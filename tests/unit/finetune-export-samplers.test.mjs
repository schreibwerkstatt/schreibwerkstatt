// Unit: Finetune-Export — Dialog-Erkennung, Typ-Balance, Holdout-Zuordnung der
// Zitat-Samples und Korrektur-Quelle.
//
// Jede dieser Stellen ist still kaputtgegangen, ohne dass ein Export
// fehlschlug: die Dialog-Regexes fanden kein typografisches Zitat mehr, die
// Typ-Balance hielt ihren Anteil nicht, Zitat-Samples ohne Kapitel-`sourceKey`
// leckten Val-Text ins Training, und abgelehnte KI-Vorschläge landeten als
// Autor-Prosa im Datensatz.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('ft-samplers');
const schema = require('../../db/schema');
const db = schema.db;
const { extractDialogs } = require('../../routes/jobs/finetune-export/lib/text.js');
const { balanceCap } = require('../../routes/jobs/finetune-export/finalize.js');
const { buildDialogSamples } = require('../../routes/jobs/finetune-export/samples/dialog.js');
const { buildFigureMetaSamples } = require('../../routes/jobs/finetune-export/samples/author-chat/figures.js');
const { collectAppliedCorrections } = require('../../routes/jobs/finetune-export/samples/correction.js');

test('extractDialogs: alle fünf Schreibweisen, jedes Zitat genau einmal', () => {
  const cases = [
    '„Ich komme morgen wieder“, sagte Anna. „Und du bleibst hier“, rief Ben.',
    '»Ich komme morgen wieder«, sagte Anna. »Und du bleibst hier«, rief Ben.',
    '«Ich komme morgen wieder», sagte Anna. «Und du bleibst hier», rief Ben.',
    '“Ich komme morgen wieder”, sagte Anna. “Und du bleibst hier”, rief Ben.',
    '"Ich komme morgen wieder", sagte Anna. "Und du bleibst hier", rief Ben.',
  ];
  for (const text of cases) {
    const quotes = extractDialogs(text).map(d => d.quote);
    assert.deepEqual(quotes, ['Ich komme morgen wieder', 'Und du bleibst hier'], text);
  }
});

test('balanceCap: kein Typ stellt nach dem Kappen mehr als den Anteil', () => {
  for (const [counts, share] of [[[900, 100, 200], 0.4], [[900, 100, 200, 300], 0.4], [[5000, 40, 40, 900], 0.5]]) {
    const cap = balanceCap(counts, share);
    assert.ok(cap > 0, `${counts} @ ${share} erfüllbar`);
    const kept = counts.reduce((a, n) => a + Math.min(n, cap), 0);
    assert.ok(cap <= share * kept, `${counts}: Cap ${cap} > ${share} × ${kept}`);
    // Grösster solcher Cap: einer mehr verletzt die Bedingung.
    const keptPlus = counts.reduce((a, n) => a + Math.min(n, cap + 1), 0);
    assert.ok(cap + 1 > share * keptPlus || Math.max(...counts) <= cap);
  }
  assert.equal(balanceCap([500, 500], 0.4), 0, 'zwei Typen können nicht beide ≤ 40 % sein');
});

function dialogCtx() {
  const page = (id, chapterId, chapter, text) => ({ id, chapter_id: chapterId, chapter, title: 'S' + id, text });
  return {
    samples: [], counts: { dialog: 0 }, langIsEn: false, unifiedSys: 'SYS', bookName: 'Buch',
    opts: { types: { dialog: true }, valSeed: 0, biasBoost: 1 },
    figRows: [{ fig_id: 'fig_a', name: 'Anna' }],
    figNamesSorted: ['Anna'],
    dialogsByFigure: new Map(),
    pageContents: [
      page(1, 11, 'Eins', '»Ich gehe jetzt nach Hause«, sagte Anna. »Morgen komme ich wieder«, sagte Anna.'),
      page(2, 12, 'Zwei', '»Das Wetter ist heute schlecht«, sagte Anna. »Wir bleiben lieber drinnen«, sagte Anna.'),
    ],
  };
}

test('Zitat-Samples tragen den sourceKey ihres Kapitels', () => {
  const ctx = dialogCtx();
  buildDialogSamples(ctx);
  const rev = ctx.samples.filter(s => s.id.startsWith('dialogRev|'));
  assert.equal(rev.length, 4);
  for (const s of rev) {
    const quote = s.messages[1].content;
    const expected = /Hause|Morgen/.test(quote) ? 'ch:11' : 'ch:12';
    assert.equal(s.sourceKey, expected, quote);
  }

  const voice = [];
  buildFigureMetaSamples({
    langIsEn: false, figRows: ctx.figRows, eventsByFigPk: new Map(), appearancesByFigPk: new Map(),
    dialogsByFigure: ctx.dialogsByFigure,
    pushQA: (id, q, a, sourceKey) => voice.push({ id, q, a, sourceKey }),
  });
  const figVoice = voice.filter(s => s.id.startsWith('authorChat|figVoice|'));
  assert.deepEqual(figVoice.map(s => s.sourceKey).sort(), ['ch:11', 'ch:12']);
  assert.equal(new Set(figVoice.map(s => s.q)).size, figVoice.length, 'keine identische Frage mit verschiedenen Antworten');
  assert.match(figVoice[0].a, /^„.+“/);
});

test('Korrekturen: nur übernommene Befunde, nicht jeder KI-Vorschlag', () => {
  const BOOK = 731;
  const USER = 'ftcorr@test.dev';
  db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(USER);
  schema.upsertBookByName(BOOK, 'Finetune-Korrektur');
  const accepted = { original: 'Er ging langsam nachhause.', korrektur: 'Er ging langsam nach Hause.', erklaerung: 'Getrenntschreibung.' };
  const rejected = { original: 'Sie lachte laut und herzlich.', korrektur: 'Sie lachte schallend.' };
  db.prepare('INSERT OR IGNORE INTO pages (page_id, book_id, page_name) VALUES (?, ?, ?)').run(7310, BOOK, 'S1');
  db.prepare(`INSERT INTO page_checks (page_id, book_id, user_email, checked_at, error_count, errors_json, applied_errors_json)
              VALUES (7310, ?, ?, '2026-01-01T00:00:00.000Z', 2, ?, ?)`)
    .run(BOOK, USER, JSON.stringify([accepted, rejected]), JSON.stringify([accepted]));
  const out = collectAppliedCorrections(BOOK, USER, 4000);
  assert.deepEqual(out.map(c => c.korr), ['Er ging langsam nach Hause.']);
});
