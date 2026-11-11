'use strict';
// Push-Job beider Blog-Syncs (WordPress, HubSpot). Die Schleife ist identisch;
// was sich unterscheidet, liefert der Anbieter-Adapter (lib/sync/providers/).
//
// Adapter-Vertrag (Push-Teil):
//   key, prefix, logTag, remoteLabel, pushErrorKeys[]
//   requireBook(bookId, userEmail) · resolveConn(bookId) · client(conn, signal)
//   db.{getLinkByPage, deleteLink, setConflictState, setLockedParts?}
//   linkStamp(link) · remoteStamp(remote) · remoteId(link)
//   fetchRemote(client, link, 'precheck'|'reconcile') · isGone(remote) · lossyParts(remote)
//   preparePush({ conn, client, bookId, signal, logger }) → state (u.a. resolveImage)
//   render({ appHtml, bib, hl, state }) → Post-Body
//   create({ client, conn, state, title, body, teaser, slug }) → Remote
//   update({ client, link, state, title, body, teaser }) → Remote
//     `teaser` geht als Meta-Description/Excerpt mit, `slug` nur beim Anlegen
//   linkAfterPush({ pageId, conn, remote, link, pushedAt }) · touchPush(conn)
//   findExistingRemote({ client, conn, title, logger }) → Remote | null und
//     linkFromRemote(remote) → Link-Form fuer `update` (optional, beide zusammen)
//   publish({ client, conn, pageId, remote, publish }) → Remote (optional;
//     `publish` = { mode: 'now' } | { mode: 'schedule', at }). Setzt den
//     Status am Link selbst. `publishNeedsTeaser`: Anbieter verlangt eine
//     Meta-Description zum Veroeffentlichen (HubSpot) — ohne Teaser wird der
//     Abschnitt vor dem Schreiben abgewiesen, statt halb gepusht zu scheitern.
//
// Ablauf pro Abschnitt (fuer beide Anbieter gleich):
//   0. Sync-Punkt `pushedAt` nehmen, BEVOR die Seite gelesen wird (siehe unten)
//   1. offener Konflikt → P_CONFLICT, kein Schreib-Call
//   2. Vorab-Pruefung gegen den Remote-Stand (nur mit Link):
//        404 / Papierkorb       → Link weg, P_REMOTE_GONE (Badge „neu"; der
//                                 naechste Push legt bewusst neu an — nie still)
//        drueben juenger        → Konflikt setzen, P_CONFLICT
//        nicht uebernehmbar     → P_UNSUPPORTED_BLOCKS (nur WordPress)
//   3. Quellen (Einheit = Seite), Titel-Werkstatt, Media-Pass, Create/Update —
//      ein Fehler hier trifft nur diesen Abschnitt, nie den ganzen Job
//   4. Link schreiben, SOFORT nach dem Remote-Write: ohne Link legte der
//      naechste Push denselben Beitrag ein zweites Mal an
//   5. Optional veroeffentlichen/planen (`publish`). Scheitert nur das, ist der
//      Push gelungen und der Toast warnt gelb — der Inhalt liegt drueben.
//   6. Create: lokaler Name bekommt den app-internen Datums-Praefix von heute
//      (`result.renamed`, sync-core.js#_applyPushRenames); scheitert das, ist
//      der Push trotzdem gelungen
// Geht kein Abschnitt durch, endet der Job als Fehler mit dem ersten Grund —
// sonst meldete der Toast Erfolg, waehrend der Abschnitt gesperrt ist.

const { updateJob, completeJob, failJob, makeJobLogger, jobAbortControllers, i18nError } = require('../shared');
const contentStore = require('../../../lib/content-store');
const { buildBibliography, resolveCitesInHtml } = require('../../../lib/bibliography');
const { newer } = require('../../../lib/blog-merge');
const { splitDatePrefix, outgoingTitle } = require('../../../lib/blog-title');
const { getHeadline } = require('../../../db/headline');
const { localIsoDate } = require('../../../lib/local-date');
const { isNotFound, codedError } = require('../../../lib/sync/request');
const { slugify } = require('../../../lib/slug');

function abortSignal(jobId) {
  return jobAbortControllers.get(jobId)?.signal || null;
}

function throwIfAborted(jobId) {
  if (abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function pushErrorKey(provider, code) {
  const known = new Set(provider.pushErrorKeys);
  return `${provider.key}.error.${known.has(code) ? code : `${provider.prefix}_PUSH_FAILED`}`;
}

/** i18n-Key eines Sync-Fehlers ausserhalb des Pushs (Abgleich, Import, Pull):
 *  `<key>.error.<CODE>` fuer die Codes, die beide Anbieter mit Text fuehren
 *  (Transport, Anmeldung, Verbindung), sonst `fallback` (z.B.
 *  `BLOG_RECONCILE_FAILED`). Ohne Mapping zeigte der Toast den nackten Code. */
const COMMON_ERROR_SUFFIXES = [
  'AUTH_FAILED', 'FORBIDDEN', 'RATE_LIMIT', 'UPSTREAM', 'TIMEOUT', 'FETCH_FAILED',
  'INVALID_JSON', 'RESPONSE_TOO_LARGE', 'NOT_CONNECTED', 'REQUIRES_BLOG_TYPE', 'SYNC_RUNNING',
];
function errorKey(provider, code, fallback) {
  const P = provider.prefix;
  const known = new Set([...(provider.pushErrorKeys || []), ...COMMON_ERROR_SUFFIXES.map(x => `${P}_${x}`)]);
  return `${provider.key}.error.${known.has(code) ? code : fallback}`;
}

/** Vorab-Pruefung. Liefert null (weiter) oder `{ code, blocks? }` (Abschnitt
 *  ueberspringen). Wirft nicht fuer Remote-Fehler — die landen im Ergebnis.
 *  `seen.stamp` bekommt den Remote-Stempel, gegen den `changedSincePrecheck`
 *  unmittelbar vor dem Schreiben noch einmal vergleicht. */
async function precheck(provider, { client, link, pageId, pageName, logger, seen: out = {} }) {
  const P = provider.prefix;
  const tag = `${provider.logTag}-Push: Page ${pageId} "${pageName}"`;
  const remoteRef = `${provider.remoteLabel} ${provider.remoteId(link)}`;
  if (link.conflict_state === 'detected') {
    logger.info(`${tag} Konflikt offen, skip`);
    return { code: `${P}_CONFLICT` };
  }
  let current;
  try {
    current = await provider.fetchRemote(client, link, 'precheck');
  } catch (e) {
    if (isNotFound(e)) {
      provider.db.deleteLink(pageId);
      logger.info(`${tag} -> ${remoteRef} weg (404), Link entfernt`);
      return { code: `${P}_REMOTE_GONE` };
    }
    logger.warn(`${tag} Vorab-Pruefung fehlgeschlagen: ${e.code || e.message}`);
    return { code: e.code || `${P}_PUSH_FAILED` };
  }
  if (provider.isGone(current)) {
    provider.db.deleteLink(pageId);
    logger.info(`${tag} -> ${remoteRef} im Papierkorb/archiviert, Link entfernt`);
    return { code: `${P}_REMOTE_GONE` };
  }
  const seen = provider.linkStamp(link);
  const now = provider.remoteStamp(current);
  out.stamp = now || null;
  if (seen && now && newer(now, seen)) {
    provider.db.setConflictState(pageId, 'detected');
    logger.info(`${tag} — ${remoteRef} drueben geaendert (${now} > ${seen}), Konflikt gesetzt`);
    return { code: `${P}_CONFLICT` };
  }
  const lossy = provider.lossyParts(current);
  // Befund am Link merken (Badge „nur im Blog bearbeitbar"), auch wenn er weg ist.
  provider.db.setLockedParts?.(pageId, lossy);
  if (lossy.length) {
    logger.info(`${tag} — ${remoteRef} enthaelt nicht uebernehmbare Bloecke (${lossy.join(', ')}), gesperrt`);
    return { code: `${P}_UNSUPPORTED_BLOCKS`, blocks: lossy };
  }
  return null;
}

/** Zweiter Stempel-Vergleich direkt vor dem Remote-Write. Zwischen Vorab-
 *  Pruefung und Update liegen Quellen, Rendering und Bild-Uploads (bis zu
 *  Minuten) — wer den Beitrag in dieser Zeit drueben bearbeitet, haette sonst
 *  keinen Konflikt bekommen, sein Edit waere still ueberschrieben worden.
 *  Liefert true, wenn drueben inzwischen jemand geschrieben hat. */
async function changedSincePrecheck(provider, { client, link, stamp }) {
  if (!stamp) return false;
  const current = await provider.fetchRemote(client, link, 'precheck');
  const now = provider.remoteStamp(current);
  return !!(now && newer(now, stamp));
}

// Pushes pro Verbindung nacheinander (Anbieter + Buch). Zwei parallele Jobs
// (anderer Abschnitts-Satz, Mitautor, `jobs.max_concurrent > 1`) koennten sonst
// fuer denselben neuen Abschnitt beide `create` aufrufen: zwei Posts drueben,
// der zweite Link ueberschriebe den ersten, ein Post bliebe verwaist.
const _pushChains = new Map();
function _serialized(key, fn) {
  const prev = _pushChains.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  _pushChains.set(key, tail);
  tail.then(() => { if (_pushChains.get(key) === tail) _pushChains.delete(key); });
  return run;
}

/** Lokaler Name nach einem Create (Datums-Praefix). Liefert
 *  `{ renamed, syncedAt }`: `syncedAt` ist der Stempel der eigenen Umbenennung,
 *  wenn seit dem Lesen der Seite niemand gespeichert hat (sonst null — dann
 *  gilt der fremde Save als offene lokale Aenderung, und das ist er auch).
 *  Scheitert die Umbenennung ganz, ist der Push trotzdem gelungen. */
async function _renameAfterCreate({ pageId, pageRow, localName, logger, tag }) {
  try {
    const saved = await contentStore.savePage(pageId, {
      name: localName, expected_updated_at: pageRow.updated_at,
    }, null);
    return { renamed: true, syncedAt: saved?.updated_at || null };
  } catch (e) {
    if (e?.code !== 'PAGE_CONFLICT') {
      logger.warn(`${tag}-Push: Page ${pageId} angelegt, aber Umbenennung fehlgeschlagen: ${e.code || e.message}`);
      return { renamed: false, syncedAt: null };
    }
  }
  // Waehrend des Pushs gespeichert: nur den Namen nachziehen, Inhalt bleibt.
  try {
    await contentStore.savePage(pageId, { name: localName }, null);
    return { renamed: true, syncedAt: null };
  } catch (e) {
    logger.warn(`${tag}-Push: Page ${pageId} angelegt, aber Umbenennung fehlgeschlagen: ${e.code || e.message}`);
    return { renamed: false, syncedAt: null };
  }
}

function runSyncPushJob(provider, jobId, bookId, userEmail, pageIds, publish = null) {
  return _serialized(`${provider.key}:${bookId}`, () => _runSyncPushJob(provider, jobId, bookId, userEmail, pageIds, publish));
}

async function _runSyncPushJob(provider, jobId, bookId, userEmail, pageIds, publish) {
  const logger = makeJobLogger(jobId);
  const P = provider.prefix;
  try {
    provider.requireBook(bookId, userEmail);
    const conn = provider.resolveConn(bookId);
    const signal = abortSignal(jobId);
    const client = provider.client(conn, signal);

    const ids = (pageIds || []).map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) throw codedError(`${P}_NO_PAGES`);
    if (publish && typeof provider.publish !== 'function') throw codedError(`${P}_PUBLISH_UNSUPPORTED`);

    const state = await provider.preparePush({ conn, client, bookId, signal, logger });
    // Neu hochgeladene Bilder zaehlen (src geaendert = Upload). Verworfene
    // (Format, Groesse, nicht erreichbar) fehlen im Beitrag, ohne dass der Push
    // scheitert — sie zaehlen pro Abschnitt und gehen nach einem gelungenen Push
    // als Toast-Warnung zum User; sonst faellt das Loch erst im Blog auf.
    let imagesUploaded = 0;
    let pageImagesDropped = 0;
    if (typeof state.resolveImage === 'function') {
      const inner = state.resolveImage;
      state.resolveImage = async (src, opts) => {
        const r = await inner(src, opts);
        if (r && r.src && r.src !== src && !r.cached) imagesUploaded++;
        if (!r || !r.src) pageImagesDropped++;
        return r;
      };
    }
    let imagesDropped = 0;
    const imagesDroppedPages = [];

    let pushed = 0;
    let createdRemote = 0;
    let conflictSkipped = 0;
    let published = 0;
    const publishFailed = [];
    const errors = [];
    const renamed = [];

    for (let i = 0; i < ids.length; i++) {
      throwIfAborted(jobId);
      const pageId = ids[i];
      updateJob(jobId, {
        statusText: `job.${provider.key}.push.upload`,
        statusParams: { current: i + 1, total: ids.length },
        progress: Math.round((i / ids.length) * 95) + 2,
      });
      // Sync-Punkt dieses Pushs, genommen BEVOR Seite und Titel-Werkstatt
      // gelesen werden. Wer den Abschnitt speichert, waehrend der Push laeuft
      // (Bild-Upload, HTTP), hat einen juengeren Stand als den gepushten — ein
      // Stempel „jetzt" nach dem Push erklaerte diese Aenderung fuer
      // uebertragen, und das Badge zeigte „synchron", obwohl sie nie ankam.
      const pushedAt = new Date().toISOString();
      const pageRow = await contentStore.loadPage(pageId).catch(() => null);
      if (!pageRow) {
        logger.warn(`${provider.logTag}-Push: Page ${pageId} nicht gefunden`);
        errors.push({ pageId, code: 'PAGE_NOT_FOUND' });
        continue;
      }
      if (pageRow.book_id !== bookId) {
        logger.warn(`${provider.logTag}-Push: Page ${pageId} gehoert nicht zu Buch ${bookId}`);
        errors.push({ pageId, code: 'PAGE_WRONG_BOOK' });
        continue;
      }

      // Link erst hier lesen (nicht vor der Schleife): ein vorausgegangener,
      // serialisierter Job kann ihn eben angelegt haben.
      const link = provider.db.getLinkByPage(pageId);
      const seen = {};
      if (link) {
        const blocked = await precheck(provider, { client, link, pageId, pageName: pageRow.name, logger, seen });
        if (blocked) {
          if (blocked.code === `${P}_CONFLICT`) conflictSkipped++;
          errors.push({ pageId, ...blocked });
          continue;
        }
      }

      // Create: der Datums-Praefix `YYYY-MM-DD:` ist app-intern und bekommt das
      // Datum von heute (leerer Rest → nur das Datum).
      let localName = pageRow.name || '';
      if (!link) {
        const { rest } = splitDatePrefix(pageRow.name);
        localName = rest ? `${localIsoDate()}: ${rest}` : localIsoDate();
      }

      // Vorbau UND Remote-Write in einem try: ein Fehler im Verzeichnis, im
      // Zitat-Aufloesen oder im Serializer trifft nur diesen Abschnitt — sonst
      // brach er den ganzen Job ab, auch nach schon gepushten Abschnitten.
      try {
        // Quellen: Einheit ist die SEITE — ein Post ist genau eine Seite, die
        // Nummern des numerischen Stils folgen den Fundstellen dieses Posts ab 1.
        // `resolveCitesInHtml` setzt den Kurzbeleg frisch (der gespeicherte Text
        // ist nur ein Cache) und laeuft vor dem Serializer des Anbieters.
        const bib = await buildBibliography({ bookId, pageIds: [pageId], userEmail });
        const appHtml = await resolveCitesInHtml(pageRow.html || pageRow.body_html || '<p></p>', bib);
        // Titel-Werkstatt (lib/blog-title.js): Titel gewinnt, sonst Seitenname
        // ohne Datums-Praefix. Teaser nur, wenn gesetzt — ein leeres Feld
        // ueberschreibt drueben nichts.
        const hl = getHeadline(pageId);
        const title = outgoingTitle(pageRow.name, hl) || String(pageRow.name || `Page ${pageId}`).trim();
        const teaser = String(hl?.teaser || '').trim();
        if (publish && provider.publishNeedsTeaser && !teaser) {
          logger.info(`${provider.logTag}-Push: Page ${pageId} "${pageRow.name}" ohne Teaser, Veroeffentlichen abgewiesen`);
          errors.push({ pageId, code: `${P}_PUBLISH_NEEDS_TEASER` });
          continue;
        }
        pageImagesDropped = 0;
        const body = await provider.render({ appHtml, bib, hl, state });

        if (link && await changedSincePrecheck(provider, { client, link, stamp: seen.stamp })) {
          provider.db.setConflictState(pageId, 'detected');
          logger.info(`${provider.logTag}-Push: Page ${pageId} "${pageRow.name}" — ${provider.remoteLabel} ${provider.remoteId(link)} waehrend des Pushs drueben geaendert, Konflikt gesetzt`);
          conflictSkipped++;
          errors.push({ pageId, code: `${P}_CONFLICT` });
          continue;
        }
        // Slug nur beim Anlegen, aus dem Titel; danach nie mehr — ein geaenderter
        // Slug braeche jeden Link auf den Beitrag. Teaser = Meta-Description
        // (HubSpot) bzw. Excerpt (WordPress), das setzt der Anbieter.
        const slug = link ? undefined : (slugify(title) || undefined);
        const args = { client, conn, link, state, title, body, teaser, metaDescription: teaser, slug };
        // Vor einem Create: liegt drueben schon ein passender, unverknuepfter
        // Entwurf (Antwort eines frueheren Creates verloren, Link mit dem
        // Trennen weg)? Dann den aktualisieren statt einen zweiten anzulegen.
        let remote;
        const existing = !link && typeof provider.findExistingRemote === 'function'
          ? await provider.findExistingRemote({ client, conn, title, logger })
          : null;
        if (existing) {
          remote = await provider.update({ ...args, link: provider.linkFromRemote(existing) });
          logger.info(`${provider.logTag}-Push: Page ${pageId} -> bestehender ${provider.remoteLabel} ${existing.id} wiederverwendet statt neu angelegt`);
        } else {
          remote = link ? await provider.update(args) : await provider.create(args);
        }
        provider.linkAfterPush({ pageId, conn, remote, link, pushedAt });
        if (pageImagesDropped) {
          imagesDropped += pageImagesDropped;
          imagesDroppedPages.push(title);
          logger.warn(`${provider.logTag}-Push: Page ${pageId} "${pageRow.name}" ohne ${pageImagesDropped} Bild(er) gepusht`);
        }
        if (!link && localName !== pageRow.name) {
          const r = await _renameAfterCreate({ pageId, pageRow, localName, logger, tag: provider.logTag });
          if (r.renamed) renamed.push({ pageId, name: localName });
          // Die eigene Umbenennung ist kein lokaler Edit: ihr Stempel wird der
          // Sync-Punkt — aber nur, wenn dazwischen niemand gespeichert hat.
          if (r.syncedAt) provider.linkAfterPush({ pageId, conn, remote, link, pushedAt: r.syncedAt });
        }
        // Veroeffentlichen erst nach dem letzten linkAfterPush: der setzte den
        // Status sonst auf den des eben geschriebenen Entwurfs zurueck.
        if (publish) {
          try {
            await provider.publish({ client, conn, pageId, remote, publish });
            published++;
            logger.info(`${provider.logTag}-Push: Page ${pageId} "${pageRow.name}" ${publish.mode === 'schedule' ? `geplant auf ${publish.at}` : 'veroeffentlicht'}`);
          } catch (e) {
            logger.warn(`${provider.logTag}-Push: Page ${pageId} "${pageRow.name}" gepusht, Veroeffentlichen fehlgeschlagen: ${e.code || e.message}`);
            publishFailed.push(title);
          }
        }
        if (link) {
          logger.info(`${provider.logTag}-Push: Page ${pageId} "${pageRow.name}" -> ${provider.remoteLabel} ${remote?.id || provider.remoteId(link)} aktualisiert`);
          pushed++;
        } else {
          logger.info(`${provider.logTag}-Push: Page ${pageId} "${localName}" -> ${provider.remoteLabel} ${remote?.id} neu angelegt`);
          createdRemote++;
        }
      } catch (e) {
        if (link && isNotFound(e)) {
          provider.db.deleteLink(pageId);
          logger.info(`${provider.logTag}-Push: Page ${pageId} "${pageRow.name}" -> ${provider.remoteLabel} ${provider.remoteId(link)} weg (404), Link entfernt`);
          errors.push({ pageId, code: `${P}_REMOTE_GONE` });
        } else {
          logger.warn(`${provider.logTag}-Push: Page ${pageId} "${pageRow.name}" Fehler ${e.code || e.message}`);
          errors.push({ pageId, code: e.code || `${P}_PUSH_FAILED`, ...(e.location ? { location: e.location } : {}) });
        }
      }
    }

    // „Letzter Push" in den Einstellungen: nur, wenn auch etwas ankam.
    if (pushed + createdRemote > 0) provider.touchPush(conn);
    logger.info(`${provider.logTag}-Push: ${pushed} aktualisiert, ${createdRemote} neu, ${conflictSkipped} Konflikt, ${imagesUploaded} Bilder hochgeladen, ${imagesDropped} verworfen, ${errors.length} Fehler.`);
    if (errors.length && pushed + createdRemote === 0) {
      const first = errors[0];
      // Weiterleitung mit bekanntem Ziel: der Toast nennt die vermutlich
      // richtige Blog-URL (`<key>.error.<CODE>_TO`).
      if (first.location && first.code === `${P}_REDIRECT`) throw i18nError(`${pushErrorKey(provider, first.code)}_TO`, { location: first.location });
      throw i18nError(pushErrorKey(provider, first.code), first.blocks ? { blocks: first.blocks.join(', ') } : null);
    }
    const toastWarnings = imagesDropped
      ? [{ key: 'sync.push.imagesDropped', params: { count: imagesDropped, pages: imagesDroppedPages.join(', ') } }]
      : [];
    if (publishFailed.length) toastWarnings.push({ key: 'sync.publish.failed', params: { pages: publishFailed.join(', ') } });
    completeJob(jobId, {
      pushed, createdRemote, conflictSkipped, published, imagesUploaded, imagesDropped, errors, renamed, toastWarnings,
    }, null,
      `${pushed + createdRemote} gepusht / ${published} veroeffentlicht / ${errors.length} Fehler`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`${provider.logTag}-Push-Fehler: ${e.code || e.message}`);
    failJob(jobId, e);
  }
}

module.exports = { runSyncPushJob, abortSignal, throwIfAborted, pushErrorKey, errorKey };
