// Fachmodul Tagebuch-Rückblick: Zeitraum-Auswahl, Aktualität, Navigation zu
// einem Tag, Facetten + Belege-Zeitleiste, History (lazy) und Kalender. Root-
// Zugriffe via window.__app. Job-Polling + run/onVisible kommen aus
// createCardJobFeature (siehe tagebuch-rueckblick-card.js). KI-Felder werden im
// Template via x-text (auto-escaped) gerendert — kein x-html-Sink.
//
// Datierung ist Server-SSoT: Zeitraum-Optionen, Eintragszahlen, Aktualität und
// Tag→Abschnitt kommen aus der Coverage (GET /history/rueckblick-coverage,
// routes/jobs/rueckblick-dates.js#buildRueckblickCoverage) — dieselbe Quelle,
// aus der der Job seine Einträge filtert. Die Karte parst keine Seitennamen.

import { fetchJson, localeTag, tzOpts } from '../utils.js';
import { buildYmHeatRows } from './ymheatmap.js';
import { isSelectedBook } from '../cards/book-guard.js';
import { memoMethods } from '../cards/card-memo.js';

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const YEAR_RE = /^\d{4}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})\b/;

export const tagebuchRueckblickMethods = {
  // Memo-Helper (cards/card-memo.js); Invalidierung rein über die Deps.
  ...memoMethods,

  // ── Coverage (Datums-SSoT) ─────────────────────────────────────────────────
  async loadRueckblickCoverage() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.rbCoverage = null; return; }
    try {
      const cov = await fetchJson('/history/rueckblick-coverage/' + bookId);
      if (!isSelectedBook(bookId)) return;
      this.rbCoverage = cov;
    } catch (e) {
      if (!isSelectedBook(bookId)) return;
      console.error('[loadRueckblickCoverage]', e);
      this.rbCoverage = null;
    }
  },

  _bucket(z) {
    const cov = this.rbCoverage;
    if (!cov || !z) return null;
    return (MONTH_RE.test(z) ? cov.months : cov.years)?.[z] || null;
  },

  // Anzahl datierter Einträge eines Zeitraums (0 = keine bzw. Coverage fehlt).
  rbEntryCount(z = this.rueckblickZeitraum) {
    return this._bucket(z)?.entries || 0;
  },

  rbCountLabel(n) {
    const app = window.__app;
    return n === 1 ? app.t('rueckblick.entriesOne') : app.t('rueckblick.entries', { n });
  },

  // Zeiträume mit Einträgen für die Combobox: Monate (feinkörniger) zuerst,
  // dann Jahre, jeweils neueste zuerst. Format: [{ value, label }].
  availableZeitraeume() {
    const cov = this.rbCoverage;
    return this._memo('zeitraeume', [cov, Alpine.store('shell').uiLocale], () => {
      if (!cov) return [];
      const withEntries = (obj) => Object.keys(obj || {}).filter(k => obj[k]?.entries > 0).sort().reverse();
      return [...withEntries(cov.months), ...withEntries(cov.years)]
        .map(v => ({ value: v, label: this.zeitraumLabel(v) }));
    });
  },

  // 'YYYY' → '2024'; 'YYYY-MM' → lokalisierter Monat + Jahr (TZ-aware).
  zeitraumLabel(value) {
    const v = String(value || '');
    const mm = MONTH_RE.exec(v);
    if (mm) {
      const d = new Date(Date.UTC(parseInt(mm[1], 10), parseInt(mm[2], 10) - 1, 1, 12));
      try {
        return d.toLocaleDateString(localeTag(Alpine.store('shell').uiLocale),
          tzOpts({ year: 'numeric', month: 'long', timeZone: 'UTC' }));
      } catch { return v; }
    }
    return v;
  },

  // Default = jüngster Monat mit Einträgen (oder leer, wenn keine datierten).
  defaultZeitraum() {
    const opts = this.availableZeitraeume();
    const firstMonth = opts.find(o => MONTH_RE.test(o.value));
    return firstMonth ? firstMonth.value : (opts[0]?.value || '');
  },

  // Vorheriger/nächster Zeitraum derselben Körnung (Monat ↔ Monat, Jahr ↔ Jahr)
  // mit Einträgen; null am Rand.
  rbNeighbor(dir) {
    const z = this.rueckblickZeitraum;
    if (!z) return null;
    const sameGrain = MONTH_RE.test(z) ? (v) => MONTH_RE.test(v) : (v) => YEAR_RE.test(v);
    const list = this.availableZeitraeume().map(o => o.value).filter(sameGrain).sort();
    const i = list.indexOf(z);
    if (i >= 0) return list[i + dir] || null;
    return dir < 0 ? (list.filter(v => v < z).pop() || null) : (list.find(v => v > z) || null);
  },

  gotoNeighbor(dir) {
    const z = this.rbNeighbor(dir);
    if (z) this._applyRueckblickZeitraum(z);
  },

  // ── Aktualität ─────────────────────────────────────────────────────────────
  // Bezogen auf den jüngsten Rückblick des gewählten Zeitraums:
  //  'none'    noch keiner erstellt
  //  'orphan'  Zeitraum hat keine datierten Einträge mehr
  //  'changed' Einträge seither bearbeitet/ergänzt (updated_at jünger) oder
  //            gelöscht (Anzahl ≠ entry_count-Snapshot)
  //  'model'   Einträge unverändert, aber mit einem anderen Modell erstellt
  //  'current' nichts davon — ein neuer Lauf liefert aus dem Server-Cache
  //            dasselbe Ergebnis
  // Nur Hinweis, keine Sperre: Neu-Erstellen bleibt immer möglich.
  rueckblickFreshness() {
    const z = this.rueckblickZeitraum;
    const entry = this._latestEntryFor(z);
    if (!entry) return { state: 'none' };
    const b = this._bucket(z);
    if (!b || !b.entries) return { state: 'orphan' };
    const genMs = Date.parse(entry.created_at) || 0;
    if ((b.newest && genMs && b.newest > genMs)
      || (entry.entry_count != null && entry.entry_count !== b.entries)) return { state: 'changed' };
    if (entry.model && this.rbCurrentModel && entry.model !== this.rbCurrentModel) {
      return { state: 'model', model: entry.model, current: this.rbCurrentModel };
    }
    return { state: 'current' };
  },

  rueckblickUpToDate() {
    return this.rueckblickFreshness().state === 'current';
  },

  rbFreshnessHint() {
    const f = this.rueckblickFreshness();
    const app = window.__app;
    if (f.state === 'changed') return app.t('rueckblick.fresh.changed');
    if (f.state === 'model') return app.t('rueckblick.fresh.model', { model: f.model, current: f.current });
    if (f.state === 'orphan') return app.t('rueckblick.fresh.orphan');
    if (f.state === 'current') return app.t('rueckblick.upToDate');
    return '';
  },

  canRunRueckblick() {
    if (this.rueckblickLoading || !this.rueckblickZeitraum) return false;
    // Ohne Coverage (Ladefehler) nicht blockieren — der Job meldet Leere selbst.
    return !this.rbCoverage || this.rbEntryCount() > 0;
  },

  _latestEntryFor(z) {
    return (this.rueckblickHistory || []).find(e => e.zeitraum === z) || null;
  },

  // Jüngster gespeicherter Rückblick des gewählten Zeitraums (oder null).
  rbLatestEntry() {
    return this._latestEntryFor(this.rueckblickZeitraum);
  },

  // ── Tag → Abschnitt ────────────────────────────────────────────────────────
  _pageForDay(datum) {
    const pages = Alpine.store('nav').pages || [];
    const day = String(datum || '').slice(0, 10);
    const id = this.rbCoverage?.days?.[day];
    if (id != null) {
      const p = pages.find(pg => String(pg.id) === String(id));
      if (p) return p;
    }
    return pages.find(p => (p?.name || '').slice(0, 10) === day) || null;
  },

  canGotoTag(datum) {
    return !!this._pageForDay(datum);
  },

  gotoRueckblickTag(datum) {
    const page = this._pageForDay(datum);
    if (page) window.__app.selectPage(page);
  },

  // ── Facetten (häufigste zuerst) ────────────────────────────────────────────
  rbThemen()   { return this._sortedFacet('themen'); },
  rbPersonen() { return this._sortedFacet('personen'); },
  rbOrte()     { return this._sortedFacet('orte'); },

  _sortedFacet(key) {
    const arr = this.rueckblickResult?.[key] || [];
    return this._memo('facet:' + key, [arr],
      () => [...arr].sort((a, b) => (b.haeufigkeit || 0) - (a.haeufigkeit || 0)));
  },

  // ── Belege des aktiven Stichworts ──────────────────────────────────────────
  // Inline-Leiste unter den Facetten statt Popover. Erneuter Klick schliesst.
  toggleBeleg(key, label, belege) {
    if (this.rbBeleg.key === key) { this.clearBeleg(); return; }
    const days = [...new Set((belege || []).map(d => String(d).slice(0, 10)).filter(Boolean))].sort();
    this.rbBeleg = { key, label: label || '', belege: days };
  },

  clearBeleg() {
    this.rbBeleg = { key: null, label: '', belege: [] };
  },

  gotoBelegTag(datum) {
    this.clearBeleg();
    this.gotoRueckblickTag(datum);
  },

  // Entitäts-Verweis für eine aktive Person/einen Ort, sofern der Name einer
  // Figur bzw. einem Schauplatz des Buchs entspricht (Name oder Kurzname,
  // case-insensitiv). Sonst null — der Name bleibt dann reiner Text.
  rbBelegRef() {
    const kind = String(this.rbBeleg.key || '').split(':')[0];
    const type = kind === 'personen' ? 'figur' : (kind === 'orte' ? 'ort' : null);
    if (!type) return null;
    const id = this._resolveEntityId(type, this.rbBeleg.label);
    return id == null ? null : { type, id };
  },

  _resolveEntityId(type, name) {
    const app = window.__app;
    const map = type === 'figur' ? app?.figurenById : app?.orteById;
    const lc = String(name || '').trim().toLowerCase();
    if (!map?.values || !lc) return null;
    for (const o of map.values()) {
      if ([o?.name, o?.kurzname].some(n => n && String(n).trim().toLowerCase() === lc)) return o.id;
    }
    return null;
  },

  // Zeitleiste des Zeitraums: alle Eintragstage als feine Striche, die Belegtage
  // des aktiven Stichworts hervorgehoben. pos in Prozent der Zeitraum-Breite.
  rbTimeline() {
    const z = this.rueckblickZeitraum;
    const belege = this.rbBeleg.belege;
    return this._memo('timeline', [z, this.rbCoverage, belege], () => {
      const span = this._periodSpan(z);
      if (!span) return [];
      const prefix = z + '-';
      const days = Object.keys(this.rbCoverage?.days || {}).filter(d => d.startsWith(prefix));
      const hit = new Set(belege);
      return [...new Set([...days, ...belege.filter(d => d.startsWith(prefix))])].sort()
        .map(d => ({ datum: d, pos: this._posInSpan(d, span), beleg: hit.has(d) }));
    });
  },

  // Beschriftung der beiden Enden der Zeitleiste.
  rbTimelineEdges() {
    const span = this._periodSpan(this.rueckblickZeitraum);
    if (!span) return ['', ''];
    const yearly = YEAR_RE.test(this.rueckblickZeitraum);
    const opts = yearly ? { month: 'short', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' };
    try {
      const fmt = new Intl.DateTimeFormat(localeTag(Alpine.store('shell').uiLocale), tzOpts(opts));
      return [fmt.format(new Date(span.start + 43200000)), fmt.format(new Date(span.end + 43200000))];
    } catch { return ['', '']; }
  },

  _periodSpan(z) {
    const m = MONTH_RE.exec(String(z || ''));
    if (m) {
      const y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1;
      return { start: Date.UTC(y, mo, 1), end: Date.UTC(y, mo + 1, 0) };
    }
    if (YEAR_RE.test(String(z || ''))) {
      const y = parseInt(z, 10);
      return { start: Date.UTC(y, 0, 1), end: Date.UTC(y, 11, 31) };
    }
    return null;
  },

  _posInSpan(d, span) {
    const m = DAY_RE.exec(d);
    if (!m) return 0;
    const t = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    const pos = ((t - span.start) / Math.max(1, span.end - span.start)) * 100;
    return Math.round(Math.min(100, Math.max(0, pos)) * 10) / 10;
  },

  // 'YYYY-MM-DD' → lokalisierter Tag (Kalendertag, UTC-Mittag ohne TZ-Rollover).
  belegLabel(datum) {
    const m = DAY_RE.exec(String(datum || ''));
    if (!m) return String(datum || '');
    const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12));
    try {
      return d.toLocaleDateString(localeTag(Alpine.store('shell').uiLocale),
        tzOpts({ weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }));
    } catch { return String(datum); }
  },

  // Zusammenfassung in Absätze splitten. Bevorzugt Doppel-Newline (Claude); nur
  // wenn keiner vorkommt, auf Einzel-Newline ausweichen (lokale Provider).
  rueckblickParagraphs() {
    const txt = String(this.rueckblickResult?.zusammenfassung || '');
    if (!txt.trim()) return [];
    const byDouble = txt.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    if (byDouble.length > 1) return byDouble;
    return txt.split(/\n/).map(s => s.trim()).filter(Boolean);
  },

  hasRueckblickResult() {
    const r = this.rueckblickResult;
    return !!(r && (r.zusammenfassung || (r.themen && r.themen.length)));
  },

  // Gerade angezeigter History-Eintrag (für die Meta-Zeile).
  rbViewedEntry() {
    if (this.selectedRueckblickId == null) return null;
    return (this.rueckblickHistory || []).find(e => e.id === this.selectedRueckblickId) || null;
  },

  // Meta-Zeile des angezeigten Rückblicks: Einträge · erstellt am · Modell.
  rbViewedMeta() {
    const e = this.rbViewedEntry();
    const n = e?.entry_count ?? this.rbEntryCount();
    const parts = [];
    if (n) parts.push(this.rbCountLabel(n));
    if (e?.created_at) parts.push(window.__app.t('rueckblick.createdAt', { date: this.rueckblickEntryDate(e.created_at) }));
    if (e?.model) parts.push(e.model);
    return parts.join(' · ');
  },

  // ── History (Metadaten aller Läufe; Ergebnis lazy pro Eintrag) ─────────────
  async loadRueckblickHistory() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.rueckblickHistory = []; this.rbHistoryLoaded = true; return; }
    try {
      const data = await fetchJson('/history/rueckblick/' + bookId);
      if (!isSelectedBook(bookId)) return;
      this.rueckblickHistory = Array.isArray(data) ? data : (data?.entries || []);
      this.rbCurrentModel = data?.current_model || '';
    } catch (e) {
      if (!isSelectedBook(bookId)) return;
      console.error('[loadRueckblickHistory]', e);
      this.rueckblickHistory = [];
    } finally {
      // Erst nach dem ersten Fetch darf der Leer-Hinweis erscheinen.
      this.rbHistoryLoaded = true;
    }
  },

  // Filter: Zeitraum (roh + lokalisiertes Label) lokal, Inhalt über die
  // Server-Suche (rbSearchIds, siehe searchRueckblicke).
  filteredRueckblickHistory() {
    const all = this.rueckblickHistory || [];
    const q = String(this.rbHistorySearch || '').trim().toLowerCase();
    const ids = this.rbSearchIds || [];
    return this._memo('histFilter', [all, q, ids, Alpine.store('shell').uiLocale], () => {
      if (!q) return all;
      const hit = new Set(ids.map(String));
      return all.filter(e => hit.has(String(e.id))
        || `${e.zeitraum || ''} ${this.zeitraumLabel(e.zeitraum)}`.toLowerCase().includes(q));
    });
  },

  async searchRueckblicke(q) {
    const bookId = Alpine.store('nav').selectedBookId;
    const needle = String(q || '').trim();
    if (!bookId || !needle) { this.rbSearchIds = []; return; }
    try {
      const res = await fetchJson(`/history/rueckblick-search/${bookId}?q=${encodeURIComponent(needle)}`);
      if (!isSelectedBook(bookId) || String(this.rbHistorySearch || '').trim() !== needle) return;
      this.rbSearchIds = res?.ids || [];
    } catch (e) {
      console.error('[searchRueckblicke]', e);
    }
  },

  // Zeitraum-Vorauswahl (Overview-Heatmap, Nachbar-Navigation, Kalender):
  // Zeitraum setzen und einen vorhandenen Rückblick zeigen — nie auto-generieren.
  _applyRueckblickZeitraum(zeitraum) {
    if (!zeitraum) return;
    this.selectedRueckblickId = null;
    this.rueckblickResult = null;
    this.rueckblickEmpty = false;
    this.clearBeleg();
    this.rueckblickZeitraum = zeitraum;
    const existing = this._latestEntryFor(zeitraum);
    if (existing) this.openRueckblickHistory(existing);
  },

  // Historischen Rückblick anzeigen (kein KI-Call). Das Ergebnis kommt aus dem
  // Eintrag selbst (Job-Ergebnis), dem Karten-Cache oder per Fetch.
  async openRueckblickHistory(entry) {
    if (!entry) return;
    this.selectedRueckblickId = entry.id;
    this.rueckblickZeitraum = entry.zeitraum || this.rueckblickZeitraum;
    this.rueckblickEmpty = false;
    this.clearBeleg();
    const known = entry.result_json || this._rbResults[entry.id];
    if (known) { this.rueckblickResult = known; return; }
    this.rueckblickResult = null;
    const bookId = Alpine.store('nav').selectedBookId;
    try {
      const row = await fetchJson('/history/rueckblick-entry/' + entry.id);
      if (!isSelectedBook(bookId) || this.selectedRueckblickId !== entry.id || !row?.result_json) return;
      this._rbResults[entry.id] = row.result_json;
      this.rueckblickResult = row.result_json;
    } catch (e) {
      console.error('[openRueckblickHistory]', e);
    }
  },

  // History-Eintrag per id öffnen (Permalink-Eingang #…/rueckblick/<id>).
  _openRueckblickEntryById(id) {
    const entry = (this.rueckblickHistory || []).find(e => String(e.id) === String(id));
    if (entry) this.openRueckblickHistory(entry);
  },

  async deleteRueckblickHistory(id) {
    const app = window.__app;
    if (app?.appConfirm && !await app.appConfirm({ message: app.t('rueckblick.confirmDelete'), danger: true })) return;
    try {
      await fetchJson('/history/rueckblick/' + id, { method: 'DELETE' });
      this.rueckblickHistory = (this.rueckblickHistory || []).filter(e => e.id !== id);
      delete this._rbResults[id];
      if (this.selectedRueckblickId === id) this.closeRueckblick();
      await this.loadRueckblickCoverage();
    } catch (e) {
      console.error('[deleteRueckblickHistory]', e);
    }
  },

  // Datum + Uhrzeit eines History-Eintrags (TZ-aware).
  rueckblickEntryDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(localeTag(Alpine.store('shell').uiLocale),
        tzOpts({ day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
    } catch { return iso; }
  },

  // Angezeigten Rückblick schliessen → zurück zur Übersicht desselben Zeitraums.
  // Ändert den Zeitraum NICHT, damit der $watch nichts erneut öffnet.
  closeRueckblick() {
    this.rueckblickResult = null;
    this.rueckblickEmpty = false;
    this.selectedRueckblickId = null;
    this.clearBeleg();
  },

  // ── Kalender (Jahr×Monat aus der Coverage) ─────────────────────────────────
  rueckblickCalendar() {
    return this._memo('rbCal', [this.rbCoverage], () => buildYmHeatRows(this.rbCoverage));
  },

  rbMonthLabels() {
    const locale = localeTag(Alpine.store('shell').uiLocale);
    return this._memo('rbMonthLabels', [locale], () => {
      const fmt = new Intl.DateTimeFormat(locale, tzOpts({ month: 'short', timeZone: 'UTC' }));
      const out = [];
      for (let m = 0; m < 12; m++) out.push(fmt.format(new Date(Date.UTC(2024, m, 15, 12))));
      return out;
    });
  },

  // Zelle/Jahr anklicken: Zeitraum wählen; vorhandener Rückblick öffnet sich
  // (_applyRueckblickZeitraum), sonst erscheint der Erstellen-Aufruf.
  openCalendarCell(cell) {
    if (cell && (cell.hasRueckblick || cell.hasEntries)) this._applyRueckblickZeitraum(cell.key);
  },

  openCalendarYear(row) {
    if (row && (row.hasRueckblick || row.hasEntries)) this._applyRueckblickZeitraum(row.yearKey);
  },

  rbCalCellTip(cell) {
    const period = `${this.rbMonthLabels()[cell.monthIdx - 1]} ${cell.key.slice(0, 4)}`;
    return this._rbCalTip(period, cell, cell.entries);
  },
  rbCalYearTip(row) {
    return this._rbCalTip(String(row.year), row, this._bucket(row.yearKey)?.entries || 0);
  },
  _rbCalTip(period, node, n) {
    const app = window.__app;
    const count = n ? ` · ${this.rbCountLabel(n)}` : '';
    if (node.hasRueckblick) return `${period}${count}: ${app.t('rueckblick.cal.tipHas', { date: this.rueckblickEntryDate(node.createdAt || node.yearCreatedAt) })}`;
    if (node.hasEntries) return `${period}${count}: ${app.t('rueckblick.cal.tipGenerate')}`;
    return `${period}: ${app.t('rueckblick.cal.tipEmpty')}`;
  },
};
