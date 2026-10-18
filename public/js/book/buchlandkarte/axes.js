// Buchlandkarte: Achsen — Wahl des Achsenpaars, Beschriftung, die Abschnitte an
// den Enden jeder Achse, eigene Pole und die KI-Benennung der PCA-Achsen.
// Gespreadet über book/buchlandkarte.js.
//
// WARUM DIE ENDEN ZEIGEN: eine PCA-Achse ist die Richtung, in der sich die
// Abschnitte am stärksten unterscheiden — was sie inhaltlich trennt, steht
// nirgends. Die drei Abschnitte an jedem Ende machen es lesbar; die
// KI-Benennung (Job `book-map-label`) fasst es auf Wunsch in zwei Labels.
//
// POLE: statt der PCA-Richtungen kann der Autor Achsen mit fester Bedeutung
// setzen — Figur gegen Figur, Schauplatz gegen Schauplatz, Begriff gegen
// Begriff. Die Kandidaten (Figuren und Orte im Index) liefert jeder Kartenlauf
// mit; ein Freitext-Pol geht immer.

import { startPoll } from '../../cards/job-helpers.js';
import { tRaw } from '../../i18n.js';
import { resultCache } from './cache.js';

// Abschnitte je Achsenende in der Anzeige bzw. im KI-Prompt.
const EXTREMES_SHOWN = 3;
const EXTREMES_LABEL = 4;
const POLE_SLOTS = ['xa', 'xb', 'ya', 'yb'];

export function emptyBookMapPoles() {
  return Object.fromEntries(POLE_SLOTS.map(k => [k, { sel: '', text: '' }]));
}

export const axesMethods = {
  // ── Achsenpaar ────────────────────────────────────────────────────────────

  /** Gewähltes Paar als [a, b]; a ist eine Achsen-Nummer, b eine Nummer oder 'order'. */
  _bookMapPair() {
    const [a, b] = String(this.bookMapAxisPair || '0-1').split('-');
    const n = this.bookMapResult?.projection?.axes?.length || 0;
    const ax = Math.min(Number(a) || 0, Math.max(0, n - 1));
    if (b === 'order' || n < 2) return [ax, 'order'];
    return [ax, Math.min(Number(b) || 1, n - 1)];
  },

  _bookMapDefaultPair() {
    const n = this.bookMapResult?.projection?.axes?.length || 0;
    return n >= 2 ? '0-1' : '0-order';
  },

  /** Optionen der Achsen-Combobox, abhängig von Modus und Achsenzahl. */
  bookMapAxisPairOptions() {
    const n = this.bookMapResult?.projection?.axes?.length || 0;
    const name = (k) => (k === 'order' ? this.bookMapAxisTitle('order') : this._bookMapAxisShortName(k));
    const pairs = [];
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) pairs.push([a, b]);
    for (let a = 0; a < n; a++) pairs.push([a, 'order']);
    return pairs.map(([a, b]) => ({ value: `${a}-${b}`, label: `${name(a)} × ${name(b)}` }));
  },

  _bookMapAxisShortName(k) {
    const t = (key, p) => window.__app?.t?.(key, p) || key;
    const ax = this.bookMapResult?.projection?.axes?.[k];
    if (ax?.kind === 'pole') return `${ax.poles[1]} ↔ ${ax.poles[0]}`;
    const lbl = this.bookMapLabels?.[k];
    if (lbl) return `${lbl.neg} ↔ ${lbl.pos}`;
    return t('buchlandkarte.axis.pcShort', { n: k + 1 });
  },

  /**
   * Beschriftung einer Achse auf der Karte. Pol-Achse: „B ← → A" (positiv =
   * näher an A). PCA-Achse: KI-Labels, sonst Nummer und Streuungsanteil.
   */
  bookMapAxisTitle(k) {
    const t = (key, p) => window.__app?.t?.(key, p) || key;
    if (k === 'order') return t('buchlandkarte.axis.order');
    const ax = this.bookMapResult?.projection?.axes?.[k];
    const pct = Math.round((ax?.variance || 0) * 100);
    if (ax?.kind === 'pole') return `← ${ax.poles[1]}   ·   ${ax.poles[0]} →  (${pct}%)`;
    const lbl = this.bookMapLabels?.[k];
    if (lbl) return `← ${lbl.neg}   ·   ${lbl.pos} →  (${pct}%)`;
    return t('buchlandkarte.axis.pc', { n: k + 1, pct });
  },

  // ── Enden der Achsen ──────────────────────────────────────────────────────

  /**
   * Je Raumachse die Abschnitte an beiden Enden. Bei Passagen-Punkten zählt je
   * Abschnitt sein Mittel — sonst stellte ein langer Abschnitt alle drei Plätze.
   */
  _bookMapExtremeIds(k, count) {
    const pts = this.bookMapResult?.projection?.points || [];
    const acc = new Map();
    for (const p of pts) {
      const v = p.c?.[k];
      if (v == null) continue;
      const e = acc.get(p.id) || { sum: 0, n: 0 };
      e.sum += v; e.n++;
      acc.set(p.id, e);
    }
    const rows = [...acc].map(([id, e]) => ({ id, v: e.sum / e.n })).sort((x, y) => x.v - y.v);
    if (rows.length < 2 * count) count = Math.floor(rows.length / 2);
    return {
      neg: rows.slice(0, count).map(r => r.id),
      pos: rows.slice(-count).reverse().map(r => r.id),
    };
  },

  /** Zeilen fürs Template: die zwei gezeigten Raumachsen mit ihren Enden. */
  bookMapAxisEnds() {
    const proj = this.bookMapResult?.projection;
    if (!proj?.axes?.length) return [];
    const t = (key, p) => window.__app?.t?.(key, p) || key;
    const keys = this._bookMapPair().filter(k => k !== 'order');
    return keys.map(k => {
      const ax = proj.axes[k];
      const { neg, pos } = this._bookMapExtremeIds(k, EXTREMES_SHOWN);
      const lbl = this.bookMapLabels?.[k] || null;
      const page = (id) => ({ id, name: this.bookMapPageName(id) });
      return {
        k,
        title: ax.kind === 'pole' ? `${ax.poles[1]} ↔ ${ax.poles[0]}` : t('buchlandkarte.axis.pcShort', { n: k + 1 }),
        negLabel: ax.kind === 'pole' ? ax.poles[1] : lbl?.neg || t('buchlandkarte.axis.negEnd'),
        posLabel: ax.kind === 'pole' ? ax.poles[0] : lbl?.pos || t('buchlandkarte.axis.posEnd'),
        diff: lbl?.diff || '',
        neg: neg.map(page),
        pos: pos.map(page),
      };
    });
  },

  // ── KI-Benennung der PCA-Achsen ───────────────────────────────────────────

  bookMapCanLabel() {
    const proj = this.bookMapResult?.projection;
    return proj?.mode === 'pca' && (proj.points?.length || 0) >= 2 * EXTREMES_LABEL && !this.bookMapLabelLoading;
  },

  async runBookMapLabels() {
    const bookId = Alpine.store('nav').selectedBookId;
    const res = this.bookMapResult;
    if (!bookId || !res || !this.bookMapCanLabel()) return;
    const axes = res.projection.axes.map((_, k) => this._bookMapExtremeIds(k, EXTREMES_LABEL));
    this.bookMapLabelLoading = true;
    this.bookMapLabelStatus = tRaw('buchlandkarte.labels.running');
    const stale = () => Alpine.store('nav').selectedBookId !== bookId || this.bookMapResult !== res;
    const failed = (job) => {
      if (stale()) return;
      this.bookMapLabelLoading = false;
      this.bookMapLabelStatus = job?.error && job.error.startsWith('job.')
        ? window.__app.t(job.error, job.errorParams)
        : tRaw('buchlandkarte.labels.error');
    };
    try {
      const r = await fetch('/jobs/book-map-label', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, axes }),
      });
      const j = await r.json().catch(() => ({}));
      if (stale()) return;
      if (!r.ok || !j.jobId) { failed(null); return; }
      startPoll(this, {
        timerProp: '_bookMapLabelPollTimer',
        jobId: j.jobId,
        intervalMs: 1000,
        onDone: (job) => {
          const labels = job.result?.axes || null;
          // Am Ergebnis-Objekt festhalten, zu dem die Labels gehören — auch im
          // Sitzungs-Cache, wenn inzwischen ein anderes Buch offen ist.
          if (labels) res._labels = labels;
          if (stale()) return;
          this.bookMapLabelLoading = false;
          this.bookMapLabelStatus = '';
          this.bookMapLabels = labels;
          if (resultCache.get(String(bookId)) === res) resultCache.set(String(bookId), res);
          this.$nextTick(() => this.renderBookMap());
        },
        onError: failed,
        onNotFound: () => failed(null),
      });
    } catch (e) {
      if (stale()) return;
      this.bookMapLabelLoading = false;
      this.bookMapLabelStatus = tRaw('common.errorColon') + (e.message || '');
    }
  },

  // ── Eigene Pole ───────────────────────────────────────────────────────────

  /** Combobox-Optionen eines Pols: Figuren und Orte aus dem letzten Lauf + Freitext. */
  bookMapPoleOptions() {
    const t = (key, p) => window.__app?.t?.(key, p) || key;
    const cands = this.bookMapResult?.poleCandidates || [];
    return [
      { value: 'text', label: t('buchlandkarte.poles.freeText') },
      ...cands.map(c => ({
        value: `${c.kind}:${c.id}`,
        label: `${c.name} (${t(c.kind === 'figure' ? 'buchlandkarte.poles.figure' : 'buchlandkarte.poles.location')})`,
      })),
    ];
  },

  _bookMapPoleSpec(slot) {
    const s = this.bookMapPoles?.[slot];
    if (!s?.sel) return null;
    if (s.sel === 'text') {
      const text = String(s.text || '').trim();
      return text ? { kind: 'text', text } : null;
    }
    const [kind, id] = s.sel.split(':');
    return kind && Number(id) ? { kind, id: Number(id) } : null;
  },

  /**
   * Pole für den POST — null, wenn die x-Achse unvollständig ist oder die
   * y-Achse nur halb gesetzt (eine halbe Achse wäre eine stille Fehlbedienung).
   * Ohne y-Paar zeigt die Karte x gegen den Buchverlauf.
   */
  _bookMapPolesPayload() {
    const [xa, xb, ya, yb] = POLE_SLOTS.map(s => this._bookMapPoleSpec(s));
    if (!xa || !xb) return null;
    const yTouched = !!(this.bookMapPoles?.ya?.sel || this.bookMapPoles?.yb?.sel);
    if (yTouched && (!ya || !yb)) return null;
    return { x: [xa, xb], y: ya && yb ? [ya, yb] : null };
  },

  _bookMapPolesFromOptions(poles) {
    const out = emptyBookMapPoles();
    const put = (slot, p) => {
      if (!p) return;
      out[slot] = p.kind === 'text' ? { sel: 'text', text: p.text || '' } : { sel: `${p.kind}:${p.id}`, text: '' };
    };
    put('xa', poles?.x?.[0]); put('xb', poles?.x?.[1]);
    put('ya', poles?.y?.[0]); put('yb', poles?.y?.[1]);
    return out;
  },
};
