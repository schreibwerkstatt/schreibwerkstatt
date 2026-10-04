'use strict';
// Erzählprofil: Speichern nur kapitel-zugeordneter Einträge, Kapitel-Schwelle des
// Buch-Befunds und die KI-Eingabe ohne nicht berechnete Abschnitte.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('erzaehlprofil-befund-gate');
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const { saveChapterNarrativeProfiles, getChapterNarrativeProfile } = require('../../db/narrative-profiles');
const { getNarrativeReport, saveAutorenBefund, getAutorenBefund } = require('../../db/narrative-report');
const { NARRATIVE_REPORT_THRESHOLDS } = require('../../lib/narrative-report');
const { _computedOnly } = require('../../routes/jobs/komplett/phases/erzaehlprofil');

const USER = 'autor@x.ch';
const NOW = new Date().toISOString();
let seq = 0;

function newBook(nChapters) {
  const bookId = 8000 + (++seq);
  db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'A');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'Buch ' + bookId, NOW, NOW, USER);
  const chNameToId = {};
  for (let i = 0; i < nChapters; i++) {
    const id = bookId * 100 + i;
    db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, bookId, `Kap ${i + 1}`, i, NOW);
    chNameToId[`Kap ${i + 1}`] = id;
  }
  return { bookId, chNameToId };
}

test('Speichern: Einträge ohne Kapitel (Vorwort, verschriebener Name) werden verworfen', () => {
  const { bookId, chNameToId } = newBook(2);
  const saved = saveChapterNarrativeProfiles(bookId, USER, [
    { kapitel: 'Kap 1', perspektive: 'ich' },
    { kapitel: 'Sonstige Seiten', perspektive: 'ich' },
    { kapitel: 'Kap  2 (falsch)', perspektive: 'ich' },
    { kapitel: 'egal', chapter_id: chNameToId['Kap 2'], perspektive: 'du' },
    { kapitel: 'Kap 1', perspektive: 'wir' }, // Dublette
  ], chNameToId, {});
  assert.equal(saved, 2);
  const p = getChapterNarrativeProfile(bookId, USER);
  assert.deepEqual(p.chapters.map(c => [c.kapitel, c.perspektive]), [['Kap 1', 'ich'], ['Kap 2', 'du']]);
});

test('Lesen: Alt-Zeilen ohne chapter_id zählen nicht zur Kapitel-Achse', () => {
  const { bookId, chNameToId } = newBook(1);
  saveChapterNarrativeProfiles(bookId, USER, [{ kapitel: 'Kap 1', perspektive: 'ich' }], chNameToId, {});
  db.prepare('INSERT INTO chapter_narrative_profile (book_id, user_email, chapter_id, sort_order) VALUES (?, ?, NULL, 1)').run(bookId, USER);
  assert.equal(getChapterNarrativeProfile(bookId, USER).chapters.length, 1);
  assert.equal(getNarrativeReport(bookId, USER).chapterCount, 1);
});

test('Befund erst ab MIN_CHAPTERS_FOR_REPORT Kapiteln', () => {
  const min = NARRATIVE_REPORT_THRESHOLDS.MIN_CHAPTERS_FOR_REPORT;
  const few = newBook(min - 1);
  saveChapterNarrativeProfiles(few.bookId, USER, Object.keys(few.chNameToId).map(k => ({ kapitel: k })), few.chNameToId, {});
  assert.deepEqual(getNarrativeReport(few.bookId, USER), { tooFewChapters: true, chapterCount: min - 1, minChapters: min });

  const many = newBook(min);
  saveChapterNarrativeProfiles(many.bookId, USER, Object.keys(many.chNameToId).map(k => ({ kapitel: k })), many.chNameToId, {});
  const r = getNarrativeReport(many.bookId, USER);
  assert.equal(r.tooFewChapters, undefined);
  assert.equal(r.chapterCount, min);
});

test('Autoren-Befund: Speichern und Lesen', () => {
  const { bookId } = newBook(1);
  saveAutorenBefund(bookId, USER, { zusammenfassung: 'z', befunde: [] });
  assert.equal(getAutorenBefund(bookId, USER).zusammenfassung, 'z');
});

test('_computedOnly: nicht berechnete Abschnitte fehlen, berechnete leere bleiben', () => {
  const out = _computedOnly({
    chapterCount: 12,
    computed: { encounters: false, spans: false, eventDeserts: true },
    encounters: [], droppedMotifs: [], eventDeserts: [],
    locations: { oneOff: [{ name: 'X' }], abandoned: [] },
    pacing: { sags: [] },
  });
  assert.ok(!('encounters' in out));
  assert.ok(!('droppedMotifs' in out));
  assert.ok(!('computed' in out));
  assert.deepEqual(out.eventDeserts, []);
  assert.deepEqual(out.locations, { oneOff: [{ name: 'X' }] });
  assert.ok('pacing' in out);
});
