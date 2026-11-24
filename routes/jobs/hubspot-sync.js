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
// meldet, statt ihn zu ueberschreiben. Hier stehen der Import und der
// Bilder-Nachzug (Posts, die vor dem Bild-Spiegel importiert wurden).

const express = require('express');
const { updateJob, completeJob, failJob, makeJobLogger, i18nError } = require('./shared');
const hubspot = require('../../db/hubspot');
const { seedImportBaseline } = require('../../lib/import-baseline');
const hubspotProvider = require('../../lib/sync/providers/hubspot');
const { relinkToastWarnings } = require('../../lib/sync/relink');
const { createLinkedPageFromHubspotPost, buildRelinkIndex, importErrorI18n, postDate, missingImageCount, structuralLocks, IMAGE_MISSING } = hubspotProvider;
const contentStore = require('../../lib/content-store');
const { headlineUpdatedAt } = require('../../db/headline');
const { latest, newer, syncPoint } = require('../../lib/blog-merge');
const { isNotFound } = require('../../lib/sync/request');
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
        conn, bookId, post, chapterCache, userEmail, logger, relink, signal: abortSignal(jobId),
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

// ── Bilder-Nachzug ──────────────────────────────────────────────────────────
// Posts, die importiert wurden, bevor der Import Bilder spiegelte, tragen im
// Abschnitt keine Bilder; ein Push loeschte sie im Entwurf (darum die Sperre
// `image-missing`). Der Nachzug liest je verknuepftem Abschnitt den Entwurf
// und zieht ihn neu (`applyRemote`: Inhalt + gespiegelte Bilder, Block-IDs
// bleiben) — aber nur, wo es sicher ist:
//   - Abschnitt seit dem Sync-Punkt unveraendert, kein offener Konflikt
//     (Save mit expected_updated_at; ein Save dazwischen gewinnt)
//   - Entwurf seit dem gesehenen Stand unveraendert, sonst Konflikt setzen —
//     der Diff entscheidet (und spiegelt beim Uebernehmen ebenfalls)
//   - nur Abschnitte, denen tatsaechlich Bilder fehlen
// Abschnitte mit lokalen Aenderungen bleiben unangetastet und bekommen die
// Bildsperre, damit kein Push die Bilder loescht. Revision: savePage legt eine
// Baseline an, der alte Stand bleibt wiederherstellbar.
async function runHubspotImageRepairJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    hubspotProvider.requireBook(bookId, userEmail);
    const conn = hubspotProvider.resolveConn(bookId);
    const signal = abortSignal(jobId);
    const client = hubspotProvider.client(conn, signal);
    const links = hubspot.listLinksForConnection(conn.id);
    const repaired = [];
    const skipped = [];
    let images = 0;
    const skip = (pageId, reason) => skipped.push({ pageId, reason });

    for (let i = 0; i < links.length; i++) {
      throwIfAborted(jobId);
      const link = hubspot.getLinkByPage(links[i].page_id);
      updateJob(jobId, {
        statusText: 'job.hubspot.images.progress',
        statusParams: { done: i + 1, total: links.length },
        progress: Math.min(98, 2 + Math.round(((i + 1) / Math.max(1, links.length)) * 95)),
      });
      if (!link) continue;
      const pageId = link.page_id;
      if (link.conflict_state === 'detected') { skip(pageId, 'CONFLICT'); continue; }
      const pageRow = await contentStore.loadPage(pageId).catch(() => null);
      if (!pageRow || Number(pageRow.book_id) !== Number(bookId)) { skip(pageId, 'PAGE_NOT_FOUND'); continue; }
      const html = pageRow.html || pageRow.body_html || '';

      let draft;
      try {
        draft = await client.getPostDraft(link.hubspot_post_id);
      } catch (e) {
        if (signal?.aborted) throw e;
        skip(pageId, isNotFound(e) ? 'REMOTE_GONE' : (e.code || 'HUBSPOT_FETCH_FAILED'));
        continue;
      }
      if (hubspotProvider.isGone(draft)) { skip(pageId, 'REMOTE_GONE'); continue; }
      const missing = missingImageCount(draft.postBody || '', { html, bookId, hubId: conn.id });
      if (!missing) continue;

      const localChanged = newer(latest(pageRow.updated_at, headlineUpdatedAt(pageId)), syncPoint(link));
      const seen = hubspotProvider.linkStamp(link);
      const now = hubspotProvider.remoteStamp(draft);
      if (seen && now && newer(now, seen)) {
        hubspot.setConflictState(pageId, 'detected');
        skip(pageId, 'CONFLICT');
        continue;
      }
      if (localChanged) {
        hubspot.setLockedBlocks(pageId, [...structuralLocks(draft), IMAGE_MISSING]);
        skip(pageId, 'LOCAL_CHANGES');
        continue;
      }
      let applied;
      try {
        applied = await hubspotProvider.applyRemote({
          pageId, bookId, pageRow, remote: draft, userEmail, logger, signal,
          expectedUpdatedAt: pageRow.updated_at, source: 'import',
        });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        if (e?.code === 'PAGE_CONFLICT') { skip(pageId, 'LOCAL_CHANGES'); continue; }
        throw e;
      }
      hubspotProvider.db.markLinkPulled(pageId, draft, applied?.syncedAt || null);
      images += missing;
      repaired.push(pageId);
      logger.info(`HubSpot-Bilder: Page ${pageId} aus Post ${link.hubspot_post_id} neu gezogen (${missing} Bilder fehlten)`);
    }

    const localChanges = skipped.filter(x => x.reason === 'LOCAL_CHANGES').length;
    logger.info(`HubSpot-Bilder: ${repaired.length} Abschnitte nachgezogen, ${skipped.length} übersprungen (${localChanges} mit lokalen Änderungen).`);
    completeJob(jobId, {
      repaired: repaired.length, images, skipped,
      toastWarnings: localChanges > 0 ? [{ key: 'hubspot.images.localChanges', n: localChanges }] : [],
    }, null, `${repaired.length} Abschnitte nachgezogen`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`HubSpot-Bilder-Nachzug-Fehler: ${e.code || e.message}`);
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
  bookExclusive: ['hubspot-import', 'hubspot-images'],
});
mountSyncJobRoute(hubspotSyncRouter, hubspotProvider, {
  type: 'hubspot-images', label: 'job.label.hubspotImages', run: runHubspotImageRepairJob,
  bookExclusive: ['hubspot-import', 'hubspot-images'],
});
mountSyncJobRoute(hubspotSyncRouter, hubspotProvider, {
  type: 'hubspot-reconcile', label: 'job.label.hubspotReconcile', run: runHubspotReconcileJob,
});
mountSyncJobRoute(hubspotSyncRouter, hubspotProvider, {
  type: 'hubspot-push', label: 'job.label.hubspotPushCount', run: runHubspotPushJob, withPages: true,
});

module.exports = { hubspotSyncRouter, runHubspotImportJob, runHubspotImageRepairJob, runHubspotPushJob, runHubspotReconcileJob };
