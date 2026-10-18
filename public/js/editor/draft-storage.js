// Lokale Draft-Persistenz für unsaved Edits im contenteditable-Editor.
// Eigenes Modul ohne browser-only Top-Level-Imports (page-view.js triggert
// `window.matchMedia` beim Laden) — so können auch reine Logik-Module wie
// app-view.js die Helper importieren, ohne dass Node-Tests am Window-Stub
// scheitern.
//
// Ablage: IndexedDB (editor/draft-idb.js) mit localStorage als synchronem
// Vorlauf. `writeDraft` schreibt zuerst localStorage (übersteht ein sofortiges
// Schliessen des Tabs), dann IndexedDB; ist der Datensatz dort bestätigt,
// fällt die localStorage-Kopie. So liegen Entwürfe dauerhaft nur in IndexedDB —
// kein Platzdeckel von wenigen MB, und der Service Worker (public/sw-drafts.js)
// kann sie im Background Sync lesen und räumen, ohne dass eine liegengebliebene
// localStorage-Kopie sie wieder auferstehen lässt. Gelesen wird synchron aus
// einem Spiegel (`_mirror`), den der Start aus IndexedDB füllt
// (`whenDraftsReady`) und den die anderen Tabs per BroadcastChannel nachführen.
// Ohne IndexedDB (Node-Tests, gesperrter Speicher) bleibt es bei localStorage.
//
// NICHTS KOMMT ZURÜCK, WAS GERÄUMT IST:
//  - Scheitert das Löschen in IndexedDB (oder ist sie gerade nicht nutzbar),
//    bleibt ein Grabstein in localStorage (`draft_tomb:<Schlüssel>` → Zeit).
//    Der Start lässt jeden Datensatz bis zu diesem Zeitpunkt fallen.
//  - Hat der Service Worker einen Entwurf nachgesendet, vermerkt er das in
//    IndexedDB (`sent:<Schlüssel>`); eine localStorage-Restkopie bis zu diesem
//    Stand ist erledigt.
//  - Ein Lösch-Broadcast trägt den Stand, den er räumt; ein jüngerer Entwurf
//    im Spiegel des Empfängers bleibt.
//
// NICHTS GEHT STILL VERLOREN:
//  - Scheitert ein IndexedDB-Write, nachdem localStorage schon voll war, bleibt
//    der Entwurf im Spiegel dieses Tabs, und EVT.DRAFT_PERSIST_FAILED sagt es
//    dem Editor (writeDraft hat da schon `true` geliefert).
//  - Lädt IndexedDB beim Start so langsam, dass schon neu geschrieben wurde,
//    bevor ein alter Entwurf im Spiegel stand, wird der alte nicht überschrieben,
//    sondern als Sicherung abgelegt (`<Schlüssel>:recovered`, EVT.DRAFT_BACKUP).
//  - Schreiben zwei Tabs gleichzeitig am selben Abschnitt (einer hält ihn per
//    live-edit.js), überschreibt keiner den Entwurf des anderen still: der
//    fremde Stand wandert vorher in die Sicherung `:recovered` (je Abschnitt
//    eine, immer der jüngste fremde Stand). Jeder Datensatz trägt dafür `tab`.
//  - Sicherungen (`:discarded` aus dem Notebook-Konfliktdialog, `:recovered`,
//    `:orphan` für Entwürfe gelöschter Abschnitte) listet `listDraftBackups`
//    für den Dialog „Nicht gespeichert" (app/app-offline-rescue.js); die
//    Outbox und der Service Worker sehen sie nicht (die ID ist keine Zahl).
import { EVT } from '../events.js';
import { lsGetJSON, lsSetJSON, lsRemove, lsKeys } from '../safe-storage.js';
import { ownSaveIds } from '../repo/save-ids.js';
import { draftIdb, requestDraftSync, DRAFT_SENT_PREFIX } from './draft-idb.js';
import { getTabId } from '../tab-id.js';
import { isLiveEditedElsewhere } from './live-edit.js';

// Schlüssel: `editor_draft_u:<email>:<pageId>` — das Konto steht im
// Schlüssel, weil der Speicher pro Browser-Profil gilt, nicht pro Konto.
// Melden sich auf einem Gerät nacheinander zwei User an, dürfen sie sich
// weder die Entwürfe überschreiben noch einander angezeigt bekommen, und die
// Outbox (app/app-outbox.js) darf keinen fremden Entwurf unter dem eigenen
// Konto speichern. Gesetzt wird das Konto, sobald die Config den User kennt
// (app-init.js); davor und in Node-Tests gilt der kontolose Alt-Schlüssel
// `editor_draft_<pageId>`. Alt-Entwürfe migriert setDraftOwner in den
// Konto-Schlüssel ihres `owner`-Felds (fehlt es, gehört der Entwurf dem
// ersten angemeldeten User); was nicht migriert werden konnte (Quota), bleibt
// unter dem Alt-Schlüssel les- und löschbar.
const DRAFT_PREFIX = 'editor_draft_';
const TOMB_PREFIX = 'draft_tomb:';
const KNOWN_OWNERS_KEY = 'draft_known_owners';
const BACKUP_KINDS = ['discarded', 'recovered', 'orphan'];
const BACKUP_RE = /^(.*?)(\d+):(discarded|recovered|orphan)$/;
const BACKUP_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LEGACY_RE = /^editor_draft_(\d+)$/;
const LEGACY_KEY = (pageId) => `${DRAFT_PREFIX}${pageId}`;
const OWNER_PREFIX = (owner) => `${DRAFT_PREFIX}u:${owner}:`;

let _owner = null;
let _idb = draftIdb;
// Schlüssel → Datensatz, in IndexedDB bestätigt bzw. dorthin unterwegs.
const _mirror = new Map();
let _ready = Promise.resolve();
// Während des Start-Ladens geräumte Schlüssel: der laufende Read darf sie
// nicht wieder in den Spiegel holen.
let _removedWhileLoading = null;
// In dieser Sitzung geschriebene Schlüssel — trifft das Start-Laden für einen
// davon einen älteren, anderen Entwurf, wird der zur Sicherung (`:recovered`).
const _writtenThisSession = new Set();
// Laufende IndexedDB-Writes je Schlüssel (put/del) und Schlüssel, deren Put
// scheiterte (Stand lebt nur noch im Spiegel bzw. in localStorage).
// `whenDraftSettled` wartet darauf, `refreshDraft` darf einen Spiegel-Eintrag
// ohne IndexedDB-Gegenstück nur verwerfen, wenn nichts davon zutrifft.
const _inflight = new Map();
const _idbFailed = new Set();

function _track(key, p) {
  const prev = _inflight.get(key);
  const next = (prev ? prev.then(() => p) : p).catch(() => {});
  _inflight.set(key, next);
  next.then(() => { if (_inflight.get(key) === next) _inflight.delete(key); });
  return p;
}
const _sessionStart = Date.now();

const DRAFT_KEY = (pageId) => (_owner ? `${OWNER_PREFIX(_owner)}${pageId}` : LEGACY_KEY(pageId));

// Ein kontoloser Alt-Entwurf gehört dem angemeldeten User nur, wenn auf
// diesem Gerät nie ein anderes Konto Entwürfe hatte — sonst ist offen, wessen
// Text es ist, und weder Outbox noch Migration nehmen ihn.
function _knownOwners() {
  const l = lsGetJSON(KNOWN_OWNERS_KEY, []);
  return Array.isArray(l) ? l : [];
}

function _ownerlessIsMine() {
  return _knownOwners().filter((o) => o !== _owner).length === 0;
}

function _visible(draft) {
  if (!draft) return false;
  if (!_owner) return true;
  if (!draft.owner) return _ownerlessIsMine();
  return draft.owner === _owner;
}

function _pageIdOf(key) {
  const m = /(\d+)(?::[a-z]+)?$/.exec(key);
  return m ? Number(m[1]) : null;
}

const _newer = (a, b) => ((a?.savedAt || 0) >= (b?.savedAt || 0) ? a : b);

// ── Ablage: localStorage-Vorlauf + IndexedDB-Spiegel ─────────────────────────

function _get(key) {
  const ls = lsGetJSON(key);
  const idb = _mirror.get(key) || null;
  if (!ls) return idb;
  if (!idb) return ls;
  return _newer(ls, idb);
}

function _keys(prefix) {
  const out = new Set(lsKeys(prefix));
  for (const k of _mirror.keys()) if (k.startsWith(prefix)) out.add(k);
  return [...out];
}

// true, wenn der Entwurf gesichert ist bzw. unterwegs nach IndexedDB.
// Scheitert IndexedDB danach und hatte localStorage keinen Platz, meldet
// EVT.DRAFT_PERSIST_FAILED das nachträglich; der Stand bleibt im Spiegel.
function _put(key, rec) {
  const lsOk = lsSetJSON(key, rec);
  _writtenThisSession.add(key);
  if (!_idb.usable()) return lsOk;
  _mirror.set(key, rec);
  // Ohne Netz geschrieben: Background Sync anmelden, damit der Entwurf auch
  // dann ankommt, wenn bis zum Wiederverbinden kein Tab mehr offen ist.
  if (globalThis.navigator?.onLine === false) requestDraftSync();
  _track(key, _idb.put(key, rec).then(() => {
    _idbFailed.delete(key);
    // Bestätigt: die localStorage-Kopie fällt, sofern sie noch dieser Stand ist.
    if (lsGetJSON(key)?.savedAt === rec.savedAt) lsRemove(key);
    _idb.broadcast({ type: 'put', key, rec });
  }).catch((e) => {
    _idbFailed.add(key);
    console.warn('[draft-storage] IndexedDB-Write gescheitert, localStorage bleibt Ablage', e);
    if (!lsOk) _emitPersistFailed(key);
    _emitDraftChanged();
  }));
  return true;
}

function _tomb(key) {
  lsSetJSON(TOMB_PREFIX + key, Date.now());
}

function _remove(key) {
  const prev = _mirror.get(key) || lsGetJSON(key);
  lsRemove(key);
  _mirror.delete(key);
  _removedWhileLoading?.add(key);
  if (!_idb.usable()) { if (_idb.present?.()) _tomb(key); return; }
  _idbFailed.delete(key);
  _track(key, _idb.del(key).then(() => {
    lsRemove(TOMB_PREFIX + key);
    _idb.broadcast({ type: 'del', key, savedAt: prev?.savedAt ?? null });
  }).catch((e) => {
    console.warn('[draft-storage] IndexedDB-Löschen gescheitert, Grabstein bleibt', e);
    _tomb(key);
  }));
}

// Start: IndexedDB in den Spiegel, dann liegengebliebene localStorage-Entwürfe
// (unbestätigt oder aus der Zeit vor IndexedDB) übernehmen — der jüngere
// gewinnt, die Kopie in localStorage fällt erst nach der Bestätigung.
async function _load() {
  const removed = (_removedWhileLoading = new Set());
  let entries;
  try { entries = await _idb.getAll(); }
  finally { _removedWhileLoading = null; }
  const now = Date.now();
  const sent = new Map();
  for (const [k, rec] of entries) {
    if (typeof k !== 'string' || !k.startsWith(DRAFT_SENT_PREFIX)) continue;
    if (!(now - (rec?.at || 0) < SENT_TTL_MS)) { _idb.del(k).catch(() => {}); continue; }
    sent.set(k.slice(DRAFT_SENT_PREFIX.length), rec?.savedAt || 0);
  }
  for (const [k, rec] of entries) {
    if (typeof k !== 'string' || k.startsWith(DRAFT_SENT_PREFIX)) continue;
    if (!rec || typeof rec !== 'object') continue;
    if (removed.has(k)) {
      // Während des Ladens geschrieben UND geräumt (bearbeitet, gespeichert),
      // bevor dieser alte Entwurf je im Spiegel stand: er stammt aus einer
      // früheren Sitzung und war nie zu sehen — Sicherung statt still weg.
      if (_writtenThisSession.has(k) && (rec.savedAt || 0) < _sessionStart && rec.html && !BACKUP_RE.test(k)) {
        _keepAsBackup(k, rec, 'recovered');
      }
      continue;
    }
    const tomb = lsGetJSON(TOMB_PREFIX + k);
    if (typeof tomb === 'number' && (rec.savedAt || 0) <= tomb) {
      _idb.del(k).then(() => lsRemove(TOMB_PREFIX + k)).catch(() => {});
      continue;
    }
    if (BACKUP_RE.test(k) && !(now - (rec.savedAt || 0) < BACKUP_TTL_MS)) { _idb.del(k).catch(() => {}); continue; }
    const cur = _mirror.get(k);
    if (cur && _writtenThisSession.has(k) && (rec.savedAt || 0) < (cur.savedAt || 0) && rec.html && rec.html !== cur.html) {
      // Alter Entwurf, den der Start zu spät sah — schon überschrieben. Nicht
      // verlieren: als Sicherung ablegen.
      _keepAsBackup(k, rec, 'recovered');
      continue;
    }
    _mirror.set(k, _newer(cur, rec));
  }
  for (const k of lsKeys(TOMB_PREFIX)) {
    if (!_mirror.has(k.slice(TOMB_PREFIX.length)) && !entries.some(([ek]) => ek === k.slice(TOMB_PREFIX.length))) lsRemove(k);
  }
  for (const k of lsKeys(DRAFT_PREFIX)) {
    const rec = lsGetJSON(k);
    if (!rec || typeof rec !== 'object') continue;
    const m = _mirror.get(k);
    if (m && (m.savedAt || 0) >= (rec.savedAt || 0)) { lsRemove(k); continue; }
    // Vom Service Worker schon nachgesendet (oder danach geräumt).
    if (sent.has(k) && (rec.savedAt || 0) <= sent.get(k)) { lsRemove(k); continue; }
    const tomb = lsGetJSON(TOMB_PREFIX + k);
    if (typeof tomb === 'number' && (rec.savedAt || 0) <= tomb) { lsRemove(k); continue; }
    _mirror.set(k, rec);
    try {
      await _idb.put(k, rec);
      if (lsGetJSON(k)?.savedAt === rec.savedAt) lsRemove(k);
    } catch { /* bleibt in localStorage */ }
  }
}

function _onBroadcast(msg) {
  if (!msg || typeof msg.key !== 'string') return;
  if (msg.type === 'put' && msg.rec) _mirror.set(msg.key, _newer(_mirror.get(msg.key), msg.rec));
  else if (msg.type === 'del') {
    // Geräumt wurde der Stand `savedAt` — ein jüngerer hier (noch unterwegs
    // nach IndexedDB) bleibt.
    const cur = _mirror.get(msg.key);
    if (cur && typeof msg.savedAt === 'number' && (cur.savedAt || 0) > msg.savedAt) return;
    _mirror.delete(msg.key);
  } else return;
  _emitDraftChanged();
}

function _keepAsBackup(key, rec, kind) {
  const bkey = `${key}:${kind}`;
  const out = { ...rec, backupOf: _pageIdOf(key), backupKind: kind, savedAt: rec.savedAt || Date.now() };
  if (_idb.usable()) {
    _mirror.set(bkey, out);
    _idb.put(bkey, out).catch(() => lsSetJSON(bkey, out));
  } else {
    lsSetJSON(bkey, out);
  }
  _emitBackup(_pageIdOf(key), kind);
}

// Austauschbares Backend (Unit-Tests ohne IndexedDB). Startet das Laden.
export function initDraftStore(idb = draftIdb) {
  _idb = idb;
  _mirror.clear();
  if (!_idb.usable()) { _ready = Promise.resolve(); return _ready; }
  _idb.onMessage(_onBroadcast);
  _ready = _load()
    .catch((e) => console.warn('[draft-storage] IndexedDB nicht lesbar, localStorage bleibt Ablage', e))
    .then(() => { if (_owner) migrateLegacyDrafts(); _emitDraftChanged(); });
  return _ready;
}

// Wartet, bis die Entwürfe aus IndexedDB im Spiegel stehen — höchstens
// `timeoutMs`: ein hängendes IndexedDB darf den Start nicht blockieren.
export function whenDraftsReady(timeoutMs = 2000) {
  return Promise.race([_ready, new Promise((r) => setTimeout(r, timeoutMs))]);
}

// Ohne Deckel: erfüllt, sobald das Start-Laden wirklich durch ist (auch nach
// dem Deckel von whenDraftsReady). Für das Nachziehen verspäteter Entwürfe.
export function draftsLoaded() {
  return _ready;
}

export function setDraftOwner(email) {
  _owner = email || null;
  if (_owner) {
    const known = _knownOwners();
    if (!known.includes(_owner)) lsSetJSON(KNOWN_OWNERS_KEY, [...known, _owner].slice(-20));
    migrateLegacyDrafts();
  }
}

// Alt-Schlüssel in Konto-Schlüssel überführen. Liegt am Ziel schon ein
// Entwurf, gewinnt der jüngere (`savedAt`). Der Alt-Schlüssel fällt erst,
// wenn das Ziel geschrieben ist — ein voller Speicher verliert nichts.
export function migrateLegacyDrafts() {
  if (!_owner) return;
  for (const key of _keys(DRAFT_PREFIX)) {
    const m = LEGACY_RE.exec(key);
    if (!m) continue;
    const draft = _get(key);
    if (!draft || typeof draft !== 'object') continue;
    // Kontolos und das Gerät kannte schon andere Konten: wessen Text das ist,
    // bleibt offen — nicht dem gerade angemeldeten zuschlagen.
    if (!draft.owner && !_ownerlessIsMine()) continue;
    const owner = draft.owner || _owner;
    const target = `${OWNER_PREFIX(owner)}${m[1]}`;
    const existing = _get(target);
    if (existing && (existing.savedAt || 0) >= (draft.savedAt || 0)) { _remove(key); continue; }
    if (_put(target, { ...draft, owner })) _remove(key);
  }
}

// Best-Effort-Signal für die Reconnect-Outbox + den Pending-Sync-Zähler, damit
// die App den Draft-Bestand nicht pollen muss. Laufzeit-guarded (nicht am
// Modul-Top-Level), damit reine Node-Tests dieses Modul ohne window importieren
// können.
function _emit(type, detail) {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(type, detail ? { detail } : undefined));
    }
  } catch {}
}

function _emitDraftChanged() { _emit(EVT.DRAFT_CHANGED); }
function _emitPersistFailed(key) { _emit(EVT.DRAFT_PERSIST_FAILED, { pageId: _pageIdOf(key) }); }
function _emitBackup(pageId, kind) { _emit(EVT.DRAFT_BACKUP, { pageId, kind }); _emitDraftChanged(); }

export function readDraft(pageId) {
  const own = _get(DRAFT_KEY(pageId));
  if (own) return own;
  if (!_owner) return null;
  const legacy = _get(LEGACY_KEY(pageId));
  return _visible(legacy) ? legacy : null;
}

// Liefert true, wenn der Entwurf lokal persistiert wurde, sonst false (i.d.R.
// QuotaExceededError bei vollem localStorage ohne IndexedDB). Der Aufrufer MUSS
// das Ergebnis prüfen und false sichtbar machen — ein still verworfener
// Offline-Entwurf ist echter Datenverlust (kein Server-Fallback, wenn offline).
//
// `ownSaveIds`: Kennungen der Saves, die der Notebook-Editor dieses Tabs seit
// der Draft-Basis geschickt hat, ohne Antwort (repo/save-ids.js). Der Draft ist
// deren Nachfahre — die Outbox nennt sie beim Nachsenden, auch aus einem
// anderen Tab, und der Server erkennt einen davon als Vorgänger-Stand.
// `writer`: Schreiber dieser Kennungen (`notebook` bzw. `book` im Bucheditor).
export function writeDraft(pageId, html, originalHtml, originalUpdatedAt, { writer = 'notebook' } = {}) {
  const key = DRAFT_KEY(pageId);
  // Ein anderer Tab schreibt gerade an diesem Abschnitt: seinen Stand nicht
  // still überschreiben, sondern als Sicherung behalten.
  const prev = _get(key);
  const tab = getTabId();
  if (prev?.html && prev.tab && prev.tab !== tab && prev.html !== html && isLiveEditedElsewhere(pageId)) {
    _keepAsBackup(key, prev, 'recovered');
  }
  const ok = _put(key, {
    html, originalHtml, originalUpdatedAt: originalUpdatedAt || null, savedAt: Date.now(),
    owner: _owner, writer, tab, ownSaveIds: ownSaveIds(writer, pageId),
  });
  if (!ok) return false;
  // Ein liegengebliebener eigener Alt-Entwurf ist jetzt überholt.
  if (_owner && _visible(_get(LEGACY_KEY(pageId)))) _remove(LEGACY_KEY(pageId));
  _emitDraftChanged();
  return true;
}

export function clearDraft(pageId) {
  _remove(DRAFT_KEY(pageId));
  if (_owner && _visible(_get(LEGACY_KEY(pageId)))) _remove(LEGACY_KEY(pageId));
  _emitDraftChanged();
}

// Nur räumen, wenn der Entwurf noch der Stand `savedAt` ist — ein Tab, der
// während eines asynchronen Sends weitergeschrieben hat, verliert nichts.
// Liefert true, wenn geräumt wurde.
export function clearDraftIfSame(pageId, savedAt) {
  const cur = readDraft(pageId);
  if (!cur) return true;
  if (cur.savedAt !== savedAt) return false;
  clearDraft(pageId);
  return true;
}

// Bis die laufenden IndexedDB-Writes dieses Entwurfs (Sichern, Räumen) durch
// sind. Die Outbox wartet darauf, bevor sie den Web Lock des Abschnitts
// freigibt: wer ihn danach nimmt (anderer Tab, Service Worker), sieht in
// IndexedDB schon den geräumten Stand.
export function whenDraftSettled(pageId) {
  return _inflight.get(DRAFT_KEY(pageId)) || Promise.resolve();
}

// Entwurf frisch aus IndexedDB in den Spiegel — unter dem Web Lock vor dem
// Senden (app/app-outbox.js). Der Spiegel erfährt das Räumen eines anderen
// Tabs oder des Service Workers erst per Broadcast, und der kommt nach der
// Lock-Freigabe: ohne diesen Abgleich ginge derselbe Stand ein zweites Mal
// raus (409 → Merge, bei Kollision ein Konflikt für den User). Fehlt der
// Datensatz in IndexedDB, wurde er anderswo gesendet — es sei denn, dieser Tab
// schreibt ihn gerade selbst oder sein Put scheiterte (dann lebt er nur hier).
export async function refreshDraft(pageId) {
  if (!_idb.usable() || typeof _idb.get !== 'function') return readDraft(pageId);
  const key = DRAFT_KEY(pageId);
  await whenDraftSettled(pageId);
  let rec;
  try { rec = await _idb.get(key); } catch { return readDraft(pageId); }
  if (_inflight.has(key)) return readDraft(pageId); // inzwischen neu geschrieben
  if (rec) _mirror.set(key, _newer(_mirror.get(key), rec));
  else if (_mirror.has(key) && !_idbFailed.has(key)) {
    _mirror.delete(key);
    _emitDraftChanged();
  }
  return readDraft(pageId);
}

// Entwurf eines Abschnitts, den es auf dem Server nicht mehr gibt (gelöscht,
// auf einem anderen Gerät oder per Kapitel/Buch), als Sicherung ablegen statt
// ihn ewig als „wartend" zu zählen.
export function moveDraftToBackup(pageId, kind = 'orphan') {
  const key = DRAFT_KEY(pageId);
  const rec = _get(key);
  if (!rec?.html) { clearDraft(pageId); return false; }
  _keepAsBackup(key, rec, kind);
  clearDraft(pageId);
  return true;
}

// Sicherungen des angemeldeten Kontos: [{ key, pageId, kind, html, savedAt }],
// jüngste zuerst. `:discarded` schreibt der Notebook-Konfliktdialog mit
// writeDraft(`<id>:discarded`, …) — auch die erscheinen hier.
export function listDraftBackups() {
  const ownPrefix = _owner ? OWNER_PREFIX(_owner) : DRAFT_PREFIX;
  const out = [];
  for (const key of _keys(DRAFT_PREFIX)) {
    if (!key.startsWith(ownPrefix)) continue;
    const m = BACKUP_RE.exec(key);
    if (!m) continue;
    const rec = _get(key);
    if (!rec?.html) continue;
    out.push({ key, pageId: Number(m[2]), kind: m[3], html: rec.html, savedAt: rec.savedAt || 0 });
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function removeDraftBackup(key) {
  if (typeof key !== 'string' || !BACKUP_RE.test(key)) return;
  _remove(key);
  _emitDraftChanged();
}

export { BACKUP_KINDS as DRAFT_BACKUP_KINDS };

// Alle Seiten-IDs mit einem lokal gesicherten Entwurf. Ein vorhandener Draft
// bedeutet: lokaler Inhalt, der (noch) nicht bestätigt auf dem Server liegt —
// erfolgreiche Saves rufen clearDraft. Basis für die Reconnect-Outbox und den
// „N Seiten warten auf Sync"-Zähler.
// Fremde Entwürfe (anderes Konto) zählen nicht.
export function listDraftPageIds() {
  const ids = new Set();
  const ownPrefix = _owner ? OWNER_PREFIX(_owner) : null;
  for (const key of _keys(DRAFT_PREFIX)) {
    let raw = null;
    if (ownPrefix && key.startsWith(ownPrefix)) raw = key.slice(ownPrefix.length);
    else {
      const m = LEGACY_RE.exec(key);
      if (!m || (_owner && !_visible(_get(key)))) continue;
      raw = m[1];
    }
    const id = Number(raw);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

initDraftStore();
