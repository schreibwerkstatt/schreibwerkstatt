// Offline vorgemerkte Strukturänderungen: Abschnitt anlegen, Abschnitt und
// Kapitel umbenennen. Schreibt contentRepo (./content.js) einen dieser Writes
// und erreicht den Server nicht (Netzfehler VOR der Zustellung, `TypeError`),
// landet er hier statt im Fehler — die Oberfläche arbeitet mit dem
// angenommenen Ergebnis weiter, die Reconnect-Outbox (app/app-outbox.js)
// spielt die Warteschlange beim Wiederverbinden in Reihenfolge ab.
//
// Ein offline angelegter Abschnitt bekommt eine negative, temporäre ID. Sein
// Inhalt lebt bis zum Abspielen in der Anlege-Operation selbst (contentRepo
// leitet Saves, Umbenennen und Löschen einer temporären ID hierher um); beim
// Abspielen entsteht er mit diesem Inhalt in einem einzigen POST, und der
// Aufrufer zieht die echte ID überall nach (`remaps`).
//
// Bewusst NICHT vorgemerkt: Kapitel anlegen, Löschen, Verschieben,
// Umsortieren. Sie greifen in den Baum anderer Geräte ein und liessen sich
// gegen einen inzwischen veränderten Server-Baum nicht verlustfrei
// nachspielen — offline scheitern sie wie bisher mit Fehlermeldung.
//
// Nicht zugestellt heisst: Netzfehler, Timeout oder SW-503 `offline`
// (utils/net.js#isNetworkError). Auch ein Request, der angekommen ist und
// dessen Antwort verloren ging, sieht so aus — darum trägt jedes Anlegen einen
// `Idempotency-Key` (`opKey`, schon beim ersten Versuch, lib/idempotency.js):
// das Nachspielen bekommt die erste Antwort zurück, statt doppelt anzulegen.
//
// ID-ZUORDNUNG: Nach dem Abspielen hält `resolveTempId` die echte ID einer
// temporären fest (localStorage je Konto, 30 Tage). contentRepo leitet damit
// Saves/Lesen/Löschen einer temporären ID weiter, die erst nach dem Anlegen
// ankommen — aus diesem Tab (Autosave zwischen POST und Umbenennung), aus
// einem anderen Tab, der die echte ID nie mitbekommen hat, oder aus einem
// Undo im Buchorganizer. Die Ideen-Warteschlange schreibt damit eine Idee an
// einem offline angelegten Abschnitt um, auch in einem späteren Durchgang.
//
// ABGEWIESEN: 401 hält das Abspielen an (Sitzung abgelaufen — nach dem Login
// geht es weiter, nichts fällt). Ein abgewiesenes Anlegen bleibt mit Inhalt als
// `stuck` liegen; `retryStuckStructureOps` gibt es wieder frei,
// `discardStructureOp` verwirft es auf ausdrücklichen Wunsch (Dialog
// „Nicht gespeichert", app/app-outbox.js).
import { lsGetJSON, lsSetJSON, lsRemove } from '../safe-storage.js';
import { EVT } from '../events.js';
import { openIdbStore } from '../shared/idb-store.js';
import { isNetworkError } from '../utils/net.js';
import { uuid } from '../utils/uuid.js';

// ── Ablage ──────────────────────────────────────────────────────────────────
// IndexedDB, eine Operation je Datensatz (`qid`), dazu ein synchroner Spiegel
// im Speicher: die Aufrufer (contentRepo, Outbox-Zähler, Baum-Überlagerung)
// lesen synchron, der Start füllt den Spiegel (`whenStructureQueueReady`),
// andere Tabs führen ihn per BroadcastChannel nach.
// **Why IndexedDB:** ein offline angelegter Abschnitt trägt seinen ganzen Text
// in der Operation — in localStorage (wenige MB je Origin, geteilt mit allem
// anderen) scheiterte das Vormerken genau bei längeren Texten, und der Abschnitt
// war weg. Je Operation ein Datensatz, damit zwei Tabs sich nicht gegenseitig
// die ganze Liste überschreiben.
// Ohne IndexedDB (Node-Tests, gesperrter Speicher) bleibt localStorage die
// Ablage (eine Liste je Konto, `structure_queue_u:<email>`); dieselben Schlüssel
// liest der Start beim Umzug nach IndexedDB ein und räumt sie danach.

export const STRUCTURE_QUEUE_DB = 'schreibwerkstatt-structure-queue';
const STORE = 'ops';
const CHANNEL = 'schreibwerkstatt-structure-queue';
const LS_PREFIX = 'structure_queue_u:';
const KEY = (owner) => `${LS_PREFIX}${owner || '-'}`;
const LOCK = 'structure-queue';
const REMAP_PREFIX = 'structure_remaps_u:';
const REMAP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let _owner = null;
let _idb = null;
let _idbOk = false;
let _ready = Promise.resolve();
let _mirror = new Map(); // qid → Operation (alle Konten)
let _chan = null;
let _seq = 0;

// Konto wie bei den Entwürfen (editor/draft-storage.js#setDraftOwner): die
// Warteschlange eines Kontos spielt nie unter einem anderen ab.
export function setStructureOwner(email) {
  _owner = email || null;
}

function _announce(queued) {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVT.STRUCTURE_QUEUE_CHANGED, { detail: { queued } }));
  } catch { /* Node-Tests */ }
}

function _channel() {
  if (_chan || typeof BroadcastChannel === 'undefined') return _chan;
  try { _chan = new BroadcastChannel(CHANNEL); } catch { _chan = null; }
  return _chan;
}

function _broadcast(msg) {
  try { _channel()?.postMessage(msg); } catch { /* nur Komfort: andere Tabs sehen es beim nächsten Start */ }
}

function _nextSeq() {
  _seq = Math.max(_seq + 1, Date.now() * 1000);
  return _seq;
}

// Liegengebliebene localStorage-Listen (Alt-Ablage oder Rückfall nach einem
// gescheiterten IndexedDB-Write) nach IndexedDB; die Kopie fällt erst nach der
// Bestätigung.
async function _migrateLegacy() {
  const ls = (() => { try { return globalThis.localStorage || null; } catch { return null; } })();
  if (!ls) return;
  const keys = [];
  for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k?.startsWith(LS_PREFIX)) keys.push(k); }
  for (const k of keys) {
    const owner = k.slice(LS_PREFIX.length);
    const list = lsGetJSON(k, []);
    if (!Array.isArray(list)) { lsRemove(k); continue; }
    try {
      for (const op of list) {
        if (!op?.qid || _mirror.has(op.qid)) continue;
        const rec = { ...op, owner: owner === '-' ? null : owner, seq: _nextSeq() };
        await _idb.put(rec);
        _mirror.set(rec.qid, rec);
      }
      lsRemove(k);
    } catch (e) { console.warn('[structure-queue] Umzug nach IndexedDB gescheitert, localStorage bleibt', e); }
  }
}

function _onMessage(msg) {
  if (msg?.type === 'put' && msg.op?.qid) _mirror.set(msg.op.qid, msg.op);
  else if (msg?.type === 'del') _mirror.delete(msg.qid);
  else return;
  _announce(false);
}

// Einmal beim Laden des Moduls (unten). Tests reichen eine Attrappe herein
// ({ usable, getAll, put, del }).
export function initStructureQueue(store = openIdbStore(STRUCTURE_QUEUE_DB, STORE, { keyPath: 'qid' })) {
  _idb = store;
  _idbOk = false;
  _mirror = new Map();
  if (!store.usable()) { _ready = Promise.resolve(); return _ready; }
  _ready = (async () => {
    for (const op of (await store.getAll()) || []) if (op?.qid) _mirror.set(op.qid, op);
    _seq = Math.max(_seq, ...[..._mirror.values()].map((o) => o.seq || 0));
    _idbOk = true;
    await _migrateLegacy();
    const ch = _channel();
    if (ch) ch.onmessage = (e) => _onMessage(e.data);
    _announce(false);
  })().catch((e) => {
    _idbOk = false;
    console.warn('[structure-queue] IndexedDB nicht lesbar, localStorage bleibt Ablage', e);
  });
  return _ready;
}

// Vor dem ersten Lesen nach dem Start abwarten (app-init, wie whenDraftsReady).
export function whenStructureQueueReady() { return _ready; }

function _load() {
  if (!_idbOk) {
    const q = lsGetJSON(KEY(_owner), []);
    return Array.isArray(q) ? q : [];
  }
  return [..._mirror.values()]
    .filter((o) => (o.owner ?? null) === _owner)
    .sort((a, b) => a.seq - b.seq)
    .map((o) => structuredClone(o));
}

// `queued`: eine Änderung wurde neu vorgemerkt (die Oberfläche sagt es an).
// Mit IndexedDB: Spiegel sofort (die Aufrufer lesen synchron weiter), Ablage im
// Hintergrund — nur geänderte Operationen werden geschrieben, entfernte gelöscht.
// Scheitert ein Write, landet die Liste des Kontos als Rückfall in localStorage;
// der nächste Start zieht sie wieder um.
function _save(q, { queued = false } = {}) {
  let ok = true;
  if (!_idbOk) {
    ok = lsSetJSON(KEY(_owner), q);
  } else {
    const before = new Map(_load().map((o) => [o.qid, o]));
    for (const op of q) {
      const rec = { ...op, owner: _owner, seq: op.seq || _nextSeq() };
      const prev = before.get(op.qid);
      before.delete(op.qid);
      if (prev && JSON.stringify(prev) === JSON.stringify(rec)) continue;
      _mirror.set(rec.qid, rec);
      _idb.put(rec).then(() => _broadcast({ type: 'put', op: rec })).catch((e) => _fallback(e));
    }
    for (const qid of before.keys()) {
      _mirror.delete(qid);
      _idb.del(qid).then(() => _broadcast({ type: 'del', qid })).catch((e) => _fallback(e));
    }
  }
  _announce(queued && ok);
  return ok;
}

function _fallback(e) {
  console.warn('[structure-queue] IndexedDB-Write gescheitert, Liste geht nach localStorage', e);
  lsSetJSON(KEY(_owner), _load());
}

export const isTempId = (id) => Number(id) < 0;

// Nicht zugestellt (Netz weg, Timeout, SW-503 `offline`) — Regel in utils/net.js.
export const isUndelivered = isNetworkError;

const _qid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// Idempotenz-Schlüssel eines Anlege-Requests (Header `Idempotency-Key`).
export function newOpKey() {
  return `op-${uuid()}`;
}

// ── Zuordnung temporär → echt ───────────────────────────────────────────────

const REMAP_KEY = () => `${REMAP_PREFIX}${_owner || '-'}`;

function _remapTable() {
  const t = lsGetJSON(REMAP_KEY(), {});
  return t && typeof t === 'object' ? t : {};
}

function _rememberRemap(tempId, realId) {
  const now = Date.now();
  const t = _remapTable();
  for (const [k, v] of Object.entries(t)) if (!(now - (v?.at || 0) < REMAP_TTL_MS)) delete t[k];
  t[String(tempId)] = { id: Number(realId), at: now };
  lsSetJSON(REMAP_KEY(), t);
}

// Echte ID eines offline angelegten Abschnitts, sobald er auf dem Server ist;
// sonst null.
export function resolveTempId(tempId) {
  const hit = _remapTable()[String(Number(tempId))];
  return hit && Number(hit.id) > 0 ? Number(hit.id) : null;
}

// Liegt das Anlegen dieses temporären Abschnitts noch in der Warteschlange
// (auch `stuck`)? Dann wartet, was ihn adressiert.
export function isTempPagePending(tempId) {
  return !!_createOp(_load(), tempId);
}

export function newTempId() {
  return -(Date.now() * 1000 + Math.floor(Math.random() * 1000));
}

// Wartend = wird von selbst gesendet. Abgewiesene (`stuck`) zählen nicht —
// sie stehen im Dialog „Nicht gespeichert" (app/app-offline-rescue.js).
export function pendingStructureCount() {
  return _load().filter((o) => !o.stuck).length;
}

// Anlege-Operationen, die der Server abgewiesen hat (auch ohne Kapitel). Ihr
// Inhalt bleibt liegen, bis der User ihn rettet — er wird nie still verworfen.
export function stuckStructureOps() {
  return _load().filter((o) => o.stuck);
}

// Abgewiesene Operationen wieder zum Abspielen freigeben (Dialog „Nicht
// gespeichert": „Erneut versuchen", z.B. nach Wiederherstellen des Kapitels).
export function retryStuckStructureOps() {
  const q = _load();
  if (!q.some((o) => o.stuck)) return false;
  return _save(q.map((o) => { const { stuck, ...rest } = o; return rest; }));
}

// Eine Operation ausdrücklich verwerfen (nach Rückfrage im Dialog).
export function discardStructureOp(qid) {
  const q = _load();
  const next = q.filter((o) => o.qid !== qid);
  return next.length !== q.length ? _save(next) : false;
}

function _createOp(q, tempId) {
  return q.find((o) => o.op === 'createPage' && o.tempId === Number(tempId)) || null;
}

// Antwortform wie POST /content/pages, mit `pending: true`.
function _syntheticPage(op) {
  const b = op.body;
  return {
    id: op.tempId, name: b.name, chapter_id: b.chapter_id ?? null, book_id: b.book_id ?? null,
    html: b.html || '', updated_at: null, position: null, pending: true,
  };
}

// Liefert die angenommene Seite oder null, wenn die Warteschlange nicht
// geschrieben werden konnte (dann wirft der Aufrufer den Originalfehler).
// `bookId`: Buch, in dem der Abschnitt entsteht — Rückfall, falls das Kapitel
// beim Abspielen nicht mehr existiert.
// `opKey`: Idempotenz-Schlüssel des ersten (gescheiterten) Versuchs — kam der
// doch an, liefert das Nachspielen dessen Abschnitt statt eines zweiten.
export function queueCreatePage(body, { bookId = null, opKey = null } = {}) {
  const q = _load();
  const op = { qid: _qid(), op: 'createPage', tempId: newTempId(), opKey: opKey || newOpKey(), body: { ...body }, bookId: body.book_id ?? bookId, at: Date.now() };
  q.push(op);
  return _save(q, { queued: true }) ? _syntheticPage(op) : null;
}

// Alle vorgemerkten Operationen (Reihenfolge des Abspielens) — für das
// Überlagern des Baums nach einem Neuladen ohne Netz.
export function pendingStructureOps() {
  return _load().map((o) => (o.op === 'createPage' ? { ...o, page: _syntheticPage(o) } : { ...o }));
}

export function pendingPage(tempId) {
  const op = _createOp(_load(), tempId);
  return op ? _syntheticPage(op) : null;
}

// Inhalt/Name einer temporären Seite ändern (Save, Umbenennen).
export function patchPendingPage(tempId, patch) {
  const q = _load();
  const op = _createOp(q, tempId);
  if (!op) return null;
  for (const k of ['name', 'html']) if (typeof patch[k] === 'string') op.body[k] = patch[k];
  return _save(q) ? _syntheticPage(op) : null;
}

export function dropPendingPage(tempId) {
  const q = _load();
  const next = q.filter((o) => !(o.op === 'createPage' && o.tempId === Number(tempId)));
  if (next.length !== q.length) _save(next);
}

// Online umbenannt: eine ältere, noch vorgemerkte Umbenennung desselben
// Objekts ist überholt — der verspätete Flush spielte sonst den alten Namen
// über den neuen.
export function dropQueuedRename(kind, id) {
  const q = _load();
  const next = q.filter((o) => !(o.op === 'rename' && o.kind === kind && o.id === Number(id)));
  if (next.length !== q.length) _save(next);
}

// Umbenennen einer echten Seite bzw. eines Kapitels. Mehrfaches Umbenennen
// desselben Objekts fällt zusammen — gesendet wird der letzte Name.
export function queueRename(kind, id, name, { bookId = null } = {}) {
  const q = _load().filter((o) => !(o.op === 'rename' && o.kind === kind && o.id === Number(id)));
  q.push({ qid: _qid(), op: 'rename', kind, id: Number(id), name, bookId, at: Date.now() });
  return _save(q, { queued: true });
}

// Spielt die Warteschlange in Reihenfolge ab. `send(op)` führt den echten
// Write aus und liefert bei `createPage` die angelegte Seite. Nach jedem
// Erfolg wird die Operation entfernt (ein Abbruch spielt nichts doppelt).
// Liefert { remaps: [{ tempId, page }], done, dropped, stuck, offline, retry, auth }.
//  - Netz weg (`isUndelivered`) → Abbruch, Rest bleibt (`offline`).
//  - 429/5xx → Abbruch, Rest bleibt (`retry`): vorübergehend.
//  - 401 → Abbruch, Rest bleibt (`auth`): nach dem Login geht es weiter.
//  - Umbenennen abgewiesen (4xx: gelöscht, kein Recht) → fällt (`dropped`) —
//    verloren ist nur ein Name, der Inhalt hängt nicht daran.
//  - Anlegen abgewiesen (4xx, meist: Kapitel inzwischen gelöscht) → einmal als
//    Abschnitt ohne Kapitel im selben Buch; scheitert auch das, bleibt die
//    Operation mit ihrem Inhalt als `stuck` liegen und wird übersprungen.
export async function flushStructureQueue(send) {
  const run = async () => {
    const out = { remaps: [], done: 0, dropped: 0, stuck: 0, offline: false, retry: false, auth: false };
    const skip = new Set();
    for (;;) {
      const op = _load().find((o) => !o.stuck && !skip.has(o.qid));
      if (!op) break;
      let res = null;
      let err = null;
      try { res = await send(op); } catch (e) { err = e; }
      if (err && op.op === 'createPage' && !isUndelivered(err) && err.status < 500 && err.status !== 429 && err.status !== 401 && op.body.chapter_id != null && op.bookId != null) {
        const solo = { ...op, body: { ...op.body, chapter_id: null, book_id: op.bookId } };
        try { res = await send(solo); err = null; } catch (e2) { err = e2; }
      }
      if (err) {
        if (isUndelivered(err)) { out.offline = true; break; }
        if (!(err.status < 500) || err.status === 429) { out.retry = true; break; }
        if (err.status === 401) { out.auth = true; break; }
        console.warn('[structure-queue] Operation abgewiesen', { op: op.op, kind: op.kind, status: err.status, code: err.code });
        if (op.op === 'createPage') {
          _save(_load().map((o) => (o.qid === op.qid ? { ...o, stuck: err.status || true } : o)));
          out.stuck++;
          skip.add(op.qid);
          continue;
        }
        out.dropped++;
      } else {
        if (op.op === 'createPage' && res?.id) {
          // Vor dem Entfernen der Operation: wer die temporäre ID danach noch
          // adressiert, findet die echte (resolveTempId).
          _rememberRemap(op.tempId, res.id);
          // Lokaler Save/Rename, der während des POST noch in die Operation lief.
          const after = _createOp(_load(), op.tempId);
          const remap = { tempId: op.tempId, page: res };
          if (after && after.body.html !== op.body.html) remap.lateHtml = after.body.html;
          if (after && after.body.name !== op.body.name) remap.lateName = after.body.name;
          out.remaps.push(remap);
        }
        out.done++;
      }
      _save(_load().filter((o) => o.qid !== op.qid));
    }
    out.stuck = stuckStructureOps().length;
    return out;
  };
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(LOCK, run) : run();
}

initStructureQueue();
