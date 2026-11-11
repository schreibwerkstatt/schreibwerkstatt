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
const { latest, newer, syncPoint } = require('./blog-merge');
const { wpTitleText, importedPageName, planPulledTitle } = require('./blog-title');
const blogs = require('../db/blogs');
const { isNotFound, codedError } = require('./sync/request');
const { relinkPage, isUniqueViolation } = require('./sync/relink');

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

// Tag des Posts, wie der Blog ihn zeigt: `date` ist die Ortszeit der Website.
// `date_gmt` verschob Posts kurz nach Mitternacht auf den Vortag (und am
// Neujahrsmorgen ins Vorjahres-Kapitel). Entwuerfe ohne festes Datum haben
// `date` trotzdem (WordPress fuellt es mit dem letzten Speichern).
function postDay(post) {
  return String(post?.date || post?.date_gmt || post?.modified_gmt || '').slice(0, 10);
}

/** Basis fuer relative Adressen im Post: die Blog-URL der Verbindung, sonst
 *  die Origin des Post-Permalinks (`link`). */
function _postBase(post, baseUrl) {
  if (baseUrl) return baseUrl;
  try { return post?.link ? new URL(post.link).origin : null; } catch { return null; }
}

async function _convert(post, citeStats, baseUrl = null) {
  // Eigenes Out-Objekt pro Post: `lead` ist eine Aussage ueber DIESEN Post und
  // darf nicht aus dem vorigen stehen bleiben.
  const local = {};
  const html = (await wpToAppHtml(_rawContent(post), local, { baseUrl: _postBase(post, baseUrl) })) || '<p></p>';
  if (citeStats && local.citesDegraded) {
    citeStats.citesDegraded = (citeStats.citesDegraded || 0) + local.citesDegraded;
  }
  return { html, lead: local.lead };
}

/** Neue Seite aus einem Post. Liefert die angelegte Seite. */
async function createPageFromPost({ bookId, chapterId, post, userEmail = null, citeStats = null, baseUrl = null }) {
  const { html, lead } = await _convert(post, citeStats, baseUrl);
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
 *  Ohne Stempel (bewusste Konflikt-Aufloesung „WordPress gewinnt") kein Guard.
 *  `source`: Revisions-Quelle (db/page-revisions.js#VALID_SOURCES); die Revision
 *  selbst schreibt contentStore.savePage — vorher eine Baseline, falls die Seite
 *  noch keine hat, danach den neuen Stand. */
async function applyPostToPage({ pageId, bookId, pageRow, post, userEmail = null, citeStats = null, expectedUpdatedAt = null, baseUrl = null, source = null }) {
  const { html, lead } = await _convert(post, citeStats, baseUrl);
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
    ...(source ? { source } : {}),
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

// Jahres-Kapitel eines WordPress-Posts (Ortszeit der Website, siehe postDay).
function postYear(post) {
  return yearOf(post.date || post.date_gmt || post.modified_gmt || '');
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
    if (!isUniqueViolation(e)) throw e;
    logger?.warn?.(`${label}: wurde parallel bereits verlinkt – angelegte Page ${created.id} wieder entfernt.`);
    await contentStore.deletePage(created.id, null, { deletedBy: userEmail }).catch((de) => {
      logger?.error?.(`${label}: verwaiste Page ${created.id} konnte nicht entfernt werden: ${de.message}`);
    });
    return null;
  }
  return created;
}

/** Remote-Post-Schluessel fuer den Wieder-Anschluss (lib/sync/relink.js#take). */
function relinkKey(post) {
  return { title: wpTitleText(post.title), day: postDay(post), fallbackName: post.slug || `Post ${post.id}` };
}

/** WordPress-Post → Seite + Link (Import und Pull-Create). Mit `relink`
 *  (lib/sync/relink.js#buildRelinkIndex) haengt er sich zuerst an einen
 *  passenden unverlinkten Abschnitt, statt eine neue Seite anzulegen. */
async function createLinkedPageFromPost({ conn, bookId, post, chapterCache, userEmail, citeStats, wpModifiedAt, logger, relink = null }) {
  if (relink && !blogs.getLinkByPost(conn.id, post.id)) {
    const target = relink.take(relinkKey(post));
    if (target) {
      const { html } = await _convert(post, null, conn.baseUrl);
      const relinked = await relinkPage({
        page: target, remoteAppHtml: html, logger, label: `Blog: WP-Post ${post.id}`,
        writeLink: ({ conflict }) => {
          blogs.upsertLink({
            pageId: target.id,
            blogId: conn.id,
            wpPostId: post.id,
            wpModifiedAt,
            wpStatus: post.status || null,
            wpSlug: post.slug || null,
            lastPulledAt: new Date().toISOString(),
            conflictState: conflict ? 'detected' : null,
          });
          blogs.setLockedBlocks(target.id, wpLossyBlocks(post?.content?.raw || ''));
        },
      });
      if (relinked) return relinked;
    }
  }
  return createLinkedPage({
    bookId, chapterCache, userEmail, logger,
    label: `Blog: WP-Post ${post.id}`,
    year: postYear(post),
    isLinked: () => !!blogs.getLinkByPost(conn.id, post.id),
    createPage: (chapterId) => createPageFromPost({ bookId, chapterId, post, userEmail, citeStats, baseUrl: conn.baseUrl }),
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

// ── Delta-Pull: ab wann fragen ──────────────────────────────────────────────
// `modified_after` vergleicht WordPress mit SEINER Uhr. Der Start des letzten
// Laufs (`last_pull_at`) ist ein Stempel der App-Uhr: geht WordPress nach, fiel
// ein Edit kurz nach dem Start aus jedem weiteren Delta. Darum zaehlt zusaetzlich
// der juengste gesehene WordPress-Stempel (`MAX(wp_modified_at)` der Links, WP-Uhr)
// abzueglich einer Marge — der FRUEHERE der beiden gewinnt. Ein Post, den der
// Pull doppelt sieht, ist harmlos: `classifyPull` liefert `skip`, ein schon
// verlinkter Post wird nicht neu angelegt. Ein Zukunftsstempel (Migrations-Plugin)
// zieht den Cursor nicht nach vorn, weil der App-Stempel ihn deckelt.
const PULL_CURSOR_MARGIN_MS = 60_000;

function _wpStampMs(stamp) {
  const s = String(stamp || '').trim();
  if (!s) return NaN;
  return Date.parse(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
}

/** ISO-Stempel fuer `modified_after` oder undefined (ganzer Bestand). */
function pullCursor({ lastPullAt, maxSeenModifiedGmt } = {}) {
  const app = Date.parse(String(lastPullAt || ''));
  if (!Number.isFinite(app)) return undefined;
  const wp = _wpStampMs(maxSeenModifiedGmt);
  const t = Number.isFinite(wp) ? Math.min(app, wp - PULL_CURSOR_MARGIN_MS) : app;
  return new Date(t).toISOString();
}

// ── Reparatur: Posts neu ziehen ─────────────────────────────────────────────
/**
 * Zieht die verlinkten Posts der Abschnitte `pageIds` neu (Inhalt, Titel, Lead,
 * Teaser — derselbe Weg wie der Pull, `applyPostToPage`). Gedacht fuer
 * Abschnitte, die ein frueherer Import falsch umgesetzt hat (Classic-Posts ohne
 * Absatzbildung). Die Rechte (Editor auf dem Buch, Buchtyp) prueft der Aufrufer.
 *
 * Revision: `contentStore.savePage` legt vor dem Schreiben eine Baseline an,
 * falls der Abschnitt noch keine hat, und danach eine Revision des neuen Stands
 * (Quelle `import`) — der bisherige Stand bleibt damit in der Revisionsliste
 * wiederherstellbar.
 *
 * Ueberschrieben wird nur, was seit dem letzten Abgleich lokal unveraendert ist
 * (Seite und Titel-Werkstatt nicht juenger als der Sync-Punkt, kein offener
 * Konflikt); der Save laeuft mit `expected_updated_at`, ein Save dazwischen
 * gewinnt. Gruende in `skipped[].reason`: NOT_LINKED, PAGE_NOT_FOUND, CONFLICT,
 * LOCAL_CHANGES, REMOTE_GONE oder der Fehlercode des Remote (BLOG_*).
 *
 * Liefert `{ repulled: [pageId], skipped: [{ pageId, reason }], renamed: [{ pageId, name }] }`.
 */
async function repullPages({ bookId, pageIds, userEmail = null, signal = null, logger = null, onProgress = null }) {
  const { createWpClient } = require('./wp-client');
  const conn = blogs.getConnection(bookId);
  if (!conn) throw codedError('BLOG_NOT_CONNECTED');
  const wp = createWpClient({ baseUrl: conn.baseUrl, username: conn.username, password: conn.password, signal });
  const repulled = [];
  const skipped = [];
  const renamed = [];
  const ids = [...new Set((pageIds || []).map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0))];

  for (const [i, pageId] of ids.entries()) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    onProgress?.(i + 1, ids.length);
    const skip = (reason) => { skipped.push({ pageId, reason }); };
    const link = blogs.getLinkByPage(pageId);
    if (!link || link.blog_id !== conn.id) { skip('NOT_LINKED'); continue; }
    if (link.conflict_state === 'detected') { skip('CONFLICT'); continue; }
    const pageRow = await contentStore.loadPage(pageId).catch(() => null);
    if (!pageRow || Number(pageRow.book_id) !== Number(bookId)) { skip('PAGE_NOT_FOUND'); continue; }
    if (newer(latest(pageRow.updated_at, headlineUpdatedAt(pageId)), syncPoint(link))) { skip('LOCAL_CHANGES'); continue; }

    let post;
    try {
      post = await wp.getPost(link.wp_post_id);
    } catch (e) {
      if (signal?.aborted) throw e;
      skip(isNotFound(e) ? 'REMOTE_GONE' : (e.code || 'BLOG_FETCH_FAILED'));
      continue;
    }
    if (post?.status === 'trash') { skip('REMOTE_GONE'); continue; }

    let applied;
    try {
      applied = await applyPostToPage({
        pageId, bookId, pageRow, post, userEmail,
        expectedUpdatedAt: pageRow.updated_at, baseUrl: conn.baseUrl, source: 'import',
      });
    } catch (e) {
      if (e?.code === 'PAGE_CONFLICT') { skip('LOCAL_CHANGES'); continue; }
      throw e;
    }
    blogs.markLinkPulled(pageId, {
      wpModifiedAt: post.modified_gmt || post.date_gmt || '',
      wpStatus: post.status || null,
      wpSlug: post.slug || null,
      pulledAt: applied.syncedAt,
    });
    blogs.setLockedBlocks(pageId, wpLossyBlocks(post?.content?.raw || ''));
    if (applied.name) renamed.push({ pageId, name: applied.name });
    repulled.push(pageId);
    logger?.info?.(`Blog-Reparatur: Page ${pageId} aus WP-Post ${link.wp_post_id} neu gezogen`);
  }
  return { repulled, skipped, renamed };
}

module.exports = {
  createPageFromPost, createLinkedPage, createLinkedPageFromPost, applyPostToPage, postDay, postYear,
  resolveYearChapter, yearOf, relinkKey, pullCursor, PULL_CURSOR_MARGIN_MS,
  repullPages,
};
