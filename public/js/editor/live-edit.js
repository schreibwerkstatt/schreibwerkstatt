// Live-Edit-Marker: welcher Abschnitt wird in welchem Tab gerade im
// Notebook-/Focus-Editor oder im Bucheditor bearbeitet — sichtbar für die
// anderen Tabs desselben Browsers.
//
// Drafts (draft-storage.js) liegen in localStorage und sind damit in allen Tabs
// dieselben. Die Reconnect-Outbox (app/app-outbox.js) eines Tabs, in dem der
// Abschnitt NICHT offen ist, hielte den laufend geschriebenen Draft eines
// anderen Tabs für liegengeblieben und speicherte ihn mit dessen altem Stempel
// — in den Save des bearbeitenden Tabs hinein. Mit dem Marker überspringt sie
// ihn; der bearbeitende Tab speichert selbst.
//
// Der Marker trägt Tab-ID + Zeitstempel und wird per Heartbeat erneuert. Ein
// Tab, der ohne Abbau verschwindet (Absturz, eingefrorener Tab), gibt den
// Abschnitt nach STALE_MS wieder frei. STALE_MS liegt bewusst weit über dem
// Heartbeat: Chrome drosselt Timer in versteckten Tabs auf einmal pro Minute,
// und genau dann (Nutzer ist im anderen Tab) muss der Marker noch gelten.
import { getTabId } from '../tab-id.js';

const KEY_PREFIX = 'notebook_live_edit:';
export const LIVE_EDIT_HEARTBEAT_MS = 30 * 1000;
export const LIVE_EDIT_STALE_MS = 5 * 60 * 1000;

// Halter → Abschnitte. Notebook/Focus hält höchstens einen (`startLiveEdit`),
// der Bucheditor alle Blöcke mit ungespeichertem Stand (`setLiveEditPages`).
// Markiert wird die Vereinigung.
const _holders = new Map();
let _marked = new Set();
let _timer = null;
let _onPageHide = null;
let _onPageShow = null;

function write(pageId) {
  try { localStorage.setItem(KEY_PREFIX + pageId, JSON.stringify({ tab: getTabId(), at: Date.now() })); } catch { /* gesperrt/voll: Outbox verhält sich wie ohne Marker */ }
}

function removeIfOwn(pageId) {
  const cur = read(pageId);
  if (cur?.tab === getTabId()) {
    try { localStorage.removeItem(KEY_PREFIX + pageId); } catch { /* ignore */ }
  }
}

function read(pageId) {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + pageId);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function union() {
  const out = new Set();
  for (const ids of _holders.values()) for (const id of ids) out.add(id);
  return out;
}

function writeAll() { for (const id of _marked) write(id); }

function sync() {
  const next = union();
  for (const id of _marked) if (!next.has(id)) removeIfOwn(id);
  for (const id of next) if (!_marked.has(id)) write(id);
  _marked = next;
  if (next.size && !_timer) {
    _timer = setInterval(writeAll, LIVE_EDIT_HEARTBEAT_MS);
    _timer.unref?.(); // Node (Unit-Tests): Heartbeat hält den Prozess nicht offen
    // Schliessen/Neuladen: sofort freigeben statt erst nach STALE_MS. Nur die
    // Marker, nicht die Sessions — `pagehide` feuert auch beim Parken im
    // Back-Forward-Cache, und nach `pageshow` wird weiter bearbeitet.
    _onPageHide = () => { for (const id of _marked) removeIfOwn(id); };
    _onPageShow = writeAll;
    window.addEventListener('pagehide', _onPageHide);
    window.addEventListener('pageshow', _onPageShow);
  } else if (!next.size && _timer) {
    clearInterval(_timer); _timer = null;
    window.removeEventListener('pagehide', _onPageHide); _onPageHide = null;
    window.removeEventListener('pageshow', _onPageShow); _onPageShow = null;
  }
}

const norm = (pageId) => Number(pageId);

// Setzt die Abschnitte eines Halters (ersetzt seine bisherigen). Leere Liste
// gibt sie frei. Ein Marker fällt nur, wenn er noch diesem Tab gehört — ein
// anderer Tab kann denselben Abschnitt inzwischen geöffnet haben.
export function setLiveEditPages(holder, pageIds) {
  const ids = new Set([...(pageIds || [])].filter((id) => id != null).map(norm));
  if (ids.size) _holders.set(holder, ids);
  else _holders.delete(holder);
  sync();
  for (const id of ids) write(id);
}

// Edit-Session des Notebook-/Focus-Editors beginnt auf `pageId`. Ersetzt einen
// laufenden Marker.
export function startLiveEdit(pageId) {
  if (pageId == null) return;
  setLiveEditPages('notebook', [pageId]);
}

export function stopLiveEdit() {
  setLiveEditPages('notebook', []);
}

// Alle Abschnitte, die DIESER Tab hält — Antwort an den Background Sync
// (public/sw-drafts.js), der sie nicht anfassen darf.
export function liveEditedHereIds() {
  return [..._marked];
}

// true, wenn DIESER Tab `pageId` gerade hält (Notebook oder Bucheditor).
export function isLiveEditedHere(pageId) {
  return _marked.has(norm(pageId));
}

// true, wenn ein ANDERER Tab `pageId` gerade bearbeitet.
export function isLiveEditedElsewhere(pageId, now = Date.now()) {
  const cur = read(pageId);
  if (!cur || cur.tab === getTabId() || typeof cur.at !== 'number') return false;
  return now - cur.at < LIVE_EDIT_STALE_MS;
}
