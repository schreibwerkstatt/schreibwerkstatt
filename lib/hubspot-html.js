'use strict';
// HubSpot ↔ App-HTML-Mapper. Eine Allowlist, zwei Richtungen.
//
// hubspotToAppHtml(rawHtml, opts): HubSpot-postBody (CMS-Wrapper, CTAs,
// Formulare, Embeds, evtl. Jinja-Marker) → App-HTML. Wrapper, Medien und
// Skripte fallen weg; Bilder ebenfalls — sie liegen im HubSpot-CDN, das die CSP
// der App (img-src) nicht zulaesst, sie stuenden im Manuskript also als kaputte
// Bilder. Was der Push selbst angehaengt hat (Lead, Verzeichnis), kommt nicht
// in den Abschnitt zurueck — siehe „Push-Zusaetze" unten.
//
// appToHubspotHtml(html, { images }): App-HTML → HubSpot-Rich-Text. Dieselbe
// Allowlist, plus Bilder (`images: true`), nachdem der Push sie per Media-Pass
// in den File-Manager geladen hat (lib/sync/image-resolver.js). Quellen-Chips
// (`span`) und App-Klassen fallen weg; einzig die Marker-Klassen der
// Push-Zusaetze bleiben stehen.
//
// Allowlist:
//   Inline: strong/b, em/i, u, s/del/strike, sup, sub, code, a[http(s)-href],
//           br, (img im Push)
//   Block:  p, h1→h2, h2, h3, h4–h6→h4, ul, ol[start], li (mit Unterlisten),
//           blockquote, pre, hr, table (caption, thead/tbody/tr/th/td,
//           Ausrichtung), figure (Push)
// Unbekannte Elemente werden entpackt. Lose Inline-Laeufe auf Block-Ebene
// kommen in ein eigenes <p> — eine Tabelle oder ein Text vor der ersten
// Ueberschrift darf nie den Rest des Posts zu einem Absatz zusammenziehen.
// Mehrere Bloecke in einem Listenpunkt oder einer Zelle bleiben durch <br>
// getrennt, Unterlisten bleiben Listen.
//
// Push-Zusaetze: der Push stellt den Lead der Titel-Werkstatt voran
// (`p.ms-head__lead`) und haengt bei `bibliography_in_blog` das Verzeichnis an
// (jeder Block mit `sw-bibliography`). Beides ist Metadata bzw. abgeleitet und
// darf beim Zuruecklesen („HubSpot uebernehmen", Konflikt-Diff) nicht in den
// Abschnittstext wandern — sonst haengt der naechste Push es ein zweites Mal
// an. Die Marker-Klassen sind der Hauptweg; streicht HubSpot sie, greift der
// inhaltliche Rueckfall (`lead`/`bibTitle` in den Optionen).

const { parseHTML } = require('linkedom');
const { LEAD_CLASS } = require('./headline-render');
const { BIBLIOGRAPHY_MARKER_CLASS } = require('./bibliography');

const STRIP_SEL = [
  '.hs-cta-wrapper', '.hs-cta-img', '.hs-form',
  '.hs_cos_wrapper_meta_field', '.hs-embed-wrapper',
  'script', 'style', 'iframe', 'noscript',
  'video', 'audio', 'svg', 'object', 'embed', 'canvas', 'picture', 'source',
];
const IMAGE_SEL = ['img', 'figure'];
const MARKER_CLASSES = [LEAD_CLASS, BIBLIOGRAPHY_MARKER_CLASS];

const INLINE_MAP = {
  STRONG: 'strong', B: 'strong',
  EM: 'em', I: 'em',
  U: 'u',
  S: 's', DEL: 's', STRIKE: 's',
  SUP: 'sup', SUB: 'sub',
  CODE: 'code',
  A: 'a',
  BR: 'br',
};
const BLOCK_MAP = {
  P: 'p',
  H1: 'h2', H2: 'h2',
  H3: 'h3', H4: 'h4', H5: 'h4', H6: 'h4',
  UL: 'ul', OL: 'ol', LI: 'li',
  BLOCKQUOTE: 'blockquote',
  PRE: 'pre',
  HR: 'hr',
};
// Elemente, die auf Block-Ebene einen eigenen Block bilden (nicht in einen
// Inline-Lauf gehoeren).
const BLOCKISH_SEL = 'p,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,pre,hr,table,figure,div,section,article';
const ALIGNS = new Set(['left', 'center', 'right']);

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Text, der das Haus verlaesst: `{{`, `{%`, `{#` waeren in HubSpot HubL-Syntax
// (und der Import striche sie). Als Entity sieht der Browser dasselbe Zeichen,
// der Template-Parser nicht.
function _escText(s, ctx) {
  const out = escapeHtml(s);
  return ctx.push ? out.replace(/\{(?=[{%#])/g, '&#123;') : out;
}

function _isBoldStyle(node) {
  const style = node.getAttribute && node.getAttribute('style');
  if (!style) return false;
  const m = /font-weight\s*:\s*([^;]+)/i.exec(style);
  if (!m) return false;
  const v = m[1].trim().toLowerCase();
  if (v === 'bold' || v === 'bolder') return true;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 600;
}

function _wrapBold(inner, bold) {
  if (!bold || !inner.trim()) return inner;
  return `<strong>${inner}</strong>`;
}

function _isBlockish(node) {
  if (node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (BLOCK_MAP[tag] || tag === 'TABLE' || tag === 'FIGURE') return true;
  return !!node.querySelector?.(BLOCKISH_SEL);
}

function _markerOf(node) {
  const cl = node.classList;
  if (!cl) return null;
  return MARKER_CLASSES.find(c => cl.contains(c)) || null;
}

// Klasse am ausgegebenen Block: nur im Push, nur die Marker der Push-Zusaetze
// (direkt am Element oder geerbt vom entpackten Verzeichnis-Wrapper).
function _cls(node, ctx) {
  if (!ctx.push) return '';
  const m = ctx.marker || (node ? _markerOf(node) : null);
  return m ? ` class="${m}"` : '';
}

// Ausrichtung einer Zelle: App-Markup traegt `data-align`, HubSpot ein
// `text-align` im Style. Beide Richtungen lesen beides.
function _cellAlign(cell) {
  const a = String(cell.getAttribute('data-align') || '').toLowerCase();
  if (ALIGNS.has(a)) return a;
  const m = /text-align\s*:\s*(left|center|right)/i.exec(cell.getAttribute('style') || '');
  return m ? m[1].toLowerCase() : '';
}

/** Inhalt eines Listenpunkts / einer Zelle: Inline-Text, Bloecke als durch
 *  <br> getrennte Segmente; mit `lists` bleiben Unterlisten Listen (`tail`). */
function _serializeFlow(node, ctx, { lists }) {
  const segs = [];
  let tail = '';
  let run = '';
  const flush = () => {
    const t = run.replace(/\s+/g, ' ').trim();
    if (t) segs.push(t);
    run = '';
  };
  for (const child of node.childNodes) {
    if (child.nodeType === 1 && lists && (child.tagName === 'UL' || child.tagName === 'OL')) {
      flush();
      tail += _serializeNode(child, false, ctx);
    } else if (child.nodeType === 1 && child.tagName === 'PRE') {
      flush();
      const t = _escText(_preText(child), ctx).trim();
      if (t) segs.push(t.replace(/\n/g, '<br>'));
    } else if (child.nodeType === 1 && _isBlockish(child) && !(child.tagName === 'FIGURE' && !ctx.images)) {
      flush();
      const inner = _serializeFlow(child, ctx, { lists });
      const t = inner.text ? _wrapBold(inner.text, _isBoldStyle(child)) : '';
      if (t) segs.push(t);
      tail += inner.tail;
    } else {
      run += _serializeNode(child, true, ctx);
    }
  }
  flush();
  return { text: segs.join('<br>'), tail };
}

function _serializeList(node, ctx, tag) {
  const items = [];
  for (const c of Array.from(node.children || [])) {
    if (c.tagName === 'LI') {
      const { text, tail } = _serializeFlow(c, ctx, { lists: true });
      if (text || tail) items.push({ text, tail });
    } else if ((c.tagName === 'UL' || c.tagName === 'OL') && items.length) {
      // Unterliste direkt unter der Liste (ungueltig, aber verbreitet): gehoert
      // zum vorigen Punkt.
      items[items.length - 1].tail += _serializeNode(c, false, ctx);
    }
  }
  if (!items.length) return '';
  const start = tag === 'ol' ? parseInt(node.getAttribute('start') || '', 10) : NaN;
  const startAttr = Number.isInteger(start) && start !== 1 ? ` start="${start}"` : '';
  return `<${tag}${_cls(node, ctx)}${startAttr}>${items.map(i => `<li>${i.text}${i.tail}</li>`).join('')}</${tag}>`;
}

function _serializeTable(table, ctx) {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return '';
  const cellsOf = (tr) => Array.from(tr.children || []).filter(c => c.tagName === 'TD' || c.tagName === 'TH');
  const headRow = rows.find(r => r.parentNode?.tagName === 'THEAD')
    || (cellsOf(rows[0]).length && cellsOf(rows[0]).every(c => c.tagName === 'TH') ? rows[0] : null);
  const cell = (c, tag, head) => {
    const align = _cellAlign(c);
    let attrs = head ? ' scope="col"' : '';
    if (align && align !== 'left') {
      attrs += ctx.push ? ` style="text-align: ${align}"` : ` data-align="${align}"`;
    }
    return `<${tag}${attrs}>${_serializeFlow(c, ctx, { lists: false }).text}</${tag}>`;
  };
  const head = headRow ? `<thead><tr>${cellsOf(headRow).map(c => cell(c, 'th', true)).join('')}</tr></thead>` : '';
  const body = rows.filter(r => r !== headRow)
    .map(r => `<tr>${cellsOf(r).map(c => cell(c, c.tagName === 'TH' ? 'th' : 'td', false)).join('')}</tr>`)
    .join('');
  const capEl = table.querySelector('caption');
  const capInner = capEl ? _serializeChildren(capEl, true, ctx).trim() : '';
  const cap = capInner ? `<caption>${capInner}</caption>` : '';
  if (!head && !body) return '';
  return `<table${_cls(table, ctx)}>${cap}${head}<tbody>${body}</tbody></table>`;
}

// Text eines <pre>: <br> und Block-Kinder sind Zeilenumbrueche (HubSpots
// Rich-Text-Editor schreibt Codezeilen so), sonst zaehlt jedes Zeichen.
function _preText(node) {
  let out = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) out += c.textContent || '';
    else if (c.nodeType === 1 && c.tagName === 'BR') out += '\n';
    else if (c.nodeType === 1) {
      const isBlock = /^(P|DIV|LI)$/.test(c.tagName);
      if (isBlock && out && !out.endsWith('\n')) out += '\n';
      out += _preText(c);
      if (isBlock && !out.endsWith('\n')) out += '\n';
    }
  }
  return out;
}

function _imgTag(img) {
  const src = String(img.getAttribute('src') || '');
  if (!/^https:\/\//i.test(src)) return '';
  const alt = img.getAttribute('alt') || '';
  return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`;
}

function _serializeFigure(fig, ctx) {
  const img = fig.querySelector('img');
  const tag = img ? _imgTag(img) : '';
  if (!tag) return '';
  const capEl = fig.querySelector('figcaption');
  const cap = capEl ? _serializeChildren(capEl, true, ctx).trim() : '';
  return `<figure>${tag}${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`;
}

function _serializeNode(node, inline, ctx) {
  if (!node) return '';
  if (node.nodeType === 3) return _escText(node.textContent || '', ctx);
  if (node.nodeType !== 1) return '';
  const tag = node.tagName;
  const bold = _isBoldStyle(node);

  if (tag === 'IMG') return ctx.images ? _imgTag(node) : '';
  if (tag === 'FIGURE') return (ctx.images && !inline) ? _serializeFigure(node, ctx) : '';
  if (tag === 'TABLE') {
    if (!inline) return _serializeTable(node, ctx);
    return _serializeChildren(node, true, ctx);
  }

  const out = INLINE_MAP[tag];
  if (out) {
    if (out === 'br') return '<br>';
    const inner = _serializeChildren(node, true, ctx);
    if (!inner.trim()) return '';
    if (out === 'a') {
      const href = node.getAttribute('href') || '';
      const wrapped = _wrapBold(inner, bold);
      if (!/^https?:\/\//i.test(href)) return wrapped;
      return `<a href="${escapeAttr(href)}">${wrapped}</a>`;
    }
    if (out === 'strong') return `<strong>${inner}</strong>`;
    return `<${out}>${_wrapBold(inner, bold)}</${out}>`;
  }
  const blockOut = BLOCK_MAP[tag];
  if (blockOut) {
    if (blockOut === 'hr') return inline ? '' : '<hr>';
    if (inline) return _wrapBold(_serializeChildren(node, true, ctx), bold);
    if (blockOut === 'pre') {
      const raw = _escText(_preText(node), ctx);
      if (!raw.trim()) return '';
      return `<pre${_cls(node, ctx)}>${raw}</pre>`;
    }
    if (blockOut === 'ul' || blockOut === 'ol') return _serializeList(node, ctx, blockOut);
    if (blockOut === 'li') {
      // Listenpunkt ausserhalb einer Liste: sein Inhalt als Absatz.
      const t = _serializeFlow(node, ctx, { lists: false }).text;
      return t ? `<p${_cls(node, ctx)}>${t}</p>` : '';
    }
    // Blockquote darf Absaetze tragen (belegtes Blockzitat); alles andere ist
    // ein Inline-Container.
    const innerInline = blockOut !== 'blockquote' || !node.querySelector('p');
    const inner = innerInline
      ? _serializeChildren(node, true, ctx).trim()
      : _serializeChildren(node, false, ctx);
    if (!inner.trim()) return '';
    return `<${blockOut}${_cls(node, ctx)}>${innerInline ? _wrapBold(inner, bold) : inner}</${blockOut}>`;
  }
  if (inline) return _wrapBold(_serializeChildren(node, true, ctx), bold);
  // Unbekanntes Element auf Block-Ebene: Container (div/section …) wird
  // entpackt, ein rein inline gefuelltes Element bildet einen eigenen Absatz.
  // Der Verzeichnis-Wrapper des Pushs vererbt seinen Marker an jeden Block.
  const marker = ctx.push ? _markerOf(node) : null;
  const childCtx = marker ? { ...ctx, marker } : ctx;
  if (_isBlockish(node)) return _serializeChildren(node, false, childCtx);
  const inner = _wrapBold(_serializeChildren(node, true, ctx), bold).trim();
  return inner ? `<p${_cls(node, childCtx)}>${inner}</p>` : '';
}

function _serializeChildren(parent, inline, ctx) {
  if (inline) {
    let out = '';
    for (const child of parent.childNodes) out += _serializeNode(child, true, ctx);
    return out.replace(/\s+/g, ' ');
  }
  // Block-Ebene: lose Text-/Inline-Knoten sammeln und als <p> ausgeben, sobald
  // ein Block kommt (bzw. am Ende).
  let out = '';
  let run = '';
  const flush = () => {
    const t = run.replace(/\s+/g, ' ').trim();
    if (t) out += `<p${_cls(null, ctx)}>${t}</p>`;
    run = '';
  };
  for (const child of parent.childNodes) {
    if (child.nodeType === 1 && _isBlockish(child)) {
      flush();
      out += _serializeNode(child, false, ctx);
    } else {
      run += _serializeNode(child, true, ctx);
    }
  }
  flush();
  return out;
}

// Jinja-/HubL-Marker nur im TEXT zwischen zwei Tags — nie ueber eine
// Elementgrenze hinweg (ein `{{` in einem und ein `}}` in einem spaeteren
// Absatz loeschte sonst alles dazwischen). Laeuft auf dem rohen Quelltext,
// damit eine Entity (`&#123;{`, so schreibt der Push eine woertliche Klammer)
// nicht als Marker zaehlt.
function _stripJinja(s) {
  return s.replace(/\{\{[^<]*?\}\}/g, '').replace(/\{%[^<]*?%\}/g, '').replace(/\{#[^<]*?#\}/g, '');
}
function _stripJinjaInText(raw) {
  return raw.replace(/(^|>)([^<]+)/g, (m, open, text) => open + _stripJinja(text));
}

const _norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Push-Zusaetze aus dem geparsten Body entfernen (siehe Kopfkommentar).
// `stats.lead`: Text des markierten Leads (nur wenn einer im Post stand).
function _removePushExtras(body, { lead = '', bibTitle = '', stats = null } = {}) {
  const leadEls = Array.from(body.querySelectorAll(`.${LEAD_CLASS}`));
  if (leadEls.length) {
    if (stats) stats.lead = _norm(leadEls.map(n => n.textContent || '').join(' '));
    leadEls.forEach(n => n.remove());
  } else if (_norm(lead)) {
    // Rueckfall ohne Klasse: erster Block = der Lead der Titel-Werkstatt.
    const first = Array.from(body.children).find(el => _norm(el.textContent));
    if (first && first.tagName === 'P' && _norm(first.textContent) === _norm(lead)) first.remove();
  }
  const bibEls = Array.from(body.querySelectorAll(`.${BIBLIOGRAPHY_MARKER_CLASS}`));
  if (bibEls.length) {
    bibEls.forEach(n => n.remove());
    if (stats) stats.bibliographyRemoved = true;
  } else if (_norm(bibTitle)) {
    // Rueckfall ohne Klasse: letzte Ueberschrift mit dem Verzeichnis-Titel auf
    // oberster Ebene — sie und alles danach ist das angehaengte Verzeichnis.
    const heads = Array.from(body.children).filter(el => /^H[1-6]$/.test(el.tagName)
      && _norm(el.textContent) === _norm(bibTitle));
    const h = heads[heads.length - 1];
    if (h) {
      let n = h;
      while (n) { const next = n.nextSibling; n.remove(); n = next; }
      if (stats) stats.bibliographyRemoved = true;
    }
  }
}

function _convert(rawHtml, ctx, extras = null) {
  if (typeof rawHtml !== 'string' || !rawHtml.trim()) return '';
  const src = ctx.push ? rawHtml : _stripJinjaInText(rawHtml);
  const { document } = parseHTML(`<!doctype html><html><body>${src}</body></html>`);
  const sel = ctx.images ? STRIP_SEL : [...STRIP_SEL, ...IMAGE_SEL];
  for (const s of sel) {
    for (const el of Array.from(document.querySelectorAll(s))) el.remove();
  }
  if (extras) _removePushExtras(document.body, extras);
  return _serializeChildren(document.body, false, ctx).trim();
}

/** HubSpot → App. Optionen (Zuruecklesen eines gepushten Posts):
 *  `lead` / `bibTitle` — Rueckfall, falls HubSpot die Marker-Klassen strich;
 *  `stats` — bekommt `lead` (Text des markierten Leads) und
 *  `bibliographyRemoved`. */
function hubspotToAppHtml(rawHtml, { lead = '', bibTitle = '', stats = null } = {}) {
  return _convert(rawHtml, { images: false, push: false }, { lead, bibTitle, stats });
}

/** App-HTML → HubSpot. `images: true` erst nach dem Media-Pass (die src zeigen
 *  dann auf den File-Manager); ohne bleiben Bilder draussen. */
function appToHubspotHtml(html, { images = false } = {}) {
  return _convert(html, { images: !!images, push: true });
}

module.exports = {
  hubspotToAppHtml,
  appToHubspotHtml,
  // Für Tests/CLI-Re-Use:
  _internals: { STRIP_SEL, INLINE_MAP, BLOCK_MAP, MARKER_CLASSES, escapeHtml, escapeAttr },
};
