// Plot-Werkstatt: Ansichts-Werkzeuge des Boards — Dichte-Modus, einklappbare
// Akte, Leer-Zustand-Einstieg, Tastatur-Bedienung der beiden teleportierten
// Menüs (Strang-Aktionen, Fundstellen) und der Archiv-Hinweis beim Öffnen eines
// Brainstorm-Laufs. Reine Anzeige-Achsen: nichts hier schreibt auf den Server.

import { lsGetJSON, lsSetJSON } from '../../safe-storage.js';
import { getUserPref, setUserPref } from '../../local-prefs.js';

// Dichte: 'normal' (Beschreibung auf drei Zeilen gekappt) | 'compact' (nur die
// Kopfzeile der Beat-Karte). Per User persistiert wie plotHideImBuch — eine
// Arbeitsgewohnheit über alle Bücher, kein buch-skopierter Filter.
const DENSITY_PREF_KEY = 'plotDensity';
const DENSITIES = ['normal', 'compact'];

// Eingeklappte Akte: pro Buch + User, Schlüssel nach dem Muster der übrigen
// Buch-Prefs (`sw:<bereich>:<email>:<bookId>`), damit storage-sweep.js sie mit
// dem Buch abräumt.
const COLLAPSED_AREA = 'plotActsCollapsed';

export function plotBoardUiState() {
  return {
    plotDensity: 'normal',
    // { [actId]: true } — eingeklappte Akt-Spalten des aktuellen Buchs.
    collapsedActs: {},
    // Trigger des zuletzt geöffneten Menüs (Fokus-Rückgabe bei Esc).
    _menuTriggerEl: null,
  };
}

export const boardUiMethods = {
  // Aus plot-card.js#init: Prefs lesen + Buchwechsel beobachten.
  _initPlotBoardUi() {
    const email = Alpine.store('session').currentUser?.email;
    const d = getUserPref(email, DENSITY_PREF_KEY, 'normal');
    this.plotDensity = DENSITIES.includes(d) ? d : 'normal';
    this._loadCollapsedActs();
    this.$watch(() => Alpine.store('nav').selectedBookId, () => this._loadCollapsedActs());
    // Ein anderer Prüflauf bringt andere Befund-Typen mit — der Typ-Filter des
    // alten Laufs liesse die Liste sonst womöglich leer erscheinen.
    this.$watch('consistencyResult', () => { this.konfliktTypFilter = ''; });
  },

  // ── Dichte ───────────────────────────────────────────────────────────────
  setPlotDensity(compact) {
    this.plotDensity = compact ? 'compact' : 'normal';
    setUserPref(Alpine.store('session').currentUser?.email, DENSITY_PREF_KEY, this.plotDensity);
  },

  // Wie viele Schalter des Ansichts-Menues (plot-view-menu.html) von der
  // Grundansicht abweichen — die Zahl am Knopf. Gezaehlt wird nur, was gerade
  // angeboten wird: ein Archiv-Haken ohne archivierte Akte wirkt nicht.
  plotViewChanges() {
    return (this.plotShowArchived && this.archivedActCount() > 0 ? 1 : 0)
      + (this.plotHideImBuch ? 1 : 0)
      + (this.plotDensity === 'compact' ? 1 : 0);
  },

  // ── Akte einklappen ──────────────────────────────────────────────────────
  _collapsedKey() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return null;
    return `sw:${COLLAPSED_AREA}:${Alpine.store('session').currentUser?.email || ''}:${bookId}`;
  },

  _loadCollapsedActs() {
    const key = this._collapsedKey();
    const ids = key ? lsGetJSON(key, []) : [];
    const map = {};
    for (const id of Array.isArray(ids) ? ids : []) map[id] = true;
    this.collapsedActs = map;
  },

  isActCollapsed(actId) { return !!this.collapsedActs[actId]; },

  toggleActCollapsed(actId) {
    const next = { ...this.collapsedActs };
    if (next[actId]) delete next[actId]; else next[actId] = true;
    this.collapsedActs = next;
    const key = this._collapsedKey();
    if (key) lsSetJSON(key, Object.keys(next).map(Number));
  },

  // ── Leer-Zustand: ersten Akt anlegen ─────────────────────────────────────
  // Ohne Strang lebt das Eingabefeld im flachen Board (addingAct); gibt es schon
  // Stränge (alle Akte gelöscht), rendert das Grid — dort heisst der Weg
  // „geteilten Akt anlegen" (addingActScope = null). Ein addingAct = true allein
  // bliebe dann unsichtbar, der Knopf wäre tot.
  startFirstAct() {
    if ((this.threads || []).length) { this.startAddAct(null); return; }
    this.addingAct = true;
    this.$nextTick(() => this.$root?.querySelector('#partial-plot-board-flat .plot-new-act-input')?.focus());
  },

  // ── Brainstorm-Lauf eines archivierten Akts ──────────────────────────────
  // Im Archiv wird nicht geplant (kein Vorschlags-Panel in der Spalte). Ein Lauf
  // dorthin würde sonst still nichts anzeigen.
  brainstormRunActArchived(run) {
    if (!run || run.act_id == null) return false;
    const act = (this.acts || []).find(a => a.id === run.act_id);
    return !!(act && act.archiviert);
  },

  openBrainstormRunChecked(run) {
    if (!run || run.act_id == null) return;
    if (this.brainstormRunActArchived(run)) {
      this.errorMessage = window.__app.t('plot.brainstorm.actArchived');
      return;
    }
    this.openBrainstormRun(run);
  },

  // ── Tastatur in den teleportierten Menüs (role=menu) ─────────────────────
  _rememberMenuTrigger(ev) { this._menuTriggerEl = ev?.currentTarget || null; },

  plotMenuRestoreFocus() {
    const el = this._menuTriggerEl;
    this._menuTriggerEl = null;
    if (el && el.isConnected) el.focus();
  },

  _plotMenuItems(menu) {
    return [...(menu?.querySelectorAll('[role="menuitem"]:not([disabled])') || [])];
  },

  // Beim Öffnen den ersten Eintrag fokussieren. rAF: x-show hat das Menü im
  // selben Tick erst sichtbar geschaltet, ein unsichtbares Element nimmt keinen Fokus.
  plotMenuFocusFirst(menu) {
    requestAnimationFrame(() => { this._plotMenuItems(menu)[0]?.focus(); });
  },

  // Pfeiltasten/Home/End wandern durch die Einträge (WAI-ARIA Menu-Pattern).
  plotMenuKeydown(e, menu) {
    const items = this._plotMenuItems(menu);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    if (!next) return;
    e.preventDefault();
    next.focus();
  },
};
