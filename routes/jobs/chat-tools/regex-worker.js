'use strict';
// Worker für search_passages mit regex=true: das Muster kommt vom Modell und kann
// katastrophal backtracken ((a|aa)+b auf einem langen Abschnitt). Im Server-Prozess
// blockierte ein einziges `exec` den Event-Loop für alle User; hier beendet der
// Aufrufer (./regex-scan.js) den Worker nach seinem Zeitdeckel.
//
// workerData: { source, flags, texts: string[], maxResults }
// Nachrichten: { matches: [{ t, index, len, text }] } je Abschnitt mit Treffern
//              (t = Index in `texts`) — so kommen die Treffer bis zu einem
//              hängenden Abschnitt auch bei Zeitüberschreitung an —, am Ende { done: true }.

const { parentPort, workerData } = require('node:worker_threads');

const { source, flags, texts, maxResults } = workerData;
const re = new RegExp(source, flags);
let found = 0;
outer: for (let t = 0; t < texts.length; t++) {
  const text = texts[t];
  const matches = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ t, index: m.index, len: m[0].length, text: m[0] });
    found++;
    if (found >= maxResults) { parentPort.postMessage({ matches }); break outer; }
    if (m[0].length === 0) re.lastIndex++;
  }
  if (matches.length) parentPort.postMessage({ matches });
}
parentPort.postMessage({ done: true });
