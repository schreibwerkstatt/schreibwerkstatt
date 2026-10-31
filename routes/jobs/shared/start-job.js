'use strict';
// Der Vorspann jedes buch-skopierten Job-POSTs an EINER Stelle:
//
//   1. book_id validieren            → 400 BOOK_ID_REQUIRED
//   2. Buch-ACL (guardBook)          → 401/403, setzt den Log-Context
//   3. optionale Vorbedingung        → 400 <error_code> (z.B. EMBED_DISABLED)
//   4. Dedup: laufender Job desselben (type, dedupId, User) → { jobId, existing: true }
//   5. createJob + enqueueJob        → { jobId }
//
// Die Dedup-ID ist immer ein String (default: die book_id) — `findActiveJobId`
// und `createJob` sehen denselben Wert, eine Route kann nicht mit Zahl prüfen
// und mit String anlegen.
//
// Routen mit Sonderlogik (Buch aus Seite/Kapitel ableiten, Namen nachladen,
// Mehrbuch-Scope) bleiben handgeschrieben — der Helfer deckt nur das Muster ab,
// das er wörtlich ersetzt.

const { toIntId } = require('../../../lib/validate');
const { guardBook, sessionEmail } = require('../../../lib/acl');
const { findActiveJobId, createJob } = require('./jobs');
const { enqueueJob } = require('./queue');

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} opts
 * @param {string} opts.type                 Job-Typ
 * @param {string} opts.minRole              Buch-Mindestrolle für guardBook
 * @param {*}      [opts.bookId]             Roh-ID (Default: req.body.book_id)
 * @param {(bookId:number)=>string|number} [opts.dedupId]  Default: die book_id
 * @param {string} opts.label                i18n-Key des Job-Labels
 * @param {object|null} [opts.labelParams]
 * @param {(bookId:number, userEmail:string|null)=>string|{status:number,error_code:string}|null} [opts.precheck]
 *        liefert einen error_code (400), eine fertige Fehlerantwort `{ status, error_code, …rest }`
 *        (z.B. 409 mit der ID des blockierenden Jobs) oder null
 * @param {(jobId:string, ctx:{bookId:number,userEmail:string})=>any} opts.run
 */
function startBookJob(req, res, {
  type, minRole, bookId = req.body?.book_id, dedupId = null,
  label, labelParams = null, precheck = null, run,
}) {
  const id = toIntId(bookId);
  if (!id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!guardBook(req, res, id, minRole)) return;
  const userEmail = sessionEmail(req);
  if (precheck) {
    const code = precheck(id, userEmail);
    if (typeof code === 'string') return res.status(400).json({ error_code: code });
    if (code) {
      const { status = 400, ...body } = code;
      return res.status(status).json(body);
    }
  }
  const dedup = String(dedupId ? dedupId(id) : id);
  const existing = findActiveJobId(type, dedup, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob(type, id, userEmail, label, labelParams, dedup);
  enqueueJob(jobId, () => run(jobId, { bookId: id, userEmail }));
  res.json({ jobId });
}

module.exports = { startBookJob };
