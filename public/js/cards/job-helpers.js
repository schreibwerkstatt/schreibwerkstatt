// Pure Job-Helper — wird sowohl vom Root (via appJobsCoreMethods-Wrapper) als
// auch direkt von Karten verwendet.

import { escHtml, fmtTok } from '../utils.js';
import { jobStreamOpen, onJobStream } from '../event-stream.js';
import { lsRemove } from '../safe-storage.js';

// Bei offenem Job-Stream ersetzt der Push die Poll-Ticks; nur jeder n-te Tick
// läuft als Sicherheitsnetz (bei 2 s: alle 30 s).
const STREAM_SAFETY_TICKS = 15;

// Footer-Sync: Ohne offenen Job-Stream pollt der Job-Queue-Footer `/jobs/queue`
// nur alle 5 s, der per-Job-Poller `/jobs/:id` alle 2 s. Bei langen Jobs mit vielen schnellen
// Progress-Updates (z.B. Komplettanalyse über viele kleine Chunks) driften
// obere Progressbar und Footer dadurch sichtbar auseinander. Beide lesen
// serverseitig dasselbe Job-Objekt — wir patchen darum den passenden
// jobQueueItems-Eintrag direkt mit dem frischen 2-s-Snapshot, damit Footer und
// Karten-Bar denselben Stand zeigen. Nur für laufende Jobs; das Entfernen
// terminaler Jobs bleibt Sache der Queue-Disappearance-Detection.
function syncJobQueueItem(job) {
  const items = window.Alpine?.store('jobs')?.jobQueueItems;
  if (!Array.isArray(items)) return;
  const item = items.find(j => j.id === job.id);
  if (!item) return;
  item.progress = job.progress;
  item.statusText = job.statusText;
  item.statusParams = job.statusParams;
  item.tokensIn = job.tokensIn || 0;
  item.tokensOut = job.tokensOut || 0;
  item.maxTokensOut = job.maxTokensOut || 0;
  item.tokensPerSec = job.tokensPerSec || 0;
}

// Generischer Job-Poller. `ctx` ist das Komponenten-Objekt (Root oder Card),
// in dessen Feldern `timerProp` und `progressProp` geschrieben wird.
//
// config: { timerProp, jobId, lsKey?, progressProp?, progressTarget?, intervalMs?,
//           onProgress, onNotFound, onError, onDone }
// progressTarget: optionales Objekt, in das `progressProp` geschrieben wird
//   (Default `ctx`). Nötig, wenn die Progress-Property in einem Alpine.store
//   statt am Komponenten-`ctx` liegt (z. B. Komplettanalyse → $store.jobs).
// intervalMs: Default 2000. PDF-Export fährt 1000 für schnelleres UI-Feedback.
export function startPoll(ctx, config) {
  if (ctx[config.timerProp]) clearInterval(ctx[config.timerProp]);
  // `setInterval` wartet nicht auf den async-Body. Bei langsamem Storage/Netz
  // (z.B. Ceph-RBD-Stall) liegen mehrere Ticks gleichzeitig in-flight, ihre
  // fetches wurden vor dem `clearInterval` dispatcht → `onDone`/`onError`
  // feuern mehrfach (klärt State, der danach erneut befüllt wird). `busy`
  // überspringt überlappende Ticks, `done` macht den Terminal-Handler einmalig.
  let busy = false;
  let done = false;
  let unsubscribe = null;
  let timer = null;
  // Eigener Handle statt `ctx[timerProp]`: räumt jemand von aussen ab
  // (Buchwechsel via card-lifecycle timerKeys) oder hat ein Nachfolge-Poller
  // denselben timerProp übernommen, darf ein noch fliegender Tick weder
  // onProgress/onDone ausführen (Ergebnis des alten Buchs in der neuen Karte)
  // noch den Handle/lsKey des Nachfolgers wegräumen.
  const owned = () => ctx[config.timerProp] === timer;
  const detach = () => {
    done = true;
    clearInterval(timer);
    unsubscribe?.();
  };
  const stop = () => {
    const mine = owned();
    detach();
    if (!mine) return;
    ctx[config.timerProp] = null;
    if (config.lsKey) lsRemove(config.lsKey);
  };
  // true = dieser Poller ist abgelöst/abgeräumt → still aussteigen.
  const stale = () => {
    if (done) return true;
    if (owned()) return false;
    detach();
    return true;
  };
  const tick = async () => {
    if (busy || stale()) return;
    busy = true;
    try {
      const resp = await fetch('/jobs/' + config.jobId);
      if (stale()) return;
      // 403: Buchzugriff seit dem Start entzogen — der Job bleibt unerreichbar,
      // weiterpollen brächte nichts.
      if (resp.status === 404 || resp.status === 403) {
        stop();
        config.onNotFound?.();
        return;
      }
      if (!resp.ok) return;
      const job = await resp.json();
      if (stale()) return;
      if (config.progressProp) (config.progressTarget || ctx)[config.progressProp] = job.progress || 0;
      if (job.status === 'running' || job.status === 'queued') {
        syncJobQueueItem(job);
        config.onProgress?.(job);
        return;
      }
      stop();
      // Race-freier Toast: sobald dieser per-Card-Poller den Terminal-Status
      // sieht, toasten — unabhängig vom 5-s-Queue-Diff (der schnelle Jobs
      // verpassen kann). `_maybeShowJobToast` dedupt via Job-ID gegen den
      // Queue-Diff-Pfad. cancelled wird dort selbst ausgefiltert.
      window.__app?._maybeShowJobToast?.({
        type: job.type, job, bookId: job.bookId ?? null, dedupId: job.dedupId ?? null,
      });
      if (job.status === 'cancelled') { await config.onError?.(job); return; }
      if (job.status === 'error') await config.onError?.(job);
      else await config.onDone?.(job);
    } catch (e) { console.error('[poll ' + config.timerProp + ']', e); }
    finally { busy = false; }
  };
  let skipped = 0;
  timer = setInterval(() => {
    if (jobStreamOpen() && ++skipped < STREAM_SAFETY_TICKS) return;
    skipped = 0;
    tick();
  }, config.intervalMs || 2000);
  ctx[config.timerProp] = timer;
  // Push-Pfad: Fortschritt direkt aus dem Stream-Snapshot (ohne `result`);
  // Terminal-Status und Reconnect (`null`) laufen über einen normalen Tick, der
  // das Ergebnis holt — so bleibt der Terminal-Pfad oben der einzige.
  unsubscribe = onJobStream(config.jobId, (snap) => {
    // Neuer startPoll auf demselben timerProp hat diesen Poller abgelöst
    // oder der Timer wurde von aussen abgeräumt.
    if (stale()) return;
    if (!snap || (snap.status !== 'running' && snap.status !== 'queued')) { tick(); return; }
    if (config.progressProp) (config.progressTarget || ctx)[config.progressProp] = snap.progress || 0;
    syncJobQueueItem(snap);
    config.onProgress?.(snap);
  });
  // Ein Job, der vor dem Abonnieren schon fertig war (Cache-Treffer, schneller
  // Export), schickt kein Event mehr — der Sofort-Tick holt ihn ab. Ohne ihn
  // wartete der Poller bei offenem Stream bis zum Sicherheits-Tick. Ohne Stream
  // übernimmt das der reguläre erste Tick.
  if (jobStreamOpen()) tick();
}

// Baut das Status-HTML für einen laufenden Job. `translate` ist die i18n-Funktion
// (in Root: this.t, in Sub: window.__app.t) — via expliziten Parameter entkoppelt.
// cacheReadIn (optional, letzter Parameter — Bestandsaufrufer lassen ihn weg):
// Anteil der Input-Tokens, der aus dem Prompt-Cache gelesen wurde. Sichtbar
// machen lohnt sich bei Jobs, deren tokensIn über mehrere Provider-Calls
// aufsummiert wird (agentischer Tool-Loop) — dort ist der Präfix ab dem zweiten
// Call vollständig gecacht und die rohe Summe wirkt sonst dramatischer als der
// Preis. Gleiche Darstellung wie das persistierte Badge (_chatTokenInfo).
export function runningJobStatus(translate, statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams, cacheReadIn) {
  let tokInfo = '';
  if ((tokIn || 0) + (tokOut || 0) > 0) {
    const pctPart = (progress > 0 && progress < 100) ? ` ~${progress}%` : '';
    const tpsPart = tokPerSec ? ` · ${Math.round(tokPerSec)} tok/s` : '';
    const inPart = (tokIn || 0) > 0 ? `↑${fmtTok(tokIn)} ` : '';
    const cachePart = ((tokIn || 0) > 0 && (cacheReadIn || 0) > 0)
      ? ` · ${translate('chat.tokenCacheShare', { pct: Math.round((cacheReadIn / tokIn) * 100) })}`
      : '';
    tokInfo = ` · ${inPart}${escHtml(translate('job.tokensOut', { n: fmtTok(tokOut || 0) }))}${pctPart}${cachePart}${tpsPart}`;
  }
  // statusText kann ein i18n-Key sein (z.B. 'job.phase.extracting') oder freier
  // Text — tRaw liefert unbekannte Keys 1:1 zurück.
  const label = statusText ? translate(statusText, statusParams) : '…';
  return `<span class="spinner"></span>${escHtml(label)}${tokInfo}`;
}
