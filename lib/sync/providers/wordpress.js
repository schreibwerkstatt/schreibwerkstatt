'use strict';
// Sync-Adapter WordPress. Die generischen Teile — Push-Schleife, Abgleich,
// Job-Routen, /status|/links|/remote|/resolve — liegen in lib/sync/,
// routes/jobs/sync/ und routes/sync-router.js; hier steht nur, was WordPress
// anders macht. Vertrag der Adapter: routes/jobs/sync/push.js (Kopfkommentar).

const blogs = require('../../../db/blogs');
const { createWpClient } = require('../../wp-client');
const { appToWpHtmlWithMedia, wpToAppHtml, wpLossyBlocks } = require('../../wp-html');
const { makeImageResolver } = require('../../wp-media');
const { applyPostToPage } = require('../../blog-pull');
const { wpTitleText } = require('../../blog-title');
const { assertBlogBook } = require('../../buchtyp');
const { codedError } = require('../request');
const { getCachedMedia, putCachedMedia, clearCachedMedia } = require('../../../db/sync-media-cache');

function remoteStamp(post) {
  return String(post?.modified_gmt || post?.date_gmt || '');
}

const wordpress = {
  key: 'blog',
  prefix: 'BLOG',
  logTag: 'Blog',
  remoteLabel: 'WP-Post',
  jobTypes: { import: 'blog-import', pull: 'blog-pull', push: 'blog-push', reconcile: 'blog-reconcile' },
  // Fehlercodes des Push mit eigenem `blog.error.*`-Text; alle anderen
  // erscheinen als BLOG_PUSH_FAILED.
  pushErrorKeys: [
    'BLOG_CONFLICT', 'BLOG_REMOTE_GONE', 'BLOG_AUTH_FAILED', 'BLOG_FORBIDDEN', 'BLOG_UNSUPPORTED_BLOCKS',
    'BLOG_RATE_LIMIT', 'BLOG_UPSTREAM', 'BLOG_TIMEOUT', 'BLOG_FETCH_FAILED', 'BLOG_PUSH_FAILED',
    'BLOG_REDIRECT', 'BLOG_PUBLISH_INVALID', 'BLOG_PUBLISH_UNSUPPORTED',
  ],

  requireBook(bookId, userEmail) {
    return assertBlogBook(bookId, userEmail, 'BLOG_REQUIRES_BLOG_TYPE');
  },
  resolveConn(bookId) {
    const conn = blogs.getConnection(bookId);
    if (!conn) throw codedError('BLOG_NOT_CONNECTED');
    return conn;
  },
  client(conn, signal = null) {
    return createWpClient({
      baseUrl: conn.baseUrl, username: conn.username, password: conn.password, signal,
    });
  },

  // ── Links ────────────────────────────────────────────────────────────────
  db: {
    clearMediaCache: (connId) => clearCachedMedia({ blogId: connId }),
    getConnection: blogs.getConnection,
    getConnectionPublic: blogs.getConnectionPublic,
    deleteConnection: blogs.deleteConnection,
    listLinks: blogs.listLinksForBlog,
    getLinkByPage: blogs.getLinkByPage,
    deleteLink: blogs.deleteLink,
    setConflictState: blogs.setConflictState,
    markConflictResolvedApp: blogs.markConflictResolvedApp,
    markLinkPulled: (pageId, remote, pulledAt = null) => {
      blogs.markLinkPulled(pageId, {
        wpModifiedAt: remoteStamp(remote), wpStatus: remote.status || null, wpSlug: remote.slug || null, pulledAt,
      });
      blogs.setLockedBlocks(pageId, wpLossyBlocks(remote?.content?.raw || ''));
    },
    // Abgleich: Status/Slug und die Push-Sperre nachziehen.
    refreshLinkMeta: (pageId, remote) => {
      blogs.setLockedBlocks(pageId, wpLossyBlocks(remote?.content?.raw || ''));
      return blogs.refreshLinkMeta(pageId, { wpStatus: remote.status || null, wpSlug: remote.slug || null });
    },
    setLockedParts: blogs.setLockedBlocks,
  },
  linkConnId: (link) => link.blog_id,
  remoteId: (link) => link.wp_post_id,
  linkStamp: (link) => link.wp_modified_at,
  remoteStamp,

  // ── Remote lesen ─────────────────────────────────────────────────────────
  fetchRemote: (client, link) => client.getPost(link.wp_post_id),
  // Im Papierkorb heisst in WordPress: weg. Die REST-API liefert den Post mit
  // context=edit weiter aus — ohne diese Pruefung fiele er nie als verwaist auf.
  isGone: (post) => post?.status === 'trash',
  // Was der Import nicht uebernimmt, loeschte ein Push im Live-Blog (siehe
  // lib/wp-html.js#wpLossyBlocks).
  lossyParts: (post) => wpLossyBlocks(post?.content?.raw || ''),
  async remoteView(post) {
    let baseUrl = null;
    try { baseUrl = post?.link ? new URL(post.link).origin : null; } catch { /* ohne Permalink */ }
    return {
      title: wpTitleText(post.title),
      // Dieselbe Umsetzung wie der Pull (Classic-Absaetze, relative Bilder):
      // der Diff zeigt, was „WordPress uebernehmen" schreiben wuerde.
      html: await wpToAppHtml((post.content && (post.content.raw || post.content.rendered)) || '', null, { baseUrl }),
      modifiedAt: remoteStamp(post),
    };
  },
  async applyRemote({ pageId, bookId, pageRow, remote, userEmail }) {
    return applyPostToPage({ pageId, bookId, pageRow, post: remote, userEmail });
  },
  async linksMeta(conn) {
    return { baseUrl: conn.baseUrl };
  },

  // ── Push ─────────────────────────────────────────────────────────────────
  preparePush({ conn, client, bookId, signal, logger }) {
    let blogOrigin = '';
    try { blogOrigin = new URL(conn.baseUrl).origin; } catch { /* validiert beim Connect */ }
    // Mediathek-Cache je Verbindung: ein Bild, das schon hochgeladen ist, wird
    // nicht bei jedem Push erneut hochgeladen (db/sync-media-cache.js).
    const owner = { blogId: conn.id };
    const cache = { get: (k) => getCachedMedia(owner, k), put: (k, v) => putCachedMedia(owner, k, v) };
    return { resolveImage: makeImageResolver({ wp: client, blogOrigin, bookId, cache, signal, logger }) };
  },
  // Lead als markierter erster Block, Verzeichnis als markierter Anhang — beides
  // holt der Pull wieder heraus (lib/wp-html.js). Nur bei aktiviertem Blog-Anhang.
  render({ appHtml, bib, hl, state }) {
    const lead = String(hl?.lead || '').trim();
    return appToWpHtmlWithMedia(appHtml, {
      resolveImage: state.resolveImage,
      bibliography: bib.inBlog ? bib : null,
      lead: lead || null,
    });
  },
  // Titel geht bei Create UND Update mit (eine Umbenennung in der App soll
  // ankommen; ein drueben geaenderter Titel faellt vorher als Konflikt auf).
  // Teaser → excerpt (Theme-Anrisstext; SEO-Plugins nehmen ihn als Meta-
  // Description, wenn keine eigene gesetzt ist), nur wenn gesetzt. `slug` nur
  // beim Anlegen: eine spaetere Aenderung braeche veroeffentlichte Links.
  create({ client, conn, title, body, teaser, slug }) {
    return client.createPost({
      title, content: body, status: conn.defaultStatus,
      ...(teaser ? { excerpt: teaser } : {}),
      ...(slug ? { slug } : {}),
    });
  },
  update({ client, link, title, body, teaser }) {
    return client.updatePost(link.wp_post_id, {
      content: body,
      ...(title ? { title } : {}),
      ...(teaser ? { excerpt: teaser } : {}),
    });
  },
  // `pushedAt`: Sync-Punkt aus der Push-Schleife (vor dem Lesen der Seite).
  linkAfterPush({ pageId, conn, remote, pushedAt }) {
    blogs.upsertLink({
      pageId,
      blogId: conn.id,
      wpPostId: remote.id,
      wpModifiedAt: remoteStamp(remote),
      wpStatus: remote.status || null,
      wpSlug: remote.slug || null,
      lastPushedAt: pushedAt || new Date().toISOString(),
    });
  },
  touchPush: (conn) => blogs.touchPush(conn.id),

  /** Nach dem Push veroeffentlichen (`status: publish`) oder planen
   *  (`status: future` + `date_gmt`). WordPress aendert dabei `modified_gmt`:
   *  der neue Stempel wird der gesehene Stand, sonst meldete der naechste Push
   *  den eigenen Statuswechsel als Konflikt. */
  async publish({ client, pageId, remote, publish }) {
    const id = remote?.id || blogs.getLinkByPage(pageId)?.wp_post_id;
    if (!id) throw codedError('BLOG_PUBLISH_UNSUPPORTED');
    const payload = publish.mode === 'schedule'
      ? { status: 'future', date_gmt: String(publish.at).replace(/\.\d{3}Z$|Z$/, '') }
      : { status: 'publish' };
    const post = await client.updatePost(id, payload);
    blogs.markLinkPublished(pageId, {
      wpStatus: post?.status || payload.status,
      wpSlug: post?.slug || null,
      wpModifiedAt: remoteStamp(post) || null,
    });
    return post;
  },

  // Bild-Cache beim Abgleich einzeln pruefen (routes/jobs/sync/reconcile.js).
  mediaOwner: (conn) => ({ blogId: conn.id }),
  async mediaExists(client, entry) {
    if (!entry?.id) return null;
    const media = await client.getMedia(entry.id);
    return media?.status !== 'trash';
  },
};

module.exports = wordpress;
