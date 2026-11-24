'use strict';
// Naechtlicher Abgleich beider Blog-Syncs (lib/cron.js). Reiht fuer jedes Buch
// mit Verbindung einen Abgleich-Job ein (routes/jobs/sync/reconcile.js): ein
// drueben veroeffentlichter, geplanter oder geloeschter Beitrag kommt so auch
// ohne manuellen Pull/Abgleich in der App an. Der Job laeuft unter dem
// Buch-Owner (job_runs braucht einen User; die Verbindung gehoert dem Buch).
// Uebersprungen: Buecher, die nicht (mehr) vom Typ Blog sind, und Buecher, deren
// Abgleich schon laeuft.

const logger = require('../../../logger');
const { createJob, enqueueJob } = require('../shared');
const { activeBookJob } = require('./routes');
const { getOwnerEmail } = require('../../../db/book-access');
const { getBookSettings } = require('../../../db/schema');
const { isBlogBook } = require('../../../lib/buchtyp');

function _providers() {
  // Lazy: blog-sync/hubspot-sync haengen beim Laden ihre Routen an und ziehen
  // den halben Job-Baum nach — der Cron-Import soll das nicht vorziehen.
  const blogs = require('../../../db/blogs');
  const hubspot = require('../../../db/hubspot');
  const { runBlogReconcileJob } = require('../blog-sync');
  const { runHubspotReconcileJob } = require('../hubspot-sync');
  return [
    { type: 'blog-reconcile', label: 'job.label.blogReconcile', listBookIds: blogs.listConnectedBookIds, run: runBlogReconcileJob },
    { type: 'hubspot-reconcile', label: 'job.label.hubspotReconcile', listBookIds: hubspot.listConnectedBookIds, run: runHubspotReconcileJob },
  ];
}

function reconcileAllConnections() {
  let enqueued = 0;
  let skipped = 0;
  for (const p of _providers()) {
    for (const bookId of p.listBookIds()) {
      const owner = getOwnerEmail(bookId);
      if (!owner || !isBlogBook(getBookSettings(bookId, owner)) || activeBookJob(bookId, [p.type])) {
        skipped++;
        continue;
      }
      const jobId = createJob(p.type, bookId, owner, p.label, null, bookId);
      enqueueJob(jobId, () => p.run(jobId, bookId, owner));
      enqueued++;
    }
  }
  logger.info(`Blog-Abgleich (Cron): ${enqueued} Lauf/Läufe eingereiht, ${skipped} übersprungen (kein Owner / kein Blog-Buch / läuft bereits).`);
  return { enqueued, skipped };
}

module.exports = { reconcileAllConnections };
