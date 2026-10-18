'use strict';
// POST /jobs/<anbieter>-<aktion> fuer beide Blog-Syncs. Alle Handler laufen
// gleich: Buch-ID → Log-Context → Buch-ACL (editor) → Buchtyp-Gate → Dedup →
// Job anlegen. Was variiert, steht in der Route-Spec.
//
//   withPages      Body traegt `page_ids` (Push). Dedup dann pro Abschnitts-
//                  Menge: ein zweiter Push fuer ANDERE Abschnitte ist ein
//                  eigener Job, nicht der laufende (sonst pollte das UI fuer
//                  Abschnitt B den Job von Abschnitt A und meldete „fertig").
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
    if (spec.withPages) {
      pageIds = _pageIds(req.body);
      if (!pageIds.length) return res.status(400).json({ error_code: `${P}_PAGE_IDS_REQUIRED` });
      dedupId = `${bookId}:${pageIds.join(',')}`;
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
      ? spec.run(jobId, bookId, userEmail, pageIds)
      : spec.run(jobId, bookId, userEmail)));
    res.json({ jobId });
  });
}

module.exports = { mountSyncJobRoute, activeBookJob };
