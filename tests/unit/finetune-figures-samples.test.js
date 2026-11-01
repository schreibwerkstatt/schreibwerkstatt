'use strict';
// Finetune-Export, Figuren-Sampler: Enum-Werte gehen als Prosa ins Training
// (nicht als Schlüssel «gehobenes_buergertum»), Dialogzitate werden vollständig
// genutzt (Sechsergruppen statt der ersten sechs). «Wer ist X?», Beruf und
// Schicht stehen im Kernwissen (samples/core-facts/), nicht mehr hier.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFigureBaseSamples, buildFigureMetaSamples } = require('../../routes/jobs/finetune-export/samples/author-chat/figures');
const { makeCoreHelpers } = require('../../routes/jobs/finetune-export/samples/core-facts/variants');
const { buildFigureCore } = require('../../routes/jobs/finetune-export/samples/core-facts/figures');

function collect(langIsEn, figRows, extra = {}) {
  const out = [];
  const ctx = {
    langIsEn, opts: { valSeed: 1 }, figRows, figQuestions: ['Wer ist {name}?'],
    pushQA: (id, q, a) => out.push({ id, q, a }),
    pickVariants: (_id, v) => v.map((_, i) => i),
    eventsByFigPk: new Map(), appearancesByFigPk: new Map(), dialogsByFigure: new Map(),
    ...extra,
  };
  buildFigureBaseSamples(ctx);
  buildFigureMetaSamples(ctx);
  return out;
}

function coreAttrs(langIsEn, figRows) {
  const ctx = {
    langIsEn, displayName: 'Buch', opts: { valSeed: 1, factParaphrases: 3, maxVariantsPerFact: 5 },
    samples: [], counts: {}, unifiedSys: 'S', figRows,
    eligibleFigIds: new Set(figRows.map(f => f.fig_id)),
    eventsByFigPk: new Map(), appearancesByFigPk: new Map(), figsByLocPk: new Map(), locRows: [],
  };
  const { emitCard } = makeCoreHelpers(ctx);
  buildFigureCore(ctx, emitCard, []);
  return ctx.samples.map(s => ({ id: s.id, factId: s.factId, a: s.messages[2].content }));
}

test('Sozialschicht als Prosa im Kernwissen, «andere» ohne Sample; Alt-Fragen nicht mehr im Figuren-Sampler', () => {
  const de = coreAttrs(false, [
    { fig_id: 'fig_1', pk: 1, name: 'Anna', geschlecht: 'weiblich', sozialschicht: 'gehobenes_buergertum', typ: 'hauptfigur' },
    { fig_id: 'fig_2', pk: 2, name: 'Bert', geschlecht: 'unbekannt', sozialschicht: 'andere', typ: 'nebenfigur' },
  ]);
  const schicht = de.filter(s => s.factId === 'fig:fig_1:schicht').map(s => s.a);
  assert.ok(schicht.includes('Anna stammt aus dem gehobenen Bürgertum.'), schicht.join(' | '));
  assert.ok(!de.some(s => s.factId === 'fig:fig_2:schicht'));
  const en = coreAttrs(true, [{ fig_id: 'fig_1', pk: 1, name: 'Anna', geschlecht: 'weiblich', sozialschicht: 'prekariat' }]);
  assert.ok(en.some(s => s.a === 'Anna comes from the precariat.'));
  const old = collect(false, [{ fig_id: 'fig_1', pk: 1, name: 'Anna', geschlecht: 'weiblich', sozialschicht: 'prekariat', beruf: 'Lehrerin', beschreibung: 'Lehrerin im Dorf.' }]);
  assert.ok(!old.some(s => /\|(fig|figAlt|figBeruf|figBeruf2|figGeschl|figSchicht)\|/.test(s.id + '|')));
});

test('Dialogstil: alle Zitate in Sechsergruppen', () => {
  const quotes = Array.from({ length: 13 }, (_, i) => ({ quote: `Das ist meine Zeile Nummer ${i} hier.` }));
  const out = collect(false, [{ fig_id: 'fig_1', pk: 1, name: 'Anna' }], { dialogsByFigure: new Map([['anna', quotes]]) });
  const voice = out.filter(s => s.id.startsWith('authorChat|figVoice|fig_1'));
  assert.equal(voice.length, 2, '13 Zitate → zwei volle Gruppen, Rest von einem Zitat zu dünn');
});
