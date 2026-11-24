'use strict';
// Regex-Suche über Abschnittstexte in einem Worker mit Zeitdeckel — für
// search_passages (tools-text.js) mit regex=true.

const path = require('node:path');
const { Worker } = require('node:worker_threads');

// Regex-Muster kommen vom Modell und laufen darum in einem Worker mit Zeitdeckel
// (./regex-worker.js): ein katastrophal backtrackendes Muster hielt sonst den
// Server-Prozess an. Literal-Muster sind aus maskierten Zeichen gebaut und laufen
// direkt. Länge gedeckelt, damit kein Muster den Worker-Start selbst teuer macht.
const REGEX_TIMEOUT_MS = 2000;
const REGEX_MAX_PATTERN = 500;

/** → `{ matches, timeout? }`. Bei Zeitüberschreitung stehen die Treffer der
 *  Abschnitte vor dem hängenden in `matches` (in Lesereihenfolge). */
function regexScan(source, texts, maxResults, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'regex-worker.js'), {
      workerData: { source, flags: 'gi', texts, maxResults },
    });
    const matches = [];
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      worker.terminate();
      fn(v);
    };
    const timer = setTimeout(() => finish(resolve, { timeout: true, matches }), REGEX_TIMEOUT_MS);
    const onAbort = () => finish(reject, new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    worker.on('message', (msg) => {
      if (Array.isArray(msg?.matches)) matches.push(...msg.matches);
      if (msg?.done || matches.length >= maxResults) finish(resolve, { matches: matches.slice(0, maxResults) });
    });
    worker.once('error', (e) => finish(reject, e));
  });
}

module.exports = { regexScan, REGEX_TIMEOUT_MS, REGEX_MAX_PATTERN };
