'use strict';
// Blog-Sync-Jobs (WordPress): einmaliger Initial-Import, manueller Delta-Pull,
// selektiver Push, Abgleich. Mapping 1 Blog == 1 Buch, 1 WP-Post == 1 Page.
// Block-Editor-HTML round-trips via lib/wp-html.js (Gutenberg-Block-Markup).
// Konflikt-Strategie: Timestamp-LWW (docs/blog-sync.md).
//
// Import und Pull sind WordPress-spezifisch und stehen hier. Push, Abgleich und
// die POST-Routen teilen sich beide Blog-Syncs (routes/jobs/sync/, Adapter
// lib/sync/providers/wordpress.js). Import + Pull schreiben Seiten und Links
// eines Buchs und laufen darum pro BUCH exklusiv (nicht pro User).

const express = require('express');
const { updateJob, completeJob, failJob, makeJobLogger } = require('./shared');
const blogs = require('../../db/blogs');
const contentStore = require('../../lib/content-store');
const { classifyPull } = require('../../lib/blog-merge');
const {
  applyPostToPage, createLinkedPageFromPost, postYear,
} = require('../../lib/blog-pull');
const { seedImportBaseline } = require('../../lib/import-baseline');
const { headlineUpdatedAt } = require('../../db/headline');
const { wpLossyBlocks } = require('../../lib/wp-html');
const wordpress = require('../../lib/sync/providers/wordpress');
const { runSyncPushJob, abortSignal, throwIfAborted } = require('./sync/push');
const { runSyncReconcileJob } = require('./sync/reconcile');
const { mountSyncJobRoute, activeBookJob } = require('./sync/routes');

const blogSyncRouter = express.Router();

// Job-Typen, die Seiten + Links eines Buchs anlegen: pro Buch exklusiv.
const BOOK_EXCLUSIVE_TYPES = ['blog-import', 'blog-pull'];

/** Aktiver (queued/running) Import/Pull fuer dieses Buch, egal von wem. */
function _activeBookSyncJob(bookId) {
  return activeBookJob(bookId, BOOK_EXCLUSIVE_TYPES);
}

async function runBlogImportJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    wordpress.requireBook(bookId, userEmail);
    const conn = wordpress.resolveConn(bookId);
    if (conn.initialImportDoneAt) {
      throw Object.assign(new Error('BLOG_ALREADY_IMPORTED'), { code: 'BLOG_ALREADY_IMPORTED' });
    }
    const wp = wordpress.client(conn, abortSignal(jobId));

    updateJob(jobId, { statusText: 'job.blog.import.fetchPage', statusParams: { page: 1 }, progress: 1 });
    const startedAt = new Date().toISOString();
    let page = 1;
    let totalPages = 1;
    let totalCount = 0;
    let imported = 0;
    let skipped = 0;
    const chapterCache = new Map();
    // Zaehlt Quellen-Chips, die ohne `data-src` zurueckkamen (KSES, siehe
    // lib/wp-html.js#_degradeCitesWithoutPointer) und darum zu Klartext wurden.
    const citeStats = {};

    do {
      throwIfAborted(jobId);
      const { posts, totalPages: tp, total } = await wp.listPosts({ page, perPage: 100 });
      totalPages = tp || 1;
      if (page === 1) totalCount = total;

      for (const post of posts) {
        throwIfAborted(jobId);
        // Idempotenz: ein abgebrochener Import hinterlaesst verlinkte Posts ohne
        // `initial_import_done_at`. Der naechste Lauf ueberspringt sie, statt an
        // UNIQUE(blog_id, wp_post_id) zu scheitern (und davor eine verwaiste
        // Seite anzulegen).
        const created = await createLinkedPageFromPost({
          conn, bookId, post, chapterCache, userEmail, citeStats, logger,
          wpModifiedAt: post.modified_gmt || post.date_gmt || '',
        });
        if (!created) {
          skipped++;
          continue;
        }
        logger.info(`Blog-Import: WP-Post ${post.id} -> Page ${created.id} "${created.name}" (Kapitel ${postYear(post)})`);
        imported++;
        updateJob(jobId, {
          statusText: 'job.blog.import.progress',
          statusParams: { done: imported, total: totalCount || imported },
          progress: Math.min(98, Math.round((imported / Math.max(1, totalCount)) * 95) + 1),
        });
      }
      page++;
    } while (page <= totalPages);

    blogs.markInitialImportDone(conn.id);
    blogs.touchPull(conn.id, startedAt);

    // Vortags-Baseline (Donut braucht prevChars vor heute, sonst Schreiben am
    // Import-Tag = 0). Analog folder-import.
    if (imported > 0) await seedImportBaseline(bookId, userEmail, logger, 'Blog-Import');

    if (citeStats.citesDegraded) {
      logger.warn(`Blog-Import: ${citeStats.citesDegraded} Quellenangabe(n) ohne Zeiger — als Klartext uebernommen (WP-Benutzer ohne unfiltered_html?).`);
    }
    logger.info(`Initial-Import: ${imported} Posts importiert, ${skipped} bereits verlinkt.`);
    completeJob(jobId, { imported, skipped, totalCount, citesDegraded: citeStats.citesDegraded || 0 }, null,
      `${imported} Posts importiert`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`Blog-Import-Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

async function runBlogPullJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    wordpress.requireBook(bookId, userEmail);
    const conn = wordpress.resolveConn(bookId);
    if (!conn.initialImportDoneAt) {
      throw Object.assign(new Error('BLOG_IMPORT_FIRST'), { code: 'BLOG_IMPORT_FIRST' });
    }
    const wp = wordpress.client(conn, abortSignal(jobId));

    updateJob(jobId, { statusText: 'job.blog.pull.fetch', progress: 1 });
    const startedAt = new Date().toISOString();

    let page = 1;
    let totalPages = 1;
    let updated = 0;
    let created = 0;
    let conflicts = 0;
    let skipped = 0;
    const renamed = []; // [{ pageId, name }] — Frontend zieht Tree + offenen Titel nach
    const chapterCache = new Map();
    // Siehe runBlogImportJob: Chips, die KSES den Zeiger genommen hat.
    const citeStats = {};

    do {
      throwIfAborted(jobId);
      const { posts, totalPages: tp } = await wp.listPosts({
        page, perPage: 100,
        modifiedAfter: conn.lastPullAt || undefined,
      });
      totalPages = tp || 1;

      for (const post of posts) {
        throwIfAborted(jobId);
        const link = blogs.getLinkByPost(conn.id, post.id);
        const wpModified = post.modified_gmt || post.date_gmt || '';

        if (!link) {
          const createdPage = await createLinkedPageFromPost({
            conn, bookId, post, chapterCache, userEmail, citeStats, logger, wpModifiedAt: wpModified,
          });
          if (!createdPage) {
            skipped++;
            continue;
          }
          logger.info(`Blog-Pull: WP-Post ${post.id} -> Page ${createdPage.id} "${createdPage.name}" neu angelegt`);
          created++;
          continue;
        }

        // Push-Sperre nachfuehren: drueben eine Galerie eingefuegt (oder wieder
        // entfernt) aendert, ob die App den Beitrag schreiben darf.
        blogs.setLockedBlocks(link.page_id, wpLossyBlocks(post?.content?.raw || ''));
        const pageRow = await contentStore.loadPage(link.page_id).catch(() => null);
        if (!pageRow) {
          logger.warn(`Blog-Pull: Page ${link.page_id} (WP-Post ${post.id}) nicht gefunden, uebersprungen`);
          skipped++;
          continue;
        }
        const action = classifyPull({
          hasLink: true,
          wpModifiedAt: wpModified,
          linkModifiedAt: link.wp_modified_at,
          pageUpdatedAt: pageRow.updated_at,
          headlineUpdatedAt: headlineUpdatedAt(link.page_id),
          lastPulledAt: link.last_pulled_at,
          lastPushedAt: link.last_pushed_at,
        });

        if (action === 'conflict') {
          blogs.setConflictState(link.page_id, 'detected');
          logger.info(`Blog-Pull: Page ${link.page_id} "${pageRow.name}" (WP-Post ${post.id}) Konflikt erkannt`);
          conflicts++;
          continue;
        }
        if (action === 'update') {
          let newName;
          let syncedAt;
          try {
            // Stempel, auf dem classifyPull entschieden hat: speichert jemand die
            // Seite dazwischen, wirft savePage 409 statt seine Aenderung zu
            // ueberschreiben — das ist dann ein Konflikt wie oben.
            ({ name: newName, syncedAt } = await applyPostToPage({
              pageId: link.page_id, bookId, pageRow, post, userEmail, citeStats,
              expectedUpdatedAt: pageRow.updated_at,
            }));
          } catch (e) {
            if (e?.code !== 'PAGE_CONFLICT') throw e;
            blogs.setConflictState(link.page_id, 'detected');
            logger.info(`Blog-Pull: Page ${link.page_id} "${pageRow.name}" (WP-Post ${post.id}) waehrend des Pulls lokal geaendert – Konflikt statt Ueberschreiben`);
            conflicts++;
            continue;
          }
          if (newName) renamed.push({ pageId: link.page_id, name: newName });
          blogs.markLinkPulled(link.page_id, {
            wpModifiedAt: wpModified,
            wpStatus: post.status || null,
            wpSlug: post.slug || null,
            pulledAt: syncedAt,
          });
          logger.info(`Blog-Pull: Page ${link.page_id} "${newName || pageRow.name}" aus WP-Post ${post.id} aktualisiert`);
          updated++;
          continue;
        }
        skipped++;
      }
      page++;
    } while (page <= totalPages);

    blogs.touchPull(conn.id, startedAt);
    if (citeStats.citesDegraded) {
      logger.warn(`Blog-Pull: ${citeStats.citesDegraded} Quellenangabe(n) ohne Zeiger — als Klartext uebernommen (WP-Benutzer ohne unfiltered_html?).`);
    }
    logger.info(`Pull: ${updated} aktualisiert, ${created} neu, ${conflicts} Konflikt, ${skipped} unverändert.`);
    completeJob(jobId, { updated, created, conflicts, skipped, renamed, citesDegraded: citeStats.citesDegraded || 0 }, null,
      `${updated} aktualisiert / ${created} neu / ${conflicts} Konflikt`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`Blog-Pull-Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

function runBlogPushJob(jobId, bookId, userEmail, pageIds) {
  return runSyncPushJob(wordpress, jobId, bookId, userEmail, pageIds);
}

function runBlogReconcileJob(jobId, bookId, userEmail) {
  return runSyncReconcileJob(wordpress, jobId, bookId, userEmail);
}

mountSyncJobRoute(blogSyncRouter, wordpress, {
  type: 'blog-import', label: 'job.label.blogImport', run: runBlogImportJob, bookExclusive: BOOK_EXCLUSIVE_TYPES,
});
mountSyncJobRoute(blogSyncRouter, wordpress, {
  type: 'blog-pull', label: 'job.label.blogPull', run: runBlogPullJob, bookExclusive: BOOK_EXCLUSIVE_TYPES,
});
mountSyncJobRoute(blogSyncRouter, wordpress, {
  type: 'blog-reconcile', label: 'job.label.blogReconcile', run: runBlogReconcileJob,
});
mountSyncJobRoute(blogSyncRouter, wordpress, {
  type: 'blog-push', label: 'job.label.blogPushCount', run: runBlogPushJob, withPages: true,
});

module.exports = { blogSyncRouter, runBlogImportJob, runBlogPullJob, runBlogPushJob, runBlogReconcileJob, _activeBookSyncJob };
