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
//     Weg zurueck — er laeuft durch dieselbe Allowlist wie der Import und
//     schneidet heraus, was der Push selbst angehaengt hat (Lead, Verzeichnis).

const hubspot = require('../../../db/hubspot');
const contentStore = require('../../content-store');
const { createHubspotClient, postUpdatedAt } = require('../../hubspot-client');
const { hubspotToAppHtml, appToHubspotHtml } = require('../../hubspot-html');
const { makeImageResolver, resolveImagesInTree } = require('../image-resolver');
const { leadHtml } = require('../../headline-render');
const { buildBibliography, bibliographySectionHtml, bibliographyVisible } = require('../../bibliography');
const { getHeadline, setHeadline, headlineUpdatedAt } = require('../../../db/headline');
const { planPulledTitle, importedPageName } = require('../../blog-title');
const { createLinkedPage, yearOf } = require('../../blog-pull');
const { latest } = require('../../blog-merge');
const { carryBlockIds } = require('../../html-clean');
const { assertBlogBook } = require('../../buchtyp');
const { codedError } = require('../request');
const { getCachedMedia, putCachedMedia, clearCachedMedia } = require('../../../db/sync-media-cache');
const { buildRelinkIndex: buildSharedRelinkIndex, relinkPage } = require('../relink');
const { parseHTML } = require('linkedom');

// Hosts, auf denen HubSpot Dateien ausliefert — dort liegende Bilder werden
// nicht erneut hochgeladen. Dazu jede Adresse unter `/hubfs/` bzw.
// `/hs-fs/hubfs/`: so liefert HubSpot den File-Manager auch auf der eigenen
// Domain des Blogs aus.
const HUBSPOT_FILE_HOST_RE = /(^|\.)(hubspotusercontent[\w-]*\.net|hubspot\.net|hubfs\.net|hs-sites\.com)$/i;
const HUBSPOT_FILE_PATH_RE = /^\/(hs-fs\/)?hubfs\//i;

function isHubspotHosted(url) {
  return HUBSPOT_FILE_HOST_RE.test(url.hostname) || HUBSPOT_FILE_PATH_RE.test(url.pathname);
}

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

// Fehler des Import-Jobs, die einen eigenen Text haben (`hubspot.error.<CODE>`);
// `HUBSPOT_HTTP_<n>` → `hubspot.error.HUBSPOT_HTTP` mit `{ status }`.
const IMPORT_ERROR_KEYS = new Set([
  'HUBSPOT_AUTH_FAILED', 'HUBSPOT_FORBIDDEN', 'HUBSPOT_RATE_LIMIT', 'HUBSPOT_UPSTREAM',
  'HUBSPOT_TIMEOUT', 'HUBSPOT_FETCH_FAILED', 'HUBSPOT_INVALID_JSON', 'HUBSPOT_RESPONSE_TOO_LARGE',
  'HUBSPOT_NOT_CONNECTED', 'HUBSPOT_REQUIRES_BLOG_TYPE', 'HUBSPOT_TOKEN_REQUIRED',
]);
function importErrorI18n(code) {
  const c = String(code || '');
  if (IMPORT_ERROR_KEYS.has(c)) return { key: `hubspot.error.${c}`, params: null };
  const m = /^HUBSPOT_HTTP_(\d{3})$/.exec(c);
  if (m) return { key: 'hubspot.error.HUBSPOT_HTTP', params: { status: m[1] } };
  return { key: 'hubspot.error.HUBSPOT_IMPORT_FAILED', params: null };
}

/** Verzeichnis-Titel dieses Abschnitts (Rueckfall beim Herausschneiden, falls
 *  HubSpot die Marker-Klasse strich). '' ohne Verzeichnis im Blog. */
async function _bibTitle(bookId, pageId, userEmail) {
  try {
    const bib = await buildBibliography({ bookId, pageIds: [pageId], userEmail });
    return bib?.inBlog && bibliographyVisible(bib) ? String(bib.title || '') : '';
  } catch { return ''; }
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
    'HUBSPOT_PUBLISH_NEEDS_TEASER', 'HUBSPOT_PUBLISH_INVALID', 'HUBSPOT_PUBLISH_UNSUPPORTED', 'HUBSPOT_SCHEDULE_INVALID',
  ],
  // HubSpot veroeffentlicht nur mit Meta-Description; die kommt aus dem Teaser.
  publishNeedsTeaser: true,

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
    // `syncedAt`: Stempel der eigenen Writes aus applyRemote (sonst „jetzt").
    markLinkPulled: (pageId, remote, syncedAt = null) => hubspot.markLinkPulled(pageId, {
      remoteUpdatedAt: postUpdatedAt(remote), pulledAt: syncedAt,
    }),
    refreshLinkMeta: (pageId, remote) => hubspot.refreshLinkMeta(pageId, {
      hubspotState: remote.state || remote.currentState || null,
      hubspotUrl: remote.url || remote.absoluteUrl || null,
    }),
  },
  linkConnId: (link) => link.hub_id,
  remoteId: (link) => link.hubspot_post_id,
  // Zuletzt gesehener Draft-Stempel. Links ohne Stempel (Import vor Migration
  // 330) fallen auf ihren Sync-Punkt zurueck: das ist der Moment, in dem der
  // Abschnitt den Post-Stand uebernahm (Import = Anlage der Seite) — ein Draft,
  // der danach geaendert wurde, ist ein Konflikt, kein stiller Ueberschrieb.
  // Ein zu alter Rueckfall-Stempel meldet schlimmstenfalls einen Konflikt
  // zu viel, nie einen zu wenig.
  linkStamp: (link) => link.hubspot_updated_at || latest(link.last_pulled_at, link.last_pushed_at) || null,
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
  // „HubSpot uebernehmen": Body durch die Import-Allowlist ohne die Push-
  // Zusaetze (Lead → Titel-Werkstatt, Verzeichnis entfaellt), Block-IDs des
  // bisherigen Stands mitnehmen (Querverweise, Kommentar-Anker), Titel nach
  // der gemeinsamen Regel (lib/blog-title.js).
  async applyRemote({ pageId, bookId, pageRow, remote, userEmail }) {
    const hl = getHeadline(pageId);
    const plan = planPulledTitle({
      currentName: pageRow?.name || '', hl, remoteTitle: postTitle(remote), postDay: postDate(remote).slice(0, 10),
    });
    const stats = {};
    const html = hubspotToAppHtml(remote.postBody || '', {
      stats, lead: hl?.lead || '', bibTitle: await _bibTitle(bookId, pageId, userEmail),
    }) || '<p></p>';
    const patch = { ...plan.headlinePatch };
    if (stats.lead !== undefined && stats.lead !== String(hl?.lead || '').trim()) patch.lead = stats.lead;
    const saved = await contentStore.savePage(pageId, {
      html: carryBlockIds(pageRow?.html || pageRow?.body_html || '', html),
      ...(plan.name ? { name: plan.name } : {}),
    }, null);
    if (Object.keys(patch).length) setHeadline(pageId, bookId, patch, userEmail);
    return {
      name: plan.name || null,
      syncedAt: latest(saved?.updated_at, headlineUpdatedAt(pageId)) || null,
    };
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
      isHosted: isHubspotHosted,
      async upload({ data, filename, mimeType }) {
        const file = await client.uploadFile({ data, filename, mimeType });
        return file?.url ? { src: file.url, id: file.id ?? null } : null;
      },
    });
    return { authorName, resolveImage };
  },
  // Lead als erster Absatz (Klasse `ms-head__lead`), dann Seite und ggf.
  // Verzeichnis (jeder Block mit `sw-bibliography`). Die Marker bleiben im
  // Post, damit „HubSpot uebernehmen" beides wieder herausschneidet.
  async render({ appHtml, bib, hl, state }) {
    const bibSection = bib.inBlog ? bibliographySectionHtml(bib, { list: true, marker: true }) : '';
    const { document } = parseHTML(`<!doctype html><html><body><div id="r">${leadHtml({ hl })}${appHtml}${bibSection}</div></body></html>`);
    const root = document.getElementById('r');
    await resolveImagesInTree(root, state.resolveImage);
    return appToHubspotHtml(root.innerHTML, { images: true }) || '<p></p>';
  },
  // `name` ist der Post-Titel, `htmlTitle` der Seitentitel (Browser-Tab,
  // Suchergebnis) — beide gleich, sonst bliebe einer auf dem Stand des
  // Erst-Pushs. Teaser → `postSummary`. `metaDescription` nur, wenn gesetzt —
  // ein leeres Feld ueberschreibt drueben nichts.
  _titleFields(title, teaser, metaDescription) {
    const meta = String(metaDescription || '').trim();
    return {
      name: title, htmlTitle: title,
      ...(teaser ? { postSummary: _escText(teaser) } : {}),
      ...(meta ? { metaDescription: meta } : {}),
    };
  },
  // `slug` nur beim Anlegen: danach gehoert die Adresse HubSpot (eine
  // nachtraegliche Aenderung braeche veroeffentlichte Links).
  create({ client, conn, state, title, body, teaser, metaDescription, slug }) {
    const s = String(slug || '').trim();
    return client.createPost({
      ...hubspotProvider._titleFields(title, teaser, metaDescription),
      postBody: body,
      contentGroupId: conn.blogId,
      blogAuthorId: conn.authorId,
      ...(state.authorName ? { authorName: state.authorName } : {}),
      ...(s ? { slug: s } : {}),
      state: 'DRAFT',
    });
  },
  update({ client, link, title, body, teaser, metaDescription }) {
    return client.updatePostDraft(link.hubspot_post_id, {
      ...hubspotProvider._titleFields(title, teaser, metaDescription),
      postBody: body,
    });
  },
  /**
   * Vor einem Create: gibt es im Blog schon einen unverknuepften DRAFT mit
   * diesem Titel vom konfigurierten Autor? Das ist der Post eines frueheren
   * Pushs, dessen Antwort verloren ging (Timeout), oder eines Abschnitts, dessen
   * Link mit dem Trennen der Verbindung wegfiel. Liefert den Post (dann
   * aktualisieren statt neu anlegen) oder null. Fehler → null (dann legt der
   * Push wie bisher an).
   */
  async findExistingRemote({ client, conn, title, logger = null }) {
    const name = String(title || '').trim();
    if (!name) return null;
    try {
      const hits = await client.findPostsByName({ blogId: conn.blogId, name, state: 'DRAFT' });
      return hits.find(p => String(p.blogAuthorId || conn.authorId) === String(conn.authorId)
        && !hubspot.getLinkByPost(conn.id, p.id)) || null;
    } catch (e) {
      logger?.warn?.(`HubSpot-Push: Suche nach bestehendem Draft "${name}" fehlgeschlagen: ${e.code || e.message}`);
      return null;
    }
  },
  // Link-Form eines gefundenen Posts fuer `update` (push.js, nach findExistingRemote).
  linkFromRemote: (post) => ({ hubspot_post_id: post.id, hubspot_state: post.state || post.currentState || null }),
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

  /** Nach dem Push: Draft-Buffer live schalten bzw. Veroeffentlichung planen.
   *  Status und Live-URL danach vom Post selbst lesen (der Buffer kennt sie
   *  nicht) und am Link nachziehen. */
  async publish({ client, pageId, remote, publish }) {
    const id = remote?.id || hubspot.getLinkByPage(pageId)?.hubspot_post_id;
    if (!id) throw codedError('HUBSPOT_PUBLISH_UNSUPPORTED');
    if (publish.mode === 'schedule') await client.schedule(id, publish.at);
    else await client.publishDraft(id);
    let post = null;
    try { post = await client.getPost(id); } catch { /* Status bleibt bis zum naechsten Abgleich */ }
    hubspot.refreshLinkMeta(pageId, {
      hubspotState: post?.state || post?.currentState || (publish.mode === 'schedule' ? 'SCHEDULED' : 'PUBLISHED'),
      hubspotUrl: post?.url || post?.absoluteUrl || null,
    });
    return post;
  },

  // Bild-Cache beim Abgleich einzeln pruefen (routes/jobs/sync/reconcile.js):
  // nur geloeschte Dateien fliegen raus, statt alles neu hochzuladen.
  mediaOwner: (conn) => ({ hubId: conn.id }),
  async mediaExists(client, entry) {
    if (!entry?.id) return null;
    const file = await client.getFile(entry.id);
    return !(file?.archived || file?.archivedAt);
  },
};

// ── Import ───────────────────────────────────────────────────────────────────

// Wieder-Anschluss: gemeinsame Logik beider Anbieter in lib/sync/relink.js.
// Hier steht nur, was HubSpot liefert (Titel, Tag, App-HTML, Link-Schreiber).
function _relinkKey(post) {
  return { title: postTitle(post), day: postDate(post).slice(0, 10), fallbackName: post.slug || `Post ${post.id}` };
}

/** Bestand fuer einen Import-Lauf; `take(post)` liefert den Abschnitt oder null. */
async function buildRelinkIndex({ bookId }) {
  const index = await buildSharedRelinkIndex({ bookId });
  return { take: (post) => index.take(_relinkKey(post)) };
}

function _relinkPage({ conn, page, post, logger = null }) {
  return relinkPage({
    page, logger, label: `HubSpot: Post ${post.id}`,
    remoteAppHtml: hubspotToAppHtml(post.postBody || ''),
    writeLink: ({ row, conflict }) => {
      hubspot.upsertLink({
        pageId: page.id,
        hubId: conn.id,
        hubspotPostId: post.id,
        hubspotState: post.state || 'PUBLISHED',
        hubspotCreatedAt: post.created || post.createdAt || post.publishDate || null,
        hubspotUpdatedAt: postUpdatedAt(post) || null,
        lastPushedAt: row.updated_at || null,
        hubspotUrl: post.url || post.absoluteUrl || null,
      });
      if (conflict) hubspot.setConflictState(page.id, 'detected');
    },
  });
}

/** HubSpot-Post → Seite + Link (Import), idempotent und race-fest ueber
 *  lib/blog-pull.js#createLinkedPage. Mit `relink` (buildRelinkIndex) wird ein
 *  passender unverknuepfter Abschnitt verknuepft statt neu angelegt. */
async function createLinkedPageFromHubspotPost({ conn, bookId, post, chapterCache, userEmail, logger, relink = null }) {
  if (hubspot.getLinkByPost(conn.id, post.id)) return null;
  const existing = relink ? relink.take(post) : null;
  if (existing) {
    const relinked = await _relinkPage({ conn, page: existing, post, logger });
    if (relinked) return relinked;
  }
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
      // Stempel des importierten Stands: Vorab-Pruefung meldet einen spaeteren
      // Edit in HubSpot als Konflikt.
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
module.exports.buildRelinkIndex = buildRelinkIndex;
module.exports.importErrorI18n = importErrorI18n;
module.exports.isHubspotHosted = isHubspotHosted;
module.exports.postTitle = postTitle;
module.exports.postDate = postDate;
