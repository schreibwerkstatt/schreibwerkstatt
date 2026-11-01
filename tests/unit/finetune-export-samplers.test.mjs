// Unit: Finetune-Export — Dialog-Erkennung, Typ-Balance und Holdout-Zuordnung
// der Zitat-Samples.
//
// Jede dieser Stellen ist still kaputtgegangen, ohne dass ein Export
// fehlschlug: die Dialog-Regexes fanden kein typografisches Zitat mehr, die
// Typ-Balance hielt ihren Anteil nicht, und Zitat-Samples ohne Kapitel-
// `sourceKey` leckten Val-Text ins Training.
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
      page(1, 11, 'Eins', '»Ich gehe jetzt nach Hause zu meiner Mutter«, sagte Anna. »Morgen komme ich mit dem ersten Zug wieder«, sagte Anna. »Ich weiss nicht.« Anna zuckte mit den Schultern.'),
      page(2, 12, 'Zwei', '»Das Wetter ist heute schlecht in dieser Stadt«, sagte Anna. »Wir bleiben lieber drinnen am warmen Ofen«, sagte Anna. »Ich gehe jetzt nach Hause zu meiner Mutter«, sagte Anna.'),
    ],
  };
}

test('Zitat-Samples tragen den sourceKey ihres Kapitels; «Wer sagt das» nur für eindeutige Zitate', () => {
  const ctx = dialogCtx();
  buildDialogSamples(ctx);
  const rev = ctx.samples.filter(s => s.id.startsWith('dialogRev|'));
  // Kurz/generisch («Ich weiss nicht.») und doppelt im Buch («nach Hause») fallen weg;
  // ohne Szene nennt die Antwort das Kapitel, und jede Antwort steht nur einmal.
  assert.equal(rev.length, 2);
  assert.equal(new Set(rev.map(s => s.messages[2].content)).size, rev.length);
  for (const s of rev) assert.doesNotMatch(s.messages[1].content, /weiss nicht|nach Hause/);
  for (const s of rev) {
    const quote = s.messages[1].content;
    const expected = /Hause|Morgen/.test(quote) ? 'ch:11' : 'ch:12';
    assert.equal(s.sourceKey, expected, quote);
  }

  const voice = [];
  buildFigureMetaSamples({
    langIsEn: false, figRows: ctx.figRows, eventsByFigPk: new Map(), appearancesByFigPk: new Map(),
    dialogsByFigure: ctx.dialogsByFigure,
    pushQA: (id, q, a, o) => voice.push({ id, q, a, sourceKey: o && typeof o === 'object' ? o.sourceKey : o }),
  });
  const figVoice = voice.filter(s => s.id.startsWith('authorChat|figVoice|'));
  assert.deepEqual(figVoice.map(s => s.sourceKey).sort(), ['ch:11', 'ch:12']);
  assert.equal(new Set(figVoice.map(s => s.q)).size, figVoice.length, 'keine identische Frage mit verschiedenen Antworten');
  assert.match(figVoice[0].a, /^„.+“/);
});
