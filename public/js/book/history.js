// History-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

import { fetchJson } from '../utils.js';
import { sortByPosition, isHardFinding } from './page-view.js';
import { contentRepo } from '../repo/content.js';
import { renderLektoratAnalysisHtml } from '../editor/lektorat-analysis.js';

export const historyMethods = {
  async loadPageHistory(pageId) {
    try {
      const rows = await fetchJson('/history/page/' + pageId);
      // Späte Antwort einer inzwischen verlassenen Seite: nicht in deren Verlauf schreiben.
      if (this.currentPage && String(this.currentPage.id) !== String(pageId)) return;
      this.pageHistory = rows;
    } catch (e) {
      console.error('[loadPageHistory]', e);
    }
  },

  // Während «Korrekturen speichern» läuft, gehört der Lauf dem Speichervorgang:
  // kein Umschalten, Löschen oder Laden eines anderen Eintrags dazwischen.
  async toggleHistoryEntrySaved(entry) {
    if (this.saveApplying != null) return;
    const newSaved = !entry.saved;
    try {
      const r = await fetch('/history/check/' + entry.id + '/saved', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ saved: newSaved }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      entry.saved = newSaved;
      entry.saved_at = newSaved ? new Date().toISOString() : null;
      this.refreshPageAges();
    } catch (e) {
      console.error('[toggleHistoryEntrySaved]', e);
      this.setStatus(this.t('editor.history.updateFailed'), false, 6000);
    }
  },

  async deletePageCheck(id) {
    if (this.saveApplying != null) return;
    try {
      const r = await fetch('/history/check/' + id, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.pageHistory = this.pageHistory.filter(e => e.id !== id);
      this.refreshPageAges();
      // Aktiven Eintrag gelöscht → Vorschau zurücksetzen
      if (this.activeHistoryEntryId === id) {
        this.activeHistoryEntryId = null;
        this.lektoratFindings = [];
        this.selectedFindings = [];
        this.appliedOriginals = [];
        this.appliedHistoricCorrections = [];
        this.lektoratProgress = null;
        this.correctedHtml = null;
        this.hasErrors = false;
        this.checkDone = false;
        this.analysisOut = '';
        this.lastCheckId = null;
        this.updatePageView();
      }
    } catch (e) {
      console.error('[deletePageCheck]', e);
      this.setStatus(this.t('editor.history.deleteFailed'), false, 6000);
    }
  },

  async loadBookReviewHistory(bookId, { signal } = {}) {
    try {
      this.bookReviewHistory = await fetchJson('/history/review/' + bookId, { signal });
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.error('[loadBookReviewHistory]', e);
    }
  },

  /** History-Eintrag in die Vorschau laden (Toggle: erneuter Klick setzt zurück) */
  async loadHistoryEntry(entry) {
    if (this.saveApplying != null) return;
    // Toggle: Klick auf aktiven Eintrag → Vorschau zurücksetzen
    if (this.activeHistoryEntryId === entry.id) {
      this.activeHistoryEntryId = null;
      this.lektoratFindings = [];
      this.selectedFindings = [];
      this.appliedOriginals = [];
      this.appliedHistoricCorrections = [];
      this.lektoratProgress = null;
      this.correctedHtml = null;
      this.hasErrors = false;
      this.checkDone = false;
      this.analysisOut = '';
      this.lastCheckId = null;
      this.updatePageView();
      return;
    }

    if (!this.currentPage) return;
    // Seite pinnen: wechselt der User während der Awaits, gehört der Eintrag
    // nicht zur dann offenen Seite — Befunde, Check-ID und Analyse blieben sonst
    // an der falschen Seite hängen (und ein Speichern schriebe dorthin).
    const pageId = this.currentPage.id;
    const samePage = () => this.currentPage?.id === pageId;

    // Aktuelles Seiten-HTML laden falls nötig
    if (!this.originalHtml) {
      try {
        const pd = await contentRepo.loadPage(pageId);
        if (!samePage()) return;
        this.originalHtml = pd.html || '';
      } catch (e) {
        this.setStatus(this.t('chat.pageLoadFailed'));
        return;
      }
    }

    // JSON-Details lazy nachladen (Listen-Endpoint liefert sie nicht mehr).
    // Cache am Eintrag selbst, damit erneuter Klick keinen zweiten Fetch macht.
    if (entry.errors_json === undefined) {
      try {
        const details = await fetchJson('/history/check/' + entry.id + '/details');
        entry.errors_json = details.errors_json || [];
        entry.applied_errors_json = details.applied_errors_json || null;
        entry.selected_errors_json = details.selected_errors_json || null;
        entry.szenen_json = details.szenen_json || null;
      } catch (e) {
        console.error('[loadHistoryEntry details]', e);
        if (samePage()) this.setStatus(this.t('chat.pageLoadFailed'));
        return;
      }
    }
    if (!samePage()) return;

    const findings = sortByPosition(this.originalHtml, entry.errors_json || []);
    this.lektoratFindings = findings;

    // Übernommen ist, was im Text gelandet ist (`applied_errors_json`). Die
    // Auswahl (`selected_errors_json`) enthält auch Übersprungenes — als
    // „übernommen" gesperrt liesse es sich nicht erneut versuchen. Nur alte
    // Einträge ohne Annahmen-Liste fallen auf die Auswahl zurück.
    const appliedEntries = entry.saved
      ? (entry.applied_errors_json || entry.selected_errors_json || [])
      : [];
    const appliedUnion = appliedEntries.map(e => e.original);
    this.appliedOriginals = [...new Set(appliedUnion)];
    const appliedSet = new Set(this.appliedOriginals);

    // Bereits eingearbeitete Korrekturen, deren Original nicht mehr im Text steht
    // (wurde durch die Korrektur ersetzt) → separate, kompakte Sektion in der Fehlerliste.
    const stillVisible = new Set(findings.map(f => f.original));
    const seenOriginals = new Set();
    this.lektoratProgress = null;
    this.appliedHistoricCorrections = appliedEntries.filter(e => {
      if (!e.original || stillVisible.has(e.original) || seenOriginals.has(e.original)) return false;
      seenOriginals.add(e.original);
      return true;
    });

    // Selection: bereits angewendete Korrekturen, weiche/redaktionelle Typen und
    // Befunde im Nachrichtenverlauf default unselected (editor/lektorat.js#findingPreselected)
    this.selectedFindings = findings.map(f => !appliedSet.has(f.original) && this.findingPreselected(f));

    const hardErrors = findings.filter(f => isHardFinding(f.typ));
    this.hasErrors = hardErrors.length > 0;
    // Vorschau = Auswahl (wie _recomputeCorrectedHtml), nicht alle harten Befunde.
    const preselected = findings.filter((_, i) => this.selectedFindings[i]);
    this.correctedHtml = preselected.length > 0
      ? this._applyCorrections(this.originalHtml, preselected)
      : this.originalHtml;

    this.checkDone = true;
    if (this.showChatCard) { this.showChatCard = false; this._checkDoneBeforeChat = false; }
    this.lastCheckId = entry.id;
    this.activeHistoryEntryId = entry.id;

    // Szenen, Stilanalyse, Fazit in analysisOut rendern — derselbe Renderer wie
    // beim frischen Lauf (editor/lektorat-analysis.js).
    this.analysisOut = renderLektoratAnalysisHtml((k, p) => this.t(k, p), {
      szenen: entry.szenen_json, stilanalyse: entry.stilanalyse, fazit: entry.fazit,
    });

    this.updatePageView();
    this.setStatus(this.t('lektorat.historyEntryLoaded', { date: this.formatDate(entry.checked_at) }), false, 4000);

    // Nach oben zur Seitenansicht scrollen
    document.getElementById('editor-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  // Wie die Kapitelbewertung: Rückfrage, und nur bei bestätigtem DELETE aus der
  // Liste nehmen (fetchJson wirft auf !ok) — sonst verschwände ein Eintrag, den
  // der Server noch hat.
  async deleteBookReview(id) {
    if (!await this.appConfirm({
      message: this.t('review.deleteConfirm'),
      confirmLabel: this.t('common.delete'),
      danger: true,
    })) return;
    try {
      await fetchJson('/history/review/' + id, { method: 'DELETE' });
      this.bookReviewHistory = this.bookReviewHistory.filter(e => e.id !== id);
      if (this.selectedBookReviewId === id) this.selectedBookReviewId = null;
    } catch (e) {
      console.error('[deleteBookReview]', e);
      this.setStatus(this.t('common.deleteFailed'), false, 5000);
    }
  },
};
