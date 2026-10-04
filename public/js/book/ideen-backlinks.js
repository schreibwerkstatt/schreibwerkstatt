// Gegenrichtung der Ideen-Verknuepfung: die Ideen-Referenzen AN einem Recherche-
// Fundstueck, einem Plot-Beat oder -Strang, einem Motiv oder einer Werkstatt-Figur.
//
// EIN Modul fuer alle Karten — sie stellen dieselbe Frage („welche meiner
// Pendenzen haengen an diesem Ding?") und bekommen dieselbe Antwortform. Der
// Lesepfad ist `GET /ideen/links`, nicht ein erweitertes Feld an der jeweiligen
// Entitaet: Ideen sind user-privat, `research_items` dagegen buchweit geteilt —
// haengte man die Anrisse an die Fundstueck-Zeile, muesste jeder ihrer
// Schreibpfade die Skopierung mitfuehren.
//
// Kuratiert wird die Kante ausschliesslich auf der Ideen-Seite (Ideen-Karte,
// Ideen-Board); hier ist sie read-only mit Sprung zurueck (x-entity-ref, Typ
// `idee`: page_id/chapter_id der Idee bestimmen das Sprungziel).
//
// Verwendung in einer Karte:
//   State:   ideaBacklinks: {}, _ideaBacklinkBookId: null
//   Init:    ...ideenBacklinkMethods  (spread)
//   Laden:   await this.loadIdeaBacklinks('beat')   // nach dem eigenen Load
//   Template: <template x-for="idee in ideasFor(beat.id)"> …
//
// Zwei Ziel-Arten in EINER Karte (Plot: Beats und Stränge): die zweite Map unter
// eigenem Namen laden — `loadIdeaBacklinks('thread', { into: 'threadIdeaBacklinks' })`
// — und im Template `ideasFor(id, 'threadIdeaBacklinks')` lesen (das Fragment
// ideen-backlinks.html nimmt dafür `ideaSource` aus dem Wrapper-x-data).

import { fetchJson } from '../utils.js';
import { ideeStatus } from './ideen-shared.js';

export const ideenBacklinkMethods = {
  /**
   * Map Ziel-ID → Ideen-Anrisse fuer EINE Ziel-Art holen.
   *
   * NON-FATAL: schlaegt der Aufruf fehl, bleibt die Karte ohne Ideen-Referenzen
   * stehen statt mit einer Fehlermeldung. Die Referenzen sind eine Beigabe — ein
   * Motiv-Katalog, der wegen einer fehlenden Nebenlesung gar nicht erscheint,
   * waere der schlechtere Tausch.
   */
  async loadIdeaBacklinks(targetKind, { into = 'ideaBacklinks' } = {}) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this[into] = {}; return; }
    try {
      const data = await fetchJson(`/ideen/links?book_id=${bookId}&target_kind=${targetKind}`);
      this[into] = data?.links || {};
      if (into === 'ideaBacklinks') this._ideaBacklinkBookId = bookId;
    } catch {
      this[into] = {};
      if (into === 'ideaBacklinks') this._ideaBacklinkBookId = null;
    }
  },

  ideasFor(targetId, from = 'ideaBacklinks') {
    return (this[from || 'ideaBacklinks'] || {})[String(targetId)] || [];
  },

  ideaStatusLabel(idee) { return window.__app.t(`ideen.status.${ideeStatus(idee)}`); },

  // Der Tooltip nennt Status und die Stelle im Buch, an der die Pendenz haengt —
  // ohne sie waere „noch ein Beleg noetig" eine Notiz ohne Ort.
  ideaAnchorLabel(idee) {
    if (idee && idee.page_id == null && idee.chapter_id == null) return window.__app.t('ideenBoard.laneBook');
    return idee?.page_name || idee?.chapter_name || window.__app.t('ideenBoard.laneUnknown');
  },

  ideaChipTip(idee) {
    const app = window.__app;
    return `${this.ideaStatusLabel(idee)} · ${this.ideaAnchorLabel(idee)} — ${app.t('ideen.link.gotoIdee')}`;
  },
};
