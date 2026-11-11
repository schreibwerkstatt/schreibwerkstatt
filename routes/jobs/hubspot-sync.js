'use strict';
// HubSpot-Sync-Jobs: Import (alle PUBLISHED-Posts des konfigurierten Autors +
// Blogs in Jahres-Kapitel; wiederholbar, holt neue Posts nach), selektiver
// Push, Abgleich.
// Mapping 1 Buch == 1 Blog, 1 Post == 1 Page.
//
// Push, Abgleich und die POST-Routen teilen sich beide Blog-Syncs
// (routes/jobs/sync/, Adapter lib/sync/providers/hubspot.js): Erst-Push legt
// einen DRAFT-Post an, Re-Push aktualisiert den Draft-Buffer — nach einer
// Vorab-Pruefung gegen diesen Buffer, die einen Edit in HubSpot als Konflikt
// meldet, statt ihn zu ueberschreiben. Hier steht nur der Import.

const express = require('express');
const { updateJob, completeJob, failJob, makeJobLogger, i18nError } = require('./shared');
const hubspot = require('../../db/hubspot');
const { seedImportBaseline } = require('../../lib/import-baseline');
const hubspotProvider = require('../../lib/sync/providers/hubspot');
const { relinkToastWarnings } = require('../../lib/sync/relink');
const { createLinkedPageFromHubspotPost, buildRelinkIndex, importErrorI18n, postDate } = hubspotProvider;
const { runSyncPushJob, abortSignal, throwIfAborted } = require('./sync/push');
const { runSyncReconcileJob } = require('./sync/reconcile');
const { mountSyncJobRoute } = require('./sync/routes');

const hubspotSyncRouter = express.Router();

async function runHubspotImportJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    hubspotProvider.requireBook(bookId, userEmail);
    const conn = hubspotProvider.resolveConn(bookId);
    const client = hubspotProvider.client(conn, abortSignal(jobId));

    updateJob(jobId, { statusText: 'job.hubspot.import.fetch', progress: 1 });

    // Alle veroeffentlichten Posts des Blogs puffern, dann aufsteigend nach
    // Datum sortieren. HubSpot liefert newest-first; ungesteuert laegen
    // Jahres-Kapitel und Seiten reverse-chronologisch. Autor und Status prueft
    // der Job selbst (die Filter-Parameter gehen nur als Vorauswahl mit) — so
    // laesst sich zaehlen, was ein anderer Autor geschrieben hat.
    const posts = [];
    let otherAuthor = 0;
    for await (const post of client.iteratePosts({ blogId: conn.blogId, state: 'PUBLISHED' })) {
      throwIfAborted(jobId);
      const state = String(post?.state || post?.currentState || 'PUBLISHED');
      if (state !== 'PUBLISHED') continue;
      if (post.blogAuthorId != null && String(post.blogAuthorId) !== String(conn.authorId)) {
        otherAuthor++;
        continue;
      }
      posts.push(post);
    }
    posts.sort((a, b) => postDate(a).localeCompare(postDate(b)));

    // Wiederholbar: verknuepfte Posts ueberspringt der Import, unverknuepfte
    // Abschnitte gleichen Namens (nach Trennen/Zielwechsel) werden wieder
    // verknuepft statt doppelt angelegt.
    const relink = await buildRelinkIndex({ conn, bookId });
    let imported = 0;
    let skipped = 0;
    let relinked = 0;
    let relinkConflicts = 0;
    const chapterCache = new Map();
    for (let i = 0; i < posts.length; i++) {
      throwIfAborted(jobId);
      const post = posts[i];
      const created = await createLinkedPageFromHubspotPost({
        conn, bookId, post, chapterCache, userEmail, logger, relink,
      });
      if (!created) {
        skipped++;
      } else if (created.relinked) {
        relinked++;
        if (created.conflict) relinkConflicts++;
        logger.info(`HubSpot-Import: Post ${post.id} -> bestehende Page ${created.id} "${created.name}" wieder verknuepft${created.conflict ? ' (Konflikt: Text weicht ab)' : ''}`);
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

    logger.info(`HubSpot-Import: ${imported} importiert, ${relinked} wieder verknuepft (${relinkConflicts} Konflikt), ${skipped} bereits verknuepft, ${otherAuthor} von anderem Autor.`);
    completeJob(jobId, {
      imported, skipped, relinked, relinkConflicts, otherAuthor, totalCount: posts.length,
      // Beitraege anderer Autoren bleiben draussen (das Buch ist das Archiv des
      // eingestellten Autors) — der Toast sagt aber, dass es sie gibt.
      toastWarnings: [
        ...relinkToastWarnings(relinkConflicts),
        ...(otherAuthor > 0 ? [{ key: 'hubspot.import.otherAuthor', n: otherAuthor }] : []),
      ],
    }, null, `${imported} Posts importiert`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`HubSpot-Import-Fehler: ${e.code || e.message}`);
    // Fehlertext als i18n-Key (hubspot.error.<CODE>), nicht als roher Code.
    if (e.name === 'AbortError' || !e.code) failJob(jobId, e);
    else {
      const { key, params } = importErrorI18n(e.code);
      const err = i18nError(key, params);
      err.code = e.code;
      failJob(jobId, err);
    }
  }
}

function runHubspotPushJob(jobId, bookId, userEmail, pageIds, publish = null) {
  return runSyncPushJob(hubspotProvider, jobId, bookId, userEmail, pageIds, publish);
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
