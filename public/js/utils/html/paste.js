// Paste-Sanitizer (Teil von utils/html.js, Facade re-exportiert
// `sanitizePasteHtml`): Clipboard-HTML auf die Form bringen, die der Editor
// selbst schreibt — Tag-Whitelist, Office-Markup, Tabellen, interne Kopie.

import { isCiteEl, CITE_ATTR_SRC, CITE_ATTR_LOC, CITE_ATTR_MODE } from '../../sources/cite-html.js';
import { isXrefEl, XREF_ATTR_KIND, XREF_ATTR_ID, XREF_ATTR_FMT } from '../../xrefs/xref-html.js';
import { MSG_THREAD_CLASS, MSG_THREAD_SEL, MSG_KIND_CLASS } from '../../messages/msg-html.js';
import { TABLE_SEL, TABLE_ATTR_ALIGN, tableModel, buildTableHtml } from '../../table/table-html.js';
import { FIGURE_CREDIT_CLASS } from '../../figure/figure-html.js';
import { DIAGRAM_CLASS } from '../../diagram/mermaid-html.js';
import { TODO_LIST_CLASS, TODO_ITEM_CLASS, TODO_TEXT_CLASS } from '../../editor/shared/todo-html.js';
import { cleanContentArtefacts } from '../html.js';

const MSG_LINE_CLASSES = new Set(Object.values(MSG_KIND_CLASS));

// Whitelist erlaubter Tags beim Paste. Alles ausserhalb wird zu Text reduziert
// (Tag-Hülle entfernt, Text-Inhalt bleibt). Tags spiegeln den Editor-Toolbar-
// Output (Notebook/Focus/Bucheditor schreiben dasselbe Markup).
const PASTE_ALLOWED_TAGS = new Set([
  'P', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'UL', 'OL', 'LI', 'HR', 'PRE',
  'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'CODE', 'MARK', 'SUB', 'SUP',
  'A', 'DIV', 'SPAN',
]);
// Attribute, die pro Tag erhalten bleiben. Alles andere wird gestrippt
// (insbesondere on*-Handler, style, id, class, data-*).
const PASTE_ALLOWED_ATTRS = {
  A: new Set(['href']),
  DIV: new Set(['class']),  // nur .poem / .msg-thread (siehe Filter unten)
  // Zeilenarten des Nachrichtenverlaufs (msg-in/-out/-name/-meta); jede andere
  // Klasse filtert der Zweig unten wieder heraus.
  P: new Set(['class']),
  // SPAN ist ausschliesslich fuer den Quellen-Chip erlaubt, nicht als
  // allgemeiner Inline-Container — Word-/Web-Pastes bestehen zur Haelfte aus
  // <span>-Huellen. Der Filter unten unwrappt jeden Span, der kein gueltiger
  // Chip ist. Der Chip selbst MUSS ueberleben: Kopiert man einen Satz mit
  // Quellenangabe an eine andere Stelle, soll sie mitwandern statt zu reinem
  // Text zu zerfallen (der Zeiger auf die Quelle waere sonst weg).
  // Ebenso der Querverweis: kopiert man einen Satz mit „siehe Kapitel 3",
  // muss der Zeiger mitwandern, sonst steht dort eine tote Zahl, die beim
  // naechsten Umbau des Buchs nicht mehr mitnummeriert.
  SPAN: new Set(['class', CITE_ATTR_SRC, CITE_ATTR_LOC, CITE_ATTR_MODE,
                 XREF_ATTR_KIND, XREF_ATTR_ID, XREF_ATTR_FMT]),
  // Belegtes Blockzitat: derselbe Grund wie beim Chip — verschiebt man ein
  // Blockzitat, muss der Zeiger auf die Quelle mitwandern, sonst faellt es zum
  // stilistischen Einzug ohne Beleg zurueck (und aus dem Zitat-Anteil heraus).
  // `class` fuer .poem als <blockquote class="poem"> (siehe html-walker).
  BLOCKQUOTE: new Set(['class', CITE_ATTR_SRC]),
};

/**
 * Sanitisiert Clipboard-HTML auf eine im Editor unterstützte Form. Wird vor
 * `document.execCommand('insertHTML', …)` aufgerufen. Parsing via DOMParser
 * statt innerHTML — Subtree hängt nie im Live-DOM, on*-Handler werden vor
 * Insert gestrippt.
 *
 * - Whitelist-Tags bleiben (Inhalt wandert mit), unbekannte Tags werden
 *   unwrapped (Text bleibt, Hülle weg).
 * - Skripte/Styles/Metadaten + ihre Subtrees fliegen komplett raus.
 * - `<div>` bleibt nur als `<div class="poem">` oder `<div class="msg-thread">`,
 *   sonst unwrapped; `<p>` behält nur Zeilenklassen des Nachrichtenverlaufs.
 * - Alle Attribute weg, ausser denen in `PASTE_ALLOWED_ATTRS`.
 * - Anschliessend durch `cleanContentArtefacts` für inline-style-Reste.
 */
export function sanitizePasteHtml(html, { tables = false, structure = false } = {}) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return '';

  root.querySelectorAll('script, style, meta, link, title, iframe, object, embed, noscript')
    .forEach(el => el.remove());
  _pasteOfficeMarkup(root, doc);
  _pasteTables(root, doc, tables);

  let guard = 32;
  let changed = true;
  while (changed && guard-- > 0) {
    changed = false;
    const all = Array.from(root.querySelectorAll('*'));
    for (const el of all) {
      const tag = el.tagName;
      if (tag === 'DIV' && !_pasteDivClass(el)) {
        _unwrap(el);
        changed = true;
        continue;
      }
      const inStructure = structure && PASTE_STRUCTURE_TAGS.has(tag);
      if (!PASTE_ALLOWED_TAGS.has(tag) && !(tables && PASTE_TABLE_TAGS.has(tag)) && !inStructure) {
        _unwrap(el);
        changed = true;
        continue;
      }
      if (inStructure && tag === 'INPUT' && el.getAttribute('type') !== 'checkbox') {
        el.remove();
        changed = true;
        continue;
      }
      const allowedAttrs = PASTE_ALLOWED_ATTRS[tag] || (tables && PASTE_TABLE_ATTRS[tag])
        || (structure && PASTE_STRUCTURE_ATTRS[tag]) || null;
      for (const attr of Array.from(el.attributes)) {
        if (!allowedAttrs || !allowedAttrs.has(attr.name)) el.removeAttribute(attr.name);
      }
      if (tag === 'DIV') el.setAttribute('class', _pasteDivClass(el));
      if (tag === 'P') _keepLineClass(el, structure);
      if (structure && _keepStructureClass(el)) continue;
      if (tag === 'IMG' && !_pasteImgSrcOk(el.getAttribute('src'))) {
        el.remove();
        changed = true;
        continue;
      }
      // Span nur als Quellen-Chip ODER Querverweis zulassen; alles andere verliert
      // die Huelle. Muss NACH dem Attribut-Filter laufen — die Praedikate pruefen
      // class+data-*, die vorher noch mit Fremdattributen vermischt sein koennten.
      if (tag === 'SPAN' && !isCiteEl(el) && !isXrefEl(el)) {
        _unwrap(el);
        changed = true;
        continue;
      }
      if (tag === 'A' && !el.getAttribute('href')) {
        _unwrap(el);
        changed = true;
      }
    }
  }

  return cleanContentArtefacts(root.innerHTML);
}

// Tabellen im Clipboard (Excel, Sheets, Numbers, Webseiten, eine kopierte
// Manuskript-Tabelle). Ohne diese Behandlung packte der Tag-Filter `<table>`,
// `<tr>` und `<td>` aus, und die Zelltexte klebten ohne Trenner aneinander.
//   tables = true  (Notebook): durch die Markup-SSoT normalisiert
//     (`tableModel` → `buildTableHtml`) — Ausrichtung, Kopfzeile, Beschriftung
//     und Inline-Auszeichnung bleiben, alles Übrige (Word-Formatierung,
//     verbundene Zellen) fällt wie beim Speichern aus dem Gitter-Dialog.
//   tables = false (Bucheditor, Fokusmodus — dort sind Tabellen nur
//     Darstellung): jede Zeile ein Absatz, Zellen durch « | » getrennt.
// Nur die äusserste Tabelle zählt; eine verschachtelte geht in deren Modell auf.
const PASTE_TABLE_TAGS = new Set(['TABLE', 'CAPTION', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);
const PASTE_TABLE_ATTRS = {
  TH: new Set(['scope', TABLE_ATTR_ALIGN]),
  TD: new Set([TABLE_ATTR_ALIGN]),
};

function _pasteTables(root, doc, keep) {
  const outer = Array.from(root.querySelectorAll(TABLE_SEL))
    .filter((t) => !t.parentElement?.closest(TABLE_SEL));
  for (const t of outer) {
    const model = tableModel(t);
    const cells = [...(model.header || []), ...model.rows.flat()];
    const hasText = cells.some((c) => c.text) || model.caption;
    if (!hasText) { t.remove(); continue; }
    if (keep) {
      const box = doc.createElement('div');
      box.innerHTML = buildTableHtml(model);
      t.replaceWith(...box.childNodes);
      continue;
    }
    const lines = [];
    if (model.caption) lines.push(model.caption);
    for (const row of [...(model.header ? [model.header] : []), ...model.rows]) {
      const line = row.map((c) => c.text).join(' | ').trim();
      if (line.replace(/[|\s]/g, '')) lines.push(line);
    }
    t.replaceWith(...lines.map((text) => {
      const p = doc.createElement('p');
      p.textContent = text;
      return p;
    }));
  }
}

// Struktur aus einer editor-internen Kopie (`structure`, nur Notebook): was der
// Editor selbst erzeugt, aber fremdes HTML nicht mitbringen soll — Abbildung
// mit Bild, Legende und Bildnachweis, Diagramm-Quelltext, Checkbox-Liste. Ein
// Bild aus fremdem HTML bleibt draussen (Hotlinking auf fremde Server).
const PASTE_STRUCTURE_TAGS = new Set(['FIGURE', 'IMG', 'FIGCAPTION', 'INPUT']);
const PASTE_STRUCTURE_ATTRS = {
  IMG: new Set(['src', 'alt']),
  INPUT: new Set(['type', 'checked']),
  UL: new Set(['class']),
  LI: new Set(['class']),
  PRE: new Set(['class']),
};
// Klassen, die in diesem Modus am jeweiligen Tag überleben (genau eine).
const STRUCTURE_CLASS = {
  UL: TODO_LIST_CLASS, LI: TODO_ITEM_CLASS, SPAN: TODO_TEXT_CLASS, PRE: DIAGRAM_CLASS,
};

// true = Element ist ein gültiger Struktur-Träger und bleibt, wie es ist.
function _keepStructureClass(el) {
  const want = STRUCTURE_CLASS[el.tagName];
  if (!want) return false;
  const has = (el.getAttribute('class') || '').split(/\s+/).includes(want);
  if (has) el.setAttribute('class', want);
  else if (el.tagName !== 'SPAN') el.removeAttribute('class');
  return has && el.tagName === 'SPAN';
}

// Bildquelle aus einer internen Kopie: eigene Uploads (relativ/http(s)) und
// eingebettete Rasterbilder. `data:image/svg+xml` könnte Skript tragen.
function _pasteImgSrcOk(src) {
  const v = String(src || '').trim();
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(v)) return true;
  return /^(https?:\/\/|\/(?!\/))/i.test(v);
}

// Office-Markup in Editor-Auszeichnung übersetzen, bevor der Tag-Filter die
// `style`-Attribute verwirft, an denen es hängt:
//   • Google Docs packt den ganzen Inhalt in `<b style="font-weight:normal">`
//     und trägt Fett/Kursiv nur als Span-Stil — die Hülle fällt, die Spans
//     werden `<strong>`/`<em>`.
//   • Word trägt Aufzählungen als `<p class="MsoListParagraph…">` mit
//     `mso-list`-Stil und dem Aufzählungszeichen als Text in einem
//     `mso-list:Ignore`-Span — daraus werden echte `<ul>`/`<ol>`, die Ebene aus
//     `levelN` verschachtelt.
function _pasteOfficeMarkup(root, doc) {
  // Kommentare (Word: `<!--[if !supportLists]-->`, Fragment-Marker) tragen
  // nichts und landeten sonst in der Persistenz.
  const stack = [root];
  while (stack.length) {
    for (const n of Array.from(stack.pop().childNodes)) {
      if (n.nodeType === 8) n.remove();
      else if (n.nodeType === 1) stack.push(n);
    }
  }
  for (const b of Array.from(root.querySelectorAll('b'))) {
    const w = _styleProp(b, 'font-weight');
    if (w === 'normal' || w === '400' || (b.id || '').startsWith('docs-internal-guid')) _unwrap(b);
  }
  for (const span of Array.from(root.querySelectorAll('span[style]'))) {
    const w = _styleProp(span, 'font-weight');
    const bold = w === 'bold' || w === 'bolder' || Number(w) >= 600;
    const italic = _styleProp(span, 'font-style') === 'italic';
    if (bold && !span.closest('b, strong, h1, h2, h3, h4, h5, h6')) _wrapChildren(span, doc.createElement('strong'));
    if (italic && !span.closest('i, em')) _wrapChildren(span, doc.createElement('em'));
  }
  _pasteWordLists(root, doc);
}

function _styleProp(el, prop) {
  const m = (el.getAttribute('style') || '').match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i'));
  return m ? m[1].trim().toLowerCase() : '';
}

function _wrapChildren(el, wrapper) {
  while (el.firstChild) wrapper.appendChild(el.firstChild);
  el.appendChild(wrapper);
}

const WORD_LIST_P = 'p[class*="MsoListParagraph"], p[style*="mso-list"]';

function _pasteWordLists(root, doc) {
  const paras = Array.from(root.querySelectorAll(WORD_LIST_P));
  if (!paras.length) return;
  let stack = []; // [{ list, level }]
  let prev = null;
  for (const p of paras) {
    const level = Number((p.getAttribute('style') || '').match(/level(\d+)/i)?.[1] || 1);
    const marker = p.querySelector('span[style*="mso-list:Ignore"], span[style*="mso-list: Ignore"]');
    const ordered = /^\s*(\d+|[a-z]|[ivx]+)[.)]/i.test(marker?.textContent || '');
    marker?.remove();
    // Ein neuer Lauf beginnt, wenn zwischen zwei Listen-Absätzen anderes steht.
    if (!prev || _nextElement(prev) !== p) stack = [];
    while (stack.length && stack[stack.length - 1].level > level) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || top.level < level) {
      const list = doc.createElement(ordered ? 'ol' : 'ul');
      if (top) {
        const host = top.list.lastElementChild || top.list.appendChild(doc.createElement('li'));
        host.appendChild(list);
      } else {
        p.parentNode.insertBefore(list, p);
      }
      top = { list, level };
      stack.push(top);
    }
    const li = doc.createElement('li');
    while (p.firstChild) li.appendChild(p.firstChild);
    _trimLeadingSpace(li);
    top.list.appendChild(li);
    prev = p;
    // Platzhalter, damit `_nextElement` den Folgeabsatz noch als Nachbarn sieht.
    p.replaceChildren();
    p.setAttribute('data-sw-list', '');
  }
  root.querySelectorAll('[data-sw-list]').forEach((p) => p.remove());
}

function _nextElement(el) {
  let n = el.nextSibling;
  while (n && n.nodeType !== 1) n = n.nextSibling;
  return n;
}

function _trimLeadingSpace(el) {
  for (let n = el.firstChild; n; n = el.firstChild) {
    if (n.nodeType === 3) {
      const t = n.data.replace(/^[\s\u00A0]+/, '');
      if (t) { n.data = t; return; }
      n.remove();
    } else if (n.nodeType === 1 && !n.textContent.replace(/[\s\u00A0]/g, '') && !n.querySelector('img, br')) {
      n.remove();
    } else {
      return;
    }
  }
}

// Klasse, unter der ein eingefügter `<div>` überlebt — '' = auspacken.
function _pasteDivClass(el) {
  const cls = (el.getAttribute('class') || '').split(/\s+/);
  if (cls.includes('poem')) return 'poem';
  if (cls.includes(MSG_THREAD_CLASS)) return MSG_THREAD_CLASS;
  return '';
}

// Am `<p>` nur die Zeilenart des Nachrichtenverlaufs stehen lassen (Word bringt
// `MsoNormal` & Co. mit). Ausserhalb eines Verlaufs ist sie bedeutungslos und
// fällt ebenfalls.
// In einer internen Kopie (`structure`) bleibt zusätzlich der Bildnachweis in
// seiner Abbildung.
function _keepLineClass(el, structure = false) {
  const cls = (el.getAttribute('class') || '').split(/\s+/);
  if (structure && cls.includes(FIGURE_CREDIT_CLASS) && el.parentElement?.tagName === 'FIGURE') {
    el.setAttribute('class', FIGURE_CREDIT_CLASS);
    return;
  }
  const inThread = el.parentElement?.matches?.(MSG_THREAD_SEL);
  const kind = inThread ? cls.find((c) => MSG_LINE_CLASSES.has(c)) : null;
  if (kind) el.setAttribute('class', kind);
  else el.removeAttribute('class');
}

function _unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}
