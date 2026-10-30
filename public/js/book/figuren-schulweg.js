// Schullaufbahn in der Figuren-Karte (docs/figur-lebenslauf.md «Schullaufbahn»),
// gespreadet in cards/figuren-card.js:
//   * Steckbrief: Schulweg der Figur pflegen (Weg, Einschulungsjahr, Repetition)
//     über PUT /figures/:book_id/schulwege/:fig_id; KI-Vorschlag mit Beleg
//     übernehmen / verwerfen.
//   * Lebenslauf: Klassenstufe in den Zellen und Knopf für den Job
//     `schulweg-vorschlag`.
//
// Gerechnet wird ausschliesslich in book/school-path.js — dieselbe Rechnung wie im
// Buch-Chat-Werkzeug `get_figure_age`. Kein `get x()` (Spread-Getter-Falle).

import { fetchJson } from '../utils.js';
import { startPoll } from '../cards/job-helpers.js';
import {
  resolveSchulsystem, figurWeg, schoolStageAt, schoolStagesForYear, geburtAusText,
  einschulungsJahre, stufeLabelKey, klasseLabelKey, wegLabelKey,
} from './school-path.js';

const _t = (key, params) => window.__app?.t?.(key, params) ?? key;

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
    this.figurSchulJobLoading = false;
    this.figurSchulJobProgress = 0;
    this.figurSchulJobStatus = '';
  },

  // Aufgelöstes System des Buchs (memoized: die Lebenslauf-Zellen lesen es je Ereignis).
  figurSchulSystem() {
    const raw = this.figurSchulData?.schulsystem || null;
    return this._memo('schulSystem', [raw], () => resolveSchulsystem(raw));
  },

  figurSchulweg(f) {
    return this.figurSchulData?.wege?.[f?.id] || null;
  },

  // Geburt aus dem Katalog: Steckbrief-Text (Tag/Monat, falls in Ziffern) sonst
  // das Geburtsjahr nach Vorrang der Alters-Analyse.
  _figurSchulGeburt(f, geburtsjahr = null) {
    const gj = geburtsjahr ?? f?.geburtsjahr ?? null;
    const g = geburtAusText(f?.geburtstag, gj);
    if (g && gj != null && g.y !== gj) return { y: gj };
    return g;
  },

  // ── Steckbrief-Anzeige ────────────────────────────────────────────────────
  figurSchulWegLabel(f) {
    const sys = this.figurSchulSystem();
    if (!sys) return '';
    const sp = this.figurSchulweg(f);
    const key = figurWeg(sys, sp);
    const label = _t(wegLabelKey(key));
    return sp?.weg ? label : _t('figuren.schule.standardWeg', { weg: label });
  },

  figurSchulEinschulung(f) {
    const sys = this.figurSchulSystem();
    if (!sys) return '';
    const sp = this.figurSchulweg(f);
    if (sp?.einschulung_jahr != null) return String(sp.einschulung_jahr);
    const jahre = einschulungsJahre(this._figurSchulGeburt(f), sys);
    if (!jahre.length) return _t('figuren.schule.einschulungUnbekannt');
    if (jahre.length === 1) return _t('figuren.schule.einschulungGerechnet', { jahr: jahre[0] });
    return _t('figuren.schule.einschulungSpanne', { a: Math.min(...jahre), b: Math.max(...jahre) });
  },

  figurSchulRepetitionen(f) {
    const reps = this.figurSchulweg(f)?.repetitionen || [];
    return reps.map(r => _t('figuren.schule.repetition', { klasse: _t(klasseLabelKey(r.stufe), { n: r.klasse }) })).join(', ');
  },

  // ── Bearbeiten ────────────────────────────────────────────────────────────
  figurSchulWegOptionen() {
    const sys = this.figurSchulSystem();
    return (sys?.wege || []).map(w => ({ value: w.key, label: _t(wegLabelKey(w.key)) }));
  },

  figurSchulStufenOptionen() {
    const sys = this.figurSchulSystem();
    return Object.keys(sys?.stufen || {}).map(k => ({ value: k, label: _t(stufeLabelKey(k)) }));
  },

  startFigurSchulEdit(f) {
    const sp = this.figurSchulweg(f);
    const rep = sp?.repetitionen?.[0] || null;
    this.figurSchulEditId = f.id;
    this.figurSchulDraft = {
      weg: sp?.weg || '',
      einschulung_jahr: sp?.einschulung_jahr ?? null,
      rep_stufe: rep?.stufe || '',
      rep_klasse: rep?.klasse ?? null,
    };
    this.figurSchulError = '';
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
    this.figurSchulBusy = true;
    this.figurSchulError = '';
    try {
      const r = await this._figurSchulRequest(bookId, f.id, '', 'PUT', {
        weg: d.weg || null,
        einschulung_jahr: d.einschulung_jahr ?? null,
        repetitionen: d.rep_stufe && d.rep_klasse != null ? [{ stufe: d.rep_stufe, klasse: d.rep_klasse }] : [],
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
    await this._figurSchulVorschlagAction(f, '/uebernehmen', 'POST');
  },

  async rejectFigurSchulVorschlag(f) {
    await this._figurSchulVorschlagAction(f, '/vorschlag', 'DELETE');
  },

  async _figurSchulVorschlagAction(f, suffix, method) {
    if (this.figurSchulBusy) return;
    const bookId = Alpine.store('nav').selectedBookId;
    this.figurSchulBusy = true;
    this.figurSchulError = '';
    try {
      const r = await this._figurSchulRequest(bookId, f.id, suffix, method);
      this._applyFigurSchulweg(f.id, r.schulweg);
    } catch (e) {
      this.figurSchulError = e.message;
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
    const data = this.figurSchulData || { schulsystem: null, wege: {} };
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
    const system = this.figurSchulSystem();
    if (!system || evt?.jahr == null || !spalte) return '';
    const f = (Alpine.store('catalog').figuren || []).find(x => x.id === spalte.id);
    const sp = this.figurSchulweg({ id: spalte.id });
    return schulStufeFuerEreignis({
      system,
      geburt: this._figurSchulGeburt(f, spalte.geburtsjahr),
      figur: sp,
      jahr: evt.jahr,
      monat: evt.monat ?? null,
    });
  },

  // ── KI-Vorschlag (Job) ────────────────────────────────────────────────────
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
          finish(_t('figuren.schule.jobDone', { n: job?.result?.vorschlaege ?? 0 }));
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
