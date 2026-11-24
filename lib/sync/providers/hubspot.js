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
//   - Bilder: Import und „HubSpot uebernehmen" spiegeln sie als Abschnittsbilder
//     (lib/sync/image-mirror.js); der Bild-Cache merkt sich die Original-Adresse,
//     ein Push setzt sie wieder ein.
//   - Push-Sperre (`locked_blocks`): der Entwurf traegt etwas, das die App nicht
//     uebernimmt (CTA, Formular, Embed, HubL-Modul — hubspotLossyParts), oder
//     ein Bild, das im Abschnitt fehlt. Ein Push loeschte es im Entwurf.

const hubspot = require('../../../db/hubspot');
const contentStore = require('../../content-store');
const { createHubspotClient, postUpdatedAt } = require('../../hubspot-client');
const { hubspotToAppHtml, appToHubspotHtml, hubspotLossyParts, hubspotImageSrcs } = require('../../hubspot-html');
const { mirrorRemoteImages, appImageRemoteMap, remoteImageKey } = require('../image-mirror');
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

// Bild-Cache einer Verbindung als `{ get, put }` (Push-Resolver und Spiegel).
function _mediaCache(hubId) {
  const owner = { hubId };
  return { get: (k) => getCachedMedia(owner, k), put: (k, v) => putCachedMedia(owner, k, v) };
}

/** Kennung der Sperre „Bild fehlt im Abschnitt" (Frontend: sync.locked.image_missing). */
const IMAGE_MISSING = 'image-missing';

/**
 * Bilder des Entwurfs, die der Abschnitt nicht traegt (weder als beim Ziel
 * gehostete Adresse noch als gespiegeltes Abschnittsbild mit Cache-Eintrag).
 * Ein Push ersetzte den Body und loeschte sie im Post. Typischer Fall: ein vor
 * dem Bild-Spiegel importierter Post (Bilder-Nachzug behebt das).
 */
function missingImageCount(postBody, { html, bookId, hubId }) {
  const remote = hubspotImageSrcs(postBody);
  if (!remote.length) return 0;
  const cache = _mediaCache(hubId);
  const local = appImageRemoteMap(html || '', { bookId, cacheGet: cache.get });
  return remote.filter(src => !local.has(remoteImageKey(src))).length;
}

/** Strukturelle Sperre aus einem Post-Body (ohne Bildabgleich). */
function structuralLocks(post) {
  return hubspotLossyParts(post?.postBody || '');
}

/** Sperre am Link nachziehen; `keepImageLock`: Bildabgleich wurde nicht neu
 *  gerechnet (Abgleich liest nur den Post), eine bestehende Bildsperre bleibt. */
function _writeLocks(pageId, parts, { keepImageLock = false } = {}) {
  const list = [...parts];
  if (keepImageLock) {
    const prev = String(hubspot.getLinkByPage(pageId)?.locked_blocks || '');
    if (prev.split(/\s*,\s*/).includes(IMAGE_MISSING)) list.push(IMAGE_MISSING);
  }
  hubspot.setLockedBlocks(pageId, list);
}

/** Bilder eines zurueckgelesenen Stands in den Abschnitt spiegeln. */
async function _mirror({ html, pageId, bookId, hubId, previousHtml = '', signal = null, logger = null }) {
  return mirrorRemoteImages({
    html, pageId, bookId, previousHtml, signal, logger,
    cache: _mediaCache(hubId), logTag: 'HubSpot-Bilder',
  });
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
    'HUBSPOT_UNSUPPORTED_BLOCKS',
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
    // Nach „HubSpot uebernehmen" traegt der Abschnitt die Bilder des Entwurfs
    // (gespiegelt bzw. mit Original-Adresse) — nur die strukturelle Sperre bleibt.
    markLinkPulled: (pageId, remote, syncedAt = null) => {
      hubspot.markLinkPulled(pageId, { remoteUpdatedAt: postUpdatedAt(remote), pulledAt: syncedAt });
      _writeLocks(pageId, structuralLocks(remote));
    },
    // Abgleich liest den Post, nicht den Abschnitt: Bildsperre unveraendert lassen.
    refreshLinkMeta: (pageId, remote) => {
      _writeLocks(pageId, structuralLocks(remote), { keepImageLock: true });
      return hubspot.refreshLinkMeta(pageId, {
        hubspotState: remote.state || remote.currentState || null,
        hubspotUrl: remote.url || remote.absoluteUrl || null,
      });
    },
    setLockedParts: (pageId, parts) => hubspot.setLockedBlocks(pageId, parts),
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
  // Was ein Push im Entwurf loeschte: Strukturelles (hubspotLossyParts) und
  // Bilder, die im Abschnitt fehlen (nur mit `html`, also in der Vorab-Pruefung).
  async lossyParts(post, { html = null, bookId = null, pageId = null } = {}) {
    const parts = structuralLocks(post);
    if (html != null && bookId) {
      const link = pageId ? hubspot.getLinkByPage(pageId) : null;
      if (link && missingImageCount(post?.postBody || '', { html, bookId, hubId: link.hub_id }) > 0) {
        parts.push(IMAGE_MISSING);
      }
    }
    return parts;
  },
  // Konflikt-Diff: was „HubSpot uebernehmen" schreiben wuerde. Bilder, die der
  // Abschnitt schon traegt, zeigt der Diff mit ihrer lokalen Adresse (die CSP
  // laesst das HubSpot-CDN nicht zu); neue behalten die Ziel-Adresse.
  async remoteView(draft, { pageHtml = '', bookId = null, hubId = null } = {}) {
    let html = hubspotToAppHtml(draft.postBody || '', { images: true });
    if (hubId && bookId && html.indexOf('<img') !== -1) {
      const known = appImageRemoteMap(pageHtml, { bookId, cacheGet: _mediaCache(hubId).get });
      html = html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (m, a, src, b) => {
        const local = known.get(remoteImageKey(src.replace(/&amp;/g, '&')));
        return local ? `${a}${local}${b}` : m;
      });
    }
    return { title: postTitle(draft), html, modifiedAt: postUpdatedAt(draft) };
  },
  // „HubSpot uebernehmen": Body durch die Import-Allowlist ohne die Push-
  // Zusaetze (Lead → Titel-Werkstatt, Verzeichnis entfaellt), Block-IDs des
  // bisherigen Stands mitnehmen (Querverweise, Kommentar-Anker), Titel nach
  // der gemeinsamen Regel (lib/blog-title.js).
  async applyRemote({ pageId, bookId, pageRow, remote, userEmail, expectedUpdatedAt = null, source = null, logger = null, signal = null }) {
    const hl = getHeadline(pageId);
    const plan = planPulledTitle({
      currentName: pageRow?.name || '', hl, remoteTitle: postTitle(remote), postDay: postDate(remote).slice(0, 10),
    });
    const stats = {};
    const raw = hubspotToAppHtml(remote.postBody || '', {
      stats, lead: hl?.lead || '', bibTitle: await _bibTitle(bookId, pageId, userEmail), images: true,
    }) || '<p></p>';
    const link = hubspot.getLinkByPage(pageId);
    const previousHtml = pageRow?.html || pageRow?.body_html || '';
    const { html } = link
      ? await _mirror({ html: raw, pageId, bookId, hubId: link.hub_id, previousHtml, signal, logger })
      : { html: raw };
    const patch = { ...plan.headlinePatch };
    if (stats.lead !== undefined && stats.lead !== String(hl?.lead || '').trim()) patch.lead = stats.lead;
    const saved = await contentStore.savePage(pageId, {
      html: carryBlockIds(previousHtml, html),
      ...(plan.name ? { name: plan.name } : {}),
      ...(expectedUpdatedAt ? { expected_updated_at: expectedUpdatedAt } : {}),
      ...(source ? { source } : {}),
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
    const resolveImage = makeImageResolver({
      bookId, signal, logger, logTag: 'HubSpot-Media',
      cache: _mediaCache(conn.id),
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
      _writeLocks(page.id, structuralLocks(post));
    },
  });
}

/** HubSpot-Post → Seite + Link (Import), idempotent und race-fest ueber
 *  lib/blog-pull.js#createLinkedPage. Mit `relink` (buildRelinkIndex) wird ein
 *  passender unverknuepfter Abschnitt verknuepft statt neu angelegt. */
async function createLinkedPageFromHubspotPost({ conn, bookId, post, chapterCache, userEmail, logger, relink = null, signal = null }) {
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
      const html = hubspotToAppHtml(post.postBody || '', { images: true }) || '<p></p>';
      // Ohne Bild direkt anlegen; mit Bild erst ohne Bilder anlegen (das
      // Abschnittsbild braucht die page_id), dann gespiegelt speichern.
      const hasImages = html.indexOf('<img') !== -1;
      const created = await contentStore.createPage({
        book_id: bookId, chapter_id: chapterId, name,
        html: hasImages ? (hubspotToAppHtml(post.postBody || '') || '<p></p>') : html,
      }, null);
      if (!hasImages || !created?.id) return { ...created, name };
      try {
        const m = await _mirror({ html, pageId: created.id, bookId, hubId: conn.id, logger, signal });
        const saved = await contentStore.savePage(created.id, { html: m.html, source: 'import' }, null);
        if (m.mirrored || m.failed) logger?.info?.(`HubSpot-Import: Post ${post.id} — ${m.mirrored} Bilder übernommen, ${m.failed} nicht ladbar`);
        return { ...created, ...(saved || {}), id: created.id, name };
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        logger?.warn?.(`HubSpot-Import: Bilder für Post ${post.id} nicht übernommen: ${e.message}`);
        return { ...created, name };
      }
    },
    link: (created) => {
      hubspot.upsertLink({
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
      });
      // Push-Sperre gleich beim Anlegen merken (Badge vor dem ersten Push).
      _writeLocks(created.id, structuralLocks(post));
    },
  });
}

module.exports = hubspotProvider;
module.exports.createLinkedPageFromHubspotPost = createLinkedPageFromHubspotPost;
module.exports.buildRelinkIndex = buildRelinkIndex;
module.exports.importErrorI18n = importErrorI18n;
module.exports.isHubspotHosted = isHubspotHosted;
module.exports.postTitle = postTitle;
module.exports.postDate = postDate;
module.exports.missingImageCount = missingImageCount;
module.exports.structuralLocks = structuralLocks;
module.exports.IMAGE_MISSING = IMAGE_MISSING;
