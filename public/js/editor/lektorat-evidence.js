// Belegvorschlag — zu einem `unbelegt`-Befund die passende Stelle in der eigenen
// Quellen-Bibliothek finden und den Kurzbeleg hinter den Satz setzen.
// Gespreadet in cards/lektorat-findings-card.js.
//
// WARUM DIESE ZWEI HAELFTEN SICH HIER TREFFEN: das wissenschaftliche
// Lektorat-Profil meldet mit `unbelegt` den woertlichen Satz, der einen Beleg
// braucht (public/js/prompts/lektorat-typen.js#WISSENSCHAFT_TYPEN), und die
// Quellen-Bibliothek hat den Volltext der angehaengten PDFs im Embedding-Index
// (source_semantic_chunks). Der Satz IST damit eine fertige semantische
// Anfrage — es fehlte nur die Verbindung.
//
// NUR `unbelegt`, bewusst nicht `zuschreibung`: im journalistischen Profil ist
// der Beleg die im Satz GENANNTE Person oder Stelle, nicht der Kurzbeleg (siehe
// die Begruendung an JOURNALISTISCH_TYPEN). Ein Quellen-Chip waere dort die
// falsche Reparatur.
//
// SCHREIBWEG: Seite frisch laden → Chip per `insertAfterInHtml` einspleissen →
// `savePage` mit `expectedUpdatedAt`. Also derselbe Weg wie der Korrektur-Apply
// des Lektorats (`_loadApplyAndSave`) und NICHT der DOM-Weg des Beleg-Pickers:
// bei sichtbaren Befunden ist der Editor per Invariante nie im Bearbeiten-Modus
// (`editMode + checkDone forbidden`, siehe editor/notebook/edit/lifecycle.js),
// es gibt hier also kein contenteditable, in das man einfuegen koennte.
//
// Das Markup baut `buildCiteHtml` (SSoT fuer Quellen-Markup), der Kurzbeleg-Text
// `formatShort` — kein zweiter Zitat-Traeger, keine handgeschriebene Chip-Form.
//
// NIE GENERATIV: der Vorschlag aendert den Text nicht von sich aus. Erst der
// Klick des Autors auf eine Quelle setzt den Chip, und eingefuegt wird nur der
// Beleg — der Satz selbst bleibt Zeichen fuer Zeichen stehen.

import { fetchJson, sendJson } from '../utils/net.js';
import { countInHtml, insertAfterInHtml, stripFocusArtefacts } from '../utils.js';
import { contentRepo } from '../repo/content.js';
import { savePage } from './shared/page-api.js';
import { buildCiteHtml } from '../sources/cite-html.js';
import { formatShort } from '../sources/format.js';
import { sourceLine } from '../sources/search.js';
import { EVT } from '../events.js';
import { tFetchError } from '../i18n.js';

// Befundtypen, fuer die ein Kurzbeleg die richtige Reparatur ist. Ein Typ-Key ist
// eine Persistenz-Konstante (`page_checks.errors_json`) — ergaenzen ja,
// umbenennen nie.
const EVIDENCE_TYPEN = new Set(['unbelegt']);

// Trennzeichen zwischen Satzende und Chip. Geschuetztes Leerzeichen aus demselben
// Grund wie im Beleg-Picker (caret-panel.js#NBSP): ein umbrechendes Leerzeichen
// liesse den Kurzbeleg allein auf die naechste Zeile fallen.
const NBSP = '\u00A0';

export const lektoratEvidenceMethods = {
  /** Hat dieser Befundtyp einen Belegvorschlag? */
  evidenceEligible(typ) {
    return EVIDENCE_TYPEN.has(typ);
  },

  /**
   * Ist der Vorschlag ueberhaupt bedienbar? Braucht den Embedding-Endpunkt (die
   * Suche laeuft ueber Vektoren) und Schreibrecht am Buch (der Chip landet im
   * Seitentext). Methode statt Getter: das Modul wird gespreadet, und ein Getter
   * feuerte dabei sofort mit falschem `this`.
   */
  evidenceReady() {
    const app = window.__app;
    return !!app?.$store?.config?.semanticSearchEnabled
      && !!app?.$store?.nav?.selectedBookId
      && !!app?.canEdit?.();
  },

  /** Wurde zu diesem Satz in dieser Sitzung schon ein Beleg gesetzt? */
  evidenceDone(original) {
    return this.evidenceApplied.includes(original);
  },

  /** Anzeigezeile einer Quelle — dieselbe Form wie im Beleg-Picker. */
  evidenceSourceLine(src) {
    return sourceLine(src);
  },

  /** Panel unter einem Befund auf-/zuklappen; beim Oeffnen Vorschlaege holen. */
  async toggleEvidence(idx) {
    if (this.evidenceOpenIdx === idx) { this.closeEvidence(); return; }
    this.closeEvidence();
    const f = window.__app?.lektoratFindings?.[idx];
    if (!f?.original) return;
    this.evidenceOpenIdx = idx;
    this.evidenceClaim = f.original;
    await this._loadEvidence(f.original);
  },

  // Schliessen bricht eine laufende Anfrage ab und loest ihren Controller: eine
  // spaete Antwort fuer Panel A landet so nie in Panel B.
  closeEvidence() {
    this._evidenceAbort?.abort();
    this._evidenceAbort = null;
    this.evidenceOpenIdx = -1;
    this.evidenceClaim = '';
    this.evidenceHits = [];
    this.evidenceError = '';
    this.evidenceLoading = false;
  },

  async _loadEvidence(claim) {
    const app = window.__app;
    const bookId = app?.$store?.nav?.selectedBookId;
    if (!bookId) return;
    this._evidenceAbort?.abort();
    const ctrl = new AbortController();
    this._evidenceAbort = ctrl;
    // Gilt die Antwort noch dem offenen Panel? Der Controller ist das Ticket
    // der Anfrage: jedes Schliessen, jede neue Anfrage und der Karten-Reset
    // (lektoratEvidenceState) ersetzen ihn. Dazu derselbe Satz.
    const current = () => this._evidenceAbort === ctrl && this.evidenceClaim === claim;
    this.evidenceLoading = true;
    try {
      const url = `/sources/evidence?book_id=${encodeURIComponent(bookId)}`
        + `&q=${encodeURIComponent(claim)}`;
      const r = await fetchJson(url, { signal: ctrl.signal });
      if (!current()) return;
      this.evidenceHits = Array.isArray(r?.hits) ? r.hits : [];
      if (!this.evidenceHits.length) this.evidenceError = app.t('evidence.empty');
    } catch (e) {
      if (e?.name === 'AbortError' || !current()) return;
      // Die drei Lagen, die der User auseinanderhalten muss: Backend nicht
      // konfiguriert, Satz als Anfrage untauglich, Endpunkt nicht erreichbar.
      const map = {
        EMBED_DISABLED: 'evidence.needBackend',
        EMBED_UNAVAILABLE: 'evidence.unavailable',
        CLAIM_TOO_SHORT: 'evidence.claimTooShort',
        CLAIM_TOO_LONG: 'evidence.claimTooLong',
      };
      this.evidenceError = app.t(map[e?.code] || 'evidence.error');
      this.evidenceHits = [];
    } finally {
      if (current()) {
        this.evidenceLoading = false;
        this._evidenceAbort = null;
      }
    }
  },

  /**
   * Vorschlag uebernehmen: Quelle dem Buch zuordnen (falls noch nicht), Chip
   * hinter den Satz spleissen, Seite speichern.
   *
   * REIHENFOLGE IST ABSICHT — erst die Zuordnung, dann der Text: ein
   * `data-src`-Marker erzeugt nur dann eine Fundstelle, wenn die Quelle dem Buch
   * der Seite zugeordnet ist (db/sources.js#replacePageCitations). Umgekehrt
   * stuende der Beleg im Text und tauchte in keinem Quellenverzeichnis auf.
   * Schlaegt die Zuordnung fehl, wird nichts eingefuegt.
   */
  async applyEvidence(idx, hit) {
    const app = window.__app;
    const f = app?.lektoratFindings?.[idx];
    const bookId = app?.$store?.nav?.selectedBookId;
    if (!f?.original || !hit?.source?.id || !bookId || !app.currentPage?.id) return;
    if (this.evidenceBusyId != null) return;
    // Der Vorschlag gilt nur fuer den Satz, zu dem er geholt wurde: offenes
    // Panel = dieser Befund, Befund-Satz = Anfrage-Satz, Treffer aus der
    // aktuellen Liste. Hat sich die Befundliste darunter verschoben (neuer
    // Lauf, Refilter), landete der Beleg sonst hinter einem fremden Satz.
    const claim = this.evidenceClaim;
    if (this.evidenceOpenIdx !== idx || !claim || f.original !== claim
        || !this.evidenceHits.some(h => h.source_id === hit.source_id)) return;

    this.evidenceBusyId = hit.source_id;
    this.evidenceError = '';
    try {
      if (!hit.linked) {
        await sendJson(`/sources/${hit.source_id}/link`, 'POST', { book_id: bookId });
        // Der Beleg-Picker haelt die Quellenliste des Buchs modulweit gecacht —
        // ohne dieses Event kennt er die neu zugeordnete Quelle nicht.
        window.dispatchEvent(new CustomEvent(EVT.SOURCES_CHANGED, { detail: { bookId } }));
      }

      const page = await contentRepo.loadPage(app.currentPage.id, { fresh: true });
      const baseHtml = stripFocusArtefacts(page.html || '');

      // Mehrdeutigkeit ist ein Abbruch, keine Wahl: `insertAfterInHtml` greift
      // ueber `findInHtml` immer das ERSTE Vorkommen — bei einem zweimal
      // vorkommenden Satz waere das moeglicherweise der falsche. Ein Beleg am
      // falschen Satz ist schlimmer als kein Beleg.
      const n = countInHtml(baseHtml, claim);
      if (n === 0) { this.evidenceError = app.t('evidence.claimGone'); return; }
      if (n > 1) { this.evidenceError = app.t('evidence.claimAmbiguous'); return; }

      const text = formatShort(hit.source, {
        style: app.citationStyleForCurrentBook || 'apa7',
        lang: app.citationLangForCurrentBook || 'de',
        loc: '',
        num: null,
        // Ein `unbelegt`-Befund meldet eine Behauptung in EIGENEN Worten — sie
        // wird sinngemaess gestuetzt („vgl."), nicht woertlich zitiert. Ein
        // Kurzzitat behauptete eine Woertlichkeit, die der Satz nicht hat.
        mode: 'paraphrase',
      });
      // Keine Stellenangabe: der Fund kommt aus einem Embedding-Chunk, und der
      // traegt keine Seitenzahl (`source_semantic_chunks` hat keine Spalte
      // dafuer). Sie zu raten waere eine erfundene Belegstelle — der Autor
      // traegt sie ueber den Klick auf den Chip nach.
      const chip = buildCiteHtml({ id: hit.source.id, loc: '', text, mode: 'paraphrase' });
      if (!chip) { this.evidenceError = app.t('evidence.error'); return; }

      const nextHtml = insertAfterInHtml(baseHtml, claim, NBSP + chip);
      if (nextHtml === baseHtml) { this.evidenceError = app.t('evidence.claimGone'); return; }

      const saved = await savePage(app.currentPage.id, {
        html: nextHtml,
        pageName: app.currentPage.name,
        // Der Beleg ist eine direkte Folge des Lektorats — dieselbe Revisions-
        // Quelle wie der Korrektur-Apply, kein neuer Wert im Whitelist-Spiegel.
        source: 'lektorat-apply',
        expectedUpdatedAt: page.updated_at || null,
      });
      if (saved?.updated_at) app.currentPage.updated_at = saved.updated_at;

      // Panel-Zustand nachziehen: Vorschau aus dem neuen Stand, Befund als
      // belegt markieren und aus der Korrektur-Auswahl nehmen. Letzteres, weil
      // eine Korrektur, die den nun belegten Satz ersetzt, ohnehin am
      // Marker-Schutz von `replaceInHtml` scheitern wuerde (`spansMarker`).
      app.originalHtml = nextHtml;
      if (app.selectedFindings) app.selectedFindings[idx] = false;
      app._recomputeCorrectedHtml?.();
      app.markPageChecked?.(app.currentPage.id);
      app._syncPageStatsAfterSave?.(app.currentPage, nextHtml);
      this.evidenceApplied = [...this.evidenceApplied, claim];
      // Panel inzwischen auf einen anderen Befund gewechselt → dessen Panel
      // offen lassen.
      if (this.evidenceClaim === claim) this.closeEvidence();
      app.setStatus?.(app.t('evidence.inserted'), false, 5000);
    } catch (e) {
      // 409 heisst: zwischen Laden und Schreiben hat jemand anders gespeichert.
      // Kein Blind-Retry — der Satz koennte inzwischen umgeschrieben sein.
      if (this.evidenceClaim !== claim) return;
      this.evidenceError = e?.status === 409
        ? app.t('evidence.conflict')
        : tFetchError(e);
    } finally {
      this.evidenceBusyId = null;
    }
  },
};

/** Anfangszustand des Slices — vom Karten-Reset mitbenutzt. */
export const lektoratEvidenceState = () => ({
  evidenceOpenIdx: -1,
  // Satz, zu dem das offene Panel seine Vorschlaege geholt hat.
  evidenceClaim: '',
  evidenceHits: [],
  evidenceLoading: false,
  evidenceError: '',
  evidenceBusyId: null,
  evidenceApplied: [],
  // AbortController der laufenden Vorschlagssuche — zugleich ihr Ticket, an dem
  // spaete Antworten eines anderen Panels verworfen werden.
  _evidenceAbort: null,
});
