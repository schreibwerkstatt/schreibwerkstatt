'use strict';
// WordPress-Post → App-Seite (plus die Import-Helfer, die WordPress und HubSpot
// teilen: Jahres-Kapitel, Seite + Link idempotent anlegen). EINE Stelle fuer alle Wege, die einen Remote-Stand
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
const { wpToAppHtml, wpLossyBlocks } = require('./wp-html');
const { getHeadline, setHeadline, headlineUpdatedAt } = require('../db/headline');
const { carryBlockIds } = require('./html-clean');
const { latest } = require('./blog-merge');
const { wpTitleText, importedPageName, planPulledTitle } = require('./blog-title');
const blogs = require('../db/blogs');

// Jahres-Kapitel: importierte Posts (WordPress wie HubSpot) werden nach Jahr
// gebuendelt, chapter_name = "YYYY" auf oberster Ebene — ein gleichnamiges
// Unterkapitel ist kein Jahres-Kapitel. Get-or-create pro Job; der Cache
// (year → chapter_id) erspart Mehrfach-Lookups.
async function resolveYearChapter(bookId, year, cache) {
  if (cache.has(year)) return cache.get(year);
  const existing = await contentStore.listChapters(bookId, null);
  for (const ch of existing) {
    if (ch.parent_chapter_id == null && String(ch.name) === year) {
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
 *  Liefert `{ name }` — den neuen Seitennamen oder null, wenn er blieb.
 *  `expectedUpdatedAt`: Stempel, auf dem der Aufrufer „WordPress ist neuer"
 *  entschieden hat (Delta-Pull, lib/blog-merge.js#classifyPull). Hat jemand die
 *  Seite seither gespeichert, wirft savePage `PAGE_CONFLICT` (409) statt die
 *  Aenderung zu ueberschreiben; der Headline-Patch bleibt dann ebenfalls aus.
 *  Ohne Stempel (bewusste Konflikt-Aufloesung „WordPress gewinnt") kein Guard. */
async function applyPostToPage({ pageId, bookId, pageRow, post, userEmail = null, citeStats = null, expectedUpdatedAt = null }) {
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

  const saved = await contentStore.savePage(pageId, {
    // Block-IDs des bisherigen Stands mitnehmen (WordPress kennt `data-bid`
    // nicht): sonst verloeren Querverweise auf Abbildungen/Tabellen ihr Ziel.
    html: carryBlockIds(pageRow?.html || pageRow?.body_html || '', html),
    ...(plan.name ? { name: plan.name } : {}),
    ...(expectedUpdatedAt ? { expected_updated_at: expectedUpdatedAt } : {}),
  }, null);
  if (Object.keys(patch).length) setHeadline(pageId, bookId, patch, userEmail);
  // Sync-Punkt = Stempel der eigenen Writes (der juengere von Seite und
  // Titel-Werkstatt), nicht „jetzt" beim Aufrufer — ein Save dazwischen gilt
  // sonst als schon abgeglichen.
  return { name: plan.name || null, syncedAt: latest(saved?.updated_at, headlineUpdatedAt(pageId)) || null };
}

// Jahres-Kapitel: "YYYY" aus einem Datum, sonst "Undatiert" (beide Anbieter).
function yearOf(dateStr) {
  const y = String(dateStr || '').slice(0, 4);
  return /^\d{4}$/.test(y) ? y : 'Undatiert';
}

// Jahres-Kapitel eines WordPress-Posts.
function postYear(post) {
  return yearOf(post.date_gmt || post.date || post.modified_gmt || '');
}

function _isUniqueViolation(e) {
  return /UNIQUE/i.test(String(e?.code || '')) || /UNIQUE constraint/i.test(String(e?.message || ''));
}

/**
 * Remote-Post → neue Seite + Link, idempotent — fuer beide Anbieter (WordPress
 * hier unten, HubSpot in lib/sync/providers/hubspot.js). Ein schon verlinkter
 * Post wird uebersprungen (null). Verliert der Lauf das Rennen um den
 * UNIQUE-Index (Anbieter, Post-ID) zwischen Check und Link (anderer Schreiber),
 * wird die eben angelegte Seite wieder entfernt, statt verwaist im Buch zu bleiben.
 *
 *   isLinked()            → true, wenn der Post schon eine Seite hat
 *   year                  → Jahres-Kapitel (resolveYearChapter)
 *   createPage(chapterId) → angelegte Seite `{ id, name, … }`
 *   link(created)         → Link schreiben (darf am UNIQUE-Index scheitern)
 * Liefert die angelegte Seite oder null.
 */
async function createLinkedPage({ bookId, year, chapterCache, isLinked, createPage, link, userEmail, logger, label }) {
  if (isLinked()) return null;
  const chapterId = await resolveYearChapter(bookId, year, chapterCache);
  const created = await createPage(chapterId);
  try {
    link(created);
  } catch (e) {
    if (!_isUniqueViolation(e)) throw e;
    logger?.warn?.(`${label}: wurde parallel bereits verlinkt – angelegte Page ${created.id} wieder entfernt.`);
    await contentStore.deletePage(created.id, null, { deletedBy: userEmail }).catch((de) => {
      logger?.error?.(`${label}: verwaiste Page ${created.id} konnte nicht entfernt werden: ${de.message}`);
    });
    return null;
  }
  return created;
}

/** WordPress-Post → Seite + Link (Import und Pull-Create). */
async function createLinkedPageFromPost({ conn, bookId, post, chapterCache, userEmail, citeStats, wpModifiedAt, logger }) {
  return createLinkedPage({
    bookId, chapterCache, userEmail, logger,
    label: `Blog: WP-Post ${post.id}`,
    year: postYear(post),
    isLinked: () => !!blogs.getLinkByPost(conn.id, post.id),
    createPage: (chapterId) => createPageFromPost({ bookId, chapterId, post, userEmail, citeStats }),
    link: (created) => {
      blogs.upsertLink({
        pageId: created.id,
        blogId: conn.id,
        wpPostId: post.id,
        wpModifiedAt,
        wpStatus: post.status || null,
        wpSlug: post.slug || null,
        lastPulledAt: new Date().toISOString(),
      });
      // Push-Sperre gleich beim Anlegen merken: das Badge zeigt sie, bevor
      // jemand den Abschnitt in der App bearbeitet.
      blogs.setLockedBlocks(created.id, wpLossyBlocks(post?.content?.raw || ''));
    },
  });
}

module.exports = {
  createPageFromPost, createLinkedPage, createLinkedPageFromPost, applyPostToPage, postDay, postYear,
  resolveYearChapter, yearOf,
};
