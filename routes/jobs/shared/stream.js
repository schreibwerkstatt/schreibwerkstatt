'use strict';
const { jobs } = require('./state');
const { bus } = require('./events');
const { jobView, queueItems, hasQueuedJob, isJobVisibleTo } = require('./serialize');

// Job-Kanal des Event-Streams (GET /events/stream, routes/events/stream.js):
// pusht die Jobs des eingeloggten Users.
//
// Events:
//   job    jobView(job) ohne `result` — pro geändertem Job
//   queue  queueItems(user) — dieselbe Liste wie GET /jobs/queue; kommt direkt
//          nach dem Connect und nach jedem Flush, in dem sich etwas bewegt hat
//
// Der Kanal ist ein Beschleuniger über dem Polling, kein Ersatz: nach einem
// Reconnect holt der Client über die `queue`-Liste und einen /jobs/:id-Tick nach,
// was er verpasst hat. Das Ergebnis eines fertigen Jobs holt er ebenfalls über
// /jobs/:id. Nur Jobs, die der Session-User sehen darf (isJobVisibleTo: eigene
// plus Buch-System-Jobs seiner Bücher) — dieselbe ACL wie bei /jobs/queue.
//
// Drossel: Streaming-Progress feuert updateJob pro Chunk. Änderungen werden pro
// Verbindung gesammelt und höchstens alle FLUSH_MS geschrieben; ein Terminal-
// Status flusht sofort.
const FLUSH_MS = 400;

// write(event, data) schreibt ein SSE-Event auf die Verbindung. Liefert die
// Abmelde-Funktion.
function attachJobChannel(write, userEmail) {
  let closed = false;
  const pending = new Set();
  let queueDirty = false;
  let timer = null;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (closed) return;
    const ids = [...pending];
    pending.clear();
    for (const id of ids) {
      const job = jobs.get(id);
      if (job) write('job', jobView(job, { withResult: false }));
    }
    if (ids.length || queueDirty) write('queue', queueItems(userEmail));
    queueDirty = false;
  };

  const schedule = (now) => {
    if (now) { flush(); return; }
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };

  const onChange = (job, terminal) => {
    if (!isJobVisibleTo(job, userEmail)) return;
    pending.add(job.id);
    schedule(terminal);
  };
  const onShift = () => {
    if (!hasQueuedJob(userEmail)) return;
    queueDirty = true;
    schedule(false);
  };

  bus.on('change', onChange);
  bus.on('shift', onShift);

  // Ausgangsstand direkt nach dem Connect.
  write('queue', queueItems(userEmail));

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    bus.off('change', onChange);
    bus.off('shift', onShift);
  };
}

module.exports = { attachJobChannel, FLUSH_MS };
