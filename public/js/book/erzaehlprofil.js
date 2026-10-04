// Kapitel-Erzählprofil-Methoden (in Alpine.data('erzaehlprofilCard') gespreadet).
// Ergebnisse stammen aus der Komplettanalyse-Phase «Erzählprofil» und werden via
// _loadErzaehlprofil (GET) angezeigt: POV/Erzählzeit pro Kapitel (+ Abweichung von
// der deklarierten Soll-Perspektive), Spannungskurve (Intensität 1–5) und
// Themen-/Motiv-Verteilung übers Buch. Rein lesend, nie generativ im Buchtext.

import { fetchJson } from '../utils.js';
import { isSelectedBook } from '../cards/book-guard.js';

const _POV_KEYS = ['ich', 'du', 'er_sie_personal', 'er_sie_auktorial', 'wir', 'gemischt'];
const _TEMPUS_KEYS = ['praeteritum', 'praesens', 'gemischt'];

export const erzaehlprofilMethods = {
  async _loadErzaehlprofil() {
    const bookId = Alpine.store('nav').selectedBookId;
    try {
      const data = await fetchJson('/jobs/erzaehlprofil/' + bookId);
      if (!isSelectedBook(bookId)) return;
      this.erzaehlprofilResult = data;
    } catch (e) {
      console.error('[_loadErzaehlprofil]', e);
    }
  },

  erzaehlprofilChapters() {
    return this.erzaehlprofilResult?.chapters || [];
  },

  erzaehlprofilHasData() {
    return this.erzaehlprofilChapters().length > 0;
  },

  // Label-Helfer (i18n mit Fallback auf den Rohwert für unbekannte Keys).
  erzaehlprofilPovLabel(key) {
    if (!key) return '';
    const t = window.__app.t('erzaehlprofil.pov.' + key);
    return t === 'erzaehlprofil.pov.' + key ? key : t;
  },
  erzaehlprofilTempusLabel(key) {
    if (!key) return '';
    const t = window.__app.t('erzaehlprofil.tempus.' + key);
    return t === 'erzaehlprofil.tempus.' + key ? key : t;
  },
  erzaehlprofilThemaTypLabel(typ) {
    if (!typ) return '';
    const t = window.__app.t('erzaehlprofil.themaTyp.' + typ);
    return t === 'erzaehlprofil.themaTyp.' + typ ? typ : t;
  },

  // Deklarierte Soll-Perspektive/-zeit (aus book_settings) als lesbare Labels –
  // Baseline für die Abweichungs-Anzeige. Null wenn nichts deklariert.
  erzaehlprofilDeclaredLabel() {
    const d = this.erzaehlprofilResult?.declared || {};
    const parts = [];
    if (d.erzaehlperspektive) parts.push(this.erzaehlprofilPovLabel(d.erzaehlperspektive));
    if (d.erzaehlzeit) parts.push(this.erzaehlprofilTempusLabel(d.erzaehlzeit));
    return parts.join(' · ');
  },

  // Kapitel mit erkannter Abweichung (Perspektive ODER Erzählzeit) von der
  // deklarierten Soll-Erzählform.
  erzaehlprofilDeviations() {
    return this.erzaehlprofilChapters().filter(c => c.pov_abweichung || c.tempus_abweichung);
  },

  // POV-Konfidenz als Prozent (0–100) bzw. null, wenn nicht bestimmt.
  erzaehlprofilKonfidenzPct(ch) {
    const k = ch?.pov_konfidenz;
    return (typeof k === 'number' && isFinite(k)) ? Math.round(k * 100) : null;
  },
  // Wackelnde/uneindeutige Erzählhaltung: die interessanten Stellen fürs Lektorat.
  erzaehlprofilKonfidenzLow(ch) {
    const k = ch?.pov_konfidenz;
    return typeof k === 'number' && isFinite(k) && k < 0.6;
  },

  // Erzähler-/Fokusfiguren übers Buch aggregiert: je Figur Anzahl Kapitel + Liste,
  // sortiert nach Häufigkeit. Bei Multi-POV-Romanen die zentrale Kennzahl («aus wessen
  // Sicht wird wie oft erzählt»). `fig_id` = Katalog-Kennung für die Entitäts-Referenz.
  erzaehlprofilFigurenVerteilung() {
    const byKey = new Map();
    for (const ch of this.erzaehlprofilChapters()) {
      const name = (ch.erzaehler_figur || '').trim();
      if (!name) continue;
      const key = ch.erzaehler_figur_id != null ? 'id:' + ch.erzaehler_figur_id : 'n:' + name.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, { name, fig_id: ch.erzaehler_fig_id ?? null, count: 0, kapitel: [] });
      const e = byKey.get(key);
      e.count++;
      if (ch.kapitel && !e.kapitel.includes(ch.kapitel)) e.kapitel.push(ch.kapitel);
    }
    return [...byKey.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  },

  // Spannungskurven-Punkte: pro Kapitel { kapitel, chapter_id, intensitaet(1–5),
  // begruendung }. Kapitel ohne Intensität → 0 (keine Balkenhöhe).
  erzaehlprofilCurve() {
    return this.erzaehlprofilChapters().map(c => ({
      kapitel: c.kapitel,
      chapter_id: c.chapter_id,
      intensitaet: Number.isFinite(c.intensitaet) ? c.intensitaet : 0,
      begruendung: c.intensitaet_begruendung || '',
    }));
  },

  // Themen/Motive/Symbole über alle Kapitel aggregiert: gleicher (normalisierter)
  // Name → ein Eintrag mit Häufigkeit + Kapitelliste. Sortiert nach Häufigkeit.
  erzaehlprofilThemenAggregiert() {
    const byKey = new Map();
    for (const ch of this.erzaehlprofilChapters()) {
      for (const t of (ch.themen || [])) {
        const name = (t.thema || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, { thema: name, typ: t.typ || null, count: 0, kapitel: [] });
        const e = byKey.get(key);
        e.count++;
        if (ch.kapitel && !e.kapitel.includes(ch.kapitel)) e.kapitel.push(ch.kapitel);
      }
    }
    return [...byKey.values()].sort((a, b) => b.count - a.count || a.thema.localeCompare(b.thema));
  },

  erzaehlprofilChapterKey(ch, i) {
    return ch?.chapter_id != null ? 'ch:' + ch.chapter_id : 'i:' + i;
  },

  // ── Buch-Befund ────────────────────────────────────────────────────────────
  // Deterministischer Struktur-Befund (read-time server-berechnet) + KI-Dach-Befund
  // (Autoren-Befund). Beide hängen an der GET-Antwort. Rein diagnostisch.
  erzaehlprofilBefund() {
    return this.erzaehlprofilResult?.befund || null;
  },
  erzaehlprofilAutorenBefund() {
    const a = this.erzaehlprofilResult?.autorenBefund || null;
    return (a && Array.isArray(a.befunde) && a.befunde.length) ? a : null;
  },
  // Nur Präsenzbögen mit auffälligem Flag (verschwindet / statisch).
  erzaehlprofilArcsFlagged() {
    return (this.erzaehlprofilBefund()?.arcs || []).filter(a => (a.flags || []).length);
  },
  // Präsenz-Band: { chapters:[{chapter_id,kap}], figures:[{id,name,present:[0/1],flags}] }.
  erzaehlprofilPresenceBand() {
    const b = this.erzaehlprofilBefund()?.presenceBand;
    return (b && b.figures?.length) ? b : null;
  },
  // Ganze Report-Sektion sichtbar? (Band ODER Befunde ODER KI-Dach-Befund vorhanden.)
  erzaehlprofilHasReport() {
    return !!this.erzaehlprofilAutorenBefund() || this.erzaehlprofilHasBefund() || !!this.erzaehlprofilPresenceBand();
  },
  // Gibt es überhaupt etwas Auffälliges zu zeigen? Steuert die Sichtbarkeit der Sektion.
  erzaehlprofilHasBefund() {
    const b = this.erzaehlprofilBefund();
    if (!b) return false;
    return this.erzaehlprofilArcsFlagged().length > 0
      || (b.encounters || []).length > 0
      || (b.pacing?.sags || []).length > 0
      || (b.pacing?.flags || []).length > 0
      || (b.droppedMotifs || []).length > 0
      || (b.eventDeserts || []).length > 0
      || (b.locations?.oneOff || []).length > 0
      || (b.locations?.abandoned || []).length > 0
      || (b.pov?.lowConfidenceRuns || []).length > 0;
  },

  // Label-Helfer für die Flags (i18n mit Fallback auf den Rohschlüssel).
  erzaehlprofilFlagLabel(flag) {
    const t = window.__app.t('erzaehlprofil.flag.' + flag);
    return t === 'erzaehlprofil.flag.' + flag ? flag : t;
  },
  erzaehlprofilPacingFlagLabel(flag) {
    const t = window.__app.t('erzaehlprofil.pacingFlag.' + flag);
    return t === 'erzaehlprofil.pacingFlag.' + flag ? flag : t;
  },
  // Schweregrad einer Autoren-Befund-Zeile → CSS-Klasse (hoch/mittel/niedrig).
  erzaehlprofilBefundPrioClass(prio) {
    return 'erzaehlprofil-befund-item--' + (['hoch', 'mittel', 'niedrig'].includes(prio) ? prio : 'mittel');
  },
  erzaehlprofilBefundKatLabel(kat) {
    if (!kat) return '';
    const t = window.__app.t('erzaehlprofil.befundKat.' + kat);
    return t === 'erzaehlprofil.befundKat.' + kat ? kat : t;
  },
  erzaehlprofilBefundPrioLabel(prio) {
    const t = window.__app.t('erzaehlprofil.befundPrio.' + prio);
    return t === 'erzaehlprofil.befundPrio.' + prio ? prio : t;
  },
};

export { _POV_KEYS, _TEMPUS_KEYS };
