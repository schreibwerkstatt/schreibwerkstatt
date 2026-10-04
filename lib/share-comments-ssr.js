'use strict';
// SSR der allgemeinen (nicht verankerten) Share-Kommentare für die öffentliche
// Leseansicht (routes/share/reader.js → {{general_comments_html}}).
//
// Gleiches Markup wie die Client-Karte (public/js/share-reader/thread-render.js,
// .comment-rail__*), gleiche Reihenfolge (Roots chronologisch, Antworten
// darunter) und dieselben Avatar-/Gruppierungs-Primitive über die ESM-Bridge —
// die Hydration durch share-reader.js tauscht die Liste so ohne sichtbaren
// Sprung aus. Ohne JS ist das zugleich die endgültige Ansicht (read-only: kein
// Antworten, keine eigenen Aktionen).
//
// Verankerte Threads fehlen hier bewusst: ohne JS nicht positionierbar, die
// schwebende Leiste hydriert der Client.

const { avatarUtil, commentThreads } = require('./esm-bridge');
const { tServer } = require('./i18n-server');
const { currentTz } = require('./local-date');
const { serializeCommentForReader, escHtml } = require('./share-helpers');

// DB-Zeitstempel → Date; SQLite-Format ohne Zone ist UTC (Pendant zu
// share-reader/dom.js#parseTs).
function parseTs(iso) {
  const s = String(iso || '');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return new Date(s.replace(' ', 'T') + 'Z');
  return new Date(s);
}

function fmt(d, lang, style) {
  const locale = lang === 'en' ? 'en-US' : 'de-CH';
  const opts = style === 'full'
    ? { dateStyle: 'full', timeStyle: 'short' }
    : { dateStyle: 'medium', timeStyle: 'short' };
  try { return d.toLocaleString(locale, { ...opts, timeZone: currentTz() }); }
  catch { return d.toISOString(); }
}

function timeHtml(iso, lang) {
  const d = parseTs(iso);
  if (isNaN(d)) return `<time class="comment-rail__time">${escHtml(iso)}</time>`;
  return `<time class="comment-rail__time" datetime="${escHtml(d.toISOString())}" title="${escHtml(fmt(d, lang, 'full'))}">${escHtml(fmt(d, lang))}</time>`;
}

function commentHtml(c, { lang, avatar, reply }) {
  const label = c.is_author
    ? tServer('share.reader.author_badge', lang)
    : (c.name || tServer('share.reader.anon', lang));
  const hue = avatar.avatarHue(c.is_author ? 'author' : (c.name || 'anon'));
  const cls = ['comment-rail__comment'];
  if (reply) cls.push('comment-rail__comment--reply');
  if (reply && c.is_author) cls.push('comment-rail__comment--author');
  const edited = c.edited_at ? `<span class="comment-rail__edited">${escHtml(tServer('share.reader.edited_badge', lang))}</span>` : '';
  const resolved = !reply && c.resolved ? `<span class="comment-rail__resolved">${escHtml(tServer('share.reader.resolved_badge', lang))}</span>` : '';
  return `<div class="${cls.join(' ')}">
      <div class="comment-rail__meta"><span class="comment-rail__avatar" aria-hidden="true" style="--avatar-hue:${Number(hue) || 0}">${escHtml(avatar.avatarInitials(label))}</span><span class="comment-rail__author">${escHtml(label)}</span>${timeHtml(c.created_at, lang)}${edited}${resolved}</div>
      <div class="comment-rail__body">${escHtml(c.body)}</div>
    </div>`;
}

/** HTML der allgemeinen Threads (`<li>`-Folge) oder der Leer-Hinweis.
 *  `rows` = listCommentsByToken(token). */
async function renderGeneralCommentsHtml(rows, lang) {
  const [avatar, threads] = await Promise.all([avatarUtil(), commentThreads()]);
  // Ohne reader_token: niemand ist „mine" — der SSR-Leser ist anonym.
  const serialized = rows.map(r => serializeCommentForReader(r, null));
  const general = threads.groupThreads(serialized)
    .filter(n => !n.root.anchor)
    .sort((a, b) => parseTs(a.root.created_at) - parseTs(b.root.created_at));
  if (!general.length) {
    return `<li class="share-comments__empty">${escHtml(tServer('share.reader.comments_empty', lang))}</li>`;
  }
  return general.map(({ root, replies }) => {
    const cls = ['comment-rail__thread', 'share-thread'];
    if (root.resolved) cls.push('comment-rail__thread--resolved');
    return `<li class="${cls.join(' ')}" data-comment-id="${Number(root.id)}">
    ${commentHtml(root, { lang, avatar, reply: false })}
    ${replies.map(r => commentHtml(r, { lang, avatar, reply: true })).join('\n    ')}
  </li>`;
  }).join('\n');
}

module.exports = { renderGeneralCommentsHtml };
