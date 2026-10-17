'use strict';

// ODT-Parser. ODT ist ein ZIP-Archiv mit content.xml. Wir extrahieren das XML,
// parsen es via linkedom (DOM-API) und walken die OpenDocument-Text-Tags zu
// einem schmalen HTML-Output: h1..h3, p, ul/ol, li, strong, em, br.
// Style-Lookup gegen office:automatic-styles erkennt fett/kursiv.

const { openCappedZip, DOC_ZIP_LIMITS } = require('../zip-limits');
const { parseHTML } = require('linkedom');

function _localName(node) {
  if (!node || !node.nodeName) return '';
  const n = node.nodeName.toLowerCase();
  const colon = n.indexOf(':');
  return colon >= 0 ? n.slice(colon + 1) : n;
}

function _attr(node, qname) {
  if (!node || !node.getAttribute) return '';
  return node.getAttribute(qname) || '';
}

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _collectStyles(doc) {
  const map = new Map();
  const styles = doc.getElementsByTagName('style:style');
  for (let i = 0; i < styles.length; i += 1) {
    const s = styles[i];
    const name = _attr(s, 'style:name');
    if (!name) continue;
    const props = s.getElementsByTagName('style:text-properties')[0];
    if (!props) continue;
    const weight = _attr(props, 'fo:font-weight');
    const italic = _attr(props, 'fo:font-style');
    map.set(name, {
      bold: weight === 'bold' || /^[6-9]00$/.test(weight),
      italic: italic === 'italic' || italic === 'oblique',
    });
  }
  return map;
}

function _walkInline(node, styles) {
  if (!node) return '';
  if (node.nodeType === 3) return _esc(node.textContent || '');
  if (node.nodeType !== 1) return '';
  const tag = _localName(node);
  if (tag === 'line-break') return '<br>';
  if (tag === 'tab' || tag === 's') return ' ';
  if (tag === 'a') {
    const href = _attr(node, 'xlink:href');
    const inner = _childrenInline(node, styles);
    return href ? `<a href="${_esc(href)}">${inner}</a>` : inner;
  }
  if (tag === 'span') {
    const styleName = _attr(node, 'text:style-name');
    const info = styleName ? styles.get(styleName) : null;
    let inner = _childrenInline(node, styles);
    if (info?.bold) inner = `<strong>${inner}</strong>`;
    if (info?.italic) inner = `<em>${inner}</em>`;
    return inner;
  }
  return _childrenInline(node, styles);
}

function _childrenInline(node, styles) {
  let out = '';
  for (const c of node.childNodes) out += _walkInline(c, styles);
  return out;
}

function _renderParagraph(node, styles) {
  const inner = _childrenInline(node, styles).trim();
  if (!inner) return '<p></p>';
  return `<p>${inner}</p>`;
}

function _renderHeading(node, styles) {
  const levelRaw = parseInt(_attr(node, 'text:outline-level'), 10);
  const level = Math.min(Math.max(Number.isFinite(levelRaw) ? levelRaw : 1, 1), 3);
  const inner = _childrenInline(node, styles).trim();
  return `<h${level}>${inner || ''}</h${level}>`;
}

function _renderList(node, styles, ordered) {
  let out = ordered ? '<ol>' : '<ul>';
  for (const c of node.childNodes) {
    if (c.nodeType !== 1) continue;
    if (_localName(c) !== 'list-item') continue;
    let inner = '';
    for (const cc of c.childNodes) {
      if (cc.nodeType !== 1) continue;
      const t = _localName(cc);
      if (t === 'p' || t === 'h') inner += _childrenInline(cc, styles);
      else if (t === 'list') inner += _renderList(cc, styles, t === 'list' && _attr(cc, 'text:style-name').toLowerCase().includes('numbered'));
    }
    out += `<li>${inner.trim()}</li>`;
  }
  out += ordered ? '</ol>' : '</ul>';
  return out;
}

function _renderBlock(node, styles, warnings) {
  const tag = _localName(node);
  if (tag === 'p') return _renderParagraph(node, styles);
  if (tag === 'h') return _renderHeading(node, styles);
  if (tag === 'list') return _renderList(node, styles, false);
  if (tag === 'table') {
    warnings.push({ code: 'TABLE_FLATTENED' });
    let out = '';
    const rows = node.getElementsByTagName('table:table-row');
    for (let i = 0; i < rows.length; i += 1) {
      const cells = rows[i].getElementsByTagName('table:table-cell');
      const parts = [];
      for (let j = 0; j < cells.length; j += 1) {
        parts.push(_childrenInline(cells[j], styles).trim());
      }
      if (parts.some(Boolean)) out += `<p>${parts.join(' | ')}</p>`;
    }
    return out;
  }
  if (tag === 'section') {
    let out = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 1) out += _renderBlock(c, styles, warnings);
    }
    return out;
  }
  if (tag === 'frame' || tag === 'image') {
    warnings.push({ code: 'IMAGES_DROPPED', count: 1 });
    return '';
  }
  return '';
}

async function parseOdt(buffer, { zipLimits = DOC_ZIP_LIMITS } = {}) {
  const warnings = [];
  const zip = await openCappedZip(buffer, zipLimits);
  const contentFile = zip.file('content.xml');
  if (!contentFile) {
    throw Object.assign(new Error('ODT missing content.xml'), { code: 'ODT_INVALID' });
  }
  const xml = await zip.read(contentFile, 'string');
  const { document } = parseHTML(xml);
  const styles = _collectStyles(document);
  const bodyTexts = document.getElementsByTagName('office:text');
  if (!bodyTexts.length) {
    return { html: '<p></p>', warnings };
  }
  const root = bodyTexts[0];
  let html = '';
  for (const c of root.childNodes) {
    if (c.nodeType !== 1) continue;
    html += _renderBlock(c, styles, warnings);
  }
  if (!html) html = '<p></p>';
  // Dedup warnings: IMAGES_DROPPED summieren
  const dropped = warnings.filter(w => w.code === 'IMAGES_DROPPED').reduce((s, w) => s + (w.count || 0), 0);
  const merged = warnings.filter(w => w.code !== 'IMAGES_DROPPED');
  if (dropped) merged.push({ code: 'IMAGES_DROPPED', count: dropped });
  return { html, warnings: merged };
}

module.exports = { parseOdt };
