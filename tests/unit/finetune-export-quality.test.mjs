// Unit: Finetune-Export — Qualität des Sets (docs/finetuning.md#qualität-des-sets).
//
// Antwort-Budget, Mischung nach Antwort-Tokens, keine Faktenkarte als Erzählziel, Train/Val-
// Split nach Einheiten ohne Überlappung, Satzgrenzen bei Ordnungszahlen,
// Anzeigenamen statt Kennungen, keine Kreuzprodukte im Ereignis-Sampler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { finalizeFinetuneSamples } = require('../../routes/jobs/finetune-export/finalize.js');
const { looksLikeCard, taskOf } = require('../../routes/jobs/finetune-export/lib/tasks.js');
const { splitByUnits, valOverlap } = require('../../routes/jobs/finetune-export/lib/split.js');
const { splitSentences } = require('../../routes/jobs/finetune-export/lib/text.js');
const { slugDisplayName, extractName } = require('../../routes/jobs/finetune-export/lib/names.js');
const { buildEventSamples } = require('../../routes/jobs/finetune-export/samples/author-chat/events.js');

const VOCAB = ('haus wald licht regen brief tür stimme feld hund kirche zug brücke fenster abend '
  + 'mutter lehrer garten strasse uhr spiegel messer dorf schnee wind hafen stein tisch lampe '
  + 'fluss wolke schule markt turm mantel karte schritt glocke vogel acker keller').split(' ');
// Abschnittstext ohne gemeinsame 8-Wort-Folgen mit anderen Abschnitten.
const pageText = (seed, n = 80) => {
  let x = seed * 7919 + 17;
  const w = [];
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    w.push(VOCAB[(x >>> 16) % VOCAB.length]);
    if (i % 10 === 9) w[w.length - 1] += '.';
  }
  return w.join(' ');
};

const sample = (id, user, answer, extra = {}) => ({
  id, type: extra.type || 'authorChat', ...extra,
  messages: [{ role: 'system', content: 'S' }, { role: 'user', content: user }, { role: 'assistant', content: answer }],
});
const finalize = (samples, opts = {}, pageContents = []) => finalizeFinetuneSamples({
  samples, langIsEn: false, pageContents,
  opts: { valSplit: 0, valSeed: 0, maxSeqTokens: 0, emitText: false, truncateLong: false, ...opts },
});
const rows = (jsonl) => jsonl.trim().split('\n').filter(Boolean).map(l => JSON.parse(l).messages);

test('Antwort-Budget: jede Antwort höchstens maxPerAnswer-mal, verschiedene Fragen bleiben', () => {
  const card = 'Rauferei am Schulfest. Zeitpunkt: Sommer 1998. Beteiligte Figuren: Dennis, Rolf.';
  const samples = [];
  for (let i = 0; i < 93; i++) samples.push(sample(`authorChat|evtsByFigLoc|${i}`, `Frage Nummer ${i} zum Ereignis?`, card));
  samples.push(sample('authorChat|evt-sig|1', 'Welche Bedeutung hat die Rauferei?', 'Sie zeigt, wie Dennis die Kontrolle verliert.'));
  const r = finalize(samples, { maxPerAnswer: 2 });
  const answers = rows(r.trainJsonl).map(m => m[2].content);
  assert.equal(answers.filter(a => a === card).length, 2);
  assert.ok(answers.includes('Sie zeigt, wie Dennis die Kontrolle verliert.'));
  assert.equal(r.stats.answerCapped, 91);
  assert.equal(r.stats.quality.repeated3Share, 0);
  // 0 = aus
  assert.equal(finalize(samples, { maxPerAnswer: 0 }).stats.total, 94);
});

test('Antwort-Budget zählt jeden Assistant-Turn eines Gesprächs', () => {
  const conv = {
    id: 'reader|conv|fig:a|0', type: 'reader',
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Wer ist Anna?' }, { role: 'assistant', content: 'Anna ist die Wirtin im Dorf.' },
      { role: 'user', content: 'Und sonst?' }, { role: 'assistant', content: 'Sie kennt jeden Gast beim Namen.' }],
  };
  const singles = [1, 2, 3].map(i => sample('authorChat|fig|a|' + i, `Erzähl von Anna, Variante ${i}.`, 'Anna ist die Wirtin im Dorf.'));
  const r = finalize([conv, ...singles], { maxPerAnswer: 2 });
  const all = rows(r.trainJsonl).flatMap(m => m.filter(x => x.role === 'assistant').map(x => x.content));
  assert.equal(all.filter(a => a === 'Anna ist die Wirtin im Dorf.').length, 2);
});

test('Mischung nach Antwort-Tokens: writing ↔ facts im Zielverhältnis, Kernfakten bleiben', () => {
  const samples = [];
  const long = (i) => `Fortsetzung Nummer ${i} des Absatzes im Buch. `.repeat(8);
  for (let i = 0; i < 60; i++) samples.push(sample(`style|${i}`, `Setze fort ${i}`, long(i), { type: 'style' }));
  for (let i = 0; i < 40; i++) samples.push(sample(`authorChat|evt|${i}|0`, `Ereignis ${i}?`, `Antwort zum Ereignis Nummer ${i}.`, { unit: 'evt:' + i }));
  for (let i = 0; i < 5; i++) samples.push(sample(`core|fig:${i}:core|0`, `Wer ist F${i}?`, `F${i} ist eine Hauptfigur der Geschichte.`, { type: 'core', task: 'figureCore', core: true, unit: 'fig:' + i }));
  const r = finalize(samples, { familyTokenShares: { writing: 0.55, facts: 0.30, persona: 0.10, refusal: 0.05 } });
  const q = r.stats.quality;
  // Prosa überwiegt die Fakten nach Tokens weit → Schreibaufgaben werden gekürzt.
  assert.ok(r.stats.mixDropped.writing > 0);
  const ratio = q.writingTokenShare / q.factTokenShare;
  assert.ok(ratio <= 0.55 / 0.30 + 0.05, String(ratio));
  assert.ok(ratio >= 0.55 / 0.30 - 0.5, String(ratio));
  assert.equal(q.tasks.find(t => t.task === 'figureCore')?.count, 5, 'Kernfakten werden nie gekürzt');
  assert.ok(q.tasks.every(t => typeof t.answerTokens === 'number' && t.tokenShare >= 0));
});

test('Keine Faktenkarte als Erzählziel', () => {
  assert.ok(looksLikeCard('Geburt von Stefan. Zeitpunkt: 1968. Art: persoenlich. Beteiligte Figuren: Stefan, Gisela.'));
  assert.ok(!looksLikeCard('Stefan wurde im Winter geboren. Die Mutter sagte: «Er schreit wie sein Vater.»'));
  const prose = 'Dennis stand am Rand des Schulhofs. Die anderen drängten sich um den Stand, und er wartete, bis Rolf kam.';
  const card = 'Rauferei am Schulfest. Zeitpunkt: Juni 1998. Art: persönlich. Beteiligte Figuren: Dennis, Rolf.';
  const r = finalize([
    sample('authorChat|evtTextFig|1|dennis', 'Erzähle «Rauferei» aus der Sicht von Dennis.', card),
    sample('authorChat|scenePov|2|Rolf', 'Erzähle die Szene «Schulfest» aus der Sicht von Rolf.', prose),
  ]);
  const out = rows(r.trainJsonl);
  assert.equal(out.length, 1);
  assert.equal(out[0][2].content, prose);
  assert.equal(r.stats.cardDropped, 1);
  assert.equal(taskOf({ id: 'authorChat|evtTextFig|1|x' }), 'povPassage');
});

test('Split nach Einheiten: Abschnitte und Entitäten getrennt, gemischte Samples fallen weg, keine Überlappung', () => {
  const pageContents = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, chapter_id: 1, text: pageText(i + 1) }));
  const samples = [];
  for (const p of pageContents) {
    const half = p.text.slice(0, p.text.indexOf('.', 200) + 1);
    samples.push(sample('style|' + p.id, 'Setze fort:\n\n' + half, p.text.slice(half.length).trim(), { type: 'style' }));
    samples.push(sample('verbPage|' + p.id, 'Gib den Abschnitt wörtlich wieder:', p.text, { type: 'verbatim' }));
  }
  // Über zwei Abschnitte: landet nur, wenn beide im selben Split liegen.
  for (let i = 0; i + 1 < pageContents.length; i++) {
    samples.push(sample('chapWin|1|' + i, 'Setze fort:\n\n' + pageContents[i].text, pageContents[i + 1].text, { type: 'style' }));
  }
  for (let i = 0; i < 40; i++) {
    samples.push(sample(`authorChat|evt|${i}|0`, `Erzähl mir von Ereignis ${i}.`, `Ereignis ${i} verändert alles für die Familie Nummer ${i}.`, { unit: 'evt:' + i }));
    samples.push(sample(`authorChat|evt-sig|${i}`, `Welche Bedeutung hat Ereignis ${i}?`, `Ereignis ${i} ist der Wendepunkt in Kapitel Nummer ${i}.`, { unit: 'evt:' + i }));
  }
  samples.push(sample('authorChat|evtChrono', 'Liste die Ereignisse.', 'Ereignis 1, Ereignis 2, Ereignis 3 und alle weiteren Ereignisse.'));

  const entries = samples.map(s => ({ s }));
  const parts = splitByUnits(entries, { pageContents, opts: { valSplit: 0.1, valSeed: 0 } });
  const valIds = new Set(parts.val.map(e => e.s.id));
  // Beide Ableitungen eines Abschnitts im selben Split, alle Fragen eines Ereignisses auch.
  for (const p of pageContents) assert.equal(valIds.has('style|' + p.id), valIds.has('verbPage|' + p.id));
  for (let i = 0; i < 40; i++) assert.equal(valIds.has(`authorChat|evt|${i}|0`), valIds.has(`authorChat|evt-sig|${i}`));
  assert.ok(!valIds.has('authorChat|evtChrono'), 'Sammelliste nur Train');
  assert.ok(parts.mixed.length > 0 && parts.mixed.every(e => e.s.id.startsWith('chapWin|')));
  assert.equal(parts.val.filter(e => e.s.id.startsWith('verbPage|')).length, 4, '10 % von 40 Abschnitten');

  const r = finalize(samples, { valSplit: 0.1 }, pageContents);
  assert.ok(r.stats.val > 0);
  assert.deepEqual(r.stats.quality.overlap, { prompt: 0, answer: 0, shingle: 0 });
  const train = rows(r.trainJsonl).map(m => m[2].content);
  for (const v of rows(r.valJsonl)) assert.ok(!train.includes(v[2].content));
});

test('Val-Bereinigung: gleiche Antwort trotz verschiedener Einheiten bleibt nur im Train', () => {
  const t = [sample('a', 'Wo spielt A?', 'Schauplatz: Basel, Olten.')];
  const v = [sample('b', 'Wo spielt B?', 'Schauplatz: Basel, Olten.'), sample('c', 'Wo spielt C?', 'Schauplatz: Frauenfeld.')];
  const ov = valOverlap(t, v);
  assert.deepEqual([...ov.answer], [0]);
  assert.equal(ov.prompt.size, 0);
});

test('Satzgrenzen: Ordnungszahlen sind kein Satzende, Jahreszahlen schon', () => {
  assert.deepEqual(splitSentences('Sie hatten beide die 1. Klasse besucht. Am 11. September war es still. Er kam 1999. Dann ging er.'),
    ['Sie hatten beide die 1. Klasse besucht.', 'Am 11. September war es still.', 'Er kam 1999.', 'Dann ging er.']);
});

test('Namen: Schreibweise des Buchs statt Kennung', () => {
  const book = 'Im Chat nannte es sich «das_unklare_abdomen». Später schrieb die Cat Lady zurück.';
  assert.equal(slugDisplayName('das_unklare_abdomen', book), 'das_unklare_abdomen', 'Nickname wörtlich im Buch');
  assert.equal(slugDisplayName('cat_lady_40', book), 'Cat Lady');
  assert.equal(slugDisplayName('madame_phantasma', book), '', 'unbekannt → Entität fällt weg');
  assert.equal(extractName('fig_129', new Map()), '', 'Kennung ist kein Name');
});

test('Ereignis-Sampler: keine Kreuzprodukte, Orte ohne geratene Präposition, keine Enums', () => {
  const out = [];
  const locs = [{ pk: 1, loc_id: 'l1', name: 'Basel' }, { pk: 2, loc_id: 'l2', name: 'Kantonsspital Olten' }];
  const figs = ['Dennis', 'Rolf', 'Frank'].map(n => ({ fig_id: n.toLowerCase(), key: n.toLowerCase(), name: n, names: [n] }));
  const events = [0, 1, 2].map(i => ({
    i, ereignis: 'Rauferei ' + i, datum: 'Juni 1998', kapitel: ['Eins'], scenes: [],
    figs: [figs[i], figs[(i + 1) % 3]], locs: [locs[i % 2]],
    typ: 'persoenlich', kindPhrase: 'ein persönliches Ereignis', bedeutung: 'Der Bruch zwischen den Freunden, Runde ' + i + '.',
    fullAnswer: 'Rauferei ' + i + '. Zeitpunkt: Juni 1998. Ein persönliches Ereignis.',
  }));
  buildEventSamples({
    langIsEn: false, events, locRows: locs, PARAPHRASES: 2,
    eventQuestions: ['Erzähl mir von {ereignis}.', 'Was weisst du über {ereignis}?', 'Warum ist {ereignis} wichtig?', 'Welche Bedeutung hat {ereignis}?'],
    pickVariants: (id, v, n) => v.slice(0, n).map((_, k) => k),
    pushQA: (id, q, a, o) => out.push({ id, q, a, unit: o?.unit }),
  });
  const byAnswer = new Map();
  for (const s of out) byAnswer.set(s.a, (byAnswer.get(s.a) || 0) + 1);
  for (const [a, n] of byAnswer) assert.ok(n <= 2, `${n}× «${a.slice(0, 60)}»`);
  for (const s of out) {
    assert.doesNotMatch(s.q, /\ban (Basel|Kantonsspital)/, s.q);
    assert.doesNotMatch(s.a, /persoenlich|Art: /, s.a);
  }
  assert.ok(out.some(s => s.q === 'Welche Ereignisse spielen am Schauplatz «Basel»?'));
  assert.ok(out.filter(s => s.id.startsWith('authorChat|evt|')).every(s => s.unit));
});
