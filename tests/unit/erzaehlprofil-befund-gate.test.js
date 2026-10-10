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

// ── Buchreihenfolge, Teil-Ausfälle, Autoren-Befund-Fehler ─────────────────────────
test('Speichern: sort_order folgt der Buchreihenfolge, nicht der Antwort-Reihenfolge', () => {
  const { bookId, chNameToId } = newBook(3);
  const order = ['Kap 1', 'Kap 2', 'Kap 3'].map(k => chNameToId[k]);
  saveChapterNarrativeProfiles(bookId, USER, [
    { kapitel: 'Kap 3', perspektive: 'ich' }, { kapitel: 'Kap 1', perspektive: 'er' }, { kapitel: 'Kap 2', perspektive: 'du' },
  ], chNameToId, {}, { chapterOrder: order });
  assert.deepEqual(getChapterNarrativeProfile(bookId, USER).chapters.map(c => c.kapitel), ['Kap 1', 'Kap 2', 'Kap 3']);
  // Ohne explizite Reihenfolge: Kapitel-position
  const b = newBook(3);
  saveChapterNarrativeProfiles(b.bookId, USER, [{ kapitel: 'Kap 2' }, { kapitel: 'Kap 1' }], b.chNameToId, {});
  assert.deepEqual(getChapterNarrativeProfile(b.bookId, USER).chapters.map(c => c.kapitel), ['Kap 1', 'Kap 2']);
});

test('Speichern: keepChapterIds behält das alte Profil gescheiterter Kapitel', () => {
  const { bookId, chNameToId } = newBook(3);
  const order = ['Kap 1', 'Kap 2', 'Kap 3'].map(k => chNameToId[k]);
  saveChapterNarrativeProfiles(bookId, USER, ['Kap 1', 'Kap 2', 'Kap 3'].map(k => ({ kapitel: k, perspektive: 'alt' })),
    chNameToId, {}, { chapterOrder: order });
  saveChapterNarrativeProfiles(bookId, USER, [{ kapitel: 'Kap 3', perspektive: 'neu' }, { kapitel: 'Kap 1', perspektive: 'neu' }],
    chNameToId, {}, { chapterOrder: order, keepChapterIds: [chNameToId['Kap 2']] });
  assert.deepEqual(getChapterNarrativeProfile(bookId, USER).chapters.map(c => [c.kapitel, c.perspektive]),
    [['Kap 1', 'neu'], ['Kap 2', 'alt'], ['Kap 3', 'neu']]);
});

test('Phase: gescheiterte Kapitel → Warnung + alter Stand; Autoren-Befund-Fehler → Warnung + alter Befund weg', async () => {
  const { runErzaehlprofil } = require('../../routes/jobs/komplett/phases/erzaehlprofil');
  const min = NARRATIVE_REPORT_THRESHOLDS.MIN_CHAPTERS_FOR_REPORT;
  const { bookId, chNameToId } = newBook(min);
  const names = Object.keys(chNameToId);
  const order = names.map(k => chNameToId[k]);
  saveChapterNarrativeProfiles(bookId, USER, names.map(k => ({ kapitel: k, perspektive: 'alt' })), chNameToId, {}, { chapterOrder: order });
  saveAutorenBefund(bookId, USER, { zusammenfassung: 'alter Befund', befunde: [] });

  const groups = new Map(names.map(k => [String(chNameToId[k]), { name: k, pages: [{ title: 'S', text: 'Text' }] }]));
  const warnings = [];
  const ctx = {
    jobId: 'none', bookIdInt: bookId, bookName: 'B', email: USER, tok: {}, effectiveProvider: 'claude',
    log: { info() {}, warn() {} }, singlePassLimit: 0, totalChars: 10, fullBookText: '', pageContents: [],
    groups, groupOrder: [...groups.keys()], idMaps: { chNameToId }, sys: {}, warnings,
    prompts: {
      buildErzaehlprofilChapterPrompt: (_b, chName) => chName,
      buildAutorenBefundPrompt: () => 'befund',
      SCHEMA_ERZAEHLPROFIL_CHAPTER: {}, SCHEMA_AUTOREN_BEFUND: {},
    },
    call: async (_j, _t, prompt) => {
      if (prompt === 'Kap 2') throw new Error('kaputt');
      if (prompt === 'befund') throw new Error('Befund kaputt');
      return { perspektive: 'neu', themen: [] };
    },
  };
  const saved = await runErzaehlprofil(ctx, {});
  assert.equal(saved, min - 1);
  const chapters = getChapterNarrativeProfile(bookId, USER).chapters;
  assert.equal(chapters.length, min, 'gescheitertes Kapitel bleibt mit altem Profil stehen');
  assert.equal(chapters[1].kapitel, 'Kap 2');
  assert.equal(chapters[1].perspektive, 'alt');
  assert.equal(chapters[0].perspektive, 'neu');
  assert.deepEqual(warnings.map(w => w.key), ['job.warn.narrativeProfileChaptersSkipped', 'job.warn.autorenBefundFailed']);
  assert.equal(warnings[0].params.chapters, 'Kap 2');
  assert.equal(getAutorenBefund(bookId, USER), null, 'alter Autoren-Befund steht nicht neben dem neuen Profil');
});
