// Seitenlogik des oeffentlichen Werkzeugs /wortwiederholungen (SSR-Seite
// public/werkzeug.html, ohne Alpine, pre-auth). Liest Parameter + Texte aus
// <script id="tool-config">, rechnet ueber wortwiederholungen.js und rendert
// ausschliesslich ueber textContent — der eingefuegte Text wird nie als HTML
// interpretiert.

import { analyzeText } from './wortwiederholungen.js';

function readConfig() {
  try {
    return JSON.parse(document.getElementById('tool-config')?.textContent || '{}');
  } catch {
    return {};
  }
}

const cfg = readConfig();
const i18n = cfg.i18n || {};
const tr = (key, params) => String(i18n[key] || key)
  .replace(/\{(\w+)\}/g, (m, k) => (params && params[k] != null ? String(params[k]) : m));
const numFmt = new Intl.NumberFormat(cfg.lang === 'en' ? 'en-US' : 'de-CH');

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function section(title) {
  const s = el('section', 'public-tool-section');
  s.append(el('h2', null, title));
  return s;
}

function renderStats(stats) {
  const ul = el('ul', 'public-tool-stats');
  const items = [
    [stats.words, 'statsWords'],
    [stats.sentences, 'statsSentences'],
    [stats.avg, 'statsAvg'],
    [stats.repeats, 'statsRepeats'],
  ];
  for (const [value, key] of items) {
    const li = el('li');
    li.append(el('span', 'public-tool-stat-value', numFmt.format(value)));
    li.append(el('span', 'public-tool-stat-label', tr(key)));
    ul.append(li);
  }
  return ul;
}

function renderText(result) {
  const s = section(tr('textTitle'));
  const box = el('div', 'public-tool-text');
  result.paragraphs.forEach((p, pi) => {
    const para = el('p');
    const marks = result.markedByParagraph[pi];
    let pos = 0;
    p.words.forEach((w, wi) => {
      if (!marks.has(wi)) return;
      if (w.start > pos) para.append(document.createTextNode(p.text.slice(pos, w.start)));
      para.append(el('mark', 'public-tool-mark', p.text.slice(w.start, w.end)));
      pos = w.end;
    });
    if (pos < p.text.length) para.append(document.createTextNode(p.text.slice(pos)));
    box.append(para);
  });
  s.append(box);
  return s;
}

function renderList(title, emptyKey, items, line) {
  const s = section(title);
  if (!items.length) {
    s.append(el('p', 'muted-msg muted-msg--sm', tr(emptyKey)));
    return s;
  }
  const ol = el('ol', 'public-tool-list');
  for (const item of items) {
    const li = el('li');
    const [main, meta] = line(item);
    li.append(document.createTextNode(main));
    li.append(el('span', 'public-tool-list-meta', meta));
    ol.append(li);
  }
  s.append(ol);
  return s;
}

function render(result, target) {
  target.replaceChildren(
    renderStats(result.stats),
    renderList(tr('repeatsTitle'), 'repeatsEmpty', result.repeats,
      r => [r.word, tr('timesUnit', { n: numFmt.format(r.count) })]),
    renderList(tr('openersTitle'), 'openersEmpty', result.openers,
      o => [o.word, tr('timesUnit', { n: numFmt.format(o.count) })]),
    renderList(tr('longTitle'), 'longEmpty', result.longSentences,
      l => [l.text, tr('wordsUnit', { n: numFmt.format(l.words) })]),
    renderText(result),
  );
  target.classList.add('public-tool-section');
}

function init() {
  const form = document.getElementById('tool-form');
  const input = document.getElementById('tool-input');
  const msg = document.getElementById('tool-msg');
  const out = document.getElementById('tool-result');
  if (!form || !input || !out) return;

  const showMsg = (text) => {
    msg.textContent = text || '';
    msg.hidden = !text;
  };

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value;
    if (!text.trim()) { showMsg(tr('empty')); out.replaceChildren(); return; }
    if (cfg.maxChars && text.length > cfg.maxChars) {
      showMsg(tr('tooLong', { max: numFmt.format(cfg.maxChars) }));
      return;
    }
    showMsg('');
    render(analyzeText(text, { window: cfg.window, long: cfg.long }), out);
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

init();
