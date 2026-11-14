// Verweildauern der Nutzungs-Events (docs/usage-events.md#verweildauer):
// Werkzeuge am Abschnitt (`panel.open`/`panel.close`) und Abschnitts-Besuche
// (`page.view`). Karten und Editoren führt features-usage.js, misst aber mit
// derselben Uhr.
//
// Gemessen wird nur sichtbare Zeit: die Uhr steht, solange der Tab im
// Hintergrund liegt. Sonst zählte eine über Nacht offene Karte als zehn
// Stunden Nutzung. Jede Dauer ist zusätzlich gedeckelt (MAX_SESSION_SEC).
//
// Rein transient und modul-lokal: nichts davon rendert, nichts gehört in den
// Alpine-State. Nicht im OTA-Editor-Bundle verwenden.

import { trackUsageEvent } from './usage-event.js';

export const MAX_SESSION_SEC = 4 * 3600;
// Kürzere Abschnitts-Besuche sind Durchklicken, kein Lesen.
export const MIN_PAGE_VIEW_SEC = 3;

// ── Sichtbare Uhr ───────────────────────────────────────────────────────────

let _visibleMs = 0;
let _visibleSince = null;

function _isHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

_visibleSince = _isHidden() ? null : Date.now();
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (_isHidden()) {
      if (_visibleSince != null) { _visibleMs += Date.now() - _visibleSince; _visibleSince = null; }
    } else if (_visibleSince == null) {
      _visibleSince = Date.now();
    }
  });
}

/** Monoton steigende Millisekunden, die nur bei sichtbarem Tab laufen. */
export function visibleClock() {
  return _visibleMs + (_visibleSince != null ? Date.now() - _visibleSince : 0);
}

function _toSec(ms) {
  return Math.min(MAX_SESSION_SEC, Math.max(0, Math.round(ms / 1000)));
}

/** Sichtbare Sekunden seit einer Marke von visibleClock(), gedeckelt. */
export function visibleSecSince(mark) {
  return _toSec(visibleClock() - mark);
}

function _currentBookId() {
  try { return window.Alpine?.store('nav')?.selectedBookId || null; } catch { return null; }
}

// ── Werkzeuge am Abschnitt ──────────────────────────────────────────────────

// Mehrere zugleich möglich (Befundliste + Abschnitts-Chat). Je Werkzeug eine
// Sitzung; ein zweites «offen» derselben Art ist ein No-op.
const _panels = new Map();

/**
 * Offen-Zustand eines Werkzeugs melden. Idempotent: nur Wechsel erzeugen ein
 * Event. `editor`: in welchem Editor das Werkzeug lief (notebook/focus/book).
 */
export function setPanelOpen(panel, open, editor = 'notebook') {
  const cur = _panels.get(panel);
  if (open && !cur) {
    const bookId = _currentBookId();
    _panels.set(panel, { since: visibleClock(), editor, bookId });
    trackUsageEvent('panel.open', { panel, editor }, bookId);
  } else if (!open && cur) {
    _panels.delete(panel);
    trackUsageEvent('panel.close', { panel, editor: cur.editor, durationSec: visibleSecSince(cur.since) }, cur.bookId);
  }
}

/** Alle offenen Werkzeuge abschliessen (Tab geht zu). Liefert die Namen. */
export function closeAllPanels() {
  const open = [..._panels.keys()];
  for (const p of open) setPanelOpen(p, false);
  return open;
}

// ── Abschnitts-Besuche ──────────────────────────────────────────────────────

let _page = null;

function _flushPage() {
  const p = _page;
  _page = null;
  if (!p) return;
  if (p.editSince != null) p.editMs += visibleClock() - p.editSince;
  const durationSec = visibleSecSince(p.since);
  if (durationSec < MIN_PAGE_VIEW_SEC) return;
  trackUsageEvent('page.view', {
    pageId: p.pageId,
    durationSec,
    editSec: Math.min(durationSec, _toSec(p.editMs)),
    changed: p.changed ? 'yes' : 'no',
  }, p.bookId);
}

/**
 * Offenen Abschnitt melden (null = keiner, z. B. Bucheditor oder Tab zu).
 * Ein Wechsel schliesst den vorigen Besuch ab. `editing`: Edit-Modus beim Start.
 */
export function setPageView(pageId, { bookId = null, editing = false } = {}) {
  const id = Number(pageId) || null;
  if (_page && _page.pageId === id) return;
  _flushPage();
  if (!id) return;
  _page = { pageId: id, bookId, since: visibleClock(), editSince: editing ? visibleClock() : null, editMs: 0, changed: false };
}

/** Edit-Modus des offenen Abschnitts an/aus — trennt Lese- von Schreibzeit. */
export function setPageEditing(editing) {
  if (!_page) return;
  if (editing && _page.editSince == null) _page.editSince = visibleClock();
  else if (!editing && _page.editSince != null) {
    _page.editMs += visibleClock() - _page.editSince;
    _page.editSince = null;
  }
}

/** Ein Save des Abschnitts ist beim Server angekommen. */
export function notePageSaved(pageId) {
  if (_page && _page.pageId === Number(pageId)) _page.changed = true;
}
