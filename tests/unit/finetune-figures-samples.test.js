'use strict';
// Finetune-Export, Figuren-Sampler: Enum-Werte gehen als Prosa ins Training
// (nicht als Schlüssel «gehobenes_buergertum»), Dialogzitate werden vollständig
// genutzt (Sechsergruppen statt der ersten sechs).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFigureBaseSamples, buildFigureMetaSamples } = require('../../routes/jobs/finetune-export/samples/author-chat/figures');

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

test('Sozialschicht und Geschlecht als Prosa, «andere/unbekannt» ohne Sample', () => {
  const de = collect(false, [
    { fig_id: 'fig_1', pk: 1, name: 'Anna', geschlecht: 'weiblich', sozialschicht: 'gehobenes_buergertum' },
    { fig_id: 'fig_2', pk: 2, name: 'Bert', geschlecht: 'unbekannt', sozialschicht: 'andere' },
  ]);
  assert.equal(de.find(s => s.id === 'authorChat|figSchicht|fig_1').a, 'Anna stammt aus dem gehobenen Bürgertum.');
  assert.equal(de.find(s => s.id === 'authorChat|figGeschl|fig_1').a, 'Anna ist weiblich.');
  assert.ok(!de.some(s => s.id.endsWith('|fig_2') && /figSchicht|figGeschl/.test(s.id)));
  const en = collect(true, [{ fig_id: 'fig_1', pk: 1, name: 'Anna', geschlecht: 'weiblich', sozialschicht: 'prekariat' }]);
  assert.equal(en.find(s => s.id === 'authorChat|figGeschl|fig_1').a, 'Anna is female.');
  assert.equal(en.find(s => s.id === 'authorChat|figSchicht|fig_1').a, 'Anna comes from the precariat.');
});

test('Dialogstil: alle Zitate in Sechsergruppen', () => {
  const quotes = Array.from({ length: 13 }, (_, i) => ({ quote: `Das ist meine Zeile Nummer ${i} hier.` }));
  const out = collect(false, [{ fig_id: 'fig_1', pk: 1, name: 'Anna' }], { dialogsByFigure: new Map([['anna', quotes]]) });
  const voice = out.filter(s => s.id.startsWith('authorChat|figVoice|fig_1'));
  assert.equal(voice.length, 2, '13 Zitate → zwei volle Gruppen, Rest von einem Zitat zu dünn');
});
