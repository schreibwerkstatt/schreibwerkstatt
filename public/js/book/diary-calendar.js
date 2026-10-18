// Diary-Calendar: Sidebar-Alternative für Bücher mit buchtyp='tagebuch'.
// Aggregiert `pages` mit `YYYY-MM-DD`-Namen (diary-date.js) zu Monats-Grid;
// Klick auf einen Tag mit Eintrag ruft `selectPage(page)`, auf einen leeren Tag
// bis heute legt er den Eintrag an. Eingebunden ins Root via spread in tree.js.
//
// Performance: `diaryCalendarPagesMap` läuft einmal pro Load + Cache-Invalidation
// in `loadPages`. Bei 2'400 Diary-Pages ist der Build ~3 ms (Regex-Match pro
// Page), wir wollen aber nicht pro Render rebuilden.

import { contentRepo } from '../repo/content.js';
import { dateTimeFormat, fetchJson, formatIsoDay, localIsoDate } from '../utils.js';
import { insertChapterItem } from './tree/load.js';
import { isSelectedBook } from '../cards/book-guard.js';
import { diaryDayKey } from './diary-date.js';

// Abbruch-Signal der Anlage-Kette in _createDiaryEntry: Buch während eines
// awaits gewechselt. Kein Fehler für den User (er hat das Buch selbst gewechselt).
class DiaryBookSwitched extends Error {}
function _assertDiaryBook(bookId) {
  if (!isSelectedBook(bookId)) throw new DiaryBookSwitched();
}

const _CACHE_KEY = '_diaryCalendarCache';

// Pure: alle Map-Keys mit gleichem `MM-DD` und Jahr < `todayYear`, absteigend
// nach Jahr. `map` ist Map<'YYYY-MM-DD', page> (diaryCalendarPagesMap-Shape).
// Exakt-Matching auf `MM-DD` (29.02. matcht nur echte 29.02.-Einträge).
export function _computeAnniversary(map, todayMMDD, todayYear) {
  const out = [];
  for (const [key, page] of map.entries()) {
    if (key.slice(5) !== todayMMDD) continue;
    const year = parseInt(key.slice(0, 4), 10);
    if (year >= todayYear) continue;
    out.push({ key, year, yearsAgo: todayYear - year, page });
  }
  out.sort((a, b) => b.year - a.year);
  return out;
}

// Pure: alle Map-Keys im inklusiven Bereich [from, to] (ISO-Strings, sortierbar),
// absteigend nach Datum. Bei from > to werden die Grenzen getauscht.
export function _computeRange(map, from, to) {
  if (!from || !to) return [];
  let lo = from, hi = to;
  if (lo > hi) { lo = to; hi = from; }
  const out = [];
  for (const [key, page] of map.entries()) {
    if (key >= lo && key <= hi) out.push({ key, page });
  }
  out.sort((a, b) => b.key.localeCompare(a.key));
  return out;
}

// Pure: Startmonat des Kalenders ohne User-Wahl. `months` absteigend wie
// diaryCalendarMonths(); `todayMonthKey` = 'YYYY-MM'. Liefert den jüngsten Monat
// mit Einträgen, der nicht in der Zukunft liegt, oder null.
export function _computeStartMonth(months, todayMonthKey) {
  const hit = (months || []).find(m => m.key <= todayMonthKey);
  return hit ? { year: hit.year, month: hit.month } : null;
}

// Pure: alle Pages mit Tagesdatum chronologisch, gleicher Tag in Eingangsreihenfolge.
export function _computeSortedEntries(pages) {
  return pages
    .map((page, i) => ({ page, i, key: diaryDayKey(page?.name) }))
    .filter(e => e.key)
    .sort((a, b) => a.key.localeCompare(b.key) || a.i - b.i)
    .map(e => e.page);
}

function _ensureCache(app) {
  if (!app[_CACHE_KEY]) app[_CACHE_KEY] = { pagesRef: null, map: null, months: null, langByBookId: {} };
  return app[_CACHE_KEY];
}

const MONTH_NAMES_DE = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const MONTH_NAMES_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// DE/EN Monatsname → 1-12. Diakritika-tolerant, akzeptiert übliche Abkürzungen.
// Spiegel zu lib/import-parsers/date-detect.js#parseMonthToken (Server-Side).
const _MONTH_TOKENS = {
  januar:1, jan:1, jaenner:1, january:1,
  februar:2, feb:2, february:2,
  maerz:3, marz:3, mar:3, mrz:3, march:3,
  april:4, apr:4,
  mai:5, may:5,
  juni:6, jun:6, june:6,
  juli:7, jul:7, july:7,
  august:8, aug:8,
  september:9, sep:9, sept:9,
  oktober:10, okt:10, oct:10, october:10,
  november:11, nov:11,
  dezember:12, dez:12, december:12,
};

function _parseMonthName(token) {
  if (!token) return null;
  const norm = String(token).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const part of norm.split(/[\s.,;:_\-/]+/).filter(Boolean)) {
    if (_MONTH_TOKENS[part]) return _MONTH_TOKENS[part];
  }
  return null;
}

export const diaryCalendarMethods = {
  // Map<'YYYY-MM-DD', page>. Cache invalidiert bei pages-Replacement.
  diaryCalendarPagesMap() {
    const cache = _ensureCache(this);
    if (cache.pagesRef === this.$store.nav.pages && cache.map) return cache.map;
    const m = new Map();
    for (const p of (this.$store.nav.pages || [])) {
      const key = diaryDayKey(p.name);
      if (key && !m.has(key)) m.set(key, p);
    }
    cache.pagesRef = this.$store.nav.pages;
    cache.map = m;
    cache.months = null;
    cache.sorted = null;
    cache.anniversary = null;
    cache.range = null;
    return m;
  },

  // [{ key:'YYYY-MM', year, month, count }] absteigend sortiert.
  diaryCalendarMonths() {
    const cache = _ensureCache(this);
    // pagesRef-Check muss hier eigenständig laufen — Template ruft
    // `diaryCalendarMonths` (via Label/Combobox) vor `diaryCalendarMonthGrid`,
    // ohne pagesRef-Check würde nach Buchwechsel die alte `cache.months`-Liste
    // zurückkommen (Label + Sprung-Combobox zeigen sonst altes Buch bis ein
    // weiterer Reactive-Trigger feuert).
    if (cache.pagesRef === this.$store.nav.pages && cache.months) return cache.months;
    const map = this.diaryCalendarPagesMap();
    const counts = new Map();
    for (const key of map.keys()) {
      const k = key.slice(0, 7);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const list = [...counts.entries()]
      .map(([k, count]) => {
        const [y, mo] = k.split('-');
        return { key: k, year: parseInt(y, 10), month: parseInt(mo, 10), count };
      })
      .sort((a, b) => b.key.localeCompare(a.key));
    cache.months = list;
    return list;
  },

  // {year, month} — explizite User-Wahl, sonst der aktuelle Monat, solange er
  // Einträge hat; sonst der jüngste Monat mit Einträgen bis heute (ein ruhendes
  // Tagebuch öffnet nicht auf einem leeren Raster). «Heute eintragen» springt
  // nach der Anlage selbst in den aktuellen Monat.
  diaryCalendarCurrentMonth() {
    if (this.diaryCalendarYearMonth) return this.diaryCalendarYearMonth;
    // „Heute" in der App-Zeitzone — dieselbe Quelle wie isToday im Grid.
    const todayIso = localIsoDate();
    const now = { year: parseInt(todayIso.slice(0, 4), 10), month: parseInt(todayIso.slice(5, 7), 10) };
    const latest = _computeStartMonth(this.diaryCalendarMonths(), todayIso.slice(0, 7));
    return latest || now;
  },

  // 6x7-Grid, jeweils { date:'YYYY-MM-DD', dayNum, inMonth, hasPage, page, isToday }.
  // Monday als Wochenanfang (Swiss).
  diaryCalendarMonthGrid() {
    const { year, month } = this.diaryCalendarCurrentMonth();
    const first = new Date(Date.UTC(year, month - 1, 1));
    const dayOfWeek = (first.getUTCDay() + 6) % 7;
    const map = this.diaryCalendarPagesMap();
    const todayIso = localIsoDate();
    const editable = !!this.canEdit?.();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const off = i - dayOfWeek;
      const d = new Date(Date.UTC(year, month - 1, 1 + off));
      const ds = d.toISOString().slice(0, 10);
      const page = map.get(ds) || null;
      cells.push({
        date: ds,
        dayNum: d.getUTCDate(),
        inMonth: d.getUTCMonth() === month - 1,
        hasPage: !!page,
        page,
        isToday: ds === todayIso,
        // Leerer Tag bis heute: Klick legt den Eintrag an (Nachtrag).
        canCreate: !page && editable && ds <= todayIso,
      });
    }
    return cells;
  },

  // Monatsname lokalisiert (Februar / February).
  diaryCalendarMonthLabel() {
    const { year, month } = this.diaryCalendarCurrentMonth();
    return this._formatYearMonth(year, month);
  },

  diaryCalendarLabelForMonth(monthEntry) {
    return this._formatYearMonth(monthEntry.year, monthEntry.month);
  },

  // Kalender-Arithmetik läuft in UTC (Date.UTC); formatiert wird darum ebenfalls
  // in UTC — sonst rutscht der Tag westlich von UTC auf den Vortag.
  _formatYearMonth(year, month) {
    const dt = new Date(Date.UTC(year, month - 1, 15));
    return dateTimeFormat(this.$store.shell.uiLocale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(dt);
  },

  // Wochentags-Header lokalisiert (Mo Di Mi … / Mon Tue Wed …).
  diaryCalendarWeekdayLabels() {
    const fmt = dateTimeFormat(this.$store.shell.uiLocale, { weekday: 'short', timeZone: 'UTC' });
    const labels = [];
    // 2024-01-01 ist ein Montag; davon ausgehend 7 Tage.
    for (let i = 0; i < 7; i++) {
      labels.push(fmt.format(new Date(Date.UTC(2024, 0, 1 + i))));
    }
    return labels;
  },

  diaryCalendarStep(delta) {
    const cur = this.diaryCalendarCurrentMonth();
    let m = cur.month + delta;
    let y = cur.year;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    this.diaryCalendarYearMonth = { year: y, month: m };
  },

  // Springt zum Monat mit Schlüssel `YYYY-MM`. Aus Combobox-Auswahl.
  diaryCalendarJumpTo(monthKey) {
    if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return;
    const [y, m] = monthKey.split('-');
    this.diaryCalendarYearMonth = { year: parseInt(y, 10), month: parseInt(m, 10) };
  },

  selectDiaryCalendarDay(cell) {
    if (cell?.page) { this.selectPage(cell.page); return; }
    if (cell?.canCreate) this._createDiaryEntry(cell.date);
  },

  // Heute-Button-Handler. Öffnet bestehenden Eintrag oder legt neuen an.
  createDiaryEntryToday() {
    this._createDiaryEntry(localIsoDate());
  },

  diaryHasTodayEntry() {
    return this.diaryCalendarPagesMap().has(localIsoDate());
  },

  // Lädt Buchsprache (de/en) aus /booksettings, gecacht pro Buch. Default 'de'.
  async _getDiaryBookLanguage(bookId = this.$store.nav.selectedBookId) {
    const cache = _ensureCache(this);
    const id = String(bookId || '');
    if (!id) return 'de';
    if (cache.langByBookId[id]) return cache.langByBookId[id];
    try {
      const data = await fetchJson(`/booksettings/${id}`);
      const lang = data?.language === 'en' ? 'en' : 'de';
      cache.langByBookId[id] = lang;
      return lang;
    } catch {
      return 'de';
    }
  },

  // Liefert Chapter-ID, in die ein neuer Diary-Eintrag für `monthNum` im
  // `year` gehört. Heuristik: Hat das Jahr-Kapitel Sub-Kapitel, die wie Monate
  // aussehen (Name enthält DE/EN-Monatsname ODER position 1-12)?
  // - keine Sub-Kapitel überhaupt → Jahr-Kapitel selbst
  // - Sub-Kapitel existieren, aber keine month-style → Jahr-Kapitel (User
  //   organisiert nach anderem Schema; nicht überschreiben)
  // - month-style Sub-Kapitel vorhanden, gesuchter Monat dabei → matching Sub
  // - month-style Sub-Kapitel vorhanden, Monat fehlt → neu anlegen
  //   (Name "YYYY <Monatsname>" in Buchsprache, position = monthNum)
  async _resolveDiaryEntryChapter(yearChapterId, year, monthNum, bookId) {
    const subs = (this.$store.nav.tree || []).filter(it =>
      it.type === 'chapter'
        && !it.solo
        && String(it.parent_id) === String(yearChapterId)
    );
    if (!subs.length) return yearChapterId;

    const monthOf = (sub) => {
      const byName = _parseMonthName(sub.name);
      if (byName) return byName;
      const p = Number(sub.priority);
      if (Number.isFinite(p) && p >= 1 && p <= 12) return p;
      return null;
    };
    const monthSubs = subs.map(s => ({ sub: s, month: monthOf(s) })).filter(x => x.month);
    if (!monthSubs.length) return yearChapterId;

    const match = monthSubs.find(x => x.month === monthNum);
    if (match) return match.sub.id;

    const lang = await this._getDiaryBookLanguage(bookId);
    _assertDiaryBook(bookId);
    const names = lang === 'en' ? MONTH_NAMES_EN : MONTH_NAMES_DE;
    const subName = `${year} ${names[monthNum - 1]}`;
    const created = await contentRepo.createChapter({
      book_id: parseInt(bookId, 10),
      name: subName,
      parent_chapter_id: yearChapterId,
      position: monthNum,
    });
    if (!created?.id) throw new Error('createChapter (month) returned no id');
    _assertDiaryBook(bookId);
    // Sub-Kapitel-Mutation: granularer Tree-Mirror deckt das nicht zuverlässig
    // ab. wake-Reload behält Selektion + State, erneuert nur Tree/Pages.
    await this.loadPages({ source: 'wake' });
    _assertDiaryBook(bookId);
    return created.id;
  },

  // Sichert Jahr-Kapitel `YYYY` (Name = Jahrzahl, position = Jahrzahl).
  // Pattern stammt aus folder-import (routes/jobs/folder-import.js): ein
  // Top-Level-Kapitel pro Jahr. Liefert Chapter-ID.
  async _ensureDiaryYearChapter(year, bookId) {
    const yearStr = String(year);
    const existing = this.$store.nav.tree.find(
      it => it.type === 'chapter' && !it.solo && it.name === yearStr
    );
    if (existing) return existing.id;
    const created = await contentRepo.createChapter({
      book_id: parseInt(bookId, 10),
      name: yearStr,
      position: parseInt(yearStr, 10),
    });
    if (!created?.id) throw new Error('createChapter returned no id');
    _assertDiaryBook(bookId);
    const chapterItem = {
      type: 'chapter',
      id: created.id,
      name: created.name,
      priority: created.position ?? parseInt(yearStr, 10),
      depth: 1,
      parent_id: null,
      hasChildren: false,
      open: true,
      solo: false,
      pages: [],
    };
    // Jahr-Kapitel sind chronologisch sortiert: hinter das letzte frühere Jahr
    // einfuegen, sonst vor das erste spaetere. Kein globaler priority-Sort —
    // der wuerde Sub-Kapitel aus ihrem Parent reissen (siehe tree/load.js).
    const topLevel = this.$store.nav.tree.filter(
      i => i.type === 'chapter' && !i.solo && (i.depth || 1) === 1);
    const prev = topLevel.filter(i => (i.priority ?? 0) < chapterItem.priority).pop();
    const next = topLevel.find(i => (i.priority ?? 0) > chapterItem.priority);
    this.$store.nav.tree = insertChapterItem(this.$store.nav.tree, chapterItem, {
      afterChapterId: prev?.id ?? null,
      beforeChapterId: next?.id ?? null,
    });
    return created.id;
  },

  // Erstellt Diary-Page mit Name = dateIso (`YYYY-MM-DD`) im passenden
  // Jahr-Kapitel und öffnet sie. Existiert bereits eine Page für dieses
  // Datum, wird sie geöffnet statt dupliziert.
  // Diary-Cache (pagesRef) wird durch Array-Reassignment invalidiert.
  async _createDiaryEntry(dateIso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso || '')) return;
    if (!this.canEdit?.()) return;
    if (this._diaryCreatingDate === dateIso) return;
    const existing = this.diaryCalendarPagesMap().get(dateIso);
    if (existing) { this.selectPage(existing); return; }
    this._diaryCreatingDate = dateIso;
    // Buch-ID EINMAL lesen: die Kette legt bis zu drei Objekte an (Jahr, Monat,
    // Seite). Wechselt der User dazwischen das Buch, darf der Rest weder im
    // neuen Buch landen noch dessen Tree/Pages mutieren → Abbruch.
    const bookId = this.$store.nav.selectedBookId;
    try {
      const year = parseInt(dateIso.slice(0, 4), 10);
      const monthNum = parseInt(dateIso.slice(5, 7), 10);
      const yearChapterId = await this._ensureDiaryYearChapter(year, bookId);
      const chapterId = await this._resolveDiaryEntryChapter(yearChapterId, year, monthNum, bookId);
      const created = await contentRepo.createPage({
        book_id: parseInt(bookId, 10),
        chapter_id: chapterId,
        name: dateIso,
        html: '<p></p>',
      });
      if (!created?.id) throw new Error('createPage returned no id');
      _assertDiaryBook(bookId);
      this.$store.nav.pages = [...this.$store.nav.pages, created];
      const treeCh = this.$store.nav.tree.find(
        it => it.type === 'chapter' && !it.solo && String(it.id) === String(chapterId)
      );
      if (treeCh) {
        treeCh.pages = [...treeCh.pages, created];
        treeCh.open = true;
      }
      // Reassignment statt Index-Assign: der `tokTotals`-Memo haengt an der
      // Identitaet von `tokEsts` (app/app-root-getters.js).
      this.tokEsts = { ...this.tokEsts, [created.id]: { tok: 0, words: 0, chars: 0 } };
      this.diaryCalendarYearMonth = { year, month: monthNum };
      this.openNewSectionForWriting(created);
    } catch (e) {
      if (e instanceof DiaryBookSwitched) return;
      console.error('[_createDiaryEntry]', e);
      this.setStatus(this.t('calendar.createError'));
    } finally {
      this._diaryCreatingDate = null;
    }
  },

  // Sortiert ALLE datierten Diary-Pages chronologisch (älteste zuerst). Zwei
  // Abschnitte am selben Tag stehen beide drin (Reihenfolge wie im Baum) — sonst
  // hätte der zweite keine Vor/Zurück-Navigation. Cache wie pagesMap.
  _diarySortedPages() {
    const cache = _ensureCache(this);
    this.diaryCalendarPagesMap();
    if (cache.sorted) return cache.sorted;
    cache.sorted = _computeSortedEntries(this.$store.nav.pages || []);
    return cache.sorted;
  },

  diaryPrevPage() {
    return this._diaryNeighbor(-1);
  },
  diaryNextPage() {
    return this._diaryNeighbor(1);
  },
  _diaryNeighbor(delta) {
    if (!this.currentPage) return null;
    const sorted = this._diarySortedPages();
    if (!sorted.length) return null;
    const idx = sorted.findIndex(p => p.id === this.currentPage.id);
    if (idx === -1) return null;
    const target = sorted[idx + delta];
    return target || null;
  },
  diaryGo(delta) {
    const target = this._diaryNeighbor(delta);
    if (target) this.selectPage(target);
  },

  // Sidebar-Mode-Toggle. Default ist 'tree' aus app-state; bei tagebuch
  // setzt Tree-Code beim Buchwechsel auf 'calendar' (in tree.js loadPages).
  toggleSidebarMode() {
    this.sidebarMode = this.sidebarMode === 'calendar' ? 'tree' : 'calendar';
  },

  // ── Rückblick „An diesem Tag" + Zeitraum-Suche (KI-frei, rein lesend) ──────

  // Bezugstag = heute als `MM-DD`, TZ-aware (app.timezone), nicht Browser-TZ.
  diaryAnniversaryToday() {
    return localIsoDate().slice(5);
  },

  // [{ key, year, yearsAgo, weekday, preview, page }] absteigend nach Jahr.
  // Cache an pagesRef + Bezugstag gekoppelt (Invalidierung in diaryCalendarPagesMap).
  diaryAnniversaryEntries() {
    const cache = _ensureCache(this);
    const mmdd = this.diaryAnniversaryToday();
    if (cache.pagesRef === this.$store.nav.pages && cache.anniversary && cache.anniversaryKey === mmdd) {
      return cache.anniversary;
    }
    const map = this.diaryCalendarPagesMap();
    const todayYear = parseInt(localIsoDate().slice(0, 4), 10);
    const list = _computeAnniversary(map, mmdd, todayYear).map(e => ({
      ...e,
      weekday: this._diaryWeekdayLabel(e.key),
      preview: e.page?.preview_text || '',
    }));
    cache.anniversary = list;
    cache.anniversaryKey = mmdd;
    return list;
  },

  // [{ key, dateLabel, weekday, preview, page }] absteigend nach Datum.
  // Cache an pagesRef + Von/Bis-Bereich gekoppelt.
  diaryRangeEntries() {
    const cache = _ensureCache(this);
    const ck = `${this.diaryRangeFrom}|${this.diaryRangeTo}`;
    if (cache.pagesRef === this.$store.nav.pages && cache.range && cache.rangeKey === ck) {
      return cache.range;
    }
    const map = this.diaryCalendarPagesMap();
    const list = _computeRange(map, this.diaryRangeFrom, this.diaryRangeTo).map(e => ({
      ...e,
      dateLabel: this._diaryDateLabel(e.key),
      weekday: this._diaryWeekdayLabel(e.key),
      preview: e.page?.preview_text || '',
    }));
    cache.range = list;
    cache.rangeKey = ck;
    return list;
  },

  // Wochentag (lang) eines `YYYY-MM-DD` — Kalendertag-Label (utils/date.js#formatIsoDay).
  _diaryWeekdayLabel(dateIso) {
    return formatIsoDay(dateIso, this.$store.shell.uiLocale, { weekday: 'long' });
  },

  // Volles Datum (z.B. „3. Juni 2025") eines `YYYY-MM-DD`.
  _diaryDateLabel(dateIso) {
    return formatIsoDay(dateIso, this.$store.shell.uiLocale, { day: 'numeric', month: 'long', year: 'numeric' });
  },

  diaryAnniversaryYearsAgoLabel(yearsAgo) {
    return yearsAgo === 1 ? this.t('diary.anniversary.oneYearAgo') : this.t('diary.anniversary.yearsAgo', { n: yearsAgo });
  },

  // Aufklapp-Zustand des „An diesem Tag"-Panels pro Buch (+ User) im
  // localStorage. Default `true` (offen) für Bücher ohne gespeicherte Wahl.
  // `_loadDiaryAnniversaryOpen` ruft tree.js#loadPages bei jedem Buchwechsel.
  _diaryAnniversaryStorageKey(bookId) {
    if (!bookId) return '';
    return `sw:diaryAnniversaryOpen:${this.$store.session.currentUser?.email || ''}:${bookId}`;
  },
  _loadDiaryAnniversaryOpen() {
    try {
      const key = this._diaryAnniversaryStorageKey(this.$store.nav.selectedBookId);
      if (!key) return true;
      const raw = localStorage.getItem(key);
      return raw === null ? true : raw === '1';
    } catch { return true; }
  },
  toggleDiaryAnniversaryOpen() {
    this.diaryAnniversaryOpen = !this.diaryAnniversaryOpen;
    try {
      const key = this._diaryAnniversaryStorageKey(this.$store.nav.selectedBookId);
      if (key) localStorage.setItem(key, this.diaryAnniversaryOpen ? '1' : '0');
    } catch { /* quota / disabled storage — ignore */ }
  },
};
