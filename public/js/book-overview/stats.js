// Schreibstatistik-Tiles: Hero-Snapshot, Sparkline, 7-Tage-Bars, Heute-Ring,
// Streak-Heatmap. Visualisierungen als reines Inline-SVG (kein Chart.js) —
// Overview soll instant beim Buchwechsel sichtbar sein, ohne Lazy-Lib-Load.
//
// Memos, die lokalisierte Strings (Wochentage, Datums-Labels, Tooltips) mit
// backen, führen `this._uiLocale()` in ihren Deps — sonst bleiben die Labels
// nach einem Sprachwechsel auf der alten Sprache stehen. Memos, deren Ergebnis
// vom heutigen Datum abhängt, führen `this.overviewToday` (reaktiv, siehe
// book-overview-card.js) — sonst zeigt eine über Mitternacht offene Karte den
// Vortag als „heute".
//
// Kalendertage werden ausschliesslich als ISO-Strings gerechnet, verankert auf
// `overviewToday` (= localIsoDate(), appTimezone) — siehe ./iso-day.js. Labels
// eines ISO-Tags formatiert `_isoDayLabel` am UTC-Mittag mit `timeZone: 'UTC'`:
// so zeigt das Label genau den Kalendertag des Strings, egal in welcher Zone
// Browser und App stehen.
import { localIsoDate, completeLiveBookStats, CHARS_PER_NORMSEITE } from '../utils.js';
import { computeTodayRing, makeDayDelta } from '../today-ring.js';
import { buildStreakGrid } from '../streak-grid.js';
import { isoAddDays, isoLastDays, isoNoonUtc } from './iso-day.js';

export const statsMethods = {
  // Heutiger Kalendertag (appTimezone). `overviewToday` ist das reaktive Feld
  // der Karte; ohne Karte (Unit-Tests) direkt aus localIsoDate().
  _todayIso() {
    return this.overviewToday || localIsoDate();
  },

  // Label eines ISO-Kalendertags (siehe Modulkopf: UTC-Mittag + timeZone UTC).
  _isoDayLabel(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
    const d = isoNoonUtc(iso);
    return d ? this._dateFmt({ ...opts, timeZone: 'UTC' }).format(d) : '';
  },

  // Live-Stand des ganzen Buchs aus tokEsts — `null`, solange tokEsts nicht
  // JEDE Seite kennt (Buchwechsel, Hintergrund-Abgleich läuft). Alle Kacheln,
  // die „aktuell" rechnen, gehen hierdurch und fallen sonst auf den Snapshot.
  _liveTotals() {
    const tokEsts = window.__app?.tokEsts || {};
    const pages = Alpine.store('nav').pages || [];
    return this._memo('liveTotals', [tokEsts, pages], () => completeLiveBookStats(tokEsts, pages));
  },

  // Hero-Snapshot: live-aggregiert aus `tokEsts` (gleiche Quelle wie Sidebar-Σ),
  // damit Hero und Sidebar nach jedem Save sofort identisch sind. Cron-Snapshot
  // (book_stats_history) gilt, solange der Live-Stand unvollständig ist (Buch
  // eben gewechselt, Background-Estimate noch unterwegs) — dann trägt das
  // Ergebnis `fromSnapshot: true`, und der Hero nennt den Stand-Tag.
  // Sparkline + 7-Tage-Balken lesen weiterhin overviewStats direkt — die
  // brauchen den historischen Verlauf.
  overviewLatest() {
    const app = window.__app;
    const tokEsts = app?.tokEsts || {};
    const pages = Alpine.store('nav').pages || [];
    const stats = this.overviewStats || [];
    // `tree` gehört in die Deps, weil chapter_count über _chapterRollup daraus
    // kommt: ein Umhängen/Umbenennen im Buchorganizer ändert den Tree, ohne
    // dass `pages` neu zugewiesen wird.
    const tree = Alpine.store('nav').tree || [];
    return this._memo('latest', [stats, tokEsts, pages, tree], () => {
      const histLast = stats.length ? stats[stats.length - 1] : null;
      const live = this._liveTotals();
      if (!live) return histLast ? { ...histLast, fromSnapshot: true } : null;
      const { chars, words, tok } = live;
      const page_count = pages.length;
      // chapter_count zählt nur Top-Level-Kapitel — Sub-Kapitel rollen auf Root.
      // Gliederung des ganzen Buchs: auch ausgeschlossene Kapitel (anyRootOf).
      const { anyRootOf } = this._chapterRollup();
      const rootIds = new Set();
      for (const p of pages) {
        if (!p.chapter_id) continue;
        const root = anyRootOf(p.chapter_id);
        if (root) rootIds.add(Number(root.id));
      }
      const chapter_count = rootIds.size;
      return { ...(histLast || {}), chars, words, tok, page_count, chapter_count, fromSnapshot: false };
    });
  },

  // „Stand: <Tag>" unter dem Hero, wenn die Zahlen aus dem Snapshot kommen.
  // `recorded_at` ist ein Kalendertag (Cron-Bucket in appTimezone).
  overviewSnapshotAsOf() {
    const latest = this.overviewLatest();
    if (!latest?.fromSnapshot || !latest.recorded_at) return '';
    return this._isoDayLabel(latest.recorded_at);
  },

  // Tagesbilanz-Funktion des aktuellen Buchs. SSoT ist makeDayDelta in
  // [public/js/today-ring.js] — dieselbe Regel, aus der das Header-Popover
  // seine 7-Tage-Balken und seine Schreib-Serie zieht. Die Kachel und der
  // Header lesen ohnehin dieselbe /history/book-stats-Antwort; eine eigene
  // Delta-Regel hier hiesse, fuer denselben Tag zwei Zahlen zu zeigen.
  _dayDelta() {
    const a = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    const pages = Alpine.store('nav').pages || [];
    const todayIso = this._todayIso();
    return this._memo('dayDelta', [a, tokEsts, pages, todayIso],
      () => makeDayDelta({ stats: a, tokEsts, pages, todayIso }));
  },

  // Letzte 7 Kalendertage. Pro Tag die Netto-Zeichenbilanz aus _dayDelta().
  // Anders als der Header-Balken (Ziel-Fortschritt) behaelt die Kachel das
  // VORZEICHEN: ein Tag, an dem mehr geloescht als geschrieben wurde, ist hier
  // eine Aussage und bekommt einen Balken nach unten.
  overviewLast7Days() {
    const a = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    const pages = Alpine.store('nav').pages || [];
    return this._memo('last7Days', [a, tokEsts, pages, this._uiLocale(), this._todayIso()], () => {
      const dayDelta = this._dayDelta();
      return isoLastDays(this._todayIso(), 7).map(iso => ({
        iso,
        label: this._isoDayLabel(iso, { weekday: 'short' }),
        delta: dayDelta(iso) ?? 0,
      }));
    });
  },

  // Skalierungs-Maximum für 7-Tage-Bars (abs, mind. 1 um Division-by-zero zu vermeiden).
  overviewLast7Max() {
    const days = this.overviewLast7Days();
    return this._memo('last7Max', [days], () =>
      Math.max(1, ...days.map(d => Math.abs(d.delta))));
  },

  overview7DayCharDelta() {
    const a = this.overviewStats;
    if (!a || a.length < 2) return null;
    const tokEsts = window.__app?.tokEsts || {};
    const pages = Alpine.store('nav').pages || [];
    return this._memo('sevenDayDelta', [a, tokEsts, pages, this._todayIso()], () => {
      // Latest = vollständiger Live-Stand, sonst letzter Snapshot (raw, kein
      // Math.max — sonst gewinnt der Snapshot bei Lösch-Edits und überzeichnet
      // die Netto-Bilanz). Konsistent zum Heute-Ring (today-ring.js).
      const live = this._liveTotals();
      const latestSnapshot = a[a.length - 1];
      const latestChars = live ? live.chars : (Number(latestSnapshot.chars) || 0);
      const cutoff = isoAddDays(this._todayIso(), -7);
      let earlier = null;
      for (let i = a.length - 2; i >= 0; i--) {
        if (a[i].recorded_at <= cutoff) { earlier = a[i]; break; }
      }
      if (!earlier) earlier = a[0];
      return latestChars - (Number(earlier.chars) || 0);
    });
  },

  // Sparkline-Daten + Polygon-Fläche darunter (Gradient-Fill).
  // Liefert { d, area, color, deltaPct, deltaAbs, endX, endY, w, h, points } oder { d:null, ... } bei <2 Punkten.
  // `deltaPct` ist null, wenn der Verlauf bei 0 Zeichen beginnt — Prozent von
  // nichts ist keine Zahl; die Kachel zeigt dann den absoluten Zuwachs.
  // `points`: pro Datenpunkt { chars, iso, label } für Hover-Overlay mit Datum + exaktem Wert.
  overviewSparkline() {
    const stats = this.overviewStats || [];
    return this._memo('sparkline', [stats, this._uiLocale(), this._todayIso()], () => {
      const W = 240, H = 48, PAD = 3;
      // Fenster nach KALENDERTAGEN, nicht nach Snapshot-Anzahl: das Label
      // verspricht „30 Tage", und Snapshot-Lücken (Cron ausgefallen, Import)
      // dehnten `slice(-30)` sonst über Monate. Der letzte Snapshot VOR dem
      // Fenster bleibt als Anker drin — er ist der Stand am Fensteranfang.
      const cutoff = isoAddDays(this._todayIso(), -30);
      let start = stats.findIndex(s => (s.recorded_at || '') >= cutoff);
      if (start < 0) start = stats.length;
      const slice = stats.slice(Math.max(0, start - 1));
      const data = slice.map(s => Number(s.chars) || 0);
      if (data.length < 2) return { d: null, area: null, color: 'currentColor', deltaPct: 0, deltaAbs: 0, endX: 0, endY: 0, w: W, h: H, points: [] };
      const min = Math.min(...data);
      const max = Math.max(...data);
      const span = Math.max(1, max - min);
      const stepX = (W - 2 * PAD) / (data.length - 1);
      const pts = data.map((v, i) => {
        const x = PAD + i * stepX;
        const y = H - PAD - ((v - min) / span) * (H - 2 * PAD);
        return [x, y];
      });
      const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      const area = d
        + ` L ${pts[pts.length - 1][0].toFixed(1)},${(H - PAD).toFixed(1)}`
        + ` L ${pts[0][0].toFixed(1)},${(H - PAD).toFixed(1)} Z`;
      const first = data[0];
      const last = data[data.length - 1];
      const deltaAbs = last - first;
      const deltaPct = first > 0 ? Math.round((deltaAbs / first) * 100) : null;
      // Farbe nach dem Vorzeichen des Zuwachses, nicht der gerundeten Prozente:
      // ein Plus von 0,4 % ist trotzdem ein Plus.
      const color = deltaAbs > 0 ? 'var(--color-success)'
                  : deltaAbs < 0 ? 'var(--color-err-border)'
                  :                'var(--color-accent)';
      const endX = pts[pts.length - 1][0];
      const endY = pts[pts.length - 1][1];
      const numFmt = this._numFmt();
      const unit = window.__app?.t?.('bookstats.unit.z') || 'Z';
      const points = slice.map((s, i) => {
        const iso = s.recorded_at;
        let label;
        if (iso) {
          label = this._isoDayLabel(iso) + ': ' + numFmt.format(data[i]) + ' ' + unit;
        } else {
          label = numFmt.format(data[i]) + ' ' + unit;
        }
        return { chars: data[i], iso, label };
      });
      return { d, area, color, deltaPct, deltaAbs, endX, endY, w: W, h: H, points };
    });
  },

  // Beschriftung des Zuwachses unter der Kurve (auch aria-label der Kachel):
  // Prozent, solange es eine Basis gibt, sonst absolute Zeichen.
  overviewSparklineDeltaLabel() {
    const { deltaPct, deltaAbs } = this.overviewSparkline();
    const t = window.__app?.t || ((k) => k);
    if (deltaPct != null) {
      return t('overview.trendDelta', { pct: (deltaPct >= 0 ? '+' : '') + deltaPct });
    }
    return t('overview.trendDeltaAbs', { n: (deltaAbs >= 0 ? '+' : '') + this._fmtNum(deltaAbs) });
  },

  // Streak-Heatmap: 52 Wochen × 7 Tage GitHub-Stil, ausgehend von HEUTE
  // (rechte untere Ecke = heute, links = vor 1 Jahr). Raster, Einfaerbung und
  // Serien-Zaehlung liegen in [public/js/streak-grid.js] — geteilt mit der
  // Schreibzeit-Heatmap in „Meine Statistik"; hier bleibt nur der Tageswert
  // (Zeichenbilanz) und der Zell-Tooltip.
  //
  // Der Tooltip wird hier einmal gebaut, nicht im Template: 364 Zellen ×
  // Formatter + t() pro Reactive-Tick waere die teuerste Schleife der Karte.
  // Er unterscheidet drei Lagen, und darum ist `null` als Tageswert nicht
  // dasselbe wie `0`: nichts geschrieben vs. gar keine Datenlage.
  overviewStreakHeatmap() {
    const a = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    const pages = Alpine.store('nav').pages || [];
    return this._memo('streakHeatmap', [a, tokEsts, pages, this._uiLocale(), this._todayIso()], () => {
      const dayDelta = this._dayDelta();
      const t = window.__app?.t || ((k) => k);
      const numFmt = this._numFmt();
      return buildStreakGrid({
        valueForIso: dayDelta,
        decorate: (cell) => {
          if (cell.future) return { delta: null, tip: null };
          const delta = cell.value;
          const date = this._isoDayLabel(cell.iso);
          const tip = delta != null && delta > 0
            ? t('overview.streak.cellTip', { date, chars: numFmt.format(delta) })
            : delta != null
              ? t('overview.streak.cellTipNoChange', { date })
              : t('overview.streak.cellTipNone', { date });
          // `delta` bleibt als sprechender Alias am Zell-Objekt: die Kachel
          // spricht von Zeichen, nicht von einem generischen `value`.
          return { delta, tip };
        },
      });
    });
  },

  // Heute-Ring: Donut-Math für Tagesziel. Shared Compute mit dem Header-Donut
  // ueber [public/js/today-ring.js] — beide bleiben deckungsgleich. Memo
  // verhindert Re-Compute pro Render (Tile ruft die Methode 6× pro Render).
  overviewTodayRing(goalChars) {
    const a = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    const pages = Alpine.store('nav').pages || [];
    const todayIso = this._todayIso();
    // Goal: expliziter Buch-Wert (book_settings.daily_goal_chars) vor
    // Default = eine Normseite/Tag. Auflösung hier statt im Template, damit
    // das Charts-Partial die Methode argumentlos aufrufen kann.
    const goal = Math.max(1, Number(goalChars) || this.overviewDailyGoalChars || CHARS_PER_NORMSEITE);
    const newBook = this.overviewIsNewBook();
    return this._memo('todayRing:' + goal, [a, tokEsts, pages, todayIso, newBook], () =>
      computeTodayRing({ stats: a, tokEsts, pages, todayIso, goalChars: goal, r: 28, newBookBaseline: newBook })
    );
  },

  // Neues Buch: Verlauf erfolgreich geladen, aber noch kein einziger Snapshot
  // (der nächtliche Lauf war seit der Anlage noch nicht da). Dann zählt der
  // Heute-Ring den vollständigen Live-Stand gegen 0 — ab dem ersten Tag statt
  // erst nach dem ersten Snapshot. Ein gescheiterter Verlaufs-Load sieht
  // genauso leer aus und bleibt darum ausgenommen.
  overviewIsNewBook() {
    if (this.overviewLoading) return false;
    if ((this.overviewStats || []).length > 0) return false;
    if ((this.overviewLoadErrors || []).includes('stats')) return false;
    return this._liveTotals() != null;
  },

  // Heute-Ring sichtbar: Verlauf vorhanden oder neues Buch mit vollständigem Live-Stand.
  overviewShowTodayRing() {
    return (this.overviewStats || []).length > 0 || this.overviewIsNewBook();
  },
};
