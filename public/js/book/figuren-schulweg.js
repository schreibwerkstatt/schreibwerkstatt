// Schullaufbahn in der Figuren-Karte (docs/figur-lebenslauf.md «Schullaufbahn»),
// gespreadet in cards/figuren-card.js:
//   * Steckbrief: Schulweg der Figur pflegen (Weg, Einschulungsjahr, Repetitionen)
//     über PUT /figures/:book_id/schulwege/:fig_id; KI-Vorschlag mit Beleg
//     übernehmen / verwerfen; Klassenangaben aus dem Text gegen die Rechnung;
//     Klassenstufe im Handlungsjahr des Buchs.
//   * Lebenslauf: Klassenstufe in den Zellen, Jahr-Abfrage über die gewählten
//     Figuren und Knopf für den Job `schulweg-vorschlag`.
//
// Gerechnet wird ausschliesslich in book/school-path.js — dieselbe Rechnung wie im
// Buch-Chat-Werkzeug `get_figure_age`, mit derselben Geburt: die liefert der
// Server (`geburten` in GET …/schulwege, lib/figure-birth.js), der Browser leitet
// sie nicht selbst her. Kein `get x()` (Spread-Getter-Falle).

import { fetchJson } from '../utils.js';
import { startPoll } from '../cards/job-helpers.js';
import {
  resolveSchulsystem, aktivesSchulsystem, figurWeg, wegGueltig, schoolStageAt, schoolStagesForYear,
  einschulungsJahre, repetitionsKlassen, pruefeKlassenangabe, SCHUL_GRENZEN,
  stufeLabelKey, klasseLabelKey, wegLabelKey,
} from './school-path.js';

const _t = (key, params) => window.__app?.t?.(key, params) ?? key;

const _repKey = (r) => `${r.stufe}:${r.klasse}`;

/** Pure: Kurzlabel einer Stufen-Position („1. Bez"), '' ausserhalb der Schulzeit. */
export function schulStufeKurz(r, t = _t) {
  if (!r || r.status !== 'schule') return '';
  const main = t(klasseLabelKey(r.stufe), { n: r.klasse });
  if (!r.unsicher || r.alternative?.status !== 'schule') return main;
  return t('schule.oder', { a: main, b: t(klasseLabelKey(r.alternative.stufe), { n: r.alternative.klasse }) });
}

/** Pure: Stufen-Label für ein Lebensereignis (Jahr, optional Monat). Ohne Monat
 *  und mit Wechsel im Jahr: „6. Primar → 1. Bez". */
export function schulStufeFuerEreignis({ system, geburt, figur, jahr, monat }, t = _t) {
  if (!system || !Number.isInteger(jahr)) return '';
  if (Number.isInteger(monat) && monat >= 1) return schulStufeKurz(schoolStageAt({ geburt, system, figur, jahr, monat }), t);
  const r = schoolStagesForYear({ geburt, system, figur, jahr });
  if (!r) return '';
  const herbst = schulStufeKurz(r.herbst, t);
  const frueh = r.fruehjahr ? schulStufeKurz(r.fruehjahr, t) : '';
  if (frueh && herbst) return t('schule.wechsel', { a: frueh, b: herbst });
  return herbst || frueh;
}

/** Pure: Stand in einem Kalenderjahr als Text — in der Schule die Stufe, sonst
 *  «noch nicht eingeschult» bzw. «Schule abgeschlossen». '' ohne Rechnung. */
export function schulStandImJahr({ system, geburt, figur, jahr }, t = _t) {
  const stufe = schulStufeFuerEreignis({ system, geburt, figur, jahr }, t);
  if (stufe) return stufe;
  const r = schoolStagesForYear({ geburt, system, figur, jahr })?.herbst;
  if (r?.status === 'vor_einschulung') return t('figuren.schule.vorEinschulung');
  if (r?.status === 'abgeschlossen') return t('figuren.schule.abgeschlossen', { jahr: r.abschluss_jahr });
  return '';
}

export const figurenSchulwegMethods = {
  // ── Laden ─────────────────────────────────────────────────────────────────
  async loadFigurenSchulwege() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.figurSchulData = null; return; }
    const isCurrent = () => String(Alpine.store('nav').selectedBookId) === String(bookId);
    try {
      const data = await fetchJson(`/figures/${encodeURIComponent(bookId)}/schulwege`);
      if (!isCurrent()) return;
      this.figurSchulData = data;
      this._memos = {};
    } catch (e) {
      if (e?.name === 'AbortError' || !isCurrent()) return;
      this.figurSchulData = null;
    }
  },

  _resetFigurSchulweg() {
    if (this._figurSchulPollTimer) { clearInterval(this._figurSchulPollTimer); this._figurSchulPollTimer = null; }
    this.figurSchulData = null;
    this.figurSchulEditId = null;
    this.figurSchulDraft = {};
    this.figurSchulBusy = false;
    this.figurSchulError = '';
    this.figurSchulMessage = '';
    this.figurSchulJobLoading = false;
    this.figurSchulJobProgress = 0;
    this.figurSchulJobStatus = '';
    this.figurSchulAbfrageJahr = null;
  },

  // Aufgelöstes System des Buchs (memoized: die Lebenslauf-Zellen lesen es je Ereignis).
  figurSchulSystem() {
    // Der Server filtert nach Buchtyp schon; hier noch einmal, damit ein eben
    // geänderter Buchtyp ohne Neuladen der Schulwege greift.
    const raw = aktivesSchulsystem(this.figurSchulData?.schulsystem, window.__app?.currentBuchtyp?.());
    return this._memo('schulSystem', [raw], () => resolveSchulsystem(raw));
  },

  figurSchulweg(f) {
    return this.figurSchulData?.wege?.[f?.id] || null;
  },

  // Geburt vom Server (Vorrang Steckbrief › Geburts-Ereignis › Alters-Index) —
  // dieselbe, mit der Job und Buch-Chat rechnen.
  _figurSchulGeburt(figId) {
    return this.figurSchulData?.geburten?.[figId] || null;
  },

  _figurSchulRechnung(f) {
    const sp = this.figurSchulweg(f);
    return {
      system: this.figurSchulSystem(),
      geburt: this._figurSchulGeburt(f?.id),
      figur: sp ? { weg: sp.weg, einschulung_jahr: sp.einschulung_jahr, repetitionen: sp.repetitionen } : null,
    };
  },

  // ── Steckbrief-Anzeige ────────────────────────────────────────────────────
  figurSchulWegLabel(f) {
    const sys = this.figurSchulSystem();
    if (!sys) return '';
    const sp = this.figurSchulweg(f);
    const label = _t(wegLabelKey(figurWeg(sys, sp)));
    if (sp?.weg && !wegGueltig(sys, sp)) return _t('figuren.schule.wegUngueltig', { weg: label });
    return sp?.weg ? label : _t('figuren.schule.standardWeg', { weg: label });
  },

  /** Gespeicherter Weg passt nicht zum Schulsystem (Vorlage gewechselt). */
  figurSchulWegUngueltig(f) {
    const sys = this.figurSchulSystem();
    return !!sys && !wegGueltig(sys, this.figurSchulweg(f));
  },

  figurSchulEinschulung(f) {
    const sys = this.figurSchulSystem();
    if (!sys) return '';
    const sp = this.figurSchulweg(f);
    if (sp?.einschulung_jahr != null) return String(sp.einschulung_jahr);
    const jahre = einschulungsJahre(this._figurSchulGeburt(f?.id), sys);
    if (!jahre.length) return _t('figuren.schule.einschulungUnbekannt');
    if (jahre.length === 1) return _t('figuren.schule.einschulungGerechnet', { jahr: jahre[0] });
    return _t('figuren.schule.einschulungSpanne', { a: Math.min(...jahre), b: Math.max(...jahre) });
  },

  figurSchulRepetitionen(f) {
    const reps = this.figurSchulweg(f)?.repetitionen || [];
    return reps.map(r => _t('figuren.schule.repetition', { klasse: _t(klasseLabelKey(r.stufe), { n: r.klasse }) })).join(', ');
  },

  figurSchulHandlungsjahr() {
    const j = this.figurSchulData?.handlungsjahr;
    return Number.isInteger(j) ? j : null;
  },

  /** Stand der Figur im Handlungsjahr des Buchs ('' ohne Handlungsjahr/Rechnung). */
  figurSchulImHandlungsjahr(f) {
    const jahr = this.figurSchulHandlungsjahr();
    const r = this._figurSchulRechnung(f);
    if (jahr == null || !r.system) return '';
    return schulStandImJahr({ ...r, jahr });
  },

  // ── Klassenangaben aus dem Text ───────────────────────────────────────────
  /** Klassenangaben mit Urteil der Rechnung: [{ ...angabe, urteil, label, gerechnet }]. */
  figurSchulKlassenangaben(f) {
    const angaben = this.figurSchulweg(f)?.klassenangaben || [];
    if (!angaben.length) return [];
    const r = this._figurSchulRechnung(f);
    if (!r.system) return [];
    return angaben.map(a => {
      const p = pruefeKlassenangabe({ ...r, angabe: a });
      const gerechnet = (p?.gerechnet || []).map(x => schulStufeKurz(x) || this._figurSchulStatusLabel(x)).filter(Boolean);
      return {
        ...a,
        urteil: p?.urteil || 'offen',
        label: _t('figuren.schule.angabe', { jahr: a.jahr, klasse: _t(klasseLabelKey(a.stufe), { n: a.klasse }) }),
        gerechnet: [...new Set(gerechnet)].join(' / '),
      };
    });
  },

  _figurSchulStatusLabel(x) {
    if (x?.status === 'vor_einschulung') return _t('figuren.schule.vorEinschulung');
    if (x?.status === 'abgeschlossen') return _t('figuren.schule.abgeschlossen', { jahr: x.abschluss_jahr });
    return '';
  },

  figurSchulWiderspruchZahl(f) {
    return this.figurSchulKlassenangaben(f).filter(a => a.urteil === 'widerspruch').length;
  },

  // ── Bearbeiten ────────────────────────────────────────────────────────────
  figurSchulWegOptionen() {
    const sys = this.figurSchulSystem();
    return (sys?.wege || []).map(w => ({ value: w.key, label: _t(wegLabelKey(w.key)) }));
  },

  // Wirksamer Weg des Entwurfs (eigener oder Standardweg) — nur dessen Klassen
  // lassen sich repetieren.
  _figurSchulDraftWeg() {
    return figurWeg(this.figurSchulSystem(), { weg: this.figurSchulDraft.weg || null });
  },

  /** Klassen zum Hinzufügen einer Repetition: die des gewählten Wegs, ohne die
   *  schon eingetragenen. Wert «stufe:klasse». */
  figurSchulRepOptionen() {
    const sys = this.figurSchulSystem();
    if (!sys) return [];
    const schon = new Set((this.figurSchulDraft.repetitionen || []).map(_repKey));
    return repetitionsKlassen(sys, this._figurSchulDraftWeg())
      .filter(r => !schon.has(_repKey(r)))
      .map(r => ({ value: _repKey(r), label: _t(klasseLabelKey(r.stufe), { n: r.klasse }) }));
  },

  figurSchulRepVoll() {
    return (this.figurSchulDraft.repetitionen || []).length >= SCHUL_GRENZEN.repetitionen;
  },

  figurSchulRepLabel(r) {
    return _t(klasseLabelKey(r.stufe), { n: r.klasse });
  },

  /** Eingetragene Repetition, die der gewählte Weg nicht durchläuft (Weg geändert). */
  figurSchulRepUngueltig(r) {
    const sys = this.figurSchulSystem();
    if (!sys) return false;
    return !repetitionsKlassen(sys, this._figurSchulDraftWeg()).some(k => _repKey(k) === _repKey(r));
  },

  addFigurSchulRepetition(value) {
    const [stufe, klasse] = String(value || '').split(':');
    if (!stufe || !klasse || this.figurSchulRepVoll()) return;
    this.figurSchulDraft.repetitionen = [...(this.figurSchulDraft.repetitionen || []), { stufe, klasse: Number(klasse) }];
    this.figurSchulDraft.rep_neu = '';
  },

  removeFigurSchulRepetition(r) {
    this.figurSchulDraft.repetitionen = (this.figurSchulDraft.repetitionen || []).filter(x => _repKey(x) !== _repKey(r));
  },

  startFigurSchulEdit(f) {
    const sp = this.figurSchulweg(f);
    this.figurSchulEditId = f.id;
    this.figurSchulDraft = {
      // Ein ungültiger Weg-Key steht nicht in der Auswahl — der Entwurf beginnt beim Standardweg.
      weg: sp?.weg && wegGueltig(this.figurSchulSystem(), sp) ? sp.weg : '',
      einschulung_jahr: sp?.einschulung_jahr ?? null,
      repetitionen: [...(sp?.repetitionen || [])],
      rep_neu: '',
    };
    this.figurSchulError = '';
    this.figurSchulMessage = '';
  },

  cancelFigurSchulEdit() {
    this.figurSchulEditId = null;
    this.figurSchulDraft = {};
    this.figurSchulError = '';
  },

  async saveFigurSchulEdit(f) {
    if (this.figurSchulBusy || this.figurSchulEditId !== f.id) return;
    const bookId = Alpine.store('nav').selectedBookId;
    const d = this.figurSchulDraft;
    if ((d.repetitionen || []).some(r => this.figurSchulRepUngueltig(r))) {
      this.figurSchulError = _t('figuren.schule.repetition.ungueltig');
      return;
    }
    this.figurSchulBusy = true;
    this.figurSchulError = '';
    try {
      const r = await this._figurSchulRequest(bookId, f.id, '', 'PUT', {
        weg: d.weg || null,
        einschulung_jahr: d.einschulung_jahr ?? null,
        repetitionen: d.repetitionen || [],
      });
      this._applyFigurSchulweg(f.id, r.schulweg);
      this.cancelFigurSchulEdit();
    } catch (e) {
      this.figurSchulError = e.message;
    } finally {
      this.figurSchulBusy = false;
    }
  },

  async acceptFigurSchulVorschlag(f) {
    const r = await this._figurSchulVorschlagAction(f, '/uebernehmen', 'POST');
    if (r?.repetitionen_entfernt) {
      this.figurSchulMessage = _t('figuren.schule.repetitionenEntfernt', { n: r.repetitionen_entfernt });
    }
  },

  async rejectFigurSchulVorschlag(f) {
    await this._figurSchulVorschlagAction(f, '/vorschlag', 'DELETE');
  },

  async _figurSchulVorschlagAction(f, suffix, method) {
    if (this.figurSchulBusy) return null;
    const bookId = Alpine.store('nav').selectedBookId;
    this.figurSchulBusy = true;
    this.figurSchulError = '';
    this.figurSchulMessage = '';
    try {
      const r = await this._figurSchulRequest(bookId, f.id, suffix, method);
      this._applyFigurSchulweg(f.id, r.schulweg);
      return r;
    } catch (e) {
      this.figurSchulError = e.message;
      return null;
    } finally {
      this.figurSchulBusy = false;
    }
  },

  async _figurSchulRequest(bookId, figId, suffix, method, body = null) {
    const res = await fetch(`/figures/${encodeURIComponent(bookId)}/schulwege/${encodeURIComponent(figId)}${suffix}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(window.__app.tError(data) || `HTTP ${res.status}`);
    return data;
  },

  // Neues Objekt statt Mutation: die Memos hängen an der Identität von figurSchulData.
  _applyFigurSchulweg(figId, schulweg) {
    const data = this.figurSchulData || { schulsystem: null, wege: {}, geburten: {} };
    this.figurSchulData = { ...data, wege: { ...data.wege, [figId]: schulweg } };
  },

  figurSchulVorschlagWeg(f) {
    const v = this.figurSchulweg(f)?.vorschlag;
    return v ? _t(wegLabelKey(v.weg)) : '';
  },

  figurSchulVorschlagDetails(f) {
    const v = this.figurSchulweg(f)?.vorschlag;
    if (!v) return '';
    const parts = [];
    if (v.einschulung_jahr != null) parts.push(_t('figuren.schule.vorschlagEinschulung', { jahr: v.einschulung_jahr }));
    if (v.repetition) parts.push(_t('figuren.schule.repetition', { klasse: _t(klasseLabelKey(v.repetition.stufe), { n: v.repetition.klasse }) }));
    return parts.join(' · ');
  },

  // ── Lebenslauf ────────────────────────────────────────────────────────────
  /** Klassenstufe eines Ereignisses in einer Lebenslauf-Spalte ('' ohne System). */
  figurSchulStufeFuerEreignis(spalte, evt) {
    if (evt?.jahr == null || !spalte) return '';
    const r = this._figurSchulRechnung({ id: spalte.id });
    if (!r.system) return '';
    return schulStufeFuerEreignis({ ...r, jahr: evt.jahr, monat: evt.monat ?? null });
  },

  /** Jahr-Abfrage: Stand jeder gewählten Lebenslauf-Spalte im eingegebenen Jahr. */
  figurSchulJahrUebersicht() {
    const jahr = this.figurSchulAbfrageJahr;
    if (!Number.isInteger(jahr) || !this.figurSchulSystem()) return [];
    return this.figurenLebenslaufMatrix().spalten.map(sp => {
      const r = this._figurSchulRechnung({ id: sp.id });
      return { id: sp.id, name: sp.name, typ: sp.typ, stand: schulStandImJahr({ ...r, jahr }) || _t('figuren.schule.keineRechnung') };
    });
  },

  // ── KI-Vorschlag (Job) ────────────────────────────────────────────────────
  _figurSchulJobDoneText(res) {
    const parts = [_t('figuren.schule.jobDone', { n: res?.vorschlaege ?? 0 })];
    if (res?.klassenangaben) parts.push(_t('figuren.schule.jobKlassenangaben', { n: res.klassenangaben, w: res.widersprueche ?? 0 }));
    const verworfen = Object.values(res?.verworfen || {}).reduce((n, x) => n + (x || 0), 0);
    if (verworfen) parts.push(_t('figuren.schule.jobVerworfen', { n: verworfen }));
    if (res?.ohneJahr) parts.push(_t('figuren.schule.jobOhneJahr', { n: res.ohneJahr }));
    const ohneStellen = (res?.figuren ?? 0) - (res?.mitStellen ?? 0);
    if (ohneStellen > 0) parts.push(_t('figuren.schule.jobOhneStellen', { n: ohneStellen }));
    return parts.join(' · ');
  },

  async runFigurSchulVorschlag() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.figurSchulJobLoading) return;
    this.figurSchulJobLoading = true;
    this.figurSchulJobProgress = 0;
    this.figurSchulJobStatus = _t('figuren.schule.jobRunning');
    try {
      const res = await fetch('/jobs/schulweg-vorschlag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.jobId) throw new Error(window.__app.tError(j) || _t('figuren.schule.jobError'));
      if (String(Alpine.store('nav').selectedBookId) !== String(bookId)) return;
      const finish = (status) => {
        this.figurSchulJobLoading = false;
        this.figurSchulJobProgress = 0;
        this.figurSchulJobStatus = status;
      };
      startPoll(this, {
        timerProp: '_figurSchulPollTimer',
        jobId: j.jobId,
        progressProp: 'figurSchulJobProgress',
        intervalMs: 1200,
        onDone: async (job) => {
          finish(this._figurSchulJobDoneText(job?.result));
          await this.loadFigurenSchulwege();
        },
        onError: (job) => finish(job?.error ? _t(job.error, job.errorParams) : _t('figuren.schule.jobError')),
        onNotFound: () => finish(_t('figuren.schule.jobError')),
      });
    } catch (e) {
      this.figurSchulJobLoading = false;
      this.figurSchulJobStatus = e.message;
    }
  },
};
