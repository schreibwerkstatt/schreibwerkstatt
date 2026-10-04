'use strict';
// Übersetzt Page-HTML in Render-Operationen für lib/pdf-render.js.
// Ausgabe ist ein flacher Array von „Blocks":
//   { kind: 'heading',  level, text, anchorId? }
//   { kind: 'paragraph', runs: Run[] }
//   { kind: 'list', ordered: bool, items: Block[][] }
//   { kind: 'blockquote', blocks: Block[] }
//   { kind: 'poem',      lines: Run[][] }       // .poem-Klasse
//   { kind: 'image',     src, alt }
//   { kind: 'hr' }
//   { kind: 'table',     caption: Run[], align: string[], header: Run[][]|null,
//                        rows: Run[][][] }
//
// Run = { text: string, bold?, italic?, underline?, link? }
//
// Unbekannte Elemente werden geskippt (Inhalt wird als Plain-Text durchgereicht,
// falls er textbasierend ist; nicht aber als Block-Strukturen). Whitelist
// orientiert sich an dem, was der Editor erzeugt: h1-h3, p, ul/ol/li,
// blockquote, div.poem (eigene Klasse aus editor/toolbar.js), pre, img,
// figure/figcaption/p.figure-credit, table, hr, br + inline strong/em/u/a/sup.
//
// Dieses Modul ist der GETEILTE Walker: der PDF-Renderer, der Custom-DOCX-Export
// (lib/export-builders/docx.js), der Markdown-Export und der Substack-Export
// lesen dieselbe Blockliste. Ein neuer Blocktyp hier muss darum in JEDEM dieser
// Konsumenten einen Zweig bekommen — fehlt er, faellt der Block in deren
// `default` und verschwindet lautlos.

const { parseHTML } = require('linkedom');

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'div', 'img', 'hr', 'br']);

function _hasClass(el, cls) {
  const c = el.getAttribute && el.getAttribute('class');
  if (!c) return false;
  return c.split(/\s+/).includes(cls);
}

// Sammelt Text-Runs der Kinder von `parent` rekursiv. Inline-Stil-Stack via
// strong/em/u/a. <br> emittiert einen \n-Run. Verschachtelte Block-Elemente
// werden geskippt — Editor-HTML verschachtelt das selten.
function _collectChildrenRuns(parent, ctx, out) {
  for (const child of parent.childNodes) _collectInline(child, ctx, out);
}

function _collectInline(node, ctx, out) {
  if (node.nodeType === 3) {
    let text = node.textContent || '';
    if (!ctx.preserveWhitespace) text = text.replace(/\s+/g, ' ');
    if (text === '') return;
    out.push({ ...ctx.style, text });
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = node.tagName ? node.tagName.toLowerCase() : '';

  let nextStyle = ctx.style;
  if (tag === 'strong' || tag === 'b')   nextStyle = { ...nextStyle, bold: true };
  if (tag === 'em' || tag === 'i')       nextStyle = { ...nextStyle, italic: true };
  if (tag === 'u')                       nextStyle = { ...nextStyle, underline: true };
  // Hochgestellt: traegt die Notenziffer des Anmerkungsapparats (lib/endnotes.js).
  // Kein eigener Blocktyp — der Marker steht mitten im Satz und muss durch
  // Zeilenumbruch, Blocksatz und Silbentrennung wie jeder andere Run laufen.
  //
  // `data-fn` setzt nur der Fussnotenmodus; damit findet der Renderer vom Marker
  // aus die Note, deren Platz er am Seitenfuss reservieren muss. Ein `<sup>` ohne
  // das Attribut ist blosse Hochstellung aus dem Manuskript (`m<sup>2</sup>`) und
  // bekommt bewusst KEINE Noten-ID.
  if (tag === 'sup') {
    nextStyle = { ...nextStyle, sup: true };
    const fn = parseInt(node.getAttribute('data-fn'), 10);
    if (Number.isInteger(fn) && fn > 0) nextStyle = { ...nextStyle, noteId: fn };
  }
  if (tag === 'a') {
    const href = node.getAttribute('href');
    if (href) nextStyle = { ...nextStyle, underline: true, link: href };
  }
  if (tag === 'br') {
    out.push({ ...ctx.style, text: '\n' });
    return;
  }
  // Verschachteltes Block-Element innerhalb eines Paragraph/Heading? Inhalt
  // einsammeln statt skippen, sonst geht Text verloren.
  for (const child of node.childNodes) _collectInline(child, { ...ctx, style: nextStyle }, out);
}

// Tabelle → `{ kind: 'table', caption, align, header, rows }`.
//
// Zellen sind Run-Arrays, keine Bloecke: der Markup-Vertrag
// (public/js/table/table-html.js) erlaubt in einer Zelle nur Inline-Inhalt, und
// damit laufen Quellen-Chip, Querverweis und Auszeichnung durch dieselbe
// Inline-Maschinerie wie im Fliesstext. Traegt eine importierte Zelle doch einen
// Block, sammelt `_collectChildrenRuns` seinen Text ein — verlustfrei, nur ohne
// Blockstruktur.
//
// Toleriert dasselbe Import-Markup wie tableModel(): fehlendes `<thead>` (erste
// Ganz-`<th>`-Zeile gilt als Kopf), fehlendes `<tbody>`, unterschiedlich lange
// Zeilen. `colspan` wird als Spaltenbreite mitgezaehlt UND beim Einsortieren
// uebersprungen: der Inhalt steht in der ersten Spalte des Verbunds, die
// restlichen bleiben leer. Ohne das Ueberspringen rutschte jede Zelle nach einem
// Verbund um dessen Spannweite nach links und stuende unter der falschen
// Kopfzeile — sichtbar nur bei Import-Markup (Word/ODT), wo verbundene Zellen
// vorkommen; der Gitter-Dialog erzeugt sie nicht.
function _walkTable(el) {
  const capEl = el.querySelector && el.querySelector('caption');
  const caption = capEl
    ? _trimRuns((() => { const r = []; _collectChildrenRuns(capEl, { style: {}, preserveWhitespace: false }, r); return r; })())
    : [];

  const cellRuns = (td) => {
    const runs = [];
    _collectChildrenRuns(td, { style: {}, preserveWhitespace: false }, runs);
    // Weiche Umbrueche in einer Zelle werden zu Leerzeichen: eine Zeile im
    // Tabellensatz bricht nach der Spaltenbreite, nicht nach dem `<br>` des
    // Autors — ein erzwungener Umbruch in einer 3 cm breiten Spalte erzeugt nur
    // Lueckentext.
    return _trimRuns(runs.map(r => (r.text === '\n' ? { ...r, text: ' ' } : r)));
  };

  const trs = el.querySelectorAll ? Array.from(el.querySelectorAll('tr')) : [];
  const parsed = [];
  for (const tr of trs) {
    const cells = Array.from(tr.children || [])
      .filter(c => c.tagName === 'TD' || c.tagName === 'TH');
    if (!cells.length) continue;
    parsed.push({
      header: cells.every(c => c.tagName === 'TH'),
      cells: cells.map(c => ({
        runs: cellRuns(c),
        align: String((c.getAttribute && c.getAttribute('data-align')) || '').toLowerCase(),
        span: Math.max(1, parseInt((c.getAttribute && c.getAttribute('colspan')) || '1', 10) || 1),
        rspan: Math.max(1, parseInt((c.getAttribute && c.getAttribute('rowspan')) || '1', 10) || 1),
      })),
    });
  }
  if (!parsed.length) return caption.length ? { kind: 'paragraph', runs: caption } : null;

  // Zeilen auf ein Raster legen. Zwei Achsen, dieselbe Regel: `colspan`
  // ueberspringt Spalten in DIESER Zeile, `rowspan` belegt sie in den FOLGENDEN.
  // Der Inhalt steht in der ersten Spalte des Verbunds, die mitueberdeckten
  // bleiben leer — und OHNE Ausrichtungsangabe: eine Aussage ueber eine Spalte
  // macht nur eine Zelle, die wirklich dort steht.
  const blank = () => ({ runs: [], align: '' });
  const carry = [];   // Spalte → wie viele weitere Zeilen sie von oben belegt ist
  const grid = [];
  for (const row of parsed) {
    const out = [];
    let c = 0;
    for (const cell of row.cells) {
      while ((carry[c] || 0) > 0) c++;   // von oben belegt → ueberspringen
      for (let k = 0; k < cell.span; k++) {
        out[c + k] = k === 0 ? { runs: cell.runs, align: cell.align } : blank();
        // `rspan` (nicht rspan-1): am Zeilenende laeuft jede Belegung um eins ab,
        // danach steht genau die Zahl der FOLGE-Zeilen drin.
        if (cell.rspan > 1) carry[c + k] = cell.rspan;
      }
      c += cell.span;
    }
    grid.push(out);
    for (let i = 0; i < carry.length; i++) if (carry[i] > 0) carry[i] -= 1;
  }

  const cols = Math.max(...grid.map(r => r.length), 1);
  const fill = (r) => Array.from({ length: cols }, (_, i) => r[i] || blank());
  const headerCells = parsed[0].header ? fill(grid[0]) : null;
  const bodyRows = (parsed[0].header ? grid.slice(1) : grid).map(fill);

  // Ausrichtung pro Spalte: Kopfzelle autoritativ, sonst die erste Zelle der
  // Spalte mit Angabe. Dieselbe Regel wie im Markup-Vertrag — hier ein zweites
  // Mal, weil dieses Modul CJS ist und den ESM-Vertrag nicht importieren kann.
  // Gegated durch tests/unit/pdf-table.test.mjs.
  const align = [];
  for (let c = 0; c < cols; c++) {
    let a = headerCells?.[c]?.align;
    if (!a || !['left', 'center', 'right'].includes(a)) {
      a = '';
      for (const r of bodyRows) {
        const v = r[c]?.align;
        if (v && ['left', 'center', 'right'].includes(v)) { a = v; break; }
      }
    }
    align.push(a || 'left');
  }

  return {
    kind: 'table',
    // Anker-ID des Querverweis-Systems (`data-bid`, vergeben am Schreib-
    // Chokepoint). Der Body-Renderer meldet damit die Seite, auf der die
    // Tabelle beginnt — Grundlage des Tabellenverzeichnisses mit Seitenzahlen
    // (lib/pdf-render/anchor-dir.js). Fehlt sie, faellt der Eintrag im
    // Verzeichnis weg; gerendert wird die Tabelle trotzdem.
    bid: _anchorBid(el),
    caption,
    align,
    header: headerCells ? headerCells.map(c => c.runs) : null,
    rows: bodyRows.map(r => r.map(c => c.runs)),
  };
}

// `data-bid` eines Ankers, normalisiert wie in public/js/xrefs/xref-anchor.js.
// Kein Anker → null; der Aufrufer laesst das Feld dann weg.
function _anchorBid(el) {
  const raw = el && el.getAttribute ? String(el.getAttribute('data-bid') || '') : '';
  const bid = raw.trim().toLowerCase();
  return /^[0-9a-f]{8,32}$/.test(bid) ? bid : null;
}

function _trimRuns(runs) {
  // Leere Runs entfernen, gleichzeitig führende/abschließende Whitespace-Runs
  // trimmen.
  const trimmed = runs.filter(r => r.text !== '');
  while (trimmed.length && /^\s*$/.test(trimmed[0].text)) trimmed.shift();
  while (trimmed.length && /^\s*$/.test(trimmed[trimmed.length - 1].text)) trimmed.pop();
  return trimmed;
}

// Verszeile: wie _trimRuns, dazu Rand-Leerzeichen INNERHALB des ersten/letzten
// Runs („Apfel <br>"). Am Zeilenrand sind sie bedeutungslos, im Markdown aber
// schädlich — `*Apfel *` ist keine Kursive, der Stern schliesst nach Leerraum nicht.
function _trimVerse(runs) {
  const t = _trimRuns(runs);
  if (!t.length) return t;
  t[0] = { ...t[0], text: t[0].text.replace(/^\s+/, '') };
  const last = t.length - 1;
  t[last] = { ...t[last], text: t[last].text.replace(/\s+$/, '') };
  return t;
}

function _walkBlock(el, ctx, blocks) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '';

  // div.poem → eigener Block-Typ. Erkennt sowohl <div class="poem"> als auch
  // <blockquote class="poem">. Verse-Inhalt wird zeilenweise gesammelt; jede
  // Quelle-Zeile = eigenes Run-Array.
  if ((tag === 'div' || tag === 'blockquote') && _hasClass(el, 'poem')) {
    // Leere Zeilen ([]) bleiben als Strophen-Trenner erhalten; der Block-Renderer
    // setzt für jede leere Zeile ein moveDown (Strophen-Abstand). Doppelte/führende/
    // schliessende Leerzeilen werden danach kollabiert.
    //
    // Zwei Schreibweisen kommen vor, beide aus dem Editor: ein Absatz pro Vers
    // (Enter) mit leerem Absatz als Strophen-Trenner, oder ein Absatz pro
    // Strophe mit <br> zwischen den Versen (Shift+Enter, auch jeder Import).
    // Trägt auch nur ein Absatz mehrere Verse, ist es die zweite Schreibweise —
    // dann ist jede Absatzgrenze ein Strophenwechsel und bekommt eine leere
    // Zeile. Sonst liefen alle Strophen in jedem Export ohne Abstand ineinander.
    const groups = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 1 && /^(p|div)$/i.test(child.tagName)) {
        const runs = [];
        _collectChildrenRuns(child, { style: { italic: true }, preserveWhitespace: true }, runs);
        // Wenn der Absatz selbst <br>s enthält, splitten wir hier auf:
        const acc = [];
        let cur = [];
        for (const r of runs) {
          if (r.text === '\n') { acc.push(_trimVerse(cur)); cur = []; }
          else cur.push(r);
        }
        acc.push(_trimVerse(cur));
        // Leerer Absatz (<p></p> / <p><br></p>) → eine leere Strophen-Trenner-Zeile.
        if (acc.every(a => !a.length)) groups.push([[]]);
        else groups.push(acc);
      } else if (child.nodeType === 3) {
        const t = (child.textContent || '').split(/\n/);
        groups.push(t.map(line => (line.trim() ? [{ text: line.trim(), italic: true }] : [])));
      }
    }
    const stanzaParas = groups.some(g => g.filter(l => l.length).length > 1);
    const lines = [];
    groups.forEach((g, i) => {
      if (stanzaParas && i > 0) lines.push([]);
      lines.push(...g);
    });
    // Führende/schliessende + aufeinanderfolgende Leerzeilen kollabieren.
    const collapsed = [];
    for (const l of lines) {
      if (!l.length && (!collapsed.length || !collapsed[collapsed.length - 1].length)) continue;
      collapsed.push(l);
    }
    while (collapsed.length && !collapsed[collapsed.length - 1].length) collapsed.pop();
    if (collapsed.length) blocks.push({ kind: 'poem', lines: collapsed });
    return;
  }

  if (tag === 'div') {
    // Generischer div ohne Poem-Klasse → durchwalken (importiertes HTML nutzt
    // teilweise Wrapper-Divs).
    for (const child of el.childNodes) _walkNode(child, ctx, blocks);
    return;
  }

  if (tag === 'p') {
    const runs = [];
    _collectChildrenRuns(el, { style: {}, preserveWhitespace: false }, runs);
    const t = _trimRuns(runs);
    if (t.length) blocks.push({ kind: 'paragraph', runs: t });
    // Leerer Absatz (vom Autor gesetzte Leerzeile) = Szenentrenner. Block
    // erhalten — der Renderer rückt den Folgeabsatz dann nicht ein (nur bei
    // aktivem Erstzeilen-Einzug).
    else blocks.push({ kind: 'blankline' });
    return;
  }

  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
    const level = Math.min(3, parseInt(tag[1]));
    const runs = [];
    _collectChildrenRuns(el, { style: {}, preserveWhitespace: false }, runs);
    const trimmed = _trimRuns(runs);
    const text = trimmed.map(r => r.text).join('').trim();
    // `runs` nur, wenn die Überschrift Hochgestelltes trägt (Notenmarker im
    // Fussnotenmodus, m²): dann setzt der PDF-Renderer sie über den Layouter und
    // die Note geht nicht verloren. Die übrigen Konsumenten lesen weiter `text`.
    if (text) {
      const hasSup = trimmed.some(r => r.sup);
      blocks.push(hasSup ? { kind: 'heading', level, text, runs: trimmed.map(r => (r.text === '\n' ? { ...r, text: ' ' } : r)) } : { kind: 'heading', level, text });
    }
    return;
  }

  if (tag === 'ul' || tag === 'ol') {
    const items = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 1 && child.tagName.toLowerCase() === 'li') {
        const sub = [];
        // li-Inhalt: ggf. mehrere Blocks (verschachtelte Listen, p, …)
        // Einfachfall: collectRuns auf Top-Level-Inline + rekursiv für innere
        // Block-Tags.
        const inlineRuns = [];
        for (const liChild of child.childNodes) {
          if (liChild.nodeType === 1 && BLOCK_TAGS.has(liChild.tagName.toLowerCase())
              && liChild.tagName.toLowerCase() !== 'br') {
            // Block innerhalb li → vorher inline-Runs zu paragraph machen.
            if (inlineRuns.length) {
              const t = _trimRuns(inlineRuns.splice(0));
              if (t.length) sub.push({ kind: 'paragraph', runs: t });
            }
            _walkNode(liChild, ctx, sub);
          } else {
            _collectInline(liChild, { style: {}, preserveWhitespace: false }, inlineRuns);
          }
        }
        if (inlineRuns.length) {
          const t = _trimRuns(inlineRuns);
          if (t.length) sub.unshift({ kind: 'paragraph', runs: t });
        }
        items.push(sub);
      }
    }
    if (items.length) blocks.push({ kind: 'list', ordered: tag === 'ol', items });
    return;
  }

  if (tag === 'blockquote') {
    const sub = [];
    for (const child of el.childNodes) _walkNode(child, ctx, sub);
    // `cited` = belegtes Blockzitat (`data-src`, Markup-SSoT
    // public/js/sources/cite-html.js). Der Renderer setzt es aufrecht und
    // kleiner; ein blockquote ohne Zeiger bleibt das stilistische Zitat/Motto.
    // Der Zeigerwert selbst interessiert hier nicht — der sichtbare Kurzbeleg
    // steckt als Chip im Text und ist schon zu Runs geworden.
    if (sub.length) blocks.push({ kind: 'blockquote', blocks: sub, cited: el.hasAttribute('data-src') });
    return;
  }

  if (tag === 'pre') {
    // Plain-Text mit erhaltenen Whitespaces; rendern wir als Poem-ähnlich
    // ohne Italic, mit Body-Font monospace-Skala (Renderer entscheidet).
    //
    // `lang` traegt die Sprachmarke eines Codeblocks weiter. Genutzt wird das
    // bisher nur von `mermaid`: erreicht ein Diagramm den Walker, konnte es
    // nicht gerendert werden (lib/diagram-export.js, Invariante B) — der
    // Markdown-Export macht daraus dann einen ```mermaid-Block, den GitHub,
    // GitLab und Obsidian ihrerseits zeichnen. Aus dem Quelltext-Fallback wird
    // dort also wieder ein Bild.
    const text = el.textContent || '';
    const lines = text.split(/\n/).map(l => [{ text: l }]);
    const cls = el.getAttribute && el.getAttribute('class');
    const lang = cls && cls.split(/\s+/).includes('mermaid') ? 'mermaid' : null;
    blocks.push({ kind: 'pre', lines, lang });
    return;
  }

  if (tag === 'img') {
    const src = el.getAttribute('src');
    const alt = el.getAttribute('alt') || '';
    if (src) blocks.push({ kind: 'image', src, alt });
    return;
  }

  // <figure> umschliesst Bilder (mit optionaler <figcaption>). Ohne eigenen
  // Zweig fiele das figure in den generischen Fallback und das <img> ginge
  // verloren (nur die Caption-Runs überlebten). Wir emittieren jedes innere
  // <img> als image-Block und die figcaption als kursiven Paragraph dahinter —
  // verlustfrei, ohne Renderer-Anpassung.
  if (tag === 'figure') {
    // Die Anker-ID sitzt an der `<figure>`, nicht am `<img>` — sie bekommt nur
    // das erste Bild, damit eine Abbildung mit mehreren Bildern im Verzeichnis
    // genau einen Eintrag hat.
    const figBid = _anchorBid(el);
    let firstImg = true;
    for (const img of el.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (!src) continue;
      blocks.push({
        kind: 'image', src, alt: img.getAttribute('alt') || '',
        ...(firstImg && figBid ? { bid: figBid } : {}),
      });
      firstImg = false;
    }
    // Legende und Bildnachweis sind zwei Absätze, in der Reihenfolge des
    // Markups (Markup-SSoT: public/js/figure/figure-html.js). Der Nachweis
    // braucht seinen eigenen Zweig: er ist ein `<p>` NEBEN der `<figcaption>`
    // und fiele hier sonst unter den Tisch — dieser Zweig kehrt zurück, ohne
    // die übrigen Kinder des `<figure>` zu besuchen.
    // Beide kursiv, wie die Legende es immer war: das Run-Modell kennt nur
    // bold/italic/underline/sup/link, keine Schriftgrösse — die kleinere Type
    // des Nachweises (so steht er am Bildschirm) liesse sich hier nur über eine
    // eigene Schriftrolle im Exportprofil ausdrücken.
    for (const capSel of ['figcaption', 'p.figure-credit']) {
      const cap = el.querySelector(capSel);
      if (!cap) continue;
      const runs = [];
      _collectChildrenRuns(cap, { style: { italic: true }, preserveWhitespace: false }, runs);
      const t = _trimRuns(runs);
      // `figCaption`: der PDF-Renderer hält die Legende mit ihrem Bild auf
      // einer Seite (block-image.js). Für alle anderen Konsumenten ein Absatz.
      if (t.length) blocks.push({ kind: 'paragraph', runs: t, figCaption: true });
    }
    return;
  }

  if (tag === 'hr') {
    let kind = 'hr';
    if (_hasClass(el, 'blankpage')) kind = 'blankpage';
    else if (_hasClass(el, 'pagebreak')) kind = 'pagebreak';
    blocks.push({ kind });
    return;
  }

  if (tag === 'table') {
    const block = _walkTable(el);
    if (block) blocks.push(block);
    return;
  }

  // Unbekannt → Inhalte einsammeln und als paragraph fallback durchreichen.
  const runs = [];
  _collectChildrenRuns(el, { style: {}, preserveWhitespace: false }, runs);
  const t = _trimRuns(runs);
  if (t.length) blocks.push({ kind: 'paragraph', runs: t });
}

function _walkNode(node, ctx, blocks) {
  if (node.nodeType === 1) return _walkBlock(node, ctx, blocks);
  if (node.nodeType === 3) {
    const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) blocks.push({ kind: 'paragraph', runs: [{ text: t }] });
  }
}

/**
 * Parst einen HTML-Snippet (typisch Page-HTML) in Block-Liste.
 * Eingabe darf außerhalb eines `<body>` stehen — linkedom packt automatisch.
 *
 * @param {string} html
 * @returns {Block[]}
 */
// Führende/abschliessende Leerzeilen-Blöcke verwerfen und aufeinanderfolgende
// auf einen kollabieren — eine Szenentrenner-Leerzeile, egal wie viele leere
// Absätze die Quelle enthält.
function _normalizeBlanklines(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.kind === 'blankline') {
      if (!out.length) continue;
      if (out[out.length - 1].kind === 'blankline') continue;
    }
    out.push(b);
  }
  while (out.length && out[out.length - 1].kind === 'blankline') out.pop();
  return out;
}

function parseHtmlToBlocks(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html || ''}</body></html>`);
  const root = document.body;
  const blocks = [];
  for (const child of root.childNodes) _walkNode(child, {}, blocks);
  return _normalizeBlanklines(blocks);
}

module.exports = { parseHtmlToBlocks };
