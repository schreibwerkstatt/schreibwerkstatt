'use strict';
// HubSpot-Sync-Jobs: einmaliger Initial-Import (alle PUBLISHED-Posts des
// konfigurierten Autors + Blogs in Jahres-Kapitel), selektiver Push, Abgleich.
// Mapping 1 Buch == 1 Blog, 1 Post == 1 Page.
//
// Push, Abgleich und die POST-Routen teilen sich beide Blog-Syncs
// (routes/jobs/sync/, Adapter lib/sync/providers/hubspot.js): Erst-Push legt
// einen DRAFT-Post an, Re-Push aktualisiert den Draft-Buffer — nach einer
// Vorab-Pruefung gegen diesen Buffer, die einen Edit in HubSpot als Konflikt
// meldet, statt ihn zu ueberschreiben. Hier steht nur der Import.

const express = require('express');
const { updateJob, completeJob, failJob, makeJobLogger } = require('./shared');
const hubspot = require('../../db/hubspot');
const { seedImportBaseline } = require('../../lib/import-baseline');
const { codedError } = require('../../lib/sync/request');
const hubspotProvider = require('../../lib/sync/providers/hubspot');
const { createLinkedPageFromHubspotPost, postDate } = hubspotProvider;
const { runSyncPushJob, abortSignal, throwIfAborted } = require('./sync/push');
const { runSyncReconcileJob } = require('./sync/reconcile');
const { mountSyncJobRoute } = require('./sync/routes');

const hubspotSyncRouter = express.Router();

async function runHubspotImportJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    hubspotProvider.requireBook(bookId, userEmail);
    const conn = hubspotProvider.resolveConn(bookId);
    if (conn.initialImportDoneAt) throw codedError('HUBSPOT_ALREADY_IMPORTED');
    const client = hubspotProvider.client(conn, abortSignal(jobId));

    updateJob(jobId, { statusText: 'job.hubspot.import.fetch', progress: 1 });

    // Alle Posts puffern, dann aufsteigend nach Datum sortieren. HubSpot liefert
    // newest-first; ungesteuert laegen Jahres-Kapitel und Seiten
    // reverse-chronologisch.
    const posts = [];
    for await (const post of client.iteratePosts({
      authorId: conn.authorId,
      blogId: conn.blogId,
      state: 'PUBLISHED',
    })) {
      throwIfAborted(jobId);
      posts.push(post);
    }
    posts.sort((a, b) => postDate(a).localeCompare(postDate(b)));

    let imported = 0;
    let skipped = 0;
    const chapterCache = new Map();
    for (let i = 0; i < posts.length; i++) {
      throwIfAborted(jobId);
      const post = posts[i];
      const created = await createLinkedPageFromHubspotPost({
        conn, bookId, post, chapterCache, userEmail, logger,
      });
      if (!created) {
        logger.info(`HubSpot-Import: Post ${post.id} bereits verlinkt, skip`);
        skipped++;
      } else {
        logger.info(`HubSpot-Import: Post ${post.id} -> Page ${created.id} "${created.name}"`);
        imported++;
      }
      updateJob(jobId, {
        statusText: 'job.hubspot.import.progress',
        statusParams: { done: i + 1, total: posts.length },
        progress: Math.min(98, 2 + Math.round(((i + 1) / posts.length) * 95)),
      });
    }

    hubspot.markInitialImportDone(conn.id);
    if (imported > 0) await seedImportBaseline(bookId, userEmail, logger, 'HubSpot-Import');

    logger.info(`HubSpot-Initial-Import: ${imported} importiert, ${skipped} bereits verlinkt.`);
    completeJob(jobId, { imported, skipped, totalCount: posts.length }, null, `${imported} Posts importiert`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`HubSpot-Import-Fehler: ${e.code || e.message}`);
    failJob(jobId, e);
  }
}

function runHubspotPushJob(jobId, bookId, userEmail, pageIds) {
  return runSyncPushJob(hubspotProvider, jobId, bookId, userEmail, pageIds);
}

function runHubspotReconcileJob(jobId, bookId, userEmail) {
  return runSyncReconcileJob(hubspotProvider, jobId, bookId, userEmail);
}

mountSyncJobRoute(hubspotSyncRouter, hubspotProvider, {
  type: 'hubspot-import', label: 'job.label.hubspotImport', run: runHubspotImportJob,
  bookExclusive: ['hubspot-import'],
});
mountSyncJobRoute(hubspotSyncRouter, hubspotProvider, {
  type: 'hubspot-reconcile', label: 'job.label.hubspotReconcile', run: runHubspotReconcileJob,
});
mountSyncJobRoute(hubspotSyncRouter, hubspotProvider, {
  type: 'hubspot-push', label: 'job.label.hubspotPushCount', run: runHubspotPushJob, withPages: true,
});

module.exports = { hubspotSyncRouter, runHubspotImportJob, runHubspotPushJob, runHubspotReconcileJob };
