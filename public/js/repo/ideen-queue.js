// Offline vorgemerkte Ideen-Writes: anlegen, Text ändern, Stufe setzen,
// zuordnen/verschieben, löschen. Erreicht einer dieser Writes den Server nicht
// (Netzfehler VOR der Zustellung), landet er hier in IndexedDB statt im
// Fehler — Ideen-Karte und Ideen-Board arbeiten mit dem angenommenen Ergebnis
// weiter, die Reconnect-Outbox (app/app-outbox.js) spielt die Warteschlange
// beim Wiederverbinden in Reihenfolge ab (`flushIdeenQueue`).
//
// WARUM: eine Pendenz fällt einem im Zug ein, und genau dort ist kein Netz.
// Ohne Warteschlange stand dann „Speichern fehlgeschlagen" und der Einfall war
// weg. Lesen deckt der Service Worker ab (public/sw-domain.js, Netz zuerst mit
// Rückfall); nach einem Neuladen ohne Netz legt `overlayPendingIdeen` die
// vorgemerkten Writes über die gecachte Liste.
//
// IndexedDB statt localStorage: die Warteschlange hält Freitext beliebiger
// Menge und muss Speicherdruck und `storage.persist()` mit den Entwürfen teilen
// (editor/draft-idb.js), nicht mit Einstellungen.
//
// Eine offline angelegte Idee bekommt eine negative, temporäre ID. Ändern oder
// Löschen einer temporären Idee schreibt in ihre Anlege-Operation; mehrere
// Änderungen derselben echten Idee fallen zu einer zusammen (zuletzt gesetzt
// gewinnt — derselbe Vertrag wie online, der PATCH kennt keinen Stempel).
//
// Bewusst NICHT vorgemerkt: Verknüpfungen, Reihenfolge im Board, Stufen-
// Einstellungen — sie hängen an Objekten, die es beim Abspielen nicht mehr
// geben muss, und scheitern offline wie bisher mit Fehlermeldung.
//
// Nicht zugestellt heisst: Netzfehler, Timeout oder SW-503 `offline`
// (utils/net.js#isNetworkError). Auch ein angekommener Request mit verlorener
// Antwort sieht so aus — darum trägt jedes Anlegen schon beim ersten Versuch
// einen `Idempotency-Key` (lib/idempotency.js), und das Nachspielen legt nicht
// doppelt an.
//
// OFFLINE ANGELEGTE ABSCHNITTE: Eine Idee an einem Abschnitt mit temporärer
// ID wartet, bis dessen Anlegen abgespielt ist, und bekommt dann die echte ID
// (repo/structure-queue.js#resolveTempId) — auch in einem späteren Durchgang
// und auch beim Verschieben (PATCH). Nie geht eine negative ID an den Server.
//
// ABGEWIESEN: 401 hält das Abspielen an (nach dem Login geht es weiter). Ein
// abgewiesenes Anlegen versucht es einmal als Buch-Idee; scheitert auch das,
// bleibt es mit Text als `stuck` liegen (Dialog „Nicht gespeichert",
// app/app-outbox.js) — ein Einfall fällt nie still weg. Eine zusammengelegte
// Änderung, die der Server ablehnt, geht Feld für Feld noch einmal: fällt nur,
// was er wirklich ablehnt (z.B. das Verschieben), nicht der neue Text daneben.
import { fetchJson, isNetworkError } from '../utils.js';
import { EVT } from '../events.js';
import { openIdbStore } from '../shared/idb-store.js';
import { isTempId as isTempPageId, isTempPagePending, newOpKey, resolveTempId } from './structure-queue.js';

export const IDEEN_QUEUE_DB = 'schreibwerkstatt-ideen-queue';
const STORE = 'ops';
const LOCK = 'ideen-queue';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let _owner = null;
let _store = null;
let _seq = 0;

// Konto wie bei den Entwürfen: die Warteschlange eines Kontos spielt nie unter
// einem anderen ab.
export function setIdeenQueueOwner(email) { _owner = email || null; }

// Nicht zugestellt (Netz weg, Timeout, SW-503 `offline`) — Regel in utils/net.js.
export const isUndelivered = isNetworkError;

export const isTempIdeeId = (id) => Number(id) < 0;

// ── Ablage ──────────────────────────────────────────────────────────────────

// Tests reichen eine Attrappe herein ({ usable, getAll, put, del }).
export function initIdeenQueue(store = openIdbStore(IDEEN_QUEUE_DB, STORE, { keyPath: 'qid' })) { _store = store; }

function _usable() {
  if (!_store) initIdeenQueue();
  return !!_owner && _store.usable();
}

async function _load() {
  if (!_usable()) return [];
  const all = await _store.getAll();
  return (all || []).filter((o) => o.owner === _owner).sort((a, b) => a.seq - b.seq);
}

function _announce(detail) {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVT.IDEEN_QUEUE_CHANGED, { detail }));
  } catch { /* Node-Tests */ }
}

function _nextSeq() {
  _seq = Math.max(_seq + 1, Date.now() * 1000);
  return _seq;
}

function _newOp(fields) {
  const seq = _nextSeq();
  return { qid: `${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, seq, owner: _owner, at: Date.now(), ...fields };
}

const _nowIso = () => new Date().toISOString();

// Antwortform wie POST /ideen, mit `pending: true`.
function _syntheticRow(op) {
  const b = op.body;
  return {
    id: op.tempId, book_id: b.book_id, page_id: b.page_id ?? null, page_name: null,
    chapter_id: b.chapter_id ?? null, chapter_name: null, content: b.content,
    status: b.status || 'offen', status_at: null, sort_order: 0,
    created_at: op.createdAt, updated_at: op.createdAt, links: [], pending: true,
  };
}

// Schreibt die Warteschlange unter dem Lock, damit ein laufendes Abspielen und
// ein neuer Write sich nicht gegenseitig überschreiben.
function _locked(fn) {
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(LOCK, fn) : fn();
}

// ── Schreibwege (Ideen-Karte, Ideen-Board) ──────────────────────────────────

// POST /ideen. Ohne Netz: vorgemerkt, Rückgabe ist die angenommene Zeile.
export async function createIdee(body) {
  const opKey = newOpKey();
  try {
    // Abschnitt selbst noch offline angelegt: gar nicht erst senden.
    if (isTempPageId(body?.page_id) && !resolveTempId(body.page_id)) throw Object.assign(new TypeError('page pending'), { status: 0 });
    const sent = isTempPageId(body?.page_id) ? { ...body, page_id: resolveTempId(body.page_id) } : body;
    return await fetchJson('/ideen', { method: 'POST', headers: { ...JSON_HEADERS, 'Idempotency-Key': opKey }, body: JSON.stringify(sent) });
  } catch (e) {
    if (!isUndelivered(e) || !_usable()) throw e;
    const tempId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000));
    const op = _newOp({ op: 'create', tempId, opKey, createdAt: _nowIso(), body: { ...body } });
    try { await _locked(() => _store.put(op)); } catch { throw e; }
    _announce({ queued: true });
    return _syntheticRow(op);
  }
}

// PATCH /ideen/:id. `idee` ist die aktuelle Zeile (für die angenommene Antwort).
export async function patchIdee(idee, fields) {
  if (isTempIdeeId(idee.id)) return _patchPendingCreate(idee, fields);
  try {
    if (isTempPageId(fields?.page_id) && !resolveTempId(fields.page_id)) throw Object.assign(new TypeError('page pending'), { status: 0 });
    const sent = isTempPageId(fields?.page_id) ? { ...fields, page_id: resolveTempId(fields.page_id) } : fields;
    const row = await fetchJson(`/ideen/${idee.id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(sent) });
    await _dropSuperseded(Number(idee.id), Object.keys(fields || {}));
    return row;
  } catch (e) {
    if (!isUndelivered(e) || !_usable()) throw e;
    try {
      await _locked(async () => {
        const prev = (await _load()).find((o) => o.op === 'patch' && o.id === Number(idee.id));
        const op = prev ? { ...prev, fields: _withFields(prev.fields, fields) } : _newOp({ op: 'patch', id: Number(idee.id), bookId: idee.book_id ?? null, fields: { ...fields } });
        await _store.put(op);
      });
    } catch { throw e; }
    _announce({ queued: true });
    return _assumePatched(idee, fields);
  }
}

// DELETE /ideen/:id.
export async function deleteIdee(idee) {
  if (isTempIdeeId(idee.id)) {
    await _locked(async () => {
      const op = (await _load()).find((o) => o.op === 'create' && o.tempId === Number(idee.id));
      if (op) await _store.del(op.qid);
    });
    _announce({ queued: false });
    return { ok: true };
  }
  try {
    return await fetchJson(`/ideen/${idee.id}`, { method: 'DELETE' });
  } catch (e) {
    if (!isUndelivered(e) || !_usable()) throw e;
    try {
      await _locked(async () => {
        // Vorgemerkte Änderungen derselben Idee sind mit dem Löschen hinfällig.
        for (const o of await _load()) if (o.op === 'patch' && o.id === Number(idee.id)) await _store.del(o.qid);
        await _store.put(_newOp({ op: 'delete', id: Number(idee.id), bookId: idee.book_id ?? null }));
      });
    } catch { throw e; }
    _announce({ queued: true });
    return { ok: true, pending: true };
  }
}

// Ein Online-Write hat Felder gesetzt, die eine ältere vorgemerkte Änderung
// derselben Idee auch trägt: diese Felder fallen dort heraus — sonst spielte
// der verspätete Flush den älteren Stand über den neueren.
async function _dropSuperseded(id, keys) {
  if (!_usable() || !keys.length) return;
  try {
    await _locked(async () => {
      for (const o of await _load()) {
        if (o.op !== 'patch' || o.id !== id) continue;
        const fields = { ...o.fields };
        for (const k of keys) delete fields[k];
        if ('page_id' in (o.fields || {}) && keys.includes('chapter_id')) delete fields.page_id;
        if ('chapter_id' in (o.fields || {}) && keys.includes('page_id')) delete fields.chapter_id;
        if (Object.keys(fields).length) await _store.put({ ...o, fields });
        else await _store.del(o.qid);
      }
    });
  } catch { /* nur Aufräumen */ }
}

// Ein Anker verdrängt den anderen (Umzug Abschnitt ↔ Kapitel): sonst trügen
// zusammengeführte Felder beide, und der Server lehnte mit INVALID_SCOPE ab.
function _withFields(base, fields) {
  const out = { ...base, ...fields };
  if ('page_id' in fields && !('chapter_id' in fields)) delete out.chapter_id;
  if ('chapter_id' in fields && !('page_id' in fields)) delete out.page_id;
  return out;
}

function _assumePatched(idee, fields) {
  const row = { ...idee, ...fields, pending: true };
  if ('page_id' in fields && !('chapter_id' in fields)) row.chapter_id = null;
  if ('chapter_id' in fields && !('page_id' in fields)) row.page_id = null;
  if (fields.status && fields.status !== idee.status) row.status_at = _nowIso();
  return row;
}

async function _patchPendingCreate(idee, fields) {
  let row = null;
  await _locked(async () => {
    const op = (await _load()).find((o) => o.op === 'create' && o.tempId === Number(idee.id));
    if (!op) return;
    op.body = _withFields(op.body, fields);
    await _store.put(op);
    row = _syntheticRow(op);
  });
  if (!row) throw Object.assign(new Error('IDEE_NOT_FOUND'), { status: 404, code: 'IDEE_NOT_FOUND' });
  _announce({ queued: true });
  return row;
}

// ── Lesen ───────────────────────────────────────────────────────────────────

// Vorgemerkte Writes über eine Server-/Cache-Liste legen. `match(row)` sagt,
// ob eine offline angelegte Idee in diese Liste gehört (Scope der Karte bzw.
// Buch des Boards).
export async function overlayPendingIdeen(rows, match = () => true) {
  let ops;
  try { ops = await _load(); } catch { return rows; }
  if (!ops.length) return rows;
  let out = [...(rows || [])];
  for (const op of ops) {
    if (op.op === 'create') {
      const row = _syntheticRow(op);
      if (match(row) && !out.some((r) => r.id === row.id)) out = [row, ...out];
    } else if (op.op === 'patch') {
      out = out.map((r) => (r.id === op.id ? _assumePatched(r, op.fields) : r));
      if (('page_id' in op.fields || 'chapter_id' in op.fields)) out = out.filter((r) => r.id !== op.id || match(r));
    } else if (op.op === 'delete') {
      out = out.filter((r) => r.id !== op.id);
    }
  }
  return out;
}

// Wartend = wird von selbst gesendet; abgewiesene (`stuck`) zählen nicht.
export async function pendingIdeenCount() {
  try { return (await _load()).filter((o) => !o.stuck).length; } catch { return 0; }
}

// Abgewiesene Anlege-Operationen (auch als Buch-Idee). Ihr Text bleibt liegen,
// bis der User ihn rettet oder ausdrücklich verwirft.
export async function stuckIdeenOps() {
  try { return (await _load()).filter((o) => o.stuck); } catch { return []; }
}

export async function retryStuckIdeenOps() {
  if (!_usable()) return false;
  let any = false;
  await _locked(async () => {
    for (const o of await _load()) {
      if (!o.stuck) continue;
      const { stuck, ...rest } = o;
      await _store.put(rest);
      any = true;
    }
  });
  if (any) _announce({ queued: false });
  return any;
}

export async function discardIdeenOp(qid) {
  if (!_usable()) return false;
  let hit = false;
  await _locked(async () => {
    const op = (await _load()).find((o) => o.qid === qid);
    if (op) { await _store.del(op.qid); hit = true; }
  });
  if (hit) _announce({ queued: false });
  return hit;
}

// ── Abspielen ───────────────────────────────────────────────────────────────

async function _send(op) {
  if (op.op === 'create') {
    const headers = op.opKey ? { ...JSON_HEADERS, 'Idempotency-Key': op.opKey } : JSON_HEADERS;
    return fetchJson('/ideen', { method: 'POST', headers, body: JSON.stringify(op.body) });
  }
  if (op.op === 'patch') return fetchJson(`/ideen/${op.id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(op.fields) });
  return fetchJson(`/ideen/${op.id}`, { method: 'DELETE' });
}

// Temporäre Abschnitts-ID in `obj[key]` auflösen. 'wait': der Abschnitt
// liegt selbst noch in der Struktur-Warteschlange; 'gone': er wurde dort
// verworfen (Anker fällt); sonst das Objekt mit echter ID.
function _resolvePage(obj, key, pageRemap) {
  const id = obj?.[key];
  if (!isTempPageId(id)) return obj;
  const real = pageRemap?.get?.(Number(id)) || resolveTempId(id);
  if (real) return { ...obj, [key]: real };
  if (isTempPagePending(id)) return 'wait';
  return 'gone';
}

const _isRejected = (err) => !isUndelivered(err) && err.status < 500 && err.status !== 429 && err.status !== 401;

// Felder eines PATCH, die zusammen gehen müssen (Verschieben: Ziel-Abschnitt
// oder -Kapitel), als Gruppen in fester Reihenfolge: Text, Stufe, Ort.
function _patchGroups(fields) {
  const groups = [];
  if ('content' in fields) groups.push({ content: fields.content });
  if ('status' in fields) groups.push({ status: fields.status });
  const move = {};
  for (const k of ['page_id', 'chapter_id']) if (k in fields) move[k] = fields[k];
  if (Object.keys(move).length) groups.push(move);
  const known = new Set(['content', 'status', 'page_id', 'chapter_id']);
  const rest = Object.fromEntries(Object.entries(fields).filter(([k]) => !known.has(k)));
  if (Object.keys(rest).length) groups.push(rest);
  return groups;
}

// Spielt die Warteschlange in Reihenfolge ab. Nach jedem Erfolg fällt die
// Operation (ein Abbruch spielt nichts doppelt).
// `pageRemap`: temporäre → echte Abschnitts-ID (Tests; sonst
// structure-queue.js#resolveTempId).
// Liefert { done, dropped, stuck, waiting, offline, retry, auth }.
//  - Netz weg → Abbruch, Rest bleibt (`offline`); 429/5xx ebenso (`retry`),
//    401 ebenso (`auth`).
//  - Idee an einem Abschnitt, dessen Anlegen noch wartet → bleibt (`waiting`).
//  - Anlegen abgewiesen (4xx, meist: Abschnitt/Kapitel inzwischen gelöscht) →
//    einmal als Buch-Idee ohne Anker; scheitert auch das → `stuck`.
//  - Ändern abgewiesen → Feld für Feld noch einmal; was der Server weiter
//    ablehnt (Idee gelöscht, Stufe abgeschaltet, abgeschlossene Idee
//    verschoben), fällt (`dropped`). Löschen einer schon gelöschten Idee (404)
//    zählt als erledigt.
export async function flushIdeenQueue(send = _send, pageRemap = null) {
  const empty = { done: 0, dropped: 0, stuck: 0, waiting: 0, offline: false, retry: false, auth: false };
  if (!_usable()) return empty;
  return _locked(async () => {
    const out = { ...empty };
    const stopOn = (err) => {
      if (isUndelivered(err)) { out.offline = true; return true; }
      if (!(err.status < 500) || err.status === 429) { out.retry = true; return true; }
      if (err.status === 401) { out.auth = true; return true; }
      return false;
    };
    for (let op of await _load()) {
      if (op.stuck) continue;
      if (op.op === 'create') {
        const r = _resolvePage(op.body, 'page_id', pageRemap);
        if (r === 'wait') { out.waiting++; continue; }
        if (r === 'gone') { const { page_id, ...rest } = op.body; op = { ...op, body: rest }; }
        else op = { ...op, body: r };
      } else if (op.op === 'patch') {
        const r = _resolvePage(op.fields, 'page_id', pageRemap);
        if (r === 'wait') { out.waiting++; continue; }
        if (r === 'gone') { const { page_id, ...rest } = op.fields; op = { ...op, fields: rest }; }
        else op = { ...op, fields: r };
        if (!Object.keys(op.fields).length) { await _store.del(op.qid); continue; }
      }
      let err = null;
      try { await send(op); } catch (e) { err = e; }
      if (err && op.op === 'create' && _isRejected(err) && (op.body.page_id != null || op.body.chapter_id != null)) {
        const { page_id, chapter_id, ...bookLevel } = op.body;
        try { await send({ ...op, body: bookLevel }); err = null; } catch (e2) { err = e2; }
      }
      if (err && op.op === 'patch' && _isRejected(err)) {
        const groups = _patchGroups(op.fields);
        if (groups.length > 1) {
          let partOk = 0;
          err = null;
          for (const g of groups) {
            try { await send({ ...op, fields: g }); partOk++; }
            catch (e2) {
              if (!_isRejected(e2)) { err = e2; break; }
              console.warn('[ideen-queue] Änderung teilweise abgewiesen', { id: op.id, fields: Object.keys(g), status: e2.status, code: e2.code });
              out.dropped++;
            }
          }
          if (!err) { if (partOk) out.done++; await _store.del(op.qid); continue; }
        }
      }
      if (err) {
        if (stopOn(err)) break;
        if (op.op === 'delete' && err.status === 404) out.done++;
        else if (op.op === 'create') {
          console.warn('[ideen-queue] Anlegen abgewiesen, bleibt liegen', { status: err.status, code: err.code });
          await _store.put({ ...op, stuck: err.status || true });
          out.stuck++;
          continue;
        } else {
          console.warn('[ideen-queue] Operation abgewiesen', { op: op.op, status: err.status, code: err.code });
          out.dropped++;
        }
      } else {
        out.done++;
      }
      await _store.del(op.qid);
    }
    out.stuck = (await _load()).filter((o) => o.stuck).length;
    if (out.done || out.dropped) _announce({ queued: false, flushed: out });
    return out;
  });
}
