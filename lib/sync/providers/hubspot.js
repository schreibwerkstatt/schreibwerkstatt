'use strict';
// Sync-Adapter HubSpot. Gegenstueck zu ./wordpress.js — dieselbe Form, nur was
// HubSpot anders macht. Vertrag: routes/jobs/sync/push.js (Kopfkommentar).
//
// Unterschiede zu WordPress:
//   - Push schreibt den Draft-Buffer (Erst-Push: neuer DRAFT-Post). Live
//     aendert sich erst, wenn der User in HubSpot publiziert.
//   - Vorab-Pruefung und Konflikt-Diff lesen den DRAFT (`…/draft`), weil der
//     Push genau den ueberschreibt; der Abgleich liest den Post selbst (Status,
//     Live-URL).
//   - Kein Delta-Pull. „HubSpot uebernehmen" im Konflikt-Diff ist der einzige
//     Weg zurueck — er laeuft durch dieselbe Allowlist wie der Import.

const hubspot = require('../../../db/hubspot');
const contentStore = require('../../content-store');
const { createHubspotClient, postUpdatedAt } = require('../../hubspot-client');
const { hubspotToAppHtml, appToHubspotHtml } = require('../../hubspot-html');
const { makeImageResolver, resolveImagesInTree } = require('../image-resolver');
const { leadHtml } = require('../../headline-render');
const { bibliographySectionHtml } = require('../../bibliography');
const { getHeadline, setHeadline } = require('../../../db/headline');
const { planPulledTitle, importedPageName } = require('../../blog-title');
const { createLinkedPage, yearOf } = require('../../blog-pull');
const { assertBlogBook } = require('../../buchtyp');
const { codedError } = require('../request');
const { getCachedMedia, putCachedMedia, clearCachedMedia } = require('../../../db/sync-media-cache');
const { parseHTML } = require('linkedom');

// Hosts, auf denen HubSpot Dateien ausliefert — dort liegende Bilder werden
// nicht erneut hochgeladen.
const HUBSPOT_FILE_HOST_RE = /(^|\.)(hubspotusercontent[\w-]*\.net|hubspot\.net|hubfs\.net|hs-sites\.com)$/i;

function _escText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Datum eines Posts fuer Seitenname und Jahres-Kapitel.
function postDate(post) {
  return String(post?.publishDate || post?.created || post?.createdAt || post?.updated || '');
}

/** Post-Titel. `name` ist der Titel des Beitrags; `htmlTitle` der SEO-/Tab-
 *  Titel und traegt oft einen Zusatz wie « | Blogname» — nur Rueckfall. */
function postTitle(post) {
  return String(post?.name || post?.htmlTitle || '').trim();
}

const hubspotProvider = {
  key: 'hubspot',
  prefix: 'HUBSPOT',
  logTag: 'HubSpot',
  remoteLabel: 'Post',
  jobTypes: { import: 'hubspot-import', push: 'hubspot-push', reconcile: 'hubspot-reconcile' },
  pushErrorKeys: [
    'HUBSPOT_CONFLICT', 'HUBSPOT_REMOTE_GONE', 'HUBSPOT_AUTH_FAILED', 'HUBSPOT_FORBIDDEN',
    'HUBSPOT_RATE_LIMIT', 'HUBSPOT_UPSTREAM', 'HUBSPOT_TIMEOUT', 'HUBSPOT_FETCH_FAILED', 'HUBSPOT_PUSH_FAILED',
  ],

  requireBook(bookId, userEmail) {
    return assertBlogBook(bookId, userEmail, 'HUBSPOT_REQUIRES_BLOG_TYPE');
  },
  resolveConn(bookId) {
    const conn = hubspot.getConnection(bookId);
    if (!conn) throw codedError('HUBSPOT_NOT_CONNECTED');
    return conn;
  },
  client(conn, signal = null) {
    return createHubspotClient({ token: conn.token, signal });
  },

  // ── Links ────────────────────────────────────────────────────────────────
  db: {
    clearMediaCache: (connId) => clearCachedMedia({ hubId: connId }),
    getConnection: hubspot.getConnection,
    getConnectionPublic: hubspot.getConnectionPublic,
    deleteConnection: hubspot.deleteConnection,
    listLinks: hubspot.listLinksForConnection,
    getLinkByPage: hubspot.getLinkByPage,
    deleteLink: hubspot.deleteLink,
    setConflictState: hubspot.setConflictState,
    markConflictResolvedApp: hubspot.markConflictResolvedApp,
    markLinkPulled: (pageId, remote) => hubspot.markLinkPulled(pageId, { remoteUpdatedAt: postUpdatedAt(remote) }),
    refreshLinkMeta: (pageId, remote) => hubspot.refreshLinkMeta(pageId, {
      hubspotState: remote.state || remote.currentState || null,
      hubspotUrl: remote.url || remote.absoluteUrl || null,
    }),
  },
  linkConnId: (link) => link.hub_id,
  remoteId: (link) => link.hubspot_post_id,
  // Links aus der Zeit vor Migration 330 haben keinen Stempel: dann gibt es
  // keine Vorab-Pruefung (nichts zum Vergleichen), der naechste Push setzt ihn.
  linkStamp: (link) => link.hubspot_updated_at,
  remoteStamp: postUpdatedAt,

  // ── Remote lesen ─────────────────────────────────────────────────────────
  fetchRemote: (client, link, purpose) => (purpose === 'reconcile'
    ? client.getPost(link.hubspot_post_id)
    : client.getPostDraft(link.hubspot_post_id)),
  isGone: (post) => !!(post?.archived || post?.archivedAt),
  lossyParts: () => [],
  async remoteView(draft) {
    return {
      title: postTitle(draft),
      html: hubspotToAppHtml(draft.postBody || ''),
      modifiedAt: postUpdatedAt(draft),
    };
  },
  // „HubSpot uebernehmen": Body durch die Import-Allowlist, Titel nach der
  // gemeinsamen Regel (lib/blog-title.js — Werkstatt-Titel oder Seitenname mit
  // stehendem Datums-Praefix).
  async applyRemote({ pageId, bookId, pageRow, remote, userEmail }) {
    const hl = getHeadline(pageId);
    const plan = planPulledTitle({
      currentName: pageRow?.name || '', hl, remoteTitle: postTitle(remote), postDay: postDate(remote).slice(0, 10),
    });
    await contentStore.savePage(pageId, {
      html: hubspotToAppHtml(remote.postBody || '') || '<p></p>',
      ...(plan.name ? { name: plan.name } : {}),
    }, null);
    if (Object.keys(plan.headlinePatch).length) setHeadline(pageId, bookId, plan.headlinePatch, userEmail);
    return { name: plan.name || null };
  },
  // portalId baut die Editor-URL eines Drafts. Verbindungen von vor Migration
  // 150 haben keinen: einmal per me() nachholen (routes/hubspot.js).
  async linksMeta(conn) {
    return { blogId: conn.blogId, portalId: conn.portalId || null };
  },

  // ── Push ─────────────────────────────────────────────────────────────────
  async preparePush({ conn, client, bookId, signal, logger }) {
    // Autorname: HubSpot v3 setzt den Autor auf neuen Posts nur zuverlaessig,
    // wenn der Name zusaetzlich zu `blogAuthorId` mitgeht.
    let authorName;
    try {
      const authors = await client.listAuthors();
      const row = (authors || []).find(a => String(a.id) === String(conn.authorId));
      authorName = (row?.fullName || row?.displayName || row?.name || '').trim() || undefined;
    } catch (e) {
      logger.warn(`HubSpot-Author-Name nicht auflösbar: ${e.code || e.message}`);
    }
    // File-Manager-Cache je Verbindung (db/sync-media-cache.js): kein erneuter
    // Upload desselben Bildes bei jedem Push.
    const owner = { hubId: conn.id };
    const resolveImage = makeImageResolver({
      bookId, signal, logger, logTag: 'HubSpot-Media',
      cache: { get: (k) => getCachedMedia(owner, k), put: (k, v) => putCachedMedia(owner, k, v) },
      isHosted: (url) => HUBSPOT_FILE_HOST_RE.test(url.hostname),
      async upload({ data, filename, mimeType }) {
        const file = await client.uploadFile({ data, filename, mimeType });
        return file?.url ? { src: file.url, id: file.id ?? null } : null;
      },
    });
    return { authorName, resolveImage };
  },
  // Lead als erster Absatz (die Allowlist behaelt das `<em>`), dann Seite und
  // ggf. Verzeichnis (ohne Marker — HubSpot liest nie zurueck, also kann
  // nichts akkumulieren; die Allowlist entpackte ein `<div>` ohnehin).
  async render({ appHtml, bib, hl, state }) {
    const bibSection = bib.inBlog ? bibliographySectionHtml(bib, { list: true }) : '';
    const { document } = parseHTML(`<!doctype html><html><body><div id="r">${leadHtml({ hl })}${appHtml}${bibSection}</div></body></html>`);
    const root = document.getElementById('r');
    await resolveImagesInTree(root, state.resolveImage);
    return appToHubspotHtml(root.innerHTML, { images: true }) || '<p></p>';
  },
  // `name` ist der Post-Titel, `htmlTitle` der Seitentitel (Browser-Tab,
  // Suchergebnis) — beide gleich, sonst bliebe einer auf dem Stand des
  // Erst-Pushs. Teaser → `postSummary`.
  _titleFields(title, teaser) {
    return { name: title, htmlTitle: title, ...(teaser ? { postSummary: _escText(teaser) } : {}) };
  },
  create({ client, conn, state, title, body, teaser }) {
    return client.createPost({
      ...hubspotProvider._titleFields(title, teaser),
      postBody: body,
      contentGroupId: conn.blogId,
      blogAuthorId: conn.authorId,
      ...(state.authorName ? { authorName: state.authorName } : {}),
      state: 'DRAFT',
    });
  },
  update({ client, link, title, body, teaser }) {
    return client.updatePostDraft(link.hubspot_post_id, {
      ...hubspotProvider._titleFields(title, teaser),
      postBody: body,
    });
  },
  // `pushedAt`: Sync-Punkt aus der Push-Schleife (vor dem Lesen der Seite).
  linkAfterPush({ pageId, conn, remote, link, pushedAt }) {
    hubspot.upsertLink({
      pageId,
      hubId: conn.id,
      hubspotPostId: remote?.id || link?.hubspot_post_id,
      // Der Draft-PATCH antwortet mit dem Post; ein publizierter Post bleibt
      // PUBLISHED (der Buffer ist nur vorgemerkt).
      hubspotState: remote?.state || remote?.currentState || link?.hubspot_state || 'DRAFT',
      hubspotCreatedAt: remote?.created || remote?.createdAt || link?.hubspot_created_at || null,
      hubspotUpdatedAt: postUpdatedAt(remote) || null,
      lastPushedAt: pushedAt || new Date().toISOString(),
      hubspotUrl: remote?.url || remote?.absoluteUrl || null,
    });
  },
  touchPush: (conn) => hubspot.touchPush(conn.id),
};

// ── Import ───────────────────────────────────────────────────────────────────

/** HubSpot-Post → Seite + Link (Initial-Import), idempotent und race-fest
 *  ueber lib/blog-pull.js#createLinkedPage. */
function createLinkedPageFromHubspotPost({ conn, bookId, post, chapterCache, userEmail, logger }) {
  return createLinkedPage({
    bookId, chapterCache, userEmail, logger,
    label: `HubSpot: Post ${post.id}`,
    year: yearOf(postDate(post)),
    isLinked: () => !!hubspot.getLinkByPost(conn.id, post.id),
    async createPage(chapterId) {
      const name = importedPageName(postTitle(post), postDate(post).slice(0, 10), post.slug || `Post ${post.id}`);
      const created = await contentStore.createPage({
        book_id: bookId, chapter_id: chapterId, name,
        html: hubspotToAppHtml(post.postBody || '') || '<p></p>',
      }, null);
      return { ...created, name };
    },
    link: (created) => hubspot.upsertLink({
      pageId: created.id,
      hubId: conn.id,
      hubspotPostId: post.id,
      hubspotState: post.state || 'PUBLISHED',
      hubspotCreatedAt: post.created || post.createdAt || post.publishDate || null,
      hubspotUpdatedAt: postUpdatedAt(post) || null,
      // Sync-Baseline = Anlage-Zeitpunkt der Page. Sonst zaehlte die
      // Seitenanlage selbst als lokaler Edit (Status faelschlich „push-needed").
      lastPushedAt: created.updated_at || null,
      hubspotUrl: post.url || post.absoluteUrl || null,
    }),
  });
}

module.exports = hubspotProvider;
module.exports.createLinkedPageFromHubspotPost = createLinkedPageFromHubspotPost;
module.exports.postTitle = postTitle;
module.exports.postDate = postDate;
