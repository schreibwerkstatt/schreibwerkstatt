'use strict';
// Abgleich-Job beider Blog-Syncs: prueft jeden Link gegen den Remote.
//   404 / Papierkorb / archiviert → Link weg (Abschnitt bleibt; Badge „neu",
//                                   der naechste Push legt einen neuen Post an)
//   lebt                          → Status/URL nachziehen (z.B. drueben publiziert)
//   anderer Fehler                → nur geloggt, Link bleibt
// Deckt Hard-Delete und Papierkorb drueben — beides taucht in keinem Delta auf.
// Danach ist der Bild-Cache der Verbindung leer (db/sync-media-cache.js): ein
// drueben geloeschtes Bild faellt sonst nie auf, der Push setzte weiter die tote
// Adresse ein. Der naechste Push laedt die Bilder einmal neu hoch.

const { updateJob, completeJob, failJob, makeJobLogger } = require('../shared');
const { isNotFound } = require('../../../lib/sync/request');
const { abortSignal, throwIfAborted } = require('./push');

async function runSyncReconcileJob(provider, jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  const tag = `${provider.logTag}-Abgleich`;
  try {
    provider.requireBook(bookId, userEmail);
    const conn = provider.resolveConn(bookId);
    const client = provider.client(conn, abortSignal(jobId));

    const links = provider.db.listLinks(conn.id);
    const total = links.length;
    let checked = 0;
    let removed = 0;
    let refreshed = 0;
    updateJob(jobId, {
      statusText: `job.${provider.key}.reconcile.check`,
      statusParams: { current: 0, total },
      progress: 1,
    });

    for (const link of links) {
      throwIfAborted(jobId);
      checked++;
      const ref = `Page ${link.page_id} -> ${provider.remoteLabel} ${provider.remoteId(link)}`;
      try {
        const remote = await provider.fetchRemote(client, link, 'reconcile');
        if (provider.isGone(remote)) {
          provider.db.deleteLink(link.page_id);
          removed++;
          logger.info(`${tag}: ${ref} im Papierkorb/archiviert, Link entfernt`);
        } else if (provider.db.refreshLinkMeta(link.page_id, remote)) {
          refreshed++;
        }
      } catch (e) {
        if (isNotFound(e)) {
          provider.db.deleteLink(link.page_id);
          removed++;
          logger.info(`${tag}: ${ref} weg, Link entfernt`);
        } else {
          logger.warn(`${tag}: ${ref} Fehler ${e.code || e.message}`);
        }
      }
      updateJob(jobId, {
        statusText: `job.${provider.key}.reconcile.check`,
        statusParams: { current: checked, total },
        progress: Math.min(98, 2 + Math.round((checked / Math.max(1, total)) * 95)),
      });
    }

    const mediaCleared = provider.db.clearMediaCache ? provider.db.clearMediaCache(conn.id) : 0;
    logger.info(`${tag}: ${checked} geprüft, ${removed} verwaiste Links entfernt, ${mediaCleared} Bild-Cache-Eintraege verworfen.`);
    completeJob(jobId, { checked, removed, refreshed }, null, `${removed} verwaiste Links entfernt`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`${tag}-Fehler: ${e.code || e.message}`);
    failJob(jobId, e);
  }
}

module.exports = { runSyncReconcileJob };
