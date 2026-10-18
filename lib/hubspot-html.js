'use strict';
// HubSpot ↔ App-HTML-Mapper. Eine Allowlist, zwei Richtungen.
//
// hubspotToAppHtml(rawHtml): HubSpot-postBody (CMS-Wrapper, CTAs, Formulare,
// Embeds, evtl. Jinja-Marker) → App-HTML. Wrapper, Medien und Skripte fallen weg;
// Bilder ebenfalls — sie liegen im HubSpot-CDN, das die CSP der App (img-src)
// nicht zulaesst, sie stuenden im Manuskript also als kaputte Bilder.
//
// appToHubspotHtml(html, { images }): App-HTML → HubSpot-Rich-Text. Dieselbe
// Allowlist, plus Bilder (`images: true`), nachdem der Push sie per Media-Pass
// in den File-Manager geladen hat (lib/sync/image-resolver.js). Quellen-Chips
// (`span`) und App-Klassen fallen weg — HubSpot liest nie zurueck.
//
// Allowlist:
//   Inline: strong/b, em/i, u, a[http(s)-href], br, (img im Push)
//   Block:  p, h1→h2, h2, h3, h4–h6→h4, ul, ol, li, blockquote, pre, hr,
//           table (caption, thead/tbody/tr/th/td, Ausrichtung), figure (Push)
// Unbekannte Elemente werden entpackt. Lose Inline-Laeufe auf Block-Ebene
// kommen in ein eigenes <p> — eine Tabelle oder ein Text vor der ersten
// Ueberschrift darf nie den Rest des Posts zu einem Absatz zusammenziehen.

const { parseHTML } = require('linkedom');

const STRIP_SEL = [
  '.hs-cta-wrapper', '.hs-cta-img', '.hs-form',
  '.hs_cos_wrapper_meta_field', '.hs-embed-wrapper',
  'script', 'style', 'iframe', 'noscript',
  'video', 'audio', 'svg', 'object', 'embed', 'canvas', 'picture', 'source',
];
const IMAGE_SEL = ['img', 'figure'];

const INLINE_MAP = {
  STRONG: 'strong', B: 'strong',
  EM: 'em', I: 'em',
  U: 'u',
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
const BLOCKISH_SEL = 'p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,pre,hr,table,figure,div,section,article';
const ALIGNS = new Set(['left', 'center', 'right']);

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

// Ausrichtung einer Zelle: App-Markup traegt `data-align`, HubSpot ein
// `text-align` im Style. Beide Richtungen lesen beides.
function _cellAlign(cell) {
  const a = String(cell.getAttribute('data-align') || '').toLowerCase();
  if (ALIGNS.has(a)) return a;
  const m = /text-align\s*:\s*(left|center|right)/i.exec(cell.getAttribute('style') || '');
  return m ? m[1].toLowerCase() : '';
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
    return `<${tag}${attrs}>${_serializeChildren(c, true, ctx).trim()}</${tag}>`;
  };
  const head = headRow ? `<thead><tr>${cellsOf(headRow).map(c => cell(c, 'th', true)).join('')}</tr></thead>` : '';
  const body = rows.filter(r => r !== headRow)
    .map(r => `<tr>${cellsOf(r).map(c => cell(c, c.tagName === 'TH' ? 'th' : 'td', false)).join('')}</tr>`)
    .join('');
  const capEl = table.querySelector('caption');
  const capInner = capEl ? _serializeChildren(capEl, true, ctx).trim() : '';
  const cap = capInner ? `<caption>${capInner}</caption>` : '';
  if (!head && !body) return '';
  return `<table>${cap}${head}<tbody>${body}</tbody></table>`;
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
  if (node.nodeType === 3) return escapeHtml(node.textContent || '');
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
      const raw = escapeHtml(node.textContent || '');
      if (!raw.trim()) return '';
      return `<pre>${raw}</pre>`;
    }
    if (blockOut === 'ul' || blockOut === 'ol') {
      const items = Array.from(node.children || []).filter(c => c.tagName === 'LI')
        .map(li => _serializeChildren(li, true, ctx).trim())
        .filter(Boolean)
        .map(t => `<li>${t}</li>`)
        .join('');
      return items ? `<${blockOut}>${items}</${blockOut}>` : '';
    }
    if (blockOut === 'li') return '';
    // Blockquote darf Absaetze tragen (belegtes Blockzitat); alles andere ist
    // ein Inline-Container.
    const innerInline = blockOut !== 'blockquote' || !node.querySelector('p');
    const inner = innerInline
      ? _serializeChildren(node, true, ctx).trim()
      : _serializeChildren(node, false, ctx);
    if (!inner.trim()) return '';
    return `<${blockOut}>${innerInline ? _wrapBold(inner, bold) : inner}</${blockOut}>`;
  }
  if (inline) return _wrapBold(_serializeChildren(node, true, ctx), bold);
  // Unbekanntes Element auf Block-Ebene: Container (div/section …) wird
  // entpackt, ein rein inline gefuelltes Element bildet einen eigenen Absatz.
  if (_isBlockish(node)) return _serializeChildren(node, false, ctx);
  const inner = _wrapBold(_serializeChildren(node, true, ctx), bold).trim();
  return inner ? `<p>${inner}</p>` : '';
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
    if (t) out += `<p>${t}</p>`;
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

function _stripJinja(s) {
  return s.replace(/\{\{[\s\S]*?\}\}/g, '').replace(/\{%[\s\S]*?%\}/g, '').replace(/\{#[\s\S]*?#\}/g, '');
}

function _convert(rawHtml, ctx) {
  if (typeof rawHtml !== 'string' || !rawHtml.trim()) return '';
  const stripped = _stripJinja(rawHtml);
  const { document } = parseHTML(`<!doctype html><html><body>${stripped}</body></html>`);
  const sel = ctx.images ? STRIP_SEL : [...STRIP_SEL, ...IMAGE_SEL];
  for (const s of sel) {
    for (const el of Array.from(document.querySelectorAll(s))) el.remove();
  }
  return _serializeChildren(document.body, false, ctx).trim();
}

function hubspotToAppHtml(rawHtml) {
  return _convert(rawHtml, { images: false, push: false });
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
  _internals: { STRIP_SEL, INLINE_MAP, BLOCK_MAP, escapeHtml, escapeAttr },
};
