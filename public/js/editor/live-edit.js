// Live-Edit-Marker: welcher Abschnitt wird in welchem Tab gerade im
// Notebook-/Focus-Editor bearbeitet — sichtbar für die anderen Tabs desselben
// Browsers.
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

let _pageId = null;
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

// Edit-Session dieses Tabs beginnt auf `pageId`. Ersetzt einen laufenden Marker.
export function startLiveEdit(pageId) {
  if (pageId == null) return;
  stopLiveEdit();
  _pageId = pageId;
  write(pageId);
  _timer = setInterval(() => { if (_pageId != null) write(_pageId); }, LIVE_EDIT_HEARTBEAT_MS);
  _timer.unref?.(); // Node (Unit-Tests): Heartbeat hält den Prozess nicht offen
  // Schliessen/Neuladen: sofort freigeben statt erst nach STALE_MS. Nur den
  // Marker, nicht die Session — `pagehide` feuert auch beim Parken im
  // Back-Forward-Cache, und nach `pageshow` wird weiter bearbeitet.
  _onPageHide = () => { if (_pageId != null) removeIfOwn(_pageId); };
  _onPageShow = () => { if (_pageId != null) write(_pageId); };
  window.addEventListener('pagehide', _onPageHide);
  window.addEventListener('pageshow', _onPageShow);
}

// Edit-Session endet. Entfernt den Marker nur, wenn er noch diesem Tab gehört —
// ein anderer Tab kann denselben Abschnitt inzwischen geöffnet haben.
export function stopLiveEdit() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_onPageHide) { window.removeEventListener('pagehide', _onPageHide); _onPageHide = null; }
  if (_onPageShow) { window.removeEventListener('pageshow', _onPageShow); _onPageShow = null; }
  if (_pageId == null) return;
  removeIfOwn(_pageId);
  _pageId = null;
}

// true, wenn ein ANDERER Tab `pageId` gerade bearbeitet.
export function isLiveEditedElsewhere(pageId, now = Date.now()) {
  const cur = read(pageId);
  if (!cur || cur.tab === getTabId() || typeof cur.at !== 'number') return false;
  return now - cur.at < LIVE_EDIT_STALE_MS;
}
