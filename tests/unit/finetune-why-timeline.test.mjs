// Unit: Finetune-Export Warum-Familie und Zeitstrahl rückwärts
// (docs/finetuning.md#warum-familie, #zeitstrahl-rückwärts): Warum-Fragen aus
// Bedeutung + Motivation/Konflikt + Vorgeschichte, nichts erfunden; Jahr →
// Ereignisse, Figur + Jahr, gemeinsame Ereignisse, Reihenfolge — nur sichere
// Jahre, keine doppelten Karten.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeCoreHelpers } = require('../../routes/jobs/finetune-export/samples/core-facts/variants.js');
const { buildEventWhy, actorOf, motiveSentences } = require('../../routes/jobs/finetune-export/samples/core-facts/why.js');
const { buildTimelineReverse } = require('../../routes/jobs/finetune-export/samples/core-facts/timeline.js');

const F = (fig_id, name) => ({ fig_id, name, names: [name] });
const figRows = [
  { fig_id: 'f1', name: 'Stefan', typ: 'hauptfigur', geschlecht: 'm',
    motivation: 'Äusserlich will er Kontrolle über seine Frau. Innerlich fehlt ihm Zugehörigkeit.',
    konflikt: 'Er lebt ein Doppelleben aus Alkohol und Gewalt.' },
  { fig_id: 'f2', name: 'Renate', typ: 'hauptfigur', geschlecht: 'f', motivation: '', konflikt: '' },
  { fig_id: 'f3', name: 'Fahrer des Mercedes', typ: 'randfigur', geschlecht: 'm', motivation: 'Er will schnell nach Hause.', konflikt: '' },
];
const events = [
  { i: 1, ereignis: 'Hochzeit von Stefan und Renate', year: 1990, figs: [F('f1', 'Stefan'), F('f2', 'Renate')], bedeutung: 'Er fühlt sich am Ziel.' },
  { i: 2, ereignis: 'Renate tritt der Damenriege bei', year: 1992, figs: [F('f2', 'Renate')], bedeutung: 'Erste Selbstbehauptung.' },
  { i: 3, ereignis: 'Stefan vergewaltigt Renate am Chilbi-Abend', year: 1994, figs: [F('f1', 'Stefan'), F('f2', 'Renate')], bedeutung: 'Er überschreitet die Grenze zur offenen Gewalt.' },
  { i: 4, ereignis: 'Stefan schlägt Renate', year: 1996, unsure: true, figs: [F('f1', 'Stefan'), F('f2', 'Renate')], bedeutung: 'Die Gewalt wird Routine.' },
  { i: 5, ereignis: 'Fahrer des Mercedes rast davon', year: 1996, figs: [F('f3', 'Fahrer des Mercedes')], bedeutung: 'Fahrerflucht.' },
];
const makeCtx = () => ({
  langIsEn: false, events, figRows, samples: [], counts: {}, unifiedSys: 'S',
  opts: { valSeed: 1, factParaphrases: 4 },
  tierByFig: new Map([['f1', 'main'], ['f2', 'main'], ['f3', 'minor']]), figNameInfo: new Map(),
});
const qa = (s) => [s.messages[1].content, s.messages[2].content];

test('Warum: Verbfrage aus dem Titel, Antwort aus Bedeutung + Motivation + Vorgeschichte', () => {
  const ctx = makeCtx();
  const { emitCard } = makeCoreHelpers(ctx);
  buildEventWhy(ctx, emitCard);
  const why = ctx.samples.filter(s => s.factId === 'evt:3:motive');
  assert.ok(why.length >= 8, 'viele Frageformen je Ereignis');
  assert.ok(why.every(s => s.task === 'eventWhy' && s.unit === 'evt:3' && s.core && s.tier === 'main'));
  const qs = why.map(s => qa(s)[0]);
  assert.ok(qs.includes('Warum vergewaltigt Stefan Renate am Chilbi-Abend?'), qs.join(' / '));
  assert.ok(qs.some(q => q.startsWith('Was sind Stefans Beweggründe')));
  assert.equal(new Set(qs).size, qs.length, 'jede Frage einmal');
  for (const s of why) {
    const a = qa(s)[1];
    assert.match(a, /Stefan überschreitet die Grenze/, 'führendes «Er» der Bedeutung wird zum Namen');
    assert.match(a, /Kontrolle über seine Frau/, 'Motivation steht drin');
    assert.match(a, /«Hochzeit von Stefan und Renate»/, 'Vorgeschichte aus dem Zeitstrahl');
    assert.doesNotMatch(a, /«Renate tritt der Damenriege bei»/, 'nur Ereignisse derselben Figur');
  }
  assert.ok(new Set(why.map(s => qa(s)[1])).size >= 3, 'mehrere Antwortfassungen');
});

test('Warum: ohne handelnde Figur, ohne Motivation oder bei Rollenfigur keine Karte', () => {
  const ctx = makeCtx();
  const { emitCard } = makeCoreHelpers(ctx);
  buildEventWhy(ctx, emitCard);
  const ids = new Set(ctx.samples.map(s => s.factId));
  assert.ok(!ids.has('evt:1:motive'), 'Titel beginnt nicht mit einem Namen');
  assert.ok(!ids.has('evt:2:motive'), 'Renate hat weder Motivation noch Konflikt');
  assert.ok(!ids.has('evt:5:motive'), 'Rollenfigur');
  assert.equal(actorOf(events[2], new Map()).verb, 'vergewaltigt');
});

test('Warum: Motivsätze nach Nähe zum Ereignis, erster Motivationssatz füllt auf', () => {
  const m = motiveSentences(figRows[0], { ereignis: 'Stefan trinkt und wird gewalttätig', bedeutung: 'Alkohol und Gewalt', figs: [] });
  assert.deepEqual(m, ['Äusserlich will er Kontrolle über seine Frau.', 'Er lebt ein Doppelleben aus Alkohol und Gewalt.']);
});

test('Zeitstrahl: Jahr, Figur + Jahr, Paare, Reihenfolge — nur sichere Jahre, keine Dubletten', () => {
  const ctx = makeCtx();
  const { emitCard } = makeCoreHelpers(ctx);
  buildTimelineReverse(ctx, emitCard);
  const ids = ctx.samples.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'keine doppelten Sample-IDs');
  assert.ok(ctx.samples.every(s => s.task === 'eventTimeline'));

  const y94 = ctx.samples.filter(s => s.factId === 'year:1994').map(qa);
  assert.ok(y94.some(([q, a]) => q === 'Was passiert 1994 in der Geschichte?' && a.includes('«Stefan vergewaltigt Renate am Chilbi-Abend»')));
  const y96 = ctx.samples.filter(s => s.factId === 'year:1996').map(s => qa(s)[1]).join(' ');
  assert.doesNotMatch(y96, /Stefan schlägt Renate/, 'unsicheres Jahr zählt nicht');

  assert.ok(ctx.samples.some(s => s.factId === 'fig:f2:year:1992' && qa(s)[0] === 'Was erlebt Renate 1992?'));
  assert.ok(!ctx.samples.some(s => String(s.factId).startsWith('fig:f3:')), 'Rollenfigur ohne Figur-Jahr-Fragen');

  const pair = ctx.samples.filter(s => s.factId === 'pairEvt:f1|f2');
  assert.ok(pair.some(s => qa(s)[0] === 'Was erleben Renate und Stefan gemeinsam?'), 'beide Namensreihenfolgen');
  assert.match(qa(pair[0])[1], /«Hochzeit von Stefan und Renate».*«Stefan vergewaltigt Renate am Chilbi-Abend»/);

  const order = ctx.samples.filter(s => String(s.factId).startsWith('order:'));
  assert.ok(order.length > 0);
  for (const s of order) {
    const [, a] = qa(s);
    const m = a.match(/\((\d{4})\).*\((\d{4})\)/);
    assert.ok(m && Number(m[1]) < Number(m[2]), 'früheres Ereignis zuerst: ' + a);
  }
});

test('Antwort-Budget: Faktenfamilie bis maxPerFactAnswer, Schreibaufgaben bei maxPerAnswer', async () => {
  const { finalizeFinetuneSamples } = require('../../routes/jobs/finetune-export/finalize.js');
  const mk = (id, q, a) => ({ id, type: 'authorChat', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: q }, { role: 'assistant', content: a }] });
  const fact = 'Stefan überschreitet erstmals die Grenze zur offenen Gewalt in der Ehe.';
  const prose = 'Der Regen schlug gegen die Scheiben, und niemand im Haus sagte ein Wort.';
  const samples = [];
  for (let i = 0; i < 10; i++) samples.push(mk(`authorChat|evtX|${i}`, `Faktenfrage Nummer ${i}?`, fact));
  for (let i = 0; i < 10; i++) samples.push(mk(`style|p${i}`, `Schreibe weiter, Variante ${i}.`, prose));
  const r = finalizeFinetuneSamples({
    samples, langIsEn: false, pageContents: [],
    opts: { valSplit: 0, valSeed: 0, maxSeqTokens: 0, emitText: false, truncateLong: false, maxPerAnswer: 2, maxPerFactAnswer: 6 },
  });
  const answers = r.trainJsonl.trim().split('\n').map(l => JSON.parse(l).messages[2].content);
  assert.equal(answers.filter(a => a === fact).length, 6);
  assert.equal(answers.filter(a => a === prose).length, 2);
  assert.equal(r.stats.maxPerFactAnswer, 6);
});

test('Weltgeschehen: nie Vorgeschichte einer Tat, nie «Was erlebt X im Jahr …?»', () => {
  const world = { i: 2.5, ereignis: 'Massenselbstmord der Sonnentempler', year: 1994, typ: 'extern', figs: [F('f1', 'Stefan')], bedeutung: 'Schlagzeile.' };
  const ctx = { ...makeCtx(), events: [...events.slice(0, 2), world, ...events.slice(2)] };
  const { emitCard } = makeCoreHelpers(ctx);
  buildEventWhy(ctx, emitCard);
  buildTimelineReverse(ctx, emitCard);
  const why = ctx.samples.filter(s => s.factId === 'evt:3:motive').map(s => s.messages[2].content).join(' ');
  assert.doesNotMatch(why, /Sonnentempler/);
  const figYear = ctx.samples.filter(s => s.factId === 'fig:f1:year:1994').map(s => s.messages[2].content).join(' ');
  assert.doesNotMatch(figYear, /Sonnentempler/);
  assert.match(ctx.samples.filter(s => s.factId === 'year:1994').map(s => s.messages[2].content).join(' '), /Sonnentempler/);
});

test('Warum: weitere Figuren aus eigener Sicht, nur mit passendem Motivsatz', () => {
  const rows = figRows.map(f => (f.fig_id === 'f2'
    ? { ...f, konflikt: 'Sie leidet unter Stefans Kontrolle und sexueller Gewalt. Sie liebt das Turnen über alles.' }
    : f));
  const ctx = { ...makeCtx(), figRows: rows };
  const { emitCard } = makeCoreHelpers(ctx);
  buildEventWhy(ctx, emitCard);
  const renate = ctx.samples.filter(s => s.factId === 'evt:3:motive:f2');
  assert.ok(renate.length > 0);
  const qs = renate.map(s => s.messages[1].content);
  assert.ok(qs.includes('Wie erlebt Renate «Stefan vergewaltigt Renate am Chilbi-Abend»?'));
  assert.ok(!qs.some(q => q.startsWith('Warum') || q.startsWith('Wie kommt es')), 'Ereignisfragen nur bei der handelnden Figur');
  for (const s of renate) {
    const a = s.messages[2].content;
    assert.match(a, /sexueller Gewalt/);
    assert.doesNotMatch(a, /Turnen/, 'nur der passende Satz');
    assert.doesNotMatch(a, /Renate überschreitet/, 'Bedeutung mit «Er» gehört der handelnden Figur');
  }
  // Stefan bei der Hochzeit: kein Satz seiner Motivation passt → keine Karte aus seiner Sicht.
  assert.ok(!ctx.samples.some(s => s.factId === 'evt:1:motive:f1'), 'ohne passenden Satz keine Karte');
});
