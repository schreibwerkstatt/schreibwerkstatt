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

// Ab dieser Länge des geprüften Texts (Zeichen) rät das Ergebnis, den Abschnitt
// zu teilen (routes/jobs/lektorat.js liefert `textChars`).
const LONG_SECTION_CHARS = 20000;

export const lektoratMethods = {
  // Befund steht in einem Nachrichtenverlauf: Chat-Schreibweise ist Figurenrede.
  // Solche Befunde sind nie vorausgewählt — „Korrekturen speichern" soll keine
  // SMS-Sprache glattbügeln, die der Autor nicht einzeln angehakt hat.
  findingInMsgThread(f) {
    return _inMsgThread(this.originalHtml, f?.original);
  },

  // Mehrdeutige Fundstelle (`mehrdeutig`, Server: lektorat-page.js#markAmbiguous):
  // «Übernehmen» ersetzt das erste Vorkommen — nicht vorauswählen, der Autor
  // hakt bewusst an. Ebenso ein Befund, den der Autor im Vorlauf stehen liess
  // (`abgelehnt`, lib/lektorat-progress.js#markPreviouslyRejected).
  findingPreselected(f) {
    return isHardFinding(f.typ) && !f.mehrdeutig && !f.abgelehnt && !this.findingInMsgThread(f) && this.findingSelectable(f);
  },

  // Auswählbar ist ein Befund, der etwas ändern würde und noch nicht übernommen
  // ist. Übernommene stehen oft weiter im Text („sagte er" → „sagte er,"): ein
  // zweites Anwenden schriebe „sagte er,,".
  findingSelectable(f) {
    return !!f?.korrektur && f.korrektur !== f.original && !this.appliedOriginals.includes(f.original);
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
  // `checkAmbiguous` (nur Abschnitts-Chat): eine mehrfach vorkommende Stelle wird
  // als 'ambiguous' übersprungen statt das erste Vorkommen zu ersetzen. Das
  // Lektorat prüft das bewusst nicht (tests/unit/lektorat-apply-guard.test.mjs).
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
    return ['notFound', 'noCorrection', 'unchanged', 'spansLink', 'spansMarker', 'boundary']
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


  _recomputeCorrectedHtml() {
    if (!this.originalHtml) return;
    const selected = this.lektoratFindings.filter((_, i) => this.selectedFindings[i]);
    this.correctedHtml = selected.length > 0
      ? this._applyCorrections(this.originalHtml, selected)
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
    if (!this.currentPage) return;
    // Guard: Lektorat darf nicht auf nicht-persistierten Edits laufen.
    // Server-Job liest die gespeicherte Seite; sind Edits nur lokal (offline-
    // Draft oder editDirty), sieht der Job die alte Fassung. Findings haben
    // dann Positionen aus altem Text, und der spätere Save-Pfad würde nach
    // einem zwischenzeitlichen Online-Retry ein Race auslösen, das Edits
    // überschreiben kann. Lieber blocken bis der Save durch ist.
    if (this.saveOffline || this.editDirty) {
      this.setStatus(this.t('lektorat.blockedUnsavedEdits'), false, 6000);
      return;
    }
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
        if (pageId != null) {
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
        this.originalHtml = base;
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

  async saveCorrections() {
    if (!this.currentPage || this.saveApplying != null) return;
    const selected = this.lektoratFindings.filter((_, i) => this.selectedFindings[i]);
    if (selected.length === 0) return;
    // Ziel des History-PATCH beim Start pinnen: die Korrekturen gehören zu DIESEM
    // Lauf, auch wenn während der Awaits ein anderer Eintrag oder eine andere
    // Seite geöffnet wird.
    const checkId = this.lastCheckId;
    const historyEntry = this.activeHistoryEntryId
      ? this.pageHistory.find(e => e.id === this.activeHistoryEntryId) || null
      : null;
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
      });
      const skipped = [...noCorrection, ...applySkipped];

      // Der Text ist gespeichert — den Lauf darum immer als übernommen
      // verbuchen, auch nach einem Seitenwechsel. Sonst bliebe er offen und die
      // Fehler-Heatmap zählte die eingearbeiteten Korrekturen weiter.
      let historyFailed = false;
      if (checkId) {
        try {
          this.saveApplying = 95;
          // Angenommen ist nur, was tatsächlich im Text gelandet ist. Ein
          // übersprungener Befund (Text nicht gefunden, Schutzmechanismus, kein
          // Vorschlag) bleibt offen — sonst zählte ihn die Fehler-Heatmap als erledigt.
          const skippedSet = new Set(skipped.map(s => s.f));
          let applied = selected.filter(f => !skippedSet.has(f));
          let selectedAll = selected;
          // Bei History-Einträgen: mit bereits angewendeten Korrekturen mergen
          if (historyEntry && historyEntry.id === checkId) {
            const merge = (existing, items) => {
              const set = new Set((existing || []).map(e => e.original));
              return [...(existing || []), ...items.filter(e => !set.has(e.original))];
            };
            applied = merge(historyEntry.applied_errors_json, applied);
            selectedAll = merge(historyEntry.selected_errors_json, selected);
          }
          const body = { applied_errors_json: applied, selected_errors_json: selectedAll };
          const r = await fetch('/history/check/' + checkId + '/saved', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
      if (stale || this.currentPage?.id !== pageId) {
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
      const historyBefore = historyEntry && historyEntry.id === checkId ? historyEntry : null;
      this._rememberLektoratUndo?.({
        pageId, pageName: this.currentPage?.name, preHtml, updatedAt: savedUpdatedAt, checkId,
        prevApplied: historyBefore?.applied_errors_json || null,
        prevSelected: historyBefore?.selected_errors_json || null,
      });
      this.correctedHtml = null;
      this.hasErrors = false;
      this.lektoratFindings = [];
      this.selectedFindings = [];
      this.appliedOriginals = [];
      this.appliedHistoricCorrections = [];
      this.lektoratProgress = null;
      this.checkDone = false;
      this.activeHistoryEntryId = null;
      // Seitenansicht aus der gespeicherten Server-Fassung (data-bid) über den
      // normalen Render-Pfad neu aufbauen (Erwähnungs-Hervorhebung inklusive).
      this.originalHtml = savedHtml;
      this.analysisOut = '';
      this.updatePageView();
    } catch (e) {
      console.error('[saveCorrections]', e);
      this.saveApplying = null;
      this.setStatus(this.t('common.errorColon') + e.message);
    }
  },

  // Serien-Lektorat: ganzes Buch oder — mit `chapterId` — ein Kapitel samt
  // Unterkapiteln. Gleicher Job (`batch-check`), gleiche Statuszeile.
  async batchCheck(chapterId = null) {
    if (!this.$store.nav.pages.length) return;
    const chapter = chapterId != null ? this._findTreeChapter(chapterId) : null;
    if (chapterId != null && !chapter) return;
    // Ganzer Unterbaum aus dem echten Baum — wie der Server (routes/jobs/lektorat.js),
    // unabhaengig von einer laufenden Sidebar-Suche.
    const ids = chapter ? this._chapterSubtreePageIds(chapter) : this.$store.nav.pages.map(p => p.id);
    const all = ids.length;
    if (!all) return;
    // Final markierte, seither unveraenderte Abschnitte prueft der Server nicht
    // (skip_final, docs/bearbeitungsstand.md) — die Rueckfrage nennt beide Zahlen.
    const skipped = this.doneUnchangedCount(ids);
    const n = all - skipped;
    if (n === 0) { this.batchStatus = escHtml(this.t('lektorat.batchAllFinal', { n: skipped })); return; }
    let message = chapter
      ? this.t('lektorat.batchConfirmChapter', { n, name: chapter.name })
      : this.t('lektorat.batchConfirm', { n });
    if (skipped > 0) message += '\n\n' + this.t('lektorat.batchSkipFinal', { n: skipped });
    if (!await this.appConfirm({ message })) return;
    this.batchLoading = true;
    this.batchProgress = 0;
    this.batchStatus = this._runningJobStatus(this.t('common.starting'), 0, 0);
    try {
      const { jobId } = await fetchJson('/jobs/batch-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: parseInt(this.$store.nav.selectedBookId),
          book_name: this.selectedBookName || null,
          ...(chapter ? { chapter_id: parseInt(chapter.id, 10) } : {}),
          skip_final: true,
        }),
      });
      lsSet('lektorat_batchcheck_job_' + this.$store.nav.selectedBookId, jobId);
      this.startBatchPoll(jobId);
    } catch (e) {
      console.error('[batchCheck]', e);
      this.batchStatus = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.batchLoading = false;
    }
  },

  startBatchPoll(jobId) {
    const bookId = this.$store.nav.selectedBookId;
    this._startPoll({
      timerProp: '_batchPollTimer',
      jobId,
      lsKey: 'lektorat_batchcheck_job_' + bookId,
      progressProp: 'batchProgress',
      onProgress: (job) => {
        this.batchStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
      },
      onNotFound: () => {
        this.batchLoading = false;
        this.batchStatus = escHtml(this.t('job.interrupted'));
      },
      onError: (job) => {
        this.batchLoading = false;
        setTimeout(() => { this.batchProgress = 0; }, 400);
        this.batchStatus = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(this.t(job.error, job.errorParams))}</span>`;
      },
      onDone: async (job) => {
        this.batchLoading = false;
        setTimeout(() => { this.batchProgress = 0; }, 400);
        if (job.result?.empty) {
          this.batchStatus = escHtml(job.result.skippedFinal > 0
            ? this.t('lektorat.batchAllFinal', { n: job.result.skippedFinal })
            : this.t(job.result.chapterId != null ? 'lektorat.batchNoPagesChapter' : 'lektorat.batchNoPages'));
          return;
        }
        const r = job.result;
        // Leere und gescheiterte Seiten getrennt nennen — „X/Y geprüft" allein
        // lässt offen, ob der Rest leer war oder ein Fehler ihn übersprungen hat.
        // x-html-Sink: Seitennamen escapen.
        let status = escHtml(this.t('lektorat.batchDone', { done: r.done, total: r.pageCount, errors: r.totalErrors }));
        if (r.skippedEmpty > 0) status += ' ' + escHtml(this.t('lektorat.batchSkippedEmpty', { n: r.skippedEmpty }));
        if (r.skippedFinal > 0) status += ' ' + escHtml(this.t('lektorat.batchSkippedFinal', { n: r.skippedFinal }));
        const failed = Array.isArray(r.failed) ? r.failed : [];
        if (failed.length > 0) {
          const MAX_NAMES = 5;
          const names = failed.slice(0, MAX_NAMES).map(p => `«${p.name}»`).join(', ') + (failed.length > MAX_NAMES ? ', …' : '');
          status += ` <span class="error-msg">${escHtml(this.t('lektorat.batchFailed', { n: failed.length, names }))}</span>`;
        }
        this.batchStatus = status;
        this.refreshPageAges();
        if (this.currentPage) await this.loadPageHistory(this.currentPage.id);
      },
    });
  },
};
