// Diary-Kalender: Tagesdatum aus dem Abschnittsnamen (diary-date.js), Startmonat
// ohne User-Wahl, chronologische Navigation auch bei zwei Einträgen am selben Tag
// und Nachtragen auf leeren Tagen bis heute.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { diaryDayKey } = await import('../../public/js/book/diary-date.js');
const {
  diaryCalendarMethods, _computeStartMonth, _computeSortedEntries,
} = await import('../../public/js/book/diary-calendar.js');

test('diaryDayKey: nur tagesgenaue ISO-Namen, Thema dahinter erlaubt', () => {
  assert.equal(diaryDayKey('2024-03-05'), '2024-03-05');
  assert.equal(diaryDayKey('2024-03-05 Hochzeit'), '2024-03-05');
  assert.equal(diaryDayKey('2024-03 Thema'), null);
  assert.equal(diaryDayKey('2024-13-01'), null);
  assert.equal(diaryDayKey('Notizen'), null);
  assert.equal(diaryDayKey(null), null);
});

test('_computeStartMonth: jüngster Monat bis heute, Zukunft übersprungen', () => {
  const months = [
    { key: '2026-12', year: 2026, month: 12 },
    { key: '2026-09', year: 2026, month: 9 },
    { key: '2025-01', year: 2025, month: 1 },
  ];
  assert.deepEqual(_computeStartMonth(months, '2026-10'), { year: 2026, month: 9 });
  assert.deepEqual(_computeStartMonth(months, '2026-12'), { year: 2026, month: 12 });
  assert.equal(_computeStartMonth([], '2026-10'), null);
});

test('_computeSortedEntries: chronologisch, gleicher Tag in Baumreihenfolge', () => {
  const pages = [
    { id: 3, name: '2024-03-05 Abend' },
    { id: 1, name: '2024-01-01' },
    { id: 9, name: 'Vorwort' },
    { id: 2, name: '2024-03-05 Morgen' },
  ];
  assert.deepEqual(_computeSortedEntries(pages).map(p => p.id), [1, 3, 2]);
});

function ctx(pages, currentId, { canEdit = true } = {}) {
  const created = [];
  const c = {
    ...diaryCalendarMethods,
    $store: { nav: { pages }, shell: { uiLocale: 'de' } },
    currentPage: pages.find(p => p.id === currentId) || null,
    canEdit: () => canEdit,
    selectPage(p) { c.selected = p; },
    _createDiaryEntry(date) { created.push(date); },
  };
  c.created = created;
  return c;
}

test('Navigation: zweiter Eintrag am selben Tag hat Vor/Zurück', () => {
  const pages = [
    { id: 1, name: '2024-01-01' },
    { id: 3, name: '2024-03-05 Abend' },
    { id: 2, name: '2024-03-05 Morgen' },
    { id: 4, name: '2024-04-01' },
  ];
  const c = ctx(pages, 2);
  assert.equal(c.diaryPrevPage()?.id, 3);
  assert.equal(c.diaryNextPage()?.id, 4);
  // Kalender zeigt pro Tag weiterhin den ersten Eintrag.
  assert.equal(c.diaryCalendarPagesMap().get('2024-03-05').id, 3);
});

test('Klick auf leeren Tag: bis heute anlegen, Zukunft und Leserecht nicht', () => {
  const c = ctx([{ id: 1, name: '2020-01-01' }], null);
  c.selectDiaryCalendarDay({ date: '2020-01-02', page: null, canCreate: true });
  assert.deepEqual(c.created, ['2020-01-02']);
  c.selectDiaryCalendarDay({ date: '2999-01-01', page: null, canCreate: false });
  assert.deepEqual(c.created, ['2020-01-02']);

  const grid = c.diaryCalendarMonthGrid.call({ ...c, diaryCalendarYearMonth: { year: 2020, month: 1 } });
  const day2 = grid.find(cell => cell.date === '2020-01-02');
  assert.equal(day2.canCreate, true);
  assert.equal(grid.find(cell => cell.date === '2020-01-01').canCreate, false, 'Tag mit Eintrag');

  const ro = ctx([], null, { canEdit: false });
  const roGrid = ro.diaryCalendarMonthGrid.call({ ...ro, diaryCalendarYearMonth: { year: 2020, month: 1 } });
  assert.ok(roGrid.every(cell => !cell.canCreate), 'ohne Schreibrecht nichts anlegbar');
});
