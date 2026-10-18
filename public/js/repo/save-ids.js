// Save-Kennungen je Schreiber und Abschnitt — Erkennung des eigenen Saves,
// dessen Antwort verloren ging (Zug, Funkloch, zugeklappter Laptop).
//
// Jeder Body-PUT trägt eine frische `save_id` (UUID) und die Kennungen der
// Saves, die derselbe Schreiber vorher geschickt hat und deren Antwort noch
// aussteht (`own_save_ids`). Der Server merkt sich je Abschnitt die Kennung des
// Saves, der den aktuellen Stand schrieb (`pages.last_save_id`), und nimmt einen
// Save mit veraltetem Stempel an, wenn dieser Stand einer der eigenen ist — der
// neue Stand ist dann sein Nachfahre, nichts Fremdes wird überschrieben
// (lib/content-store/backends/localdb.js#savePage). Ein Write ohne Kennung
// (Job, Import, alter Client) setzt sie auf NULL und beendet die Erkennung.
//
// Nachfahre ist der neue Stand aber nur, wenn er auf derselben Basis aufbaut
// wie der verlorene Save. Darum trägt jede Kennung den Stempel, gegen den ihr
// PUT ging (`expected_updated_at`), und zählt nur bei passender Basis: die
// Kette nach einer verlorenen Antwort läuft immer gegen denselben Stempel (der
// Editor rückt ohne Antwort nicht vor), ein Stand auf einer anderen Basis —
// Konflikt-Auflösung gegen einen älteren Stand, veraltete Ansicht, Rebase —
// läuft in den Merge statt den verlorenen Save ungemergt zu überschreiben.
// Einträge ohne Basis (Save ohne Stempel, Altbestand) zählen nie.
//
// «Schreiber» = Editor-Instanz in diesem Tab (`notebook`, `book`, `outbox`),
// nicht Konto oder Gerät: Bucheditor, Notebook-Editor und andere Tabs desselben
// Browsers schreiben mit derselben Geräte-ID, und ihr Stand darf nie als
// «eigener» still überschrieben werden. sessionStorage, weil der Fall ein
// Neuladen überleben muss; ein Draft nimmt die Kennungen seines Schreibers mit
// (editor/draft-storage.js), damit die Outbox sie beim Nachsenden nennen kann.

const KEY = (writer, pageId) => `own_save_ids:${writer}:${pageId}`;
// Gleicher Deckel wie der Server (routes/content/pages.js#OWN_SAVE_IDS_MAX).
const MAX_IDS = 16;

// Eintrag `{ id, base }`; alles andere (auch Alt-Einträge als blosser String)
// fällt beim Lesen weg.
const isEntry = (e) => !!e && typeof e.id === 'string' && typeof e.base === 'string' && !!e.base;

function read(writer, pageId) {
  try {
    const raw = sessionStorage.getItem(KEY(writer, pageId));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(isEntry) : [];
  } catch { return []; }
}

function write(writer, pageId, list) {
  try {
    if (list.length) sessionStorage.setItem(KEY(writer, pageId), JSON.stringify(list.slice(-MAX_IDS)));
    else sessionStorage.removeItem(KEY(writer, pageId));
  } catch { /* voll/gesperrt: Erkennung fällt aus, Konfliktpfad wie ohne Kennung */ }
}

function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Kennungen aus `entries`, deren Basis in `bases` liegt.
function idsOnBases(entries, bases) {
  const bs = (bases || []).filter(Boolean);
  if (!bs.length) return [];
  return (entries || []).filter((e) => isEntry(e) && bs.includes(e.base)).map((e) => e.id);
}

// Unbestätigte Saves dieses Schreibers für den Abschnitt (älteste zuerst), als
// `{ id, base }` — so nimmt ein Draft sie mit.
export function ownSaveIds(writer, pageId) {
  if (!writer || pageId == null) return [];
  return read(writer, pageId);
}

// Vor dem PUT: neue Kennung samt Basis vermerken (vor dem Request — geht die
// Antwort verloren, ist sie trotzdem bekannt). Mitgeschickt werden nur
// Vorgänger auf derselben Basis. `extraOwn`: Einträge, die ein Draft von seinem
// Schreiber mitbringt (Outbox).
export function beginSave(writer, pageId, extraOwn = [], baseAt = null) {
  const prior = [...(extraOwn || []), ...read(writer, pageId)];
  const own = [...new Set(idsOnBases(prior, [baseAt]))].slice(-MAX_IDS);
  const saveId = uuid();
  if (baseAt) write(writer, pageId, [...read(writer, pageId), { id: saveId, base: baseAt }]);
  return { save_id: saveId, own_save_ids: own };
}

// Antwort da: dieser Save und alle davor geschickten sind erledigt — der
// Schreiber kennt den Server-Stand wieder als Basis. Später geschickte bleiben.
export function confirmSave(writer, pageId, saveId) {
  const list = read(writer, pageId);
  const i = list.findIndex((e) => e.id === saveId);
  if (i >= 0) write(writer, pageId, list.slice(i + 1));
}

// Server hat geantwortet, ohne zu schreiben (4xx, z.B. 409): die Kennung kann
// nie der Server-Stand werden.
export function dropSave(writer, pageId, saveId) {
  write(writer, pageId, read(writer, pageId).filter((e) => e.id !== saveId));
}

// Stammt der Server-Stand (`last_save_id` aus GET/409-Body) von einem Save
// dieses Schreibers, der gegen eine der `localBases` ging — der Stempel, auf
// denen der lokale Stand aufbaut? Nur dann ist der lokale Stand sein Nachfahre.
export function isOwnServerSave(writer, pageId, lastSaveId, localBases, extraOwn = []) {
  if (!lastSaveId) return false;
  return idsOnBases([...(extraOwn || []), ...ownSaveIds(writer, pageId)], localBases).includes(lastSaveId);
}
