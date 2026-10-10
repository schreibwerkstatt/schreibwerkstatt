'use strict';
// WordPress-Post → App-Seite (plus der Import-Helfer, den WordPress und HubSpot
// teilen: Jahres-Kapitel). EINE Stelle fuer alle Wege, die einen Remote-Stand
// in eine Seite schreiben: Initial-Import, Delta-Pull (neu + Update) und die
// Konflikt-Aufloesung „WordPress gewinnt" (routes/blog.js). Verteilt auf die
// Aufrufer lief der Titel dort auseinander (Entities, Datums-Praefix).
//
// Was ausser dem Seiten-HTML ankommt:
//   - Titel   → Titel-Werkstatt oder Seitenname (lib/blog-title.js#planPulledTitle)
//   - Lead    → `page_headline.lead`, wenn der markierte Lead-Block im Post steht
//               (lib/wp-html.js#HEADLINE_MARKER_CLASS)
//   - Excerpt → `page_headline.teaser`, aber nur wenn die Seite einen Teaser
//               fuehrt: ohne ihn schickt der Push auch keinen, und ein in
//               WordPress gepflegter Auszug gehoert WordPress.

const contentStore = require('./content-store');
const { wpToAppHtml } = require('./wp-html');
const { getHeadline, setHeadline } = require('../db/headline');
const { wpTitleText, importedPageName, planPulledTitle } = require('./blog-title');

// Jahres-Kapitel: importierte Posts (WordPress wie HubSpot) werden nach Jahr
// gebuendelt, chapter_name = "YYYY". Get-or-create pro Job; der Cache
// (year → chapter_id) erspart Mehrfach-Lookups.
async function resolveYearChapter(bookId, year, cache) {
  if (cache.has(year)) return cache.get(year);
  const existing = await contentStore.listChapters(bookId, null);
  for (const ch of existing) {
    if (String(ch.name) === year) {
      cache.set(year, ch.id);
      return ch.id;
    }
  }
  const created = await contentStore.createChapter({ book_id: bookId, name: year }, null);
  cache.set(year, created.id);
  return created.id;
}

function _rawContent(post) {
  return (post?.content && (post.content.raw || post.content.rendered)) || '';
}

function postDay(post) {
  return String(post?.date_gmt || post?.date || post?.modified_gmt || '').slice(0, 10);
}

async function _convert(post, citeStats) {
  // Eigenes Out-Objekt pro Post: `lead` ist eine Aussage ueber DIESEN Post und
  // darf nicht aus dem vorigen stehen bleiben.
  const local = {};
  const html = (await wpToAppHtml(_rawContent(post), local)) || '<p></p>';
  if (citeStats && local.citesDegraded) {
    citeStats.citesDegraded = (citeStats.citesDegraded || 0) + local.citesDegraded;
  }
  return { html, lead: local.lead };
}

/** Neue Seite aus einem Post. Liefert die angelegte Seite. */
async function createPageFromPost({ bookId, chapterId, post, userEmail = null, citeStats = null }) {
  const { html, lead } = await _convert(post, citeStats);
  const name = importedPageName(wpTitleText(post.title), postDay(post), post.slug || `Post ${post.id}`);
  const created = await contentStore.createPage({
    book_id: bookId, chapter_id: chapterId, name, html,
  }, null);
  if (lead) setHeadline(created.id, bookId, { lead }, userEmail);
  return { ...created, name };
}

/** Bestehende Seite mit dem Remote-Stand ueberschreiben.
 *  Liefert `{ name }` — den neuen Seitennamen oder null, wenn er blieb. */
async function applyPostToPage({ pageId, bookId, pageRow, post, userEmail = null, citeStats = null }) {
  const { html, lead } = await _convert(post, citeStats);
  const hl = getHeadline(pageId);
  const plan = planPulledTitle({
    currentName: pageRow?.name || '',
    hl,
    remoteTitle: wpTitleText(post.title),
    postDay: postDay(post),
  });
  const patch = { ...plan.headlinePatch };
  if (lead !== undefined && lead !== String(hl?.lead || '')) patch.lead = lead;
  const excerpt = typeof post?.excerpt?.raw === 'string' ? post.excerpt.raw.replace(/\s+/g, ' ').trim() : '';
  if (hl?.teaser && excerpt && excerpt !== hl.teaser) patch.teaser = excerpt;

  await contentStore.savePage(pageId, { html, ...(plan.name ? { name: plan.name } : {}) }, null);
  if (Object.keys(patch).length) setHeadline(pageId, bookId, patch, userEmail);
  return { name: plan.name || null };
}

module.exports = {
  createPageFromPost, applyPostToPage, postDay, resolveYearChapter,
};
