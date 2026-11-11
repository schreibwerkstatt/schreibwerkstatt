'use strict';
// POST /jobs/<anbieter>-<aktion> fuer beide Blog-Syncs. Alle Handler laufen
// gleich: Buch-ID → Log-Context → Buch-ACL (editor) → Buchtyp-Gate → Dedup →
// Job anlegen. Was variiert, steht in der Route-Spec.
//
//   withPages      Body traegt `page_ids` (Push). Dedup dann pro Abschnitts-
//                  Menge: ein zweiter Push fuer ANDERE Abschnitte ist ein
//                  eigener Job, nicht der laufende (sonst pollte das UI fuer
//                  Abschnitt B den Job von Abschnitt A und meldete „fertig").
//                  Optional `publish: 'now'` | `publish_at: ISO`: nach dem
//                  Push veroeffentlichen bzw. planen (push.js#runSyncPushJob).
//   bookExclusive  Typen, die Seiten + Links eines Buchs anlegen (Import,
//                  Pull): laeuft einer davon fuer das Buch — egal von wem —,
//                  antwortet die Route 409 P_SYNC_RUNNING. Die Verbindung gehoert
//                  dem Buch; zwei Mitautoren legten sonst Posts doppelt an.

const { createJob, enqueueJob, findActiveJobId, jobs, jsonBody } = require('../shared');
const { guardBook, sessionEmail } = require('../../../lib/acl');
const { toIntId } = require('../../../lib/validate');
const { setContext } = require('../../../lib/log-context');

/** Aktiver (queued/running) Job eines der `types` fuer dieses Buch, egal von wem. */
function activeBookJob(bookId, types) {
  const key = String(bookId);
  const set = new Set(types);
  for (const job of jobs.values()) {
    if (!set.has(job.type) || job.bookId !== key) continue;
    if (job.status === 'queued' || job.status === 'running') return job;
  }
  return null;
}

// Veroeffentlichen nach dem Push: `publish: 'now'` oder `publish_at: <ISO>`
// (Zukunft, hoechstens zwei Jahre). Liefert `{ mode: 'now' }`,
// `{ mode: 'schedule', at }`, null (nur pushen) oder false (ungueltig).
const MAX_SCHEDULE_MS = 2 * 366 * 86400_000;
function _publishOpts(body) {
  if (body?.publish_at != null && body.publish_at !== '') {
    const ms = Date.parse(String(body.publish_at));
    const now = Date.now();
    if (!Number.isFinite(ms) || ms <= now + 60_000 || ms > now + MAX_SCHEDULE_MS) return false;
    return { mode: 'schedule', at: new Date(ms).toISOString() };
  }
  if (body?.publish === 'now') return { mode: 'now' };
  if (body?.publish != null && body.publish !== '' && body.publish !== false) return false;
  return null;
}

function _pageIds(body) {
  const raw = Array.isArray(body?.page_ids) ? body.page_ids : [];
  return [...new Set(raw.map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

/**
 * spec: { type, label, run(jobId, bookId, userEmail, pageIds?), withPages?,
 *         bookExclusive?: string[] }
 */
function mountSyncJobRoute(router, provider, spec) {
  const P = provider.prefix;
  router.post(`/${spec.type}`, jsonBody, (req, res) => {
    const bookId = toIntId(req.body?.book_id);
    if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
    setContext({ book: bookId });
    if (!guardBook(req, res, bookId, 'editor')) return;
    const userEmail = sessionEmail(req);
    try { provider.requireBook(bookId, userEmail); }
    catch (e) { return res.status(400).json({ error_code: e.code }); }

    let pageIds = null;
    let dedupId = null;
    let publish = null;
    if (spec.withPages) {
      pageIds = _pageIds(req.body);
      if (!pageIds.length) return res.status(400).json({ error_code: `${P}_PAGE_IDS_REQUIRED` });
      publish = _publishOpts(req.body);
      if (publish === false) return res.status(400).json({ error_code: `${P}_PUBLISH_INVALID` });
      // Der Modus gehoert zum Dedup: ein „veroeffentlichen" waehrend eines
      // laufenden reinen Pushs derselben Abschnitte ist ein eigener Auftrag.
      dedupId = `${bookId}:${pageIds.join(',')}${publish ? `:${publish.mode}` : ''}`;
    }
    const existing = findActiveJobId(spec.type, dedupId ?? bookId, userEmail);
    if (existing) return res.json({ jobId: existing, existing: true });
    // Fremder Job derselben Familie: dessen ID bekommt der zweite User nicht
    // (GET /jobs/:id zeigt nur eigene Jobs), darum ein eigener Fehlercode statt
    // eines Pollings ins Leere.
    if (spec.bookExclusive && activeBookJob(bookId, spec.bookExclusive)) {
      return res.status(409).json({ error_code: `${P}_SYNC_RUNNING` });
    }
    const labelParams = spec.withPages ? { count: pageIds.length } : null;
    const jobId = createJob(spec.type, bookId, userEmail, spec.label, labelParams, dedupId);
    enqueueJob(jobId, () => (spec.withPages
      ? spec.run(jobId, bookId, userEmail, pageIds, publish)
      : spec.run(jobId, bookId, userEmail)));
    res.json({ jobId });
  });
}

module.exports = { mountSyncJobRoute, activeBookJob };
