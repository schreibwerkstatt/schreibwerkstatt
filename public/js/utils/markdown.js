// Chat-Markdown → HTML + Mention/Channel-Dekoration. `renderChatMarkdown` rendert
// über markdown-it mit `html: false`: Roh-HTML im Text wird escaped statt
// durchgereicht, Links nur mit http(s)/mailto (XSS-Invariante, siehe CLAUDE.md).
import { escHtml } from './escape.js';
import { loadMarkdownIt } from '../lazy-libs.js';

/**
 * Display-Pass: Markiert Slack-Style `@mentions` (User-Handles) und `#channels`
 * im View-Modus als Chips. Pure HTML-String-Transform, nicht persistent —
 * läuft auf `renderedPageHtml`, niemals auf `originalHtml`. Überspringt Text
 * in `<a>`, `<pre>`, `<code>` und bereits dekorierten Spans (idempotent).
 *
 * `@name`: 2+ Wortzeichen, beginnt mit Buchstabe.
 * `#tag`:  2+ Wortzeichen, beginnt mit Buchstabe oder Ziffer; Bindestrich erlaubt
 *           (matcht `#1-vbs`, `#dot-sync`).
 * Boundary: vorheriges Zeichen darf kein Wortzeichen oder `/` sein.
 */
const _MENTION_SKIP_ANCESTOR = new Set(['A', 'PRE', 'CODE']);
const _CHIP_RE = /(^|[^\w/&])([@#])([A-Za-z0-9][\w-]{1,})/g;

export function decorateMentions(html) {
  if (!html || (!html.includes('@') && !html.includes('#'))) return html;
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return html;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  let n = walker.nextNode();
  while (n) {
    if (!_mentionAncestorSkip(n) && /[@#]/.test(n.textContent)) texts.push(n);
    n = walker.nextNode();
  }
  for (const textNode of texts) {
    const text = textNode.textContent;
    const matches = [...text.matchAll(_CHIP_RE)];
    if (matches.length === 0) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of matches) {
      const pre = m[1];
      const sigil = m[2];
      const word = m[3];
      const start = m.index + pre.length;
      const end = start + 1 + word.length;
      if (start > last) frag.appendChild(doc.createTextNode(text.slice(last, start)));
      const span = doc.createElement('span');
      span.className = sigil === '@' ? 'mention' : 'channel';
      span.textContent = sigil + word;
      frag.appendChild(span);
      last = end;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
  return root.innerHTML;
}

function _mentionAncestorSkip(node) {
  let p = node.parentNode;
  while (p && p.nodeType === 1) {
    if (_MENTION_SKIP_ANCESTOR.has(p.tagName)) return true;
    const cls = p.getAttribute && p.getAttribute('class');
    if (cls && /\b(mention|channel)\b/.test(cls)) return true;
    p = p.parentNode;
  }
  return false;
}

// Klassen des Chat-Vokabulars (public/css/chat.css) je Token-Typ.
const _CHAT_CLASS = {
  paragraph_open: 'chat-p',
  bullet_list_open: 'chat-list',
  ordered_list_open: 'chat-list chat-list--ol',
  blockquote_open: 'chat-quote',
  hr: 'chat-hr',
  code_inline: 'chat-code',
  table_open: 'chat-table',
  link_open: 'chat-link',
};

function _decorateTokens(tokens) {
  for (const tok of tokens) {
    const cls = _CHAT_CLASS[tok.type];
    if (cls) tok.attrJoin('class', cls);
    if (tok.type === 'heading_open' || tok.type === 'heading_close') {
      // `#` ist im Chat eine Zwischenüberschrift, kein Seitentitel: eine Ebene tiefer.
      const level = Number(tok.tag.slice(1));
      tok.tag = 'h' + Math.min(level + 1, 6);
      if (tok.type === 'heading_open') tok.attrJoin('class', `chat-heading chat-heading--${Math.min(level, 3)}`);
    }
    if (tok.type === 'link_open') {
      tok.attrSet('target', '_blank');
      tok.attrSet('rel', 'noopener noreferrer');
    }
    if (tok.children) _decorateTokens(tok.children);
  }
}

function _buildChatMarkdown(markdownit) {
  const md = markdownit({ html: false, breaks: true, linkify: true, typographer: false });
  // Bilder nie laden: eine Modell-Antwort soll keinen Fremd-Request auslösen.
  md.disable('image');
  // Nur http(s)/mailto werden zum Link, alles andere bleibt Klartext.
  md.validateLink = (url) => /^(https?:|mailto:)/i.test(String(url).trim());
  md.core.ruler.push('chat_classes', (state) => { _decorateTokens(state.tokens); });
  const esc = md.utils.escapeHtml;
  const code = (content) => '<pre class="chat-pre"><code>' + esc(content.replace(/\n+$/, '')) + '</code></pre>\n';
  md.renderer.rules.fence = (tokens, idx) => code(tokens[idx].content);
  md.renderer.rules.code_block = (tokens, idx) => code(tokens[idx].content);
  md.renderer.rules.table_open = (tokens, idx, opts, _env, self) =>
    '<div class="table-scroll">' + self.renderToken(tokens, idx, opts);
  md.renderer.rules.table_close = (tokens, idx, opts, _env, self) =>
    self.renderToken(tokens, idx, opts) + '</div>';
  return md;
}

let _md = null;
let _mdPromise = null;

/** Lädt markdown-it einmalig; danach rendert `renderChatMarkdown` Markdown. */
export function loadChatMarkdown() {
  if (_md) return Promise.resolve(_md);
  if (!_mdPromise) {
    _mdPromise = loadMarkdownIt()
      .then(markdownit => (_md = _buildChatMarkdown(markdownit)))
      .catch(err => { _mdPromise = null; throw err; });
  }
  return _mdPromise;
}

export function chatMarkdownReady() {
  return _md !== null;
}

/**
 * Markdown → HTML für Chat-Antworten (CommonMark + GFM-Tabellen, Linkify,
 * einfache Zeilenumbrüche als <br>). Bis markdown-it geladen ist, kommt der
 * escapte Klartext mit <br> zurück — die Chat-Basis rendert nach dem Laden neu.
 */
export function renderChatMarkdown(text) {
  if (!text) return '';
  if (!_md) return escHtml(text).replace(/\n/g, '<br>');
  return _md.render(String(text)).trim();
}
