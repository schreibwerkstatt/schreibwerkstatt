// Plot-Werkstatt: erzählte Zeit am Beat — wie die Angabe verstanden wurde, wie
// alt die Strang-Figur dort ist, welches Zeitfenster der Akt für den Strang
// bedeutet, welche Befunde der Zeit-Messung an ihm hängen und welche Zeit der
// Text für einen Beat im Buch nahelegt (GET /plot/zeit-vorschlaege, pure Logik
// in lib/plot-zeit-vorschlag.js). Kein Job, keine Kosten; die Vorschläge werden
// mit der Zeit-Messung nachgeladen (time-check.js#loadTimeChecks), also nach
// jeder Beat-Mutation.
//
// Zwei Quellen, zwei Rollen:
//   · Das Fenster aus Akt + Alter („Erwachsen (24-28)", Stefan *1968 → 1992–1997)
//     wird nur ANGEZEIGT (aktFenster), nie gespeichert. Gespeichert würde es den
//     Widerspruch verdecken, den die Zeit-Messung finden soll (alterAusserhalbAkt:
//     ein geschriebener Beat liegt in einem Akt, dessen Alter nicht zum Text passt).
//   · Der Vorschlag aus dem Text wird übernommen — einzeln (füllt nur das Feld im
//     offenen Beat) oder über die Durchsicht (plot-zeit-review.html): jeder
//     Vorschlag mit Belegen und Abschnitt, vorausgewählt nur die eindeutigen; die
//     Auswahl läuft als EIN Undo-Schritt (beat-fields-batch) über PATCH
//     /plot/beats/:id. Kein blinder Sammel-Klick: die Fundstelle kann eine
//     verwandte Szene sein, das sieht man am Beleg.

import { fetchJson } from '../../utils.js';
import { formatZeitKey } from './zeit-format.js';
import { befundSeverityTone } from '../../utils/befund-severity.js';

export const zeitMethods = {
  async loadZeitVorschlaege() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.zeitVorschlaege = []; return; }
    try {
      const data = await fetchJson(`/plot/zeit-vorschlaege?book_id=${bookId}`);
      if (Alpine.store('nav').selectedBookId !== bookId) return;
      this.zeitVorschlaege = Array.isArray(data.vorschlaege) ? data.vorschlaege : [];
      // Auswahl der Durchsicht: bestehende Entscheidungen bleiben, neue Vorschläge
      // starten vorausgewählt, wenn sie eindeutig sind.
      const prev = this.zeitVorschlagSel || {};
      const sel = {};
      for (const v of this.zeitVorschlaege) sel[v.beat_id] = v.beat_id in prev ? prev[v.beat_id] : !!v.eindeutig;
      this.zeitVorschlagSel = sel;
    } catch (e) {
      // Non-fatal: Vorschläge sind eine Hilfe, kein Board-Blocker.
      this.zeitVorschlaege = [];
    }
  },

  // ── Verstanden als … ───────────────────────────────────────────────────────
  // null = keine Angabe; { ok: false } = Freitext, den der Parser nicht versteht
  // (wird dann auch nicht geprüft); { ok: true, text } = das erkannte Fenster.
  zeitVerstanden(beat) {
    if (!beat || !(beat.zeit || '').trim()) return null;
    const text = formatZeitKey(beat.zeit_key, window.__app.t);
    return text ? { ok: true, text } : { ok: false };
  },

  beatZeitTip(beat) {
    const app = window.__app;
    const v = this.zeitVerstanden(beat);
    if (!v) return app.t('plot.beat.zeitTip');
    return v.ok ? app.t('plot.zeitKey.verstanden', { zeit: v.text }) : app.t('plot.zeitKey.unklar');
  },

  // Hinweis unter dem Zeit-Feld im offenen Beat. Gilt nur, solange der Entwurf
  // dem gespeicherten Wert entspricht — für getippten, noch nicht gespeicherten
  // Text gibt es kein Server-Fenster, und ein veraltetes wäre irreführend.
  beatDraftZeitHint() {
    const app = window.__app;
    const beat = (this.beats || []).find(b => b.id === this.editingBeatId);
    const draft = (this.beatDraft.zeit || '').trim();
    if (!beat || !draft) return null;
    if (draft !== (beat.zeit || '').trim()) return { ok: true, text: app.t('plot.zeitKey.pending') };
    const v = this.zeitVerstanden(beat);
    if (!v) return null;
    return v.ok
      ? { ok: true, text: app.t('plot.zeitKey.verstanden', { zeit: v.text }) }
      : { ok: false, text: app.t('plot.zeitKey.unklar') };
  },

  // ── Alter der Strang-Figur am Beat ─────────────────────────────────────────
  // Geburtsjahr (GET /plot → geburtsjahre: Steckbrief, sonst Alters-Analyse) gegen das Zeitfenster des
  // Beats; Fenster über mehrere Jahre → Altersspanne. Keine Angabe ohne Strang-
  // Figur mit Geburtsjahr, ohne Kalenderzeit oder vor der Geburt (das meldet die
  // Zeit-Messung als beatVorGeburt).
  beatAlter(beat) {
    const key = beat && beat.zeit_key;
    if (!key || key.mode !== 'abs' || beat.thread_id == null) return null;
    const figId = (this.threads || []).find(t => t.id === beat.thread_id)?.fig_id;
    const geb = figId ? (this.geburtsjahre || {})[figId] : null;
    if (!Number.isFinite(geb) || key.yearTo < geb) return null;
    const von = Math.max(0, key.yearFrom - geb), bis = key.yearTo - geb;
    const fig = (Alpine.store('catalog').figuren || []).find(f => f.id === figId);
    const figur = fig ? (fig.kurzname || fig.name) : figId;
    const alter = von === bis ? String(von) : `${von}–${bis}`;
    const app = window.__app;
    return {
      text: app.t('plot.beat.alter', { figur, alter }),
      tip: app.t((this.geburtsjahrAusText || []).includes(figId) ? 'plot.beat.alterTipText' : 'plot.beat.alterTip',
        { figur, alter, geburtsjahr: geb }),
    };
  },

  // ── Befunde der Zeit-Messung an der Karte ──────────────────────────────────
  beatTimeChecks(beat) {
    return beat ? (this.timeChecks || []).filter(f => f.beat_id === beat.id) : [];
  },

  // Befunde kommen nach Schwere sortiert vom Server — der erste bestimmt den Ton.
  // Plakette im Stil der Fundstellen-Badges (.plot-beat-anchor), nicht die breite
  // .severity-tag-Pille der Befund-Liste; die Ton-Zuordnung bleibt die geteilte.
  beatTimeCheckClass(beat) {
    const list = this.beatTimeChecks(beat);
    return list.length ? 'plot-beat-timecheck--' + befundSeverityTone(list[0].schwere) : '';
  },

  beatTimeCheckTip(beat) {
    return this.beatTimeChecks(beat).map(f => this.timeCheckText(f)).join('\n');
  },

  // ── Zeitfenster des Akts für einen Strang ──────────────────────────────────
  // Altersspanne im Aktnamen (GET /plot → act.alter) + Geburtsjahr der Strang-
  // Figur. Nur bekannt ist das Geburtsjahr: wer 24–28 ist, lebt in den Jahren
  // Geburtsjahr+24 bis Geburtsjahr+29 (vor dem 29. Geburtstag noch 28).
  // Reine Anzeige, nie gespeichert — siehe Kopfkommentar.
  aktFenster(actId, threadId) {
    if (threadId == null) return null;
    const act = (this.acts || []).find(a => a.id === actId);
    if (!act || !act.alter) return null;
    const figId = (this.threads || []).find(t => t.id === threadId)?.fig_id;
    const geb = figId ? (this.geburtsjahre || {})[figId] : null;
    if (!Number.isFinite(geb)) return null;
    const von = geb + act.alter.von, bis = geb + act.alter.bis + 1;
    const fig = (Alpine.store('catalog').figuren || []).find(f => f.id === figId);
    const app = window.__app;
    const params = {
      von, bis, figur: fig ? (fig.kurzname || fig.name) : figId, geburtsjahr: geb,
      alterVon: act.alter.von, alterBis: act.alter.bis,
    };
    return { text: app.t('plot.aktFenster.cell', params), tip: app.t('plot.aktFenster.tip', params) };
  },

  // Hinweis im offenen Beat ohne Zeitangabe: das Fenster seines Akts.
  editAktFenster() {
    if ((this.beatDraft.zeit || '').trim()) return null;
    const beat = (this.beats || []).find(b => b.id === this.editingBeatId);
    return beat ? this.aktFenster(beat.act_id, beat.thread_id ?? null) : null;
  },

  // ── Vorschläge aus dem Text ────────────────────────────────────────────────
  zeitVorschlagBelege(v) {
    return (v && Array.isArray(v.belege) ? v.belege : [])
      .map(b => window.__app.t('plot.zeitVorschlag.beleg', { datum: b.datum, ereignis: b.ereignis }));
  },

  zeitVorschlagFor(beatId) {
    return (this.zeitVorschlaege || []).find(v => v.beat_id === beatId) || null;
  },

  // Vorschlag für den offenen Beat, solange sein Zeit-Feld leer ist.
  editZeitVorschlag() {
    if ((this.beatDraft.zeit || '').trim()) return null;
    return this.zeitVorschlagFor(this.editingBeatId);
  },

  applyZeitVorschlagToDraft() {
    const v = this.editZeitVorschlag();
    if (v) this.beatDraft.zeit = v.zeit;
  },

  // ── Durchsicht (Sammel-Übernahme) ──────────────────────────────────────────
  // Der offen bearbeitete Beat bleibt aussen vor — sein Entwurf würde den
  // übernommenen Wert beim Speichern überschreiben.
  zeitReviewList() {
    return (this.zeitVorschlaege || []).filter(v => v.beat_id !== this.editingBeatId);
  },

  zeitReviewSelected() {
    const sel = this.zeitVorschlagSel || {};
    return this.zeitReviewList().filter(v => sel[v.beat_id]);
  },

  zeitReviewBeatTitel(v) {
    return (this.beats || []).find(b => b.id === v.beat_id)?.titel || '';
  },

  setZeitReviewAll(on) {
    const sel = { ...(this.zeitVorschlagSel || {}) };
    for (const v of this.zeitReviewList()) sel[v.beat_id] = !!on;
    this.zeitVorschlagSel = sel;
  },

  async applyZeitReviewSelection() {
    const list = this.zeitReviewSelected();
    if (!list.length || this.busy || this._inHistoryFlight) return;
    this.busy = true;
    try {
      const ids = await this._hPatchBeats(list.map(v => ({ id: v.beat_id, fields: { zeit: v.zeit } })));
      const done = new Set(ids);
      this._recordBeatFieldsBatch(list.filter(v => done.has(v.beat_id))
        .map(v => ({ id: v.beat_id, before: { zeit: null }, after: { zeit: v.zeit } })));
    } finally { this.busy = false; }
  },
};
