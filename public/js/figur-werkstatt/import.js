// Import bestehender Buch-Figur als Werkstatt-Draft.
// Server filtert figures-Liste auf jene ohne aktiven Werkstatt-Draft des Users.
// POST /import erzeugt Draft mit Mindmap aus figures-Feldern + source_figure_id-
// Referenz. Werkstatt-Jobs schliessen die Quell-Figur serverseitig vom Buch-
// Kontext aus, damit sie sich nicht selbst referenziert.

import { fetchJson, sendJson } from '../utils.js';
import { isSelectedBook } from '../cards/book-guard.js';

// Normalisierung fuer den Namensvergleich: getrimmt, kleingeschrieben. Bewusst
// stumpf — er entscheidet nur die VORAUSWAHL im Verknuepfen-Dialog, nie die
// Verknuepfung selbst (die bestaetigt der Autor).
function _norm(s) { return String(s || '').trim().toLowerCase(); }

export const importMethods = {
  async startImport() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    this.importing = true;
    this.importablesLoading = true;
    this.selectedImportFigureId = '';
    this.errorMessage = '';
    try {
      const rows = await fetchJson(`/draft-figures/${bookId}/importable`);
      if (!isSelectedBook(bookId)) return;
      this.importables = Array.isArray(rows) ? rows : [];
    } catch (e) {
      this.importables = [];
      this.errorMessage = app.t('werkstatt.error.importLoad');
    } finally {
      this.importablesLoading = false;
    }
  },

  // ── Nachtraeglich mit einer Katalog-Figur verknuepfen ──────────────────────
  // Der Weg fuer alle, die erst geplant und dann geschrieben haben: die
  // Komplettanalyse legt die Figur ein zweites Mal an. Ohne den Zeiger bleiben
  // es zwei Figuren, und jede Bruecke im Haus fuehrt zwei Spalten.
  // `anchor` = Trigger des Overflow-Menues: der Menue-Eintrag verschwindet mit
  // dem Menue, der Picker (werkstatt-link-picker.html) haengt am Knopf. Er geht
  // sofort auf und zeigt den Ladezustand; nach dem Laden wird neu gemessen,
  // weil Combobox bzw. Leer-Hinweis die Hoehe aendern.
  async startLinkFigure(anchor) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.selectedDraftId) return;
    this.linking = true;
    this.linkCandidatesLoading = true;
    this.selectedLinkFigureId = '';
    this.linkCandidates = [];
    this.errorMessage = '';
    this._openPickerPopover(anchor, 'werkstattLinkPopover', () => this.cancelLinkFigure());
    try {
      const rows = await fetchJson(`/draft-figures/${bookId}/link-candidates`);
      if (!isSelectedBook(bookId)) return;
      this.linkCandidates = Array.isArray(rows) ? rows : [];
      // Vorauswahl bei Namensgleichheit — der haeufigste Fall ist genau der,
      // und er soll ein Klick sein, keine Suche.
      const me = _norm(this.editName || this.selectedDraft()?.name);
      const hit = this.linkCandidates.find(f => _norm(f.name) === me || _norm(f.kurzname) === me);
      if (hit) this.selectedLinkFigureId = String(hit.id);
    } catch {
      this.linkCandidates = [];
      this.errorMessage = app.t('werkstatt.error.linkLoad');
    } finally {
      this.linkCandidatesLoading = false;
      this._refinePickerPopover('werkstattLinkPopover');
    }
  },

  cancelLinkFigure() {
    this.linking = false;
    this.selectedLinkFigureId = '';
    this.linkCandidates = [];
    this._releasePickerPopover();
  },

  // figureId === null loest die Verknuepfung wieder (der Draft lebt weiter —
  // `source_figure_id` ist ein Zeiger, kein Besitz).
  async runLinkFigure(figureId) {
    const app = window.__app;
    const id = this.selectedDraftId;
    if (!id) return;
    const fid = figureId === null ? null : parseInt(figureId ?? this.selectedLinkFigureId);
    if (figureId !== null && !fid) return;
    this.busy = true;
    try {
      let body;
      try {
        body = await sendJson(`/draft-figures/by-id/${id}/link-figure`, 'POST', { figureId: fid });
      } catch (e) {
        if (e.status !== 409 || !e.body?.existingDraftId) throw e;
        // Die Katalog-Figur haengt schon an einem anderen Draft — dorthin
        // springen statt eine mehrdeutige Quelle zu erlauben.
        this.errorMessage = app.t('werkstatt.error.alreadyLinked');
        this.cancelLinkFigure();
        this.selectDraft(e.body.existingDraftId);
        return;
      }
      // Draft-Liste lokal nachziehen (der Server liefert die frische Zeile mit
      // aufgeloestem source_figure_name) und die Cross-Feature-Badges neu holen:
      // die Plot-/Motiv-Beteiligung haengt an der Quell-Figur.
      const idx = this.drafts.findIndex(d => d.id === id);
      if (idx >= 0) this.drafts.splice(idx, 1, body);
      this.cancelLinkFigure();
      this.errorMessage = '';
      this.loadPlotUsage?.();
      this.loadMotifUsage?.();
    } catch {
      this.errorMessage = app.t('werkstatt.error.link');
    } finally { this.busy = false; }
  },

  cancelImport() {
    this.importing = false;
    this.selectedImportFigureId = '';
    this.importables = [];
  },

  async runImport() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    const figureId = parseInt(this.selectedImportFigureId);
    if (!bookId || !figureId) return;
    this.busy = true;
    try {
      // 409 ALREADY_IMPORTED traegt `existingDraftId`: dann zum bestehenden
      // Draft springen statt eine Fehlermeldung zu zeigen.
      let body;
      try {
        body = await sendJson(`/draft-figures/${bookId}/import`, 'POST', { figureId });
      } catch (e) {
        if (e.status !== 409 || e.code !== 'ALREADY_IMPORTED' || !e.body?.existingDraftId) throw e;
        this.importing = false;
        this.importables = [];
        this.selectedImportFigureId = '';
        await this.loadDrafts();
        this.selectDraft(e.body.existingDraftId);
        this.errorMessage = '';
        return;
      }
      this.drafts = [body, ...this.drafts];
      this.importing = false;
      this.importables = [];
      this.selectedImportFigureId = '';
      this.selectDraft(body.id);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.import');
    } finally {
      this.busy = false;
    }
  },

  // Zweitzeile (sublabel) im Import-Picker: Hauptkapitel · Beruf · Jahrgang,
  // jeweils nur wenn bekannt. Server liefert hauptkapitel/beruf/geburtstag.
  importFigureContext(f) {
    const app = window.__app;
    const t = (k, p) => app?.t?.(k, p) ?? '';
    const parts = [];
    if (f.hauptkapitel) parts.push(t('werkstatt.import.ctx.chapter', { name: f.hauptkapitel }));
    if (f.beruf) parts.push(String(f.beruf).trim());
    const jahr = f.geburtstag && String(f.geburtstag).match(/\d{4}/);
    if (jahr) parts.push(t('werkstatt.import.ctx.year', { year: jahr[0] }));
    return parts.join(' · ');
  },

  // Quell-Figur-Name für Header-Badge. null wenn frei angelegt oder Quell-Figur
  // gelöscht (FK SET NULL).
  //
  // Quelle ist `source_figure_name` aus der Draft-Antwort: db/draft-figures.js
  // loest den Namen schon per LEFT JOIN auf. Ein zweiter Lookup im
  // catalog-Store waere von dessen Ladezustand abhaengig — das Badge fehlte
  // dann, obwohl der Server den Namen laengst mitgeschickt hat.
  importedFromName() {
    const sel = this.selectedDraft();
    if (!sel?.source_figure_id) return null;
    return sel.source_figure_name || null;
  },
};
