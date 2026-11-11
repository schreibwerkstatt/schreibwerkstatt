'use strict';
// Abgleich-Job beider Blog-Syncs: prueft jeden Link gegen den Remote.
//   404 / Papierkorb / archiviert → Link weg (Abschnitt bleibt; Badge „neu",
//                                   der naechste Push legt einen neuen Post an)
//   lebt                          → Status/URL nachziehen (z.B. drueben publiziert)
//   anderer Fehler                → nur geloggt, Link bleibt
// Deckt Hard-Delete und Papierkorb drueben — beides taucht in keinem Delta auf.
// Danach der Bild-Cache der Verbindung (db/sync-media-cache.js): ein drueben
// geloeschtes Bild faellt sonst nie auf, der Push setzte weiter die tote Adresse
// ein. Kann der Anbieter ein Medium einzeln pruefen (`mediaExists`), fliegen nur
// die toten Eintraege raus — den ganzen Cache zu verwerfen, liesse den naechsten
// Push JEDES Bild noch einmal hochladen (Dubletten in der Mediathek). Ohne
// Einzelpruefung, oder wenn sie scheitert, bleibt nur das Verwerfen.

const { updateJob, completeJob, failJob, makeJobLogger, i18nError } = require('../shared');
const { isNotFound } = require('../../../lib/sync/request');
const { abortSignal, throwIfAborted, errorKey } = require('./push');
const { listCachedMedia, deleteCachedMedia } = require('../../../db/sync-media-cache');

/** Bild-Cache pruefen: Anzahl verworfener Eintraege. */
async function _pruneMediaCache(provider, { conn, client, jobId, logger, tag }) {
  const owner = provider.mediaOwner?.(conn);
  if (!owner || typeof provider.mediaExists !== 'function') {
    return provider.db.clearMediaCache ? provider.db.clearMediaCache(conn.id) : 0;
  }
  let dropped = 0;
  for (const entry of listCachedMedia(owner)) {
    throwIfAborted(jobId);
    let alive;
    try { alive = await provider.mediaExists(client, entry); }
    catch (e) {
      if (isNotFound(e)) alive = false;
      else {
        logger.warn(`${tag}: Bild-Pruefung fehlgeschlagen (${e.code || e.message}), Cache wird verworfen`);
        return dropped + (provider.db.clearMediaCache ? provider.db.clearMediaCache(conn.id) : 0);
      }
    }
    if (alive === false) dropped += deleteCachedMedia(owner, entry.srcKey);
  }
  return dropped;
}

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

    const mediaCleared = await _pruneMediaCache(provider, { conn, client, jobId, logger, tag });
    logger.info(`${tag}: ${checked} geprüft, ${removed} verwaiste Links entfernt, ${mediaCleared} Bild-Cache-Eintraege verworfen.`);
    completeJob(jobId, { checked, removed, refreshed }, null, `${removed} verwaiste Links entfernt`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`${tag}-Fehler: ${e.code || e.message}`);
    failJob(jobId, e?.code && e.name !== 'AbortError' ? i18nError(errorKey(provider, e.code, `${provider.prefix}_RECONCILE_FAILED`)) : e);
  }
}

module.exports = { runSyncReconcileJob };
