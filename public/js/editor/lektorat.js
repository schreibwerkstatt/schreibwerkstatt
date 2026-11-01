import { escHtml, fetchJson, SAFETY_HTML_RATIO, countInHtml, replaceInHtml, replaceInHtmlRich, richSkipReason, findInHtml, skipReason, stripFocusArtefacts, formatNumber } from '../utils.js';
import { insideClassDiv } from '../utils/html-container.js';
import { MSG_THREAD_CLASS } from '../messages/msg-html.js';
import { sortByPosition, isHardFinding } from '../book/page-view.js';
import { contentRepo } from '../repo/content.js';
import { savePage } from './shared/page-api.js';
import { renderLektoratAnalysisHtml } from './lektorat-analysis.js';
import { runQuoteNormalizeHtml } from './shared/quote-normalize.js';
import { lsSet } from '../safe-storage.js';
import { UNDO_WINDOW_MS } from './lektorat-undo.js';
import { trackUsageEvent } from '../features-usage.js';
import { patchBookedLists, mergeByOriginal, bookingEntry } from './lektorat-booking.js';
import { lektoratBatchMethods } from './lektorat/batch.js';

// Lektorat-Workflow-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

// Befund-Ort „im Nachrichtenverlauf", gemerkt pro geprüftem HTML-Stand: die
// Befundliste fragt bei jedem Render. Ausserhalb von Alpine, damit das Merken
// keinen Effekt auslöst.
let _threadMemoHtml = null;
const _threadMemo = new Map();
function _inMsgThread(html, original) {
  if (!html || !original) return false;
  if (html !== _threadMemoHtml) { _threadMemoHtml = html; _threadMemo.clear(); }
  if (!_threadMemo.has(original)) {
    const m = findInHtml(html, original);
    _threadMemo.set(original, !!m && insideClassDiv(html, m.htmlStart, MSG_THREAD_CLASS));
  }
  return _threadMemo.get(original);
}

// Stelle steht mehrfach in der angezeigten Fassung, gemerkt wie oben.
let _ambigMemoHtml = null;
const _ambigMemo = new Map();
function _ambiguousIn(html, original) {
  if (!html || !original) return false;
  if (html !== _ambigMemoHtml) { _ambigMemoHtml = html; _ambigMemo.clear(); }
  if (!_ambigMemo.has(original)) _ambigMemo.set(original, countInHtml(html, original) > 1);
  return _ambigMemo.get(original);
}

// Ab dieser Länge des geprüften Texts (Zeichen) rät das Ergebnis, den Abschnitt
// zu teilen (routes/jobs/lektorat.js liefert `textChars`).
const LONG_SECTION_CHARS = 20000;

export const lektoratMethods = {
  // Befund steht in einem Nachrichtenverlauf: Chat-Schreibweise ist Figurenrede.
  // Solche Befunde sind nie vorausgewählt — «Angehakte übernehmen» soll keine
  // SMS-Sprache glattbügeln, die der Autor nicht einzeln angehakt hat.
  findingInMsgThread(f) {
    return _inMsgThread(this.originalHtml, f?.original);
  },

  // Mehrdeutige Fundstelle (`mehrdeutig`, Server: lektorat-page.js#markAmbiguous):
  // «Übernehmen» überspringt sie (findingAmbiguousNow) — nicht vorauswählen. Ebenso ein Befund, den der Autor im Vorlauf stehen liess
  // (`abgelehnt`, lib/lektorat-progress.js#markPreviouslyRejected).
  findingPreselected(f) {
    return isHardFinding(f.typ) && !f.mehrdeutig && !f.abgelehnt && !this.findingInMsgThread(f) && this.findingSelectable(f);
  },

  // Auswählbar ist ein Befund, der etwas ändern würde und noch nicht übernommen
  // ist. Übernommene stehen oft weiter im Text („sagte er" → „sagte er,"): ein
  // zweites Anwenden schriebe „sagte er,,". Umgeschriebene stehen nicht mehr da.
  findingSelectable(f) {
    return !!f?.korrektur && f.korrektur !== f.original && !f.umgeschrieben && !this.appliedOriginals.includes(f.original);
  },

  // Steht die Stelle gerade mehrfach im Text? Edit-Modus: Live-Text (`mehrfach`,
  // lektorat-live.js#_relocateLektoratLive), Leseansicht: die angezeigte Fassung.
  // «Übernehmen» überspringt solche Befunde in beiden Modi (Skip-Grund `ambiguous`).
  findingAmbiguousNow(f) {
    if (this.editMode) return !!f?.mehrfach;
    return _ambiguousIn(this.originalHtml, f?.original);
  },

  // Angehakt und jetzt übernehmbar: eine mehrfach dastehende Stelle bleibt
  // angehakt, zählt aber nicht mit — «Übernehmen» überspränge sie ohnehin.
  _applicableSelectedIndices() {
    return this.selectedFindings.flatMap((v, i) => (v && !this.findingAmbiguousNow(this.lektoratFindings[i]) ? [i] : []));
  },

  applicableSelectedCount() {
    return this._applicableSelectedIndices().length;
  },

  applySelectedFindings() {
    return this.applyFindings(this._applicableSelectedIndices());
  },

  // «Übernehmen» — ein Einstieg für beide Modi: im Edit-Modus in den Live-Editor
  // (lektorat-live.js#applyLektoratLive, Server-Write liesse das contenteditable
  // auf altem Stand), in der Leseansicht per Server-Write (saveCorrections).
  // Die Befundliste bleibt in beiden stehen; Übernommenes trägt „übernommen".
  applyFindings(indices) {
    return this.editMode ? this.applyLektoratLive(indices) : this.saveCorrections(indices);
  },

  // Steht die Stelle des Befunds `i` (noch) im Text? Eine Regel für beide Wege,
  // die das nachführen: gegen das gespeicherte HTML nach einem Save
  // (notebook/edit/lifecycle.js#_filterFindingsAfterSave) und gegen den
  // Live-Text im Edit-Modus (lektorat-live.js#_relocateLektoratLive).
  // Weg: `umgeschrieben` (grau, nicht auswählbar) und abgewählt. Wieder da
  // (Strg+Z, Abbrechen): nicht mehr „durch andere Korrektur erledigt".
  _setFindingPresence(i, present) {
    const f = this.lektoratFindings[i];
    if (!f) return;
    if (!!f.umgeschrieben === present) f.umgeschrieben = !present;
    if (present && f.erledigt) f.erledigt = false;
    if (!present && this.selectedFindings[i]) this.selectedFindings[i] = false;
  },

  // `outSkipped` (optional): sammelt Korrekturen, die replaceInHtml unangetastet
  // liess (No-Op), als `{ f, reason }`. Fünf Gründe (`skipReason`), die der User auseinander
  // halten MUSS — „Stelle existiert nicht mehr" (Seite wurde zwischenzeitlich
  // umgeschrieben, typisch nach einem Write von einem Zweitgerät) verlangt keine
  // manuelle Nachkontrolle, „Link/Quellenangabe/Absatzgrenze betroffen" schon.
  // Reihenfolge des
  // Entscheidungsbaums identisch zum Seiten-Chat (chat.js#applyChatVorschlag).
  // Ausgewertet wird gegen `result`, den sequenziell mitwandernden Stand: ein
  // Finding, dessen `original` erst durch eine vorherige Korrektur verschwindet,
  // ist `notFound` und nicht `boundary`.
  // Aufrufer ohne Interesse an den Skips lassen den Parameter weg.
  // `checkAmbiguous` (Abschnitts-Chat, Lektorat-«Übernehmen» in beiden Modi):
  // eine mehrfach vorkommende Stelle wird als 'ambiguous' übersprungen. Die
  // Vorschau der Leseansicht prüft es ebenso, damit sie zeigt, was übernommen würde.
  // `rich` (nur Abschnitts-Chat): Ersatz darf *kursiv*/**fett** und eine
  // Absatzteilung tragen (utils/html-replace-rich.js); eine Lektorat-Korrektur
  // ist immer Klartext.
  _applyCorrections(html, fehler, outSkipped, { checkAmbiguous = false, rich = false } = {}) {
    const replace = rich ? replaceInHtmlRich : replaceInHtml;
    const reasonOf = rich ? richSkipReason : skipReason;
    let result = html;
    for (const f of fehler) {
      if (!f.original || !f.korrektur || f.original === f.korrektur) continue;
      if (checkAmbiguous && countInHtml(result, f.original) > 1) {
        if (outSkipped) outSkipped.push({ f, reason: 'ambiguous' });
        continue;
      }
      const next = replace(result, f.original, f.korrektur);
      if (next === result) {
        if (outSkipped) outSkipped.push({ f, reason: reasonOf(result, f.original, f.korrektur) });
        continue;
      }
      result = next;
    }
    return result;
  },

  // Fasst uebersprungene Korrekturen nach Grund zusammen: je vorkommender Grund
  // ein lokalisierter Teilsatz, in fester Reihenfolge verbunden. Feste Reihenfolge
  // statt Iteration ueber die Skip-Liste, damit die Meldung bei gleicher Ursache
  // gleich lautet.
  _skipSummary(skipped) {
    const counts = {};
    for (const s of skipped) counts[s.reason] = (counts[s.reason] || 0) + 1;
    return ['notFound', 'ambiguous', 'noCorrection', 'unchanged', 'spansLink', 'spansMarker', 'boundary']
      .filter(k => counts[k] > 0)
      .map(k => this.t('lektorat.skip.' + k, { count: counts[k] }))
      .join(', ');
  },

  // Gemeinsamer Kern fuer Lektorat-Save und History-Apply:
  // Seite frisch laden → Korrekturen anwenden → Safety-Check → Speichern.
  // `fresh: true` umgeht SWR; sonst koennte der CONTENT_CACHE nach kurz zuvor
  // gesetzten Edits noch die alte Fassung liefern und der gleich folgende PUT
  // wuerde frische Server-Edits mit Stale-Daten ueberschreiben.
  //
  // Die Seite wird beim Start gepinnt: Korrekturen gehören zu der Seite, auf
  // der sie gefunden wurden, und ein Seitenwechsel während der Awaits darf
  // weder Ziel noch Name des PUT verschieben. `stale: true` im Ergebnis sagt
  // dem Aufrufer, dass inzwischen eine andere Seite offen ist — deren View-State
  // (originalHtml, updated_at) fasst er dann nicht an.
  // `opts.checkAmbiguous`/`opts.rich` reichen an `_applyCorrections` durch (Abschnitts-Chat).
  async _loadApplyAndSave(selectedErrors, onProgress, source = 'lektorat-apply', { checkAmbiguous = false, rich = false } = {}) {
    const pageId = this.currentPage.id;
    const pageName = this.currentPage.name;
    onProgress(10, this.t('lektorat.loadingPage'));
    const page = await contentRepo.loadPage(pageId, { fresh: true });
    page.html = stripFocusArtefacts(page.html || '');

    const skipped = [];
    let finalHtml = selectedErrors.length > 0
      ? this._applyCorrections(page.html, selectedErrors, skipped, { checkAmbiguous, rich })
      : page.html;

    // KI-Korrekturen/Vorschläge liefern oft gerade `"`/`'` — auf Buch-Style
    // ziehen (de-CH «», de-DE „" …), bevor sie persistiert werden. Ganze Seite,
    // damit Quotes vollen Open/Close-Kontext haben. Idempotent, fehlertolerant.
    if (selectedErrors.length > 0 && this.$store.nav.selectedBookId) {
      const { html } = await runQuoteNormalizeHtml({ bookId: this.$store.nav.selectedBookId, html: finalHtml });
      finalHtml = html;
    }

    if (finalHtml.length < page.html.length * SAFETY_HTML_RATIO) {
      throw new Error(this.t('lektorat.unsafeHtml'));
    }

    onProgress(85, this.t('lektorat.saving'));
    // `page.updated_at` ist der frisch geladene Stand; PUT optimistisch gegen
    // genau diesen Stamp. Wenn dazwischen jemand schreibt → 409 vom Server.
    const saved = await savePage(pageId, {
      html: finalHtml,
      pageName,
      source,
      expectedUpdatedAt: page.updated_at || null,
    });
    const stale = this.currentPage?.id !== pageId;
    if (!stale && saved?.updated_at) this.currentPage.updated_at = saved.updated_at;
    // Uebernommene Korrekturen sind direkte Folge des Lektorats — Seite soll
    // nicht unmittelbar danach auf "seit Lektorat bearbeitet" flippen. Ein
    // Seiten-Chat-Vorschlag ('chat-apply') ist KEIN Lektorat: die Seite wurde
    // bearbeitet und gilt danach zu Recht als „seit Lektorat geaendert".
    if (source !== 'chat-apply') this.markPageChecked?.(pageId);
    this._syncPageStatsAfterSave?.({ id: pageId, updated_at: saved?.updated_at || null }, finalHtml);
    // `preHtml` + `savedUpdatedAt`: Grundlage für «Korrekturen rückgängig»
    // (lektorat-undo.js) — der frisch geladene Stand vor dem Übernehmen.
    // `savedHtml`: Server-Fassung (mit data-bid) — Basis für Ansicht und nächsten Merge.
    const savedHtml = typeof saved?.html === 'string' ? saved.html : finalHtml;
    return { finalHtml, savedHtml, skipped, pageId, stale, preHtml: page.html, savedUpdatedAt: saved?.updated_at || null };
  },


  // Im Edit-Modus unsichtbar: nachgeholt beim Verlassen (lektorat-live.js#_setupLektoratLive).
  _recomputeCorrectedHtml() {
    if (!this.originalHtml || this.editMode) return;
    const selected = this.lektoratFindings.filter((_, i) => this.selectedFindings[i]);
    this.correctedHtml = selected.length > 0
      ? this._applyCorrections(this.originalHtml, selected, null, { checkAmbiguous: true })
      : this.originalHtml;
    this.updatePageView();
  },

  toggleFinding(i) {
    const next = !this.selectedFindings[i];
    if (next && !this.findingSelectable(this.lektoratFindings[i])) return;
    this.selectedFindings[i] = next;
    this._recomputeCorrectedHtml();
  },

  selectAllFindings(val) {
    this.selectedFindings = this.lektoratFindings.map(f => val && this.findingSelectable(f));
    this._recomputeCorrectedHtml();
  },

  closeFindings() {
    this.checkDone = false;
    this.lektoratFindings = [];
    this.selectedFindings = [];
    this.appliedOriginals = [];
    this.appliedHistoricCorrections = [];
    this.lektoratProgress = null;
    this.correctedHtml = null;
    this.hasErrors = false;
    this.analysisOut = '';
    this.checkStatus = '';
    this.activeHistoryEntryId = null;
    this.updatePageView();
  },

  async runCheck() {
    if (!this.currentPage || this.checkLoading) return;
    if (await this._saveBeforeLiveCheck?.() === false) return; // Edit-Modus: erst speichern
    // Job liest die gespeicherte Seite: lokale Edits (Draft, editDirty) erst speichern.
    if (this.saveOffline || this.editDirty) {
      this.setStatus(this.t('lektorat.blockedUnsavedEdits'), false, 6000);
      return;
    }
    // Edit-Modus: ob leer, steht erst nach dem Save fest (Leseansicht sperrt den Knopf).
    if (this.currentPageEmpty) return this.setStatus(this.t('editor.btn.pageEmpty'), false, 4000);
    const pageIdAtStart = this.currentPage.id;
    this.logAuditEvent?.('lektoratOpened', { book: this.$store.nav.selectedBookId, page: pageIdAtStart });
    this.checkLoading = true;
    this.checkDone = false;
    this.activeHistoryEntryId = null;
    // originalHtml und renderedPageHtml beibehalten → Seitenansicht bleibt sichtbar
    this.correctedHtml = null;
    this.hasErrors = false;
    this.analysisOut = '';
    this.lektoratFindings = [];
    this.selectedFindings = [];
    this.appliedOriginals = [];
    this.appliedHistoricCorrections = [];
    this.lektoratProgress = null;
    this.checkProgress = 0;
    this.checkStatus = `<span class="spinner"></span>${escHtml(this.t('lektorat.starting'))}`;

    try {
      const { jobId } = await fetchJson('/jobs/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: this.currentPage.id,
          book_id: this.currentPage.book_id || null,
          page_name: this.currentPage.name || null,
        }),
      });
      if (this.currentPage?.id !== pageIdAtStart) return;
      lsSet('lektorat_check_job_' + this.currentPage.id, jobId);
      this.startCheckPoll(jobId);
    } catch (e) {
      console.error('[runCheck]', e);
      if (this.currentPage?.id !== pageIdAtStart) return;
      this.analysisOut = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.checkStatus = '';
      this.checkLoading = false;
    }
  },

  startCheckPoll(jobId) {
    const pageId = this.currentPage?.id;
    // Per-pageId Timer-Slot: Wechselt User während laufendem Check auf eine
    // andere Seite, soll der Poll für die ursprüngliche Seite weiterlaufen
    // (sonst feuert `onDone` nie → Sidebar-Status der Ursprungsseite bleibt
    // stale). Ein zweiter Check für eine andere Seite kollidiert nicht.
    this._startPoll({
      timerProp: '_checkPollTimer_' + pageId,
      jobId,
      lsKey: pageId != null ? 'lektorat_check_job_' + pageId : null,
      onProgress: (job) => {
        if (this.currentPage?.id !== pageId) return;
        this.checkProgress = job.progress || 0;
        this.checkStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
      },
      onNotFound: () => {
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        this.analysisOut = `<span class="error-msg">${escHtml(this.t('job.interrupted'))}</span>`;
        this.checkStatus = '';
      },
      onError: (job) => {
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        setTimeout(() => { this.checkProgress = 0; }, 400);
        this.analysisOut = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(this.t(job.error, job.errorParams))}</span>`;
        this.checkStatus = '';
      },
      onDone: async (job) => {
        // Sidebar-Status immer aktualisieren, auch wenn User inzwischen auf eine andere Seite gewechselt hat.
        const r = job.result || {};
        const fehler = r.fehler || [];
        if (!r.empty) this.markPageChecked(pageId, { pending: fehler.length > 0 });
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        setTimeout(() => { this.checkProgress = 0; }, 400);
        this.checkStatus = '';
        if (r.empty) {
          this.analysisOut = `<span class="muted-msg">${escHtml(this.t('job.pageEmpty'))}</span>`;
          return;
        }
        // Staleness: `r.originalHtml` ist der Seitenstand aus dem Moment, in dem
        // der Job gelesen hat. Wurde danach geschrieben, sind die Findings gegen
        // einen Text berechnet, den es nicht mehr gibt.
        //
        // `currentPage.updated_at` taugt als Vergleichswert NICHT allein: es ist
        // eine browserlokale Kopie und rückt nur vor, wenn `_refetchCurrentPage`
        // lief. Das setzt den 5s-Collab-Poll voraus, der am 40s-Buch-Device-Ping
        // hängt und ganz schweigt, wenn ein Zweitgerät (Mac-/Android-Client)
        // offline schrieb und beim Reconnect nur pusht. Darum den Stempel hier
        // selbst holen statt der lokalen Kopie zu glauben.
        let base = r.originalHtml;
        let verified = false;
        let staleRefiltered = false;
        const live = this._lektoratLiveBase?.(r.originalHtml); // Edit-Modus: Live-Text, originalHtml bleibt Save-Basis
        if (live) { ({ html: base, changed: staleRefiltered } = live); verified = true; }
        else if (pageId != null) {
          try {
            const pd = await contentRepo.loadPage(pageId, { fresh: true });
            if (this.currentPage?.id !== pageId) return;
            verified = true;
            if (r.updatedAt && pd.updated_at && pd.updated_at !== r.updatedAt) {
              // Frischen Stand in die Seitenansicht ziehen (setzt originalHtml,
              // renderedPageHtml und currentPage.updated_at über _applyPageData).
              // Der interne _filterFindingsAfterSave-Zweig ist hier No-Op —
              // runCheck hat die Findings geleert.
              await this._refetchCurrentPage();
              if (this.currentPage?.id !== pageId) return;
              base = this.originalHtml;
              staleRefiltered = true;
            }
          } catch (e) {
            console.error('[lektorat staleness-check]', e);
          }
        }
        // Verifikation nicht möglich (offline, SW-Fehler, kein pageId): auf den
        // lokalen Vergleich zurückfallen und komplett verwerfen, statt ungeprüft
        // auf dem Snapshot weiterzuarbeiten.
        if (!verified && r.updatedAt && this.currentPage?.updated_at && r.updatedAt !== this.currentPage.updated_at) {
          this.analysisOut = `<span class="error-msg">${escHtml(this.t('lektorat.staleResultDropped'))}</span>`;
          return;
        }
        // `sortByPosition` IST der Survivor-Filter: es verwirft jedes Finding,
        // dessen `original` per findInHtml nicht in `base` auffindbar ist, und
        // berechnet die Position aus `base`. Im Stale-Fall bleibt damit genau die
        // Teilmenge stehen, die den Fremd-Write verbatim überlebt hat — ihre
        // Positionen zeigen auf den aktuellen Text, nicht ins Leere.
        const findings = sortByPosition(base, fehler);
        if (staleRefiltered && findings.length === 0) {
          this.analysisOut = `<span class="error-msg">${escHtml(this.t('lektorat.staleResultDropped'))}</span>`;
          return;
        }
        if (!live) this.originalHtml = base;
        this.lektoratFindings = findings;
        // Default selected: nur „harte" Typen (page-view.js#findingKind) ausserhalb
        // eines Nachrichtenverlaufs. Weiche und redaktionelle default unselected.
        this.selectedFindings = findings.map(f => this.findingPreselected(f));
        this.appliedOriginals = [];
        // Im Stale-Fall ist der Vergleich gegen einen Text gerechnet, den es nicht
        // mehr gibt — dann lieber keiner als ein falscher.
        this.lektoratProgress = staleRefiltered ? null : (r.progress || null);
        const hardErrors = findings.filter(f => isHardFinding(f.typ));
        this.hasErrors = hardErrors.length > 0;
        // Vorschau = Auswahl (wie _recomputeCorrectedHtml), nicht alle harten Befunde.
        const preselected = findings.filter((_, i) => this.selectedFindings[i]);
        this.correctedHtml = preselected.length > 0
          ? this._applyCorrections(base, preselected)
          : base;
        this.updatePageView();
        let out = '';
        // Hinweis nur, wenn der Fremd-Write wirklich Befunde gekostet hat. Haben
        // alle überlebt, gibt es nichts zu warnen — ein „0 von N verworfen"
        // trainiert den User nur, die Warnbox zu überlesen.
        const droppedByStale = staleRefiltered ? fehler.length - findings.length : 0;
        if (droppedByStale > 0) {
          out += `<div class="analysis-notice">${escHtml(this.t('lektorat.staleResultRefiltered', {
            dropped: droppedByStale,
            total: fehler.length,
          }))}</div>`;
        }
        // Langer Abschnitt: ein Lauf prüft ihn als Ganzes, die Befunde streuen
        // dort von Lauf zu Lauf stärker und dauern länger. Rat, ihn zu teilen.
        if (r.textChars > LONG_SECTION_CHARS) {
          out += `<div class="analysis-notice">${escHtml(this.t('lektorat.longSection', {
            chars: formatNumber(r.textChars, this.$store.shell.uiLocale, 0),
          }))}</div>`;
        }
        out += renderLektoratAnalysisHtml((k, p) => this.t(k, p), {
          szenen: r.szenen, stilanalyse: r.stilanalyse, fazit: r.fazit,
        });
        this.analysisOut = out;
        this.checkDone = true;
        this.lastCheckId = r.checkId || null;
        this.activeHistoryEntryId = r.checkId || null;
        if (pageId != null) await this.loadPageHistory(pageId);
        this.setStatus(this.t('job.analyseDone'), false, 5000);
      },
    });
  },

  // Leseansicht-Zweig von `applyFindings`: frisch laden, übernehmen, speichern,
  // am Lauf buchen. `indices` ohne Angabe: alle angehakten übernehmbaren.
  async saveCorrections(indices = this._applicableSelectedIndices()) {
    if (!this.currentPage || this.saveApplying != null) return;
    const selected = indices.map(i => this.lektoratFindings[i])
      .filter(f => f && !this.appliedOriginals.includes(f.original) && !f.umgeschrieben);
    if (selected.length === 0) return;
    const shown = this.lektoratFindings.length;
    // Ziel des History-PATCH beim Start pinnen: die Korrekturen gehören zu DIESEM
    // Lauf, auch wenn während der Awaits ein anderer Eintrag oder eine andere
    // Seite geöffnet wird.
    const checkId = this.lastCheckId;
    // Ohne anwendbaren Vorschlag (Feld geleert, gleich dem Original) ändert ein
    // Befund nichts — er ist übersprungen, nicht übernommen. `_applyCorrections`
    // lässt ihn still aus, weil der Abschnitts-Chat denselben Kern nutzt.
    const noCorrection = selected
      .filter(f => !f.korrektur || f.korrektur === f.original)
      .map(f => ({ f, reason: 'noCorrection' }));

    try {
      const { savedHtml, skipped: applySkipped, pageId, stale, preHtml, savedUpdatedAt } = await this._loadApplyAndSave(selected, (pct, text) => {
        this.saveApplying = pct;
        if (text) this.setStatus(text, true);
      }, 'lektorat-apply', { checkAmbiguous: true });
      const skipped = [...noCorrection, ...applySkipped];
      const skippedSet = new Set(skipped.map(s => s.f));
      const appliedNow = selected.filter(f => !skippedSet.has(f));
      // Nutzungs-Event (docs/usage-events.md): nur Zahlen, keine Befundtexte.
      trackUsageEvent('lektorat.applied', { shown, selected: selected.length, applied: selected.length - skipped.length, skipped: skipped.length });

      // Der Text ist gespeichert — den Lauf darum immer als übernommen
      // verbuchen, auch nach einem Seitenwechsel. Sonst bliebe er offen und die
      // Fehler-Heatmap zählte die eingearbeiteten Korrekturen weiter.
      let historyFailed = false;
      let bookedApplied = [], bookedSelected = [];
      if (checkId) {
        try {
          this.saveApplying = 95;
          // Angenommen ist nur, was tatsächlich im Text gelandet ist. Ein
          // übersprungener Befund (Text nicht gefunden, Schutzmechanismus, kein
          // Vorschlag) bleibt offen — sonst zählte ihn die Fehler-Heatmap als erledigt.
          const applied = appliedNow.map(bookingEntry);
          const { prev } = await patchBookedLists(checkId, p => ({
            applied: mergeByOriginal(p.applied, applied),
            selected: mergeByOriginal(p.selected, selected.map(bookingEntry)),
          }));
          // Für «Korrekturen rückgängig»: nur austragen, was DIESER Save neu gebucht hat.
          const had = (list) => new Set(list.map(e => e.original));
          const hadApplied = had(prev.applied), hadSelected = had(prev.selected);
          bookedApplied = applied.map(f => f.original).filter(o => !hadApplied.has(o));
          bookedSelected = selected.map(f => f.original).filter(o => !hadSelected.has(o));
          this.refreshPageAges();
          if (!stale && this.currentPage?.id === pageId) await this.loadPageHistory(pageId);
        } catch (e) {
          console.error('[history saved]', e);
          historyFailed = true;
        }
      }
      this.saveApplying = null;

      // Seite während des Speicherns gewechselt: gespeichert ist die richtige
      // Seite, aber Findings-/History-/View-State gehören jetzt der neuen.
      if (stale || this.currentPage?.id !== pageId || this.lastCheckId !== checkId) {
        if (!stale && this.currentPage?.id === pageId) { this.originalHtml = savedHtml; this.updatePageView(); }
        this.setStatus(this.t(historyFailed ? 'lektorat.historySaveFailed' : 'lektorat.correctionsSaved'), false, historyFailed ? 8000 : 5000);
        return;
      }

      // Nachkontrolle nur, wo ein Schutzmechanismus gegriffen hat. Veralteter
      // Textbezug, fehlender oder wirkungsloser Vorschlag: nichts zu prüfen.
      const NO_CHECK = new Set(['notFound', 'noCorrection', 'unchanged']);
      const skipParams = skipped.length > 0 ? {
        details: this._skipSummary(skipped),
        hint: skipped.some(s => !NO_CHECK.has(s.reason)) ? ' ' + this.t('lektorat.skipCheckHint') : '',
      } : null;
      let msg;
      if (historyFailed) {
        msg = this.t('lektorat.historySaveFailed') + (skipParams ? ' ' + this.t('lektorat.skippedList', skipParams) : '');
      } else {
        msg = skipParams ? this.t('lektorat.correctionsSavedWithSkips', skipParams) : this.t('lektorat.correctionsSaved');
      }
      this.setStatus(msg, false, UNDO_WINDOW_MS);
      this._rememberLektoratUndo?.({
        pageId, pageName: this.currentPage?.name, preHtml, updatedAt: savedUpdatedAt, checkId,
        bookedApplied, bookedSelected, appliedOriginals: appliedNow.map(f => f.original),
      });
      // Befundliste bleibt stehen (wie im Edit-Modus): Übernommenes trägt
      // „übernommen", Offenes lässt sich weiter übernehmen. Ansicht aus der
      // gespeicherten Server-Fassung (data-bid) über den normalen Render-Pfad.
      const openBefore = new Set(this.lektoratFindings.filter(f => !f.umgeschrieben && !this.appliedOriginals.includes(f.original)));
      this.appliedOriginals = [...new Set([...this.appliedOriginals, ...appliedNow.map(f => f.original)])];
      this.originalHtml = savedHtml;
      this.lektoratFindings.forEach((f, i) => {
        if (this.appliedOriginals.includes(f.original)) {
          if (this.selectedFindings[i]) this.selectedFindings[i] = false;
          return;
        }
        this._setFindingPresence(i, !!(f.original && findInHtml(savedHtml, f.original)));
        // Vorher offen, jetzt weg: durch eine der eben übernommenen Korrekturen erledigt.
        if (f.umgeschrieben && openBefore.has(f)) f.erledigt = true;
      });
      this._recomputeCorrectedHtml();
    } catch (e) {
      console.error('[saveCorrections]', e);
      this.saveApplying = null;
      this.setStatus(this.t('common.errorColon') + e.message);
    }
  },

  ...lektoratBatchMethods,
};
