// Unit: Finetune-Export — was das Buch nicht erzählt, und Nachhaken
// (docs/finetuning.md#ablehnen-lernen, #kernwissen): Ja/Nein zur Beteiligung
// an Ereignissen mit sicherem Nein, «Davon erzählt meine Geschichte nichts»
// bei echten Figuren, Nachhak-Gespräche, die bei der belegten Antwort bleiben.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EXPORT_DEFAULTS } from '../../public/js/book/finetune-profiles.js';

const require = createRequire(import.meta.url);
const { makeCoreHelpers } = require('../../routes/jobs/finetune-export/samples/core-facts/variants.js');
const { buildEventPresence } = require('../../routes/jobs/finetune-export/samples/core-facts/events.js');
const { nameInfo } = require('../../routes/jobs/finetune-export/samples/core-facts/naming.js');
const { buildNotInBookSamples, buildChallengeConversations, restate } = require('../../routes/jobs/finetune-export/samples/reader/grounding.js');
const { makeReaderPush } = require('../../routes/jobs/finetune-export/samples/reader/push.js');
const { taskOf, familyOf } = require('../../routes/jobs/finetune-export/lib/tasks.js');

const FIGS = [
  { fig_id: 'fig_1', name: 'Stefan', typ: 'hauptfigur', geschlecht: 'männlich' },
  { fig_id: 'fig_2', name: 'Renate', typ: 'hauptfigur', geschlecht: 'weiblich' },
  { fig_id: 'fig_7', name: 'Gisela', typ: 'nebenfigur', geschlecht: 'weiblich' },
  { fig_id: 'fig_33', name: 'Adrian', typ: 'nebenfigur', geschlecht: 'männlich' },
  { fig_id: 'fig_40', name: 'Pietro', typ: 'nebenfigur', geschlecht: 'männlich' },
];
const fig = (id) => { const f = FIGS.find(x => x.fig_id === id); return { fig_id: f.fig_id, name: f.name, names: [f.name] }; };
const rel = (a, b, typ) => ({ key: `${a}|${b}`, a: fig(a), b: fig(b), typ, desc: '', core: true });
const PAGES = [
  { id: 10, text: 'Renate fuhr nach Oensingen. Adrian wartete am Bahnhof. Sie assen ihr Lieblingsessen.' },
  { id: 11, text: 'Stefan stand in der Werkstatt. Gisela rief an.' },
  { id: 12, text: 'Pietro kochte in Neapel.' },
];
const NIGHT = 'Renate und Adrian verbringen die Nacht miteinander in Oensingen';

function makeCtx() {
  const ctx = {
    langIsEn: false, displayName: 'Der Amoklauf', unifiedSys: 'SYS', samples: [], counts: {},
    opts: { valSeed: 7, factParaphrases: 4, maxVariantsPerFact: 5 },
    figRows: FIGS, locRows: [], pageContents: PAGES,
    figNameInfo: nameInfo(FIGS),
    tierByFig: new Map(FIGS.map(f => [f.fig_id, f.typ === 'hauptfigur' ? 'main' : 'side'])),
    eligibleFigIds: new Set(FIGS.map(f => f.fig_id)),
    relationFacts: [rel('fig_1', 'fig_2', 'ehepartner'), rel('fig_1', 'fig_7', 'elternteil'), rel('fig_7', 'fig_33', 'kind')],
    events: [
      { i: 3, ereignis: NIGHT, datum: 'Ende August 1999', unsure: false, bedeutung: 'Rache und Trost.', kapitel: ['Der Vater'],
        pageIds: [10], figs: [fig('fig_2'), fig('fig_33')] },
      { i: 4, ereignis: 'Stefan beichtet Adrian die Beziehung', datum: '1986', unsure: false, bedeutung: '', kapitel: [],
        pageIds: [], figs: [fig('fig_1'), fig('fig_33')] },
    ],
  };
  return ctx;
}

test('Beteiligung: Nein nur für verbundene, nirgends genannte Figuren; ohne Abschnitt kein Nein', () => {
  const ctx = makeCtx();
  const { emitCard } = makeCoreHelpers(ctx);
  buildEventPresence(ctx, emitCard);
  const no = ctx.samples.filter(s => s.messages[2].content.startsWith('Nein'));
  const asked = new Set(no.map(s => s.factId));
  // Stefan (Ehemann von Renate) und Gisela (Mutter von Adrian): verbunden, Abschnitt 10 nennt sie nicht.
  assert.ok(asked.has('evt:3:with:fig_1'), 'Stefan');
  assert.ok(asked.has('evt:3:with:fig_7'), 'Gisela');
  assert.ok(!asked.has('evt:3:with:fig_40'), 'Pietro ist mit keiner beteiligten Figur verbunden');
  assert.ok(!no.some(s => s.factId.startsWith('evt:4:')), 'Ereignis ohne Abschnitt bekommt kein Nein');
  for (const s of no) {
    assert.equal(s.task, 'eventCore');
    assert.equal(s.unit, 'evt:3');
    assert.match(s.messages[2].content, /Renate und Adrian/);
  }
  // Titel nennt beide Beteiligten → kein triviales Ja.
  assert.ok(!ctx.samples.some(s => s.messages[2].content.startsWith('Ja')));
});

test('notInBook: Eigenschaft fehlt im Buch, erzählte Eigenschaft fällt ganz weg; Paare ohne Verbindung', () => {
  const ctx = makeCtx();
  buildNotInBookSamples(ctx, makeReaderPush(ctx));
  const attr = ctx.samples.filter(s => s.id.startsWith('refusal|notInBook|attr|'));
  assert.ok(attr.length >= 4, 'Haupt- und Nebenfiguren bekommen Eigenschaftsfragen');
  assert.ok(!attr.some(s => s.id.endsWith('|food')), '«Lieblingsessen» steht im Buch');
  assert.equal(attr.filter(s => s.id.includes('|fig_1|') && !s.id.endsWith('|insist')).length, 3, 'Hauptfigur: drei Eigenschaften');
  for (const s of attr) {
    assert.equal(taskOf(s), 'notInBook');
    assert.equal(familyOf(taskOf(s)), 'refusal');
    assert.match(s.messages[2].content, /Stefans|Renates|Giselas|Adrians|Pietros/);
  }
  const pairs = ctx.samples.filter(s => s.id.startsWith('refusal|notInBook|pair|') && !s.id.endsWith('|insist')).map(s => s.id);
  // Pietro teilt mit niemandem einen Abschnitt und ist nicht verbunden.
  assert.ok(pairs.some(id => id.includes('fig_40')), 'Paar mit Pietro');
  // Stefan/Gisela: Beziehung; Renate/Gisela: Abstand 2 über Stefan; Renate/Adrian: gemeinsamer Abschnitt.
  for (const k of ['fig_1|fig_7', 'fig_2|fig_7', 'fig_2|fig_33']) assert.ok(!pairs.some(id => id.endsWith(k)), k);
  const insist = ctx.samples.filter(s => s.id.endsWith('|insist'));
  assert.ok(insist.length > 0, 'Nachhaken auf «weiss ich nicht»');
  for (const s of insist) {
    assert.equal(s.messages.length, 5);
    assert.match(s.messages[4].content, /erfind|erfunden/);
  }
});

test('Nachhaken: bleibt bei der belegten Antwort, mit Einheit der Quelle, ohne Ja-Vorlage', () => {
  const ctx = makeCtx();
  const { emitCard } = makeCoreHelpers(ctx);
  buildEventPresence(ctx, emitCard);
  makeReaderPush(ctx)({
    id: 'refusal|falsePremise|rel|fig_1|fig_7|0', unit: 'ref:fp:fig_1|fig_7',
    turns: [['Warum ist Gisela Stefans Mentorin?', 'Das stimmt so nicht: Gisela ist nicht Stefans Mentorin, sondern Stefans Mutter.']],
  });
  buildChallengeConversations(ctx, makeReaderPush(ctx));
  const ch = ctx.samples.filter(s => s.id.startsWith('reader|challenge|'));
  assert.ok(ch.length >= 2);
  for (const s of ch) {
    assert.equal(taskOf(s), 'factChallenge');
    assert.equal(familyOf(taskOf(s)), 'facts');
    assert.equal(s.messages.length, 5);
    const src = ctx.samples.find(x => `reader|challenge|${x.id}` === s.id);
    assert.equal(s.unit, src.unit, 'Einheit der Quelle');
    assert.ok(!/das stimmt:/i.test(s.messages[4].content));
  }
  const fp = ch.find(s => s.unit === 'ref:fp:fig_1|fig_7');
  assert.match(fp.messages[4].content, /Gisela ist nicht Stefans Mentorin, sondern Stefans Mutter\.$/);
  const ev = ch.find(s => s.unit === 'evt:3');
  assert.match(ev.messages[4].content, /Ende August 1999/);
});

test('restate: Einstieg fällt weg, nur ganze Sätze', () => {
  assert.equal(restate('Nein, Gisela ist nicht dabei.'), 'Gisela ist nicht dabei.');
  assert.equal(restate('Da liegt ein Irrtum vor. Gisela ist Stefans Mutter.'), 'Gisela ist Stefans Mutter.');
  assert.equal(restate('Ja.'), null);
});

test('Profil: notInBook in der Ablehnungs-Mischung und im Val', () => {
  const mix = EXPORT_DEFAULTS.refusalMix;
  assert.ok(mix.notInBook > 0);
  assert.ok(Math.abs(Object.values(mix).reduce((a, b) => a + b, 0) - 1) < 1e-9, 'Mischung summiert auf 1');
  assert.ok(EXPORT_DEFAULTS.valRefusalMin.notInBook > 0);
});
