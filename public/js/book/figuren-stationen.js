// Berufsweg und Hobbys in der Figuren-Karte (docs/figur-lebenslauf.md «Berufsweg
// und Hobbys»), gespreadet in cards/figuren-card.js:
//   * Steckbrief: zwei Listen pflegen (anlegen, ändern, löschen) über
//     /figures/:book_id/stationen/:kind/:fig_id; KI-Vorschläge mit Beleg
//     übernehmen / verwerfen.
//   * Alterstabelle: Tätigkeit am Stichtag.
//   * Lebenslauf: Beginn/Ende datierter Stationen in den Zellen, Knopf für den
//     Job `stationen-vorschlag`.
//
// Gerechnet wird ausschliesslich in book/figure-stationen.js — dieselbe Rechnung
// wie im Buch-Chat-Werkzeug `get_figure_age`. Kein `get x()` (Spread-Getter-Falle).

import { fetchJson } from '../utils.js';
import { startPoll } from '../cards/job-helpers.js';
import { stationenAm, stationZeitraum, stationTitel, normalizeStation, JOB_ARTEN } from './figure-stationen.js';
import { stichtagAus } from './figuren-alter.js';

const _t = (key, params) => window.__app?.t?.(key, params) ?? key;

const _leererEntwurf = (kind) => ({
  ...(kind === 'berufe' ? { taetigkeit: '', art: 'beruf', arbeitgeber: '' } : { hobby: '' }),
  ort: '', von_jahr: null, von_monat: null, bis_jahr: null, bis_monat: null, notiz: '',
});

export const figurenStationenMethods = {
  // ── Laden ─────────────────────────────────────────────────────────────────
  async loadFigurenStationen() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.figurStationenData = null; return; }
    const isCurrent = () => String(Alpine.store('nav').selectedBookId) === String(bookId);
    try {
      const data = await fetchJson(`/figures/${encodeURIComponent(bookId)}/stationen`);
      if (!isCurrent()) return;
      this.figurStationenData = data;
      this._memos = {};
    } catch (e) {
      if (e?.name === 'AbortError' || !isCurrent()) return;
      this.figurStationenData = null;
    }
  },

  _resetFigurStationen() {
    if (this._figurStationPollTimer) { clearInterval(this._figurStationPollTimer); this._figurStationPollTimer = null; }
    this.figurStationenData = null;
    this.figurStationEdit = null;
    this.figurStationDraft = {};
    this.figurStationBusy = false;
    this.figurStationError = '';
    this.figurStationJobLoading = false;
    this.figurStationJobProgress = 0;
    this.figurStationJobStatus = '';
  },

  // ── Lesen ─────────────────────────────────────────────────────────────────
  _figurStationenAlle(figId, kind) {
    return this.figurStationenData?.[kind]?.[figId] || [];
  },

  figurStationenAktiv(f, kind) {
    return this._figurStationenAlle(f?.id, kind).filter(s => s.status === 'aktiv');
  },

  figurStationenVorschlaege(f, kind) {
    return this._figurStationenAlle(f?.id, kind).filter(s => s.status === 'vorschlag');
  },

  figurStationTitel(kind, s) {
    return stationTitel(kind, s);
  },

  /** Nebenzeile: Zeitraum · Art (Ausbildung) · Ort. */
  figurStationMeta(kind, s) {
    const parts = [stationZeitraum(s, _t)];
    if (kind === 'berufe' && s.art === 'ausbildung') parts.push(_t('figuren.stationen.art.ausbildung'));
    if (s.ort) parts.push(s.ort);
    return parts.filter(Boolean).join(' · ');
  },

  figurStationArtOptionen() {
    return JOB_ARTEN.map(a => ({ value: a, label: _t('figuren.stationen.art.' + a) }));
  },

  // ── Bearbeiten (eine Zeile zur Zeit, wie Katalog-Pflege und Schulweg) ─────
  figurStationEditing(f, kind, s = null) {
    const e = this.figurStationEdit;
    return !!e && e.figId === f?.id && e.kind === kind && (s ? e.id === s.id : e.id == null);
  },

  startFigurStationNew(f, kind) {
    this.figurStationEdit = { figId: f.id, kind, id: null };
    this.figurStationDraft = _leererEntwurf(kind);
    this.figurStationError = '';
  },

  startFigurStationEdit(f, kind, s) {
    const d = _leererEntwurf(kind);
    for (const k of Object.keys(d)) d[k] = s[k] ?? d[k];
    this.figurStationEdit = { figId: f.id, kind, id: s.id };
    this.figurStationDraft = d;
    this.figurStationError = '';
  },

  cancelFigurStationEdit() {
    this.figurStationEdit = null;
    this.figurStationDraft = {};
    this.figurStationError = '';
  },

  async saveFigurStationEdit(f) {
    const e = this.figurStationEdit;
    if (this.figurStationBusy || !e || e.figId !== f.id) return;
    // Dieselbe Prüfung wie der Server — der Fehler steht so am Formular, bevor
    // der Request rausgeht.
    const check = normalizeStation(e.kind, this.figurStationDraft);
    if (check.fehler) {
      this.figurStationError = _t('figuren.stationen.fehler.' + check.fehler);
      return;
    }
    const suffix = e.id != null ? `/${e.id}` : '';
    const r = await this._figurStationRequest(f, e.kind, suffix, e.id != null ? 'PUT' : 'POST', check.fields);
    if (r) this.cancelFigurStationEdit();
  },

  async deleteFigurStation(f, kind, s) {
    const ok = await window.__app.appConfirm({
      message: _t('figuren.stationen.loeschenConfirm', { titel: stationTitel(kind, s) }),
      danger: true,
    });
    if (!ok) return;
    await this._figurStationRequest(f, kind, `/${s.id}`, 'DELETE');
  },

  async acceptFigurStation(f, kind, s) {
    await this._figurStationRequest(f, kind, `/${s.id}/uebernehmen`, 'POST');
  },

  async rejectFigurStation(f, kind, s) {
    await this._figurStationRequest(f, kind, `/${s.id}`, 'DELETE');
  },

  // Nach jeder Änderung die Listen neu laden: Sortierung und Vorschlags-Status
  // kommen vom Server, ein lokales Nachbauen liefe ihm davon.
  async _figurStationRequest(f, kind, suffix, method, body = null) {
    if (this.figurStationBusy) return null;
    const bookId = Alpine.store('nav').selectedBookId;
    this.figurStationBusy = true;
    this.figurStationError = '';
    try {
      const res = await fetch(`/figures/${encodeURIComponent(bookId)}/stationen/${kind}/${encodeURIComponent(f.id)}${suffix}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(window.__app.tError(data) || `HTTP ${res.status}`);
      await this.loadFigurenStationen();
      return data;
    } catch (e) {
      this.figurStationError = e.message;
      return null;
    } finally {
      this.figurStationBusy = false;
    }
  },

  // ── Alterstabelle: Tätigkeit am Stichtag ─────────────────────────────────
  figurenAlterStichtagTaetigkeit(row) {
    const st = stichtagAus(this.figurenAlterStichtag?.jahr ?? null, this.figurenAlterStichtag?.monat);
    if (!st) return '';
    const teile = [];
    for (const kind of ['berufe', 'hobbys']) {
      for (const s of stationenAm(this._figurStationenAlle(row.id, kind), { jahr: st.y, monat: st.m })) {
        teile.push(stationTitel(kind, s) + (s.unsicher ? ' (?)' : ''));
      }
    }
    return teile.join(', ');
  },

  // ── Lebenslauf ────────────────────────────────────────────────────────────
  /** Map fig_id → { berufe, hobbys } für computeLebenslauf (memoized). */
  figurenLebenslaufStationen() {
    const data = this.figurStationenData;
    return this._memo('llStationen', [data], () => {
      const out = new Map();
      for (const kind of ['berufe', 'hobbys']) {
        for (const [figId, list] of Object.entries(data?.[kind] || {})) {
          const e = out.get(figId) || { berufe: [], hobbys: [] };
          e[kind] = list;
          out.set(figId, e);
        }
      }
      return out;
    });
  },

  figurenLebenslaufStationLabel(evt) {
    return _t(`figuren.stationen.lebenslauf.${evt.station}.${evt.phase}`);
  },

  // ── KI-Vorschlag (Job) ────────────────────────────────────────────────────
  _figurStationJobDoneText(res) {
    const tn = (key, n) => window.__app?.tn?.(key, n) ?? key;
    const parts = [_t('figuren.stationen.jobDone', { berufe: res?.berufe ?? 0, hobbys: res?.hobbys ?? 0 })];
    const verworfen = Object.values(res?.verworfen || {}).reduce((n, x) => n + (x || 0), 0);
    if (verworfen) parts.push(tn('figuren.stationen.jobVerworfen', verworfen));
    if (res?.schonVorhanden) parts.push(tn('figuren.stationen.jobSchonVorhanden', res.schonVorhanden));
    const ohneStellen = (res?.figuren ?? 0) - (res?.mitStellen ?? 0);
    if (ohneStellen > 0) parts.push(tn('figuren.stationen.jobOhneStellen', ohneStellen));
    return parts.join(' · ');
  },

  async runFigurStationenVorschlag() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.figurStationJobLoading) return;
    this.figurStationJobLoading = true;
    this.figurStationJobProgress = 0;
    this.figurStationJobStatus = _t('figuren.stationen.jobRunning');
    try {
      const res = await fetch('/jobs/stationen-vorschlag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.jobId) throw new Error(window.__app.tError(j) || _t('figuren.stationen.jobError'));
      if (String(Alpine.store('nav').selectedBookId) !== String(bookId)) return;
      const finish = (status) => {
        this.figurStationJobLoading = false;
        this.figurStationJobProgress = 0;
        this.figurStationJobStatus = status;
      };
      startPoll(this, {
        timerProp: '_figurStationPollTimer',
        jobId: j.jobId,
        progressProp: 'figurStationJobProgress',
        intervalMs: 1200,
        onDone: async (job) => {
          finish(this._figurStationJobDoneText(job?.result));
          await this.loadFigurenStationen();
        },
        onError: (job) => finish(job?.error ? _t(job.error, job.errorParams) : _t('figuren.stationen.jobError')),
        onNotFound: () => finish(_t('figuren.stationen.jobError')),
      });
    } catch (e) {
      this.figurStationJobLoading = false;
      this.figurStationJobStatus = e.message;
    }
  },
};
