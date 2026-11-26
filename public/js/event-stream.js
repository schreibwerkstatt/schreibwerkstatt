// Event-Stream (SSE, GET /events/stream) — Push-Kanal über dem Polling.
//
// Eine EventSource pro Tab, zwei Kanäle:
//   Jobs  Konsumenten sind `startPoll` (cards/job-helpers.js) und der
//         Job-Queue-Footer (app/app-jobs-core.js).
//   Buch  Abo auf das offene Buch (`setEventStreamBook`), Konsument ist die
//         Collab-Schicht (app/app-collab-stream.js). Das Abo steckt in der URL —
//         ein Buchwechsel baut die Verbindung neu auf.
//
// Alle Konsumenten pollen weiter, solange der Stream nicht offen ist, und fahren
// bei offenem Stream nur noch einen seltenen Sicherheits-Tick — der Stream
// beschleunigt, er ersetzt nichts: nach einem Reconnect liefert der Server die
// Queue-Liste neu, Job-Abonnenten bekommen `null` als Signal „nachholen" (ein
// /jobs/:id-Tick), Buch-Abonnenten ein `{ reconnect: true }`.
//
// Session-Ablauf: der Server antwortet dann mit 401, die EventSource geht auf
// CLOSED und versucht es selbst nicht mehr. Das Polling läuft wieder im
// normalen Takt und trifft den 401 über den zentralen fetch-Wrapper (app.js) —
// der Stream braucht darum kein eigenes session-expired-Handling.

import { getDeviceId } from './device-id.js';
import { getTabId } from './tab-id.js';

const RETRY_AFTER_CLOSE_MS = 30_000;

const jobListeners = new Map(); // jobId → Set<cb(snapshot|null)>
const queueListeners = new Set(); // cb(items)
const bookListeners = new Set(); // cb({ changed, presence, meta } | { gone } | { reconnect })
let es = null;
let open = false;
let started = false;
let retryTimer = null;
let bookId = null; // gewünschtes Abo
let connectedBook = null; // Abo in der URL der laufenden Verbindung
let resubscribeQueued = false;
let subscribedBook = null; // vom Server bestätigtes Abo (`hello`)
let lastHelloBook = null; // Buch des letzten `hello` — trennt Reconnect von Buchwechsel

function _parse(data) {
  try { return JSON.parse(data); } catch { return null; }
}

function _url() {
  if (!bookId) return '/events/stream';
  const params = new URLSearchParams({ book_id: String(bookId), device_id: getDeviceId(), tab_id: getTabId() });
  return '/events/stream?' + params.toString();
}

function _connect() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  connectedBook = bookId;
  const src = new EventSource(_url());
  es = src;
  src.addEventListener('open', () => {
    if (es !== src) return;
    open = true;
    for (const set of jobListeners.values()) for (const cb of [...set]) cb(null);
  });
  src.addEventListener('error', () => {
    if (es !== src) return;
    open = false;
    subscribedBook = null;
    // CONNECTING = Browser reconnectet selbst. CLOSED = Server hat mit
    // Nicht-200 geantwortet (401, 5xx, Proxy) — selbst später neu versuchen.
    if (src.readyState === EventSource.CLOSED) {
      es = null;
      retryTimer = setTimeout(_connect, RETRY_AFTER_CLOSE_MS);
    }
  });
  src.addEventListener('hello', (e) => {
    if (es !== src) return;
    const data = _parse(e.data);
    subscribedBook = data?.book ? Number(data.book) : null;
    // Nur ein Wieder-Verbinden zum SELBEN Buch muss nachholen — beim Buchwechsel
    // liest die Collab-Schicht ohnehin frisch.
    const again = !!subscribedBook && subscribedBook === lastHelloBook;
    lastHelloBook = subscribedBook;
    if (again) for (const cb of [...bookListeners]) cb({ reconnect: true });
  });
  src.addEventListener('job', (e) => {
    const job = _parse(e.data);
    const set = job && jobListeners.get(job.id);
    if (set) for (const cb of [...set]) cb(job);
  });
  src.addEventListener('queue', (e) => {
    const items = _parse(e.data);
    if (Array.isArray(items)) for (const cb of [...queueListeners]) cb(items);
  });
  src.addEventListener('book', (e) => {
    if (es !== src || !subscribedBook) return;
    const data = _parse(e.data);
    if (!data) return;
    if (data.gone) subscribedBook = null;
    for (const cb of [...bookListeners]) cb(data);
  });
}

// Vor dem Entladen selbst schliessen: Firefox meldet eine beim Reload/Wegnavigieren
// noch offene EventSource sonst als Konsolen-Fehler („connection … was
// interrupted while the page was loading"), und zwar schon bevor `pagehide`
// feuert — deshalb `beforeunload`. Bleibt die Seite doch (Navigation abgebrochen,
// z.B. Rückfrage bei ungespeicherten Änderungen), verbindet der Timer neu; beim
// echten Entladen läuft er nie. Aus dem bfcache zurück baut `pageshow` neu auf.
const REOPEN_AFTER_CANCELLED_UNLOAD_MS = 2000;

function _closeForUnload() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (!es) return;
  es.close();
  es = null;
  open = false;
  subscribedBook = null;
}

export function startEventStream() {
  if (started || typeof EventSource === 'undefined') return;
  started = true;
  window.addEventListener('beforeunload', () => {
    _closeForUnload();
    setTimeout(() => { if (!es) _connect(); }, REOPEN_AFTER_CANCELLED_UNLOAD_MS);
  });
  window.addEventListener('pagehide', _closeForUnload);
  window.addEventListener('pageshow', (e) => { if (e.persisted && !es) _connect(); });
  // Erst nach `load` verbinden: die Buchwahl fällt meist noch in den Boot, und
  // eine während des Ladens wieder geschlossene EventSource meldet Firefox
  // ebenfalls als Konsolen-Fehler. Bis dahin sammelt `setEventStreamBook` nur
  // das Abo ein — die erste Verbindung trägt es gleich in der URL.
  if (document.readyState === 'complete') _connect();
  else window.addEventListener('load', () => { if (!es) _connect(); }, { once: true });
}

// Buch-Abo setzen (null = kein Buch). Baut die Verbindung neu auf, wenn sie
// schon läuft; vor `startEventStream` merkt es sich nur das Buch. Wechsel
// innerhalb eines Ticks (Teardown + Neustart desselben Buchs) werden zu einem
// zusammengefasst — nur ein tatsächlich anderes Buch kostet einen Reconnect.
export function setEventStreamBook(id) {
  bookId = id ? Number(id) : null;
  if (resubscribeQueued) return;
  resubscribeQueued = true;
  queueMicrotask(() => {
    resubscribeQueued = false;
    if (!started || !es || bookId === connectedBook) return;
    es.close();
    es = null;
    open = false;
    subscribedBook = null;
    _connect();
  });
}

export function jobStreamOpen() {
  return open;
}

// true, solange der Stream offen ist UND der Server das Abo auf genau dieses
// Buch bestätigt hat.
export function bookStreamOpen(id) {
  return open && !!id && subscribedBook === Number(id);
}

// cb(snapshot) bei jeder Änderung des Jobs (ohne `result`), cb(null) nach
// (Re-)Connect. Liefert die Abmelde-Funktion.
export function onJobStream(jobId, cb) {
  const key = String(jobId);
  let set = jobListeners.get(key);
  if (!set) { set = new Set(); jobListeners.set(key, set); }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (!set.size && jobListeners.get(key) === set) jobListeners.delete(key);
  };
}

// cb(items) mit derselben Liste wie GET /jobs/queue.
export function onJobQueueStream(cb) {
  queueListeners.add(cb);
  return () => queueListeners.delete(cb);
}

// cb(event) für Anstösse des Buch-Kanals. Liefert die Abmelde-Funktion.
export function onBookStream(cb) {
  bookListeners.add(cb);
  return () => bookListeners.delete(cb);
}
