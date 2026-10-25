import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseDatum } = require('../../lib/datum-parse.js');

test('leerer Input liefert leeres Label', () => {
  assert.deepEqual(parseDatum(null), { label: '' });
  assert.deepEqual(parseDatum(''), { label: '' });
  assert.deepEqual(parseDatum('   '), { label: '' });
});

test('reines Jahr', () => {
  assert.equal(parseDatum('1850').year, 1850);
  assert.equal(parseDatum('1850').label, '1850');
  assert.equal(parseDatum('ca. 1850').year, 1850);
  assert.equal(parseDatum('anno 1850').year, 1850);
});

test('ISO-Datum', () => {
  const r = parseDatum('1850-05-12');
  assert.equal(r.year, 1850);
  assert.equal(r.month, 5);
  assert.equal(r.day, 12);
});

test('ISO ohne Tag', () => {
  const r = parseDatum('1850-05');
  assert.equal(r.year, 1850);
  assert.equal(r.month, 5);
  assert.equal(r.day, undefined);
});

test('DD.MM.YYYY', () => {
  const r = parseDatum('12.03.1850');
  assert.equal(r.day, 12);
  assert.equal(r.month, 3);
  assert.equal(r.year, 1850);
});

test('DD.MM. ohne Jahr', () => {
  const r = parseDatum('12.03.');
  assert.equal(r.day, 12);
  assert.equal(r.month, 3);
  assert.equal(r.year, undefined);
});

test('Monatsname DE: "Mai 1850"', () => {
  const r = parseDatum('Mai 1850');
  assert.equal(r.month, 5);
  assert.equal(r.year, 1850);
  assert.equal(r.day, undefined);
});

test('Monatsname DE mit Tag: "12. März 1850"', () => {
  const r = parseDatum('12. März 1850');
  assert.equal(r.day, 12);
  assert.equal(r.month, 3);
  assert.equal(r.year, 1850);
});

test('Monatsname EN: "May 1850"', () => {
  const r = parseDatum('May 1850');
  assert.equal(r.month, 5);
  assert.equal(r.year, 1850);
});

test('Monatsname EN mit Tag: "May 5, 1850"', () => {
  const r = parseDatum('May 5, 1850');
  assert.equal(r.month, 5);
  assert.equal(r.day, 5);
  assert.equal(r.year, 1850);
});

test('Story-Tag: "Tag 3"', () => {
  const r = parseDatum('Tag 3');
  assert.equal(r.story_tag, 3);
  assert.equal(r.year, undefined);
});

test('Story-Tag EN: "Day 12"', () => {
  const r = parseDatum('Day 12');
  assert.equal(r.story_tag, 12);
});

test('vor Christus: "500 v. Chr."', () => {
  const r = parseDatum('500 v. Chr.');
  assert.equal(r.year, -500);
});

test('vor Christus EN: "300 BCE"', () => {
  const r = parseDatum('300 BCE');
  assert.equal(r.year, -300);
});

test('nur Monat ohne Jahr: "Mai"', () => {
  const r = parseDatum('Mai');
  assert.equal(r.month, 5);
  assert.equal(r.year, undefined);
});

test('nicht parsbar: Freitext bleibt nur Label', () => {
  const r = parseDatum('vor der Reise');
  assert.equal(r.label, 'vor der Reise');
  assert.equal(r.year, undefined);
  assert.equal(r.month, undefined);
  assert.equal(r.day, undefined);
  assert.equal(r.story_tag, undefined);
});

test('Label wird stets erhalten', () => {
  assert.equal(parseDatum('  1850  ').label, '1850');
  assert.equal(parseDatum('Mai 1850').label, 'Mai 1850');
});

test('abgekürzter Monatsname mit Punkt: "Dez. 1849"', () => {
  const r = parseDatum('Dez. 1849');
  assert.equal(r.month, 12);
  assert.equal(r.year, 1849);
});

test('Day-Heuristik wählt keinen Wert >31', () => {
  const r = parseDatum('Mai 1850');
  assert.equal(r.day, undefined);
});

test('Tag aus Vier-stelligem Jahr nicht missdeuten', () => {
  // "1850" darf nicht als Tag 18 oder 50 interpretiert werden
  const r = parseDatum('Juli 1850');
  assert.equal(r.day, undefined);
  assert.equal(r.year, 1850);
  assert.equal(r.month, 7);
});

// ── Spannen, Jahreszeiten, Unsicherheit ─────────────────────────────────────
// Die Zusätze verschieben den Startpunkt nie — alle Konsumenten, die nur
// year/month/day lesen (Zeitstrahl, Geburt, Rückblick), sehen dieselben Werte.

test('Jahres-Spannen in allen Schreibweisen', () => {
  for (const s of ['1987–1989', '1987 - 1989', '1987-89', 'von 1987 bis 1989', 'zwischen 1987 und 1989']) {
    const r = parseDatum(s);
    assert.equal(r.year, 1987, s);
    assert.equal(r.ende_year, 1989, s);
  }
});

test('ISO YYYY-MM bleibt Monat, nicht Spanne', () => {
  const r = parseDatum('1987-11');
  assert.equal(r.month, 11);
  assert.equal(r.ende_year, undefined);
});

test('Monats- und Tages-Spannen erben Jahr und Monat von rechts', () => {
  const m = parseDatum('März–Mai 1987');
  assert.deepEqual([m.year, m.month, m.ende_year, m.ende_month], [1987, 3, 1987, 5]);
  const d = parseDatum('12.–15. März 1987');
  assert.deepEqual([d.year, d.month, d.day, d.ende_month, d.ende_day], [1987, 3, 12, 3, 15]);
});

test('Winter 1944/45, Jahrzehnt, Story-Tag-Spanne', () => {
  const w = parseDatum('Winter 1944/45');
  assert.deepEqual([w.year, w.ende_year, w.season], [1944, 1945, 'winter']);
  const j = parseDatum('1980er Jahre');
  assert.deepEqual([j.year, j.ende_year], [1980, 1989]);
  const t = parseDatum('Tag 3–5');
  assert.deepEqual([t.story_tag, t.story_tag_ende], [3, 5]);
});

test('Text nach einem Bindestrich ist keine Spanne', () => {
  assert.deepEqual(parseDatum('1987 - Hochzeit'), { label: '1987 - Hochzeit', year: 1987 });
  assert.equal(parseDatum('Tag 3 - Ankunft').story_tag, 3);
  assert.equal(parseDatum('1989–1987').ende_year, undefined, 'rueckwaerts ist keine Spanne');
});

test('Jahreszeit und Teil verschieben den Startpunkt nicht', () => {
  const s = parseDatum('Sommer 1987');
  assert.deepEqual([s.year, s.month, s.season], [1987, undefined, 'sommer']);
  const sp = parseDatum('Spätherbst 1850');
  assert.deepEqual([sp.season, sp.part], ['herbst', 'ende']);
  assert.equal(parseDatum('Frühjahr 1850').season, 'fruehling');
  const a = parseDatum('Anfang März 1987');
  assert.deepEqual([a.month, a.part], [3, 'anfang']);
  assert.equal(parseDatum('Ende 1987').part, 'ende');
});

test('unsicher bei um/ca./etwa', () => {
  assert.equal(parseDatum('um 1900').unsicher, true);
  assert.equal(parseDatum('ca. 1850').unsicher, true);
  assert.equal(parseDatum('1850').unsicher, undefined);
});

test('n. Chr. ist positiv, auch ohne Punkte', () => {
  assert.equal(parseDatum('312 n. Chr.').year, 312);
  assert.equal(parseDatum('312 n Chr').year, 312);
});
