// Unit: Finetune-Export v3.2 (docs/finetuning.md#qualität-des-sets):
// Beziehungsprüfung mit jeder Regel (Fall Adrian/Peter/Gisela/Stefan),
// betroffene Paare fallen aus allen Fakten-Aufgaben; Kernfakten der
// Hauptfiguren in vielen Varianten; Kapitel-Zusammenfassungen ohne
// «Dann:»-Ketten, nur aus dem eigenen Kapitel; Kontrastpaare beim Ablehnen,
// Teil-Ablehnung, Meta-Fragen, Off-Topic; Lint `colonList`/`repetition`;
// geschichtete Val-Ablehnungen; Profile, Studio-Beilagen, Fragevarianten der KI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as relTypes from '../../public/js/book/beziehung-typen.js';
import { finetuneProfileById, FINETUNE_PROFILES, EXPORT_DEFAULTS } from '../../public/js/book/finetune-profiles.js';
import { studioYamlFor, modelfileFor } from '../../public/js/book/finetune-studio-files.js';

const require = createRequire(import.meta.url);
const { checkRelations } = require('../../routes/jobs/finetune-export/lib/relation-check.js');
const { buildCoreFactSamples } = require('../../routes/jobs/finetune-export/samples/core-facts/index.js');
const { buildChapterCore } = require('../../routes/jobs/finetune-export/samples/core-facts/events.js');
const { makeCoreHelpers } = require('../../routes/jobs/finetune-export/samples/core-facts/variants.js');
const { isOwnLifeEvent, berufHead, jobInSentence, isSingleJob } = require('../../routes/jobs/finetune-export/samples/core-facts/words.js');
const { PORTRAIT_QUESTIONS } = require('../../routes/jobs/finetune-export/samples/core-facts/figures.js');
const { buildRefusalSamples } = require('../../routes/jobs/finetune-export/samples/reader/refusals.js');
const { OFF_TOPIC, EVAL_FAKES } = require('../../routes/jobs/finetune-export/samples/reader/refusal-text.js');
const { makeReaderPush } = require('../../routes/jobs/finetune-export/samples/reader/push.js');
const { lintAnswer } = require('../../routes/jobs/finetune-export/lib/answer-lint.js');
const { pickRefusalVal } = require('../../routes/jobs/finetune-export/lib/split.js');
const { coreFactVariants, buildQualityStats } = require('../../routes/jobs/finetune-export/lib/export-stats.js');
const { keepsQuestion } = require('../../routes/jobs/finetune-export/samples/core-facts/ai-paraphrase.js');
const { buildFigureBaseSamples } = require('../../routes/jobs/finetune-export/samples/author-chat/figures.js');

// ── Fixture: der Fall aus dem Export «Der Amoklauf» ──────────────────────
// Stefan hat laut Daten zwei Väter (Adrian und Peter, gleiche Beschreibung),
// Gisela ist mit beiden verheiratet, Renate nennt Adrian «Schwager», und
// Adrians Ereignis spricht vom «grossen Bruder». Adrian ist jünger als Stefan.
const FIGS = [
  { fig_id: 'fig_1', pk: 1, name: 'Stefan', typ: 'hauptfigur', geschlecht: 'männlich', beruf: 'Polymechaniker, zuerst im Stahlwerk Gerlafingen, ab 1988 Facharbeiter in Olten' },
  { fig_id: 'fig_2', pk: 2, name: 'Renate', typ: 'hauptfigur', geschlecht: 'weiblich' },
  { fig_id: 'fig_7', pk: 7, name: 'Gisela', typ: 'nebenfigur', geschlecht: 'weiblich' },
  { fig_id: 'fig_32', pk: 32, name: 'Peter', typ: 'randfigur', geschlecht: 'männlich' },
  { fig_id: 'fig_33', pk: 33, name: 'Adrian', typ: 'nebenfigur', geschlecht: 'männlich' },
];
const VATER = 'Ein distanzierter, lesender Vater, der ihm bei der Stellensuche sachlich hilft.';
const EHE = 'Eine Zweckgemeinschaft, in der Gisela führt und Peter sich fügt.';
const RELS = [
  { rel_id: 5077, from_fig_id: 'fig_1', to_fig_id: 'fig_2', typ: 'ehepartner', beschreibung: '' },
  { rel_id: 5078, from_fig_id: 'fig_1', to_fig_id: 'fig_7', typ: 'elternteil', beschreibung: 'Die Mutter lenkt seine Kindheit.' },
  { rel_id: 5079, from_fig_id: 'fig_1', to_fig_id: 'fig_33', typ: 'elternteil', beschreibung: VATER },
  { rel_id: 5090, from_fig_id: 'fig_1', to_fig_id: 'fig_32', typ: 'elternteil', beschreibung: VATER },
  { rel_id: 5097, from_fig_id: 'fig_2', to_fig_id: 'fig_33', typ: 'andere', beschreibung: 'Schwager und Vertrauter, bei dem sie Trost sucht.' },
  { rel_id: 5170, from_fig_id: 'fig_7', to_fig_id: 'fig_33', typ: 'ehepartner', beschreibung: EHE },
  { rel_id: 5174, from_fig_id: 'fig_7', to_fig_id: 'fig_32', typ: 'ehepartner', beschreibung: EHE },
];
const EVENTS = new Map([
  [1, [{ id: 1, subtyp: 'geburt', ereignis: 'Geburt von Stefan', datum_year: 1968 }]],
  [7, [{ id: 7, subtyp: 'geburt', ereignis: 'Geburt von Stefan', datum_year: 1968 }]],
  [33, [
    { id: 2243, ereignis: 'Stefan beichtet Adrian die Beziehung zu Renate', bedeutung: 'Emanzipation vom grossen Bruder.' },
    { id: 33, subtyp: 'geburt', ereignis: 'Geburt von Adrian', datum_year: 1970 },
  ]],
]);
const TIERS = new Map(FIGS.map(f => [f.fig_id, f.typ === 'hauptfigur' ? 'main' : f.typ === 'nebenfigur' ? 'side' : 'minor']));
const relCtx = (figs = FIGS, rels = RELS, events = EVENTS) => ({
  figRows: figs, figById: new Map(figs.map(f => [f.fig_id, f])), figRelRows: rels, eventsByFigPk: events, relTypes, tierByFig: TIERS,
});
const rulesOf = (r) => new Set(r.conflicts.map(c => c.rule));

test('Beziehungsprüfung: Fall Adrian/Peter/Gisela/Stefan', () => {
  const r = checkRelations(relCtx());
  const rules = rulesOf(r);
  for (const rule of ['maxParents', 'duplicateDescription', 'textContradiction', 'generationGap']) assert.ok(rules.has(rule), rule);
  const two = r.conflicts.find(c => c.rule === 'maxParents');
  assert.deepEqual([...two.figures].sort(), ['Adrian', 'Gisela', 'Peter', 'Stefan']);
  assert.ok(two.sources.includes('relation:5079') && two.sources.includes('relation:5170'), 'Quellen mit Beziehungs-ID');
  assert.ok(two.main, 'Stefan ist Hauptfigur');
  assert.ok(r.conflicts.some(c => c.rule === 'textContradiction' && c.sources.includes('event:2243')), 'Ereignis nennt den Bruder');
  assert.ok(r.conflicts.some(c => c.rule === 'textContradiction' && c.sources.includes('relation:5097')), 'Schwager ≠ Schwiegervater');
  // Gisela ist Stefans einzige Mutter, ihr Geburtsereignis «Geburt von Stefan» ist nicht ihres.
  assert.ok(!r.pairs.has('fig_1|fig_7'));
  assert.ok(!r.conflicts.some(c => c.rule === 'generationGap' && c.figures.includes('Gisela')));
  // Feiner sperren: der Text widerspricht nur Adrians Kanten (Bruder, «… Peter sich
  // fügt»), Peters Vater- und Ehe-Kante bleiben im Set und stehen in `kept`.
  for (const k of ['fig_1|fig_33', 'fig_33|fig_7']) assert.ok(r.pairs.has(k), k);
  for (const k of ['fig_1|fig_32', 'fig_32|fig_7']) assert.ok(!r.pairs.has(k), k);
  assert.deepEqual(two.kept, [['Stefan', 'Peter'], ['Peter', 'Gisela']]);
  assert.ok(r.conflicts.some(c => c.rule === 'foreignName' && c.sources.includes('relation:5170')), 'Ehe-Kante zu Adrian nennt Peter');
  assert.ok(r.mainCount > 0);
});

test('Beziehungsprüfung: ohne unabhängigen Beleg bleiben beide Alternativen gesperrt', () => {
  // Ohne Ereignis und ohne Ehe-Kanten weiss niemand, welcher der beiden Väter falsch ist.
  const rels = RELS.filter(r => [5079, 5090].includes(r.rel_id));
  const r = checkRelations(relCtx(FIGS, rels, new Map()));
  for (const k of ['fig_1|fig_33', 'fig_1|fig_32']) assert.ok(r.pairs.has(k), k);
  assert.ok(r.conflicts.every(c => !c.kept));
});

test('Beziehungsprüfung: Geschlecht des Rollenworts gegen die Zielfigur', () => {
  const F = (id, name, g) => ({ fig_id: id, pk: Number(id.slice(2)), name, geschlecht: g });
  const reto = F('f_1', 'Reto', 'männlich'), mutter = F('f_2', 'Stefanies Mutter', 'weiblich'), manfred = F('f_3', 'Manfred', 'männlich');
  const R = (from, to, typ, beschreibung) => ({ from_fig_id: from, to_fig_id: to, typ, beschreibung });
  const rules = (rels) => rulesOf(checkRelations(relCtx([reto, mutter, manfred], rels, new Map())));
  // Prod-Fall: «Der Vater …» auf der Elternteil-Kante zu einer Frau.
  assert.ok(rules([R('f_1', 'f_2', 'elternteil', 'Der Vater baut ihm mit Manfred die Mini-Pipe.')]).has('genderMismatch'));
  assert.ok(!rules([R('f_1', 'f_2', 'elternteil', 'Die Mutter schlägt ihn, als er Koch werden will.')]).has('genderMismatch'));
  // Das Wort direkt bei einer dritten Figur meint deren Verwandten.
  assert.ok(!rules([R('f_1', 'f_2', 'elternteil', 'Sie streitet mit Manfreds Vater um das Haus.')]).has('genderMismatch'));
  // Ein Wort, das eine andere Rolle als die Kante nennt, zählt nicht.
  assert.ok(!rules([R('f_1', 'f_2', 'elternteil', 'Sie zieht den Sohn allein gross.')]).has('genderMismatch'));
});

test('Beziehungsprüfung: Ereigniswort belastet nur Figuren mit passendem Geschlecht', () => {
  // «zwischen den Brüdern» meint nicht Renate, die im selben Ereignis steht.
  const events = new Map([[1, [{ id: 2196, ereignis: 'Stefan beichtet Adrian die Beziehung zu Renate',
    bedeutung: 'Seine Lüge bricht das Vertrauen zwischen den Brüdern.' }]]]);
  const rels = RELS.filter(r => [5077, 5079].includes(r.rel_id));
  const r = checkRelations(relCtx(FIGS, rels, events));
  const tc = r.conflicts.find(c => c.rule === 'textContradiction' && c.sources.includes('event:2196'));
  assert.ok(tc, 'Widerspruch zu Adrian gemeldet');
  assert.ok(!r.pairs.has('fig_1|fig_2'), 'Ehe Stefan–Renate bleibt');
  assert.ok(r.pairs.has('fig_1|fig_33'));
});

test('Beziehungsprüfung: fremder Name nur als ganzer Name, nicht als Namensteil einer Rollenfigur', () => {
  const F = (id, name, g) => ({ fig_id: id, pk: Number(id.slice(2)), name, geschlecht: g });
  const figs = [F('f_1', 'Dennis', 'männlich'), F('f_2', 'Herr Ruprecht', 'männlich'), F('f_3', 'Deutschlehrerin am Bifang', 'weiblich')];
  const R = (from, to, typ, beschreibung) => ({ from_fig_id: from, to_fig_id: to, typ, beschreibung });
  const r = checkRelations(relCtx(figs, [
    R('f_1', 'f_2', 'mentor', 'Klassenlehrer im Bifang, dessen Satz zur Selbstorganisation Dennis prägt.'),
    R('f_1', 'f_3', 'mentor', 'Sie fördert sein Schreiben.'),
  ], new Map()));
  assert.ok(!rulesOf(r).has('foreignName'));
});

test('Beziehungsprüfung: übrige Regeln einzeln', () => {
  const F = (id, name, g, extra = {}) => ({ fig_id: id, pk: Number(id.slice(2)), name, geschlecht: g, ...extra });
  const a = F('f_1', 'Anna', 'weiblich'), b = F('f_2', 'Bruno', 'männlich'), c = F('f_3', 'Clara', 'weiblich'), d = F('f_4', 'Dora', 'weiblich');
  const run = (rels, figs = [a, b, c, d], events = new Map()) => rulesOf(checkRelations(relCtx(figs, rels, events)));
  const R = (from, to, typ, beschreibung = '') => ({ from_fig_id: from, to_fig_id: to, typ, beschreibung });
  assert.ok(run([R('f_1', 'f_2', 'elternteil'), R('f_1', 'f_2', 'geschwister')]).has('parentIsKin'));
  assert.ok(run([R('f_1', 'f_2', 'ehepartner'), R('f_2', 'f_1', 'kollege')]).has('spouseAsymmetric'));
  assert.ok(run([R('f_1', 'f_2', 'kollege'), R('f_1', 'f_2', 'feind')]).has('pairConflict'));
  assert.ok(run([R('f_1', 'f_2', 'geschwister'), R('f_1', 'f_2', 'freund')]).has('familyAndFriend'));
  // Geschwister mit erfassten, aber verschiedenen Eltern.
  assert.ok(run([R('f_1', 'f_3', 'geschwister'), R('f_1', 'f_2', 'elternteil'), R('f_3', 'f_4', 'elternteil')]).has('siblingsNoParent'));
  assert.ok(!run([R('f_1', 'f_3', 'geschwister'), R('f_1', 'f_2', 'elternteil'), R('f_3', 'f_2', 'elternteil')]).has('siblingsNoParent'));
  // Elternteil nur 10 Jahre älter.
  const ev = new Map([[1, [{ subtyp: 'geburt', ereignis: 'Geburt', datum_year: 1980 }]], [2, [{ subtyp: 'geburt', ereignis: 'Geburt', datum_year: 1970 }]]]);
  assert.ok(run([R('f_1', 'f_2', 'elternteil')], [a, b, c, d], ev).has('generationGap'));
  // Zwei Mütter.
  assert.ok(run([R('f_1', 'f_3', 'elternteil'), R('f_1', 'f_4', 'elternteil')]).has('maxParents'));
  // Ohne Widerspruch: nichts.
  assert.equal(checkRelations(relCtx([a, b, c], [R('f_1', 'f_2', 'elternteil', 'Der Vater ist streng.'), R('f_1', 'f_3', 'geschwister')], new Map())).conflicts.length, 0);
});

test('Konflikt-Paare fehlen in Kernwissen, Porträt, Falschannahme und Familienlisten', () => {
  const r = checkRelations(relCtx());
  const ctx = {
    langIsEn: false, displayName: 'Der Amoklauf', unifiedSys: 'S', samples: [], counts: {}, relTypes,
    opts: { valSeed: 0, factParaphrases: 4, maxVariantsPerFact: 5, minMentions: 1, coreFactRepeat: 2 },
    ...relCtx(), relationExcluded: r.pairs,
    pageContents: [{ id: 1, text: FIGS.map(f => f.name).join(' ') }],
    appearancesByFigPk: new Map(), figsByLocPk: new Map(), locRows: [], events: [], chapterKeys: [], chapterNameByKey: new Map(),
  };
  buildCoreFactSamples(ctx);
  assert.ok(ctx.conflictDropped >= 3);
  assert.ok(!ctx.relationFacts.some(f => f.a.fig_id === 'fig_33' || f.b.fig_id === 'fig_33'));
  const text = ctx.samples.map(s => s.messages.map(m => m.content).join(' ')).join('\n');
  assert.doesNotMatch(text, /Adrian ist Stefans Vater|Adrian ist Giselas/);
  assert.match(text, /Gisela ist Stefans Mutter/, 'unbestrittene Beziehung bleibt');
  assert.match(text, /Peter ist Stefans Vater/, 'die belegte Alternative bleibt (feiner sperren)');
  const push = makeReaderPush(ctx);
  buildRefusalSamples({ ...ctx, figMentions: new Map() }, push);
  const fp = ctx.samples.filter(s => s.id.startsWith('refusal|falsePremise|rel'));
  assert.ok(fp.length && fp.every(s => !/Adrian/.test(s.messages[2].content)));
});

test('Geburt/Tod: nur die eigene zählt', () => {
  assert.equal(isOwnLifeEvent({ name: 'Gisela' }, { ereignis: 'Geburt von Stefan' }), false);
  assert.equal(isOwnLifeEvent({ name: 'Sandra' }, { ereignis: 'Tod von Sandras Vater' }), false);
  assert.equal(isOwnLifeEvent({ name: 'Stefan' }, { ereignis: 'Geburt von Stefan' }), true);
  assert.equal(isOwnLifeEvent({ name: 'Anna' }, { ereignis: 'Geburt' }), true);
});

// ── Kernfakten ──────────────────────────────────────────────────────────
function mainCtx() {
  const figs = [
    { fig_id: 'fig_1', pk: 1, name: 'Stefan', typ: 'hauptfigur', geschlecht: 'männlich', beruf: 'Polymechaniker, zuerst im Stahlwerk Gerlafingen', motivation: 'Er sucht Halt in festen Abläufen.' },
    { fig_id: 'fig_2', pk: 2, name: 'Renate', typ: 'hauptfigur', geschlecht: 'weiblich' },
    { fig_id: 'fig_3', pk: 3, name: 'Gisela', typ: 'nebenfigur', geschlecht: 'weiblich' },
  ];
  const ctx = {
    langIsEn: false, displayName: 'Der Amoklauf', unifiedSys: 'S', samples: [], counts: {}, relTypes,
    opts: { valSeed: 0, factParaphrases: 4, maxVariantsPerFact: 5, minMentions: 1, corePerTier: EXPORT_DEFAULTS.corePerTier, coreFactRepeat: 2 },
    figRows: figs, figById: new Map(figs.map(f => [f.fig_id, f])),
    figRelRows: [
      { from_fig_id: 'fig_1', to_fig_id: 'fig_2', typ: 'ehepartner', beschreibung: '' },
      { from_fig_id: 'fig_1', to_fig_id: 'fig_3', typ: 'elternteil', beschreibung: '' },
    ],
    pageContents: [{ id: 1, text: 'Stefan Renate Gisela' }],
    eventsByFigPk: new Map([[1, [
      { subtyp: 'geburt', ereignis: 'Geburt von Stefan', datum: '1968', datum_year: 1968 },
      { subtyp: 'wendepunkt', typ: 'persoenlich', ereignis: 'Lehrbeginn im Stahlwerk', datum: '1984', datum_year: 1984 },
      { subtyp: 'wendepunkt', typ: 'persoenlich', ereignis: 'Erster Kuss', datum: '1983', datum_year: 1983, datum_unsicher: 1 },
    ]]]),
    appearancesByFigPk: new Map([[1, ['Der Vater']]]), figsByLocPk: new Map(), locRows: [],
    events: [], chapterKeys: [], chapterNameByKey: new Map(),
  };
  buildCoreFactSamples(ctx);
  return ctx;
}

test('Kernfakten: ≥ 12 Porträt-Vorlagen, jeder Fakt in ≥ 8 Paaren, gleiche Rollenwörter', () => {
  assert.ok(PORTRAIT_QUESTIONS.de.core.length >= 12 && PORTRAIT_QUESTIONS.en.core.length >= 12);
  const ctx = mainCtx();
  const facts = ctx.coreFactsByFig.get('fig_1');
  const ids = facts.map(f => f.id);
  for (const id of ['rel:fig_1|fig_2', 'rel:fig_1|fig_3', 'fig:fig_1:beruf', 'fig:fig_1:geburt', 'fig:fig_1:kapitel', 'fig:fig_1:motiv']) assert.ok(ids.includes(id), id);
  assert.ok(ids.some(id => id.includes(':tp:')), 'Wendepunkt mit sicherem Jahr');
  assert.ok(!facts.some(f => /Erster Kuss/.test(f.label)), 'erschlossenes Jahr ist kein Kernfakt');
  const v = coreFactVariants(ctx.samples, ctx.coreFactsByFig, (id) => id);
  assert.ok(v.figures.fig_1.min >= 6 && v.figures.fig_1.median >= 8, JSON.stringify(v.figures.fig_1));
  const spouse = ctx.samples.filter(s => (s.factIds || [s.factId]).includes('rel:fig_1|fig_2'));
  const qs = spouse.map(s => s.messages.filter(m => m.role === 'user').map(m => m.content).join(' / '));
  assert.ok(qs.some(q => q === 'Wer ist Stefans Ehefrau?'), 'direkt');
  assert.ok(qs.some(q => /^Wessen Ehefrau ist Renate\?$/.test(q)), 'umgekehrt');
  assert.ok(qs.some(q => /^Ist Renate Stefans Ehefrau\?$/.test(q)), 'Ja/Nein');
  assert.ok(qs.some(q => /Familie/.test(q)), 'eingebettet');
  assert.ok(spouse.some(s => s.messages.length === 5), 'Mehrturn');
  assert.ok(spouse.filter(s => s.task === 'coreFact').every(s => /Ehefrau|Ehemann|verheiratet/.test(s.messages.at(-1).content)), 'gleiches Rollenwort');
  assert.ok(spouse.filter(s => s.messages.length === 3 && /^Ist /.test(s.messages[1].content)).every(s => /^Ja/.test(s.messages[2].content)));
  // Beruf: Kopf des freien Feldes, Werdegang als Variante.
  assert.equal(berufHead('Polymechaniker, zuerst im Stahlwerk Gerlafingen'), 'Polymechaniker');
  assert.ok(ctx.samples.some(s => /Stefan ist Polymechaniker – zuerst im Stahlwerk/.test(s.messages.at(-1).content)));
  // Geschützt und vom Antwort-Budget ausgenommen.
  assert.ok(ctx.samples.filter(s => s.task === 'coreFact').every(s => s.core && s.coreFact && s.tier === 'main'));
});

test('Beruf in der Falschannahme: nur Einzelbegriff, Adjektiv klein', () => {
  assert.equal(jobInSentence('Reformierter Pfarrer'), 'reformierter Pfarrer');
  assert.equal(isSingleJob('Bezirksschüler, Hockeyspieler, Mitgründer'), false);
  assert.equal(isSingleJob('Polymechaniker'), true);
});

// ── Kapitel ─────────────────────────────────────────────────────────────
test('Kapitel: drei Fassungen, Fliesstext, nur Ereignisse dieses Kapitels, Kapitelliste', () => {
  const S = { fig_id: 'fig_1', name: 'Stefan' }, R = { fig_id: 'fig_2', name: 'Renate' }, F = { fig_id: 'fig_9', name: 'Fabio' };
  const ev = (i, t, y, figs, pages, kap) => ({ i, ereignis: t, datum: String(y), year: y, figs, pageIds: pages, kapitel: kap, bedeutung: i === 0 ? 'Er will etwas bewirken.' : '' });
  const events = [ev(0, 'Lehrbeginn im Stahlwerk', 1984, [S], [1], ['Der Vater']), ev(1, 'Erster Kuss mit Renate', 1985, [S, R], [1], ['Der Vater']),
    ev(2, 'Militärdienst', 1987, [S], [2], ['Der Vater']), ev(3, 'Hochzeit', 1990, [S, R], [2], ['Der Vater']),
    ev(4, 'Geburt von Fabio', 1995, [F], [3], ['Der Vater', 'Fabio']), ev(5, 'Umzug nach Rickenbach', 1991, [S, R], [2], ['Der Vater'])];
  const ctx = {
    langIsEn: false, displayName: 'Der Amoklauf', unifiedSys: 'S', samples: [], counts: {}, opts: { valSeed: 0, factParaphrases: 4, maxVariantsPerFact: 5 },
    events, chapterKeys: [1, 2], chapterNameByKey: new Map([[1, 'Der Vater'], [2, 'Fabio']]),
    pageChapterById: new Map([[1, 'Der Vater'], [2, 'Der Vater'], [3, 'Fabio']]), tierByFig: new Map([['fig_1', 'main'], ['fig_2', 'main']]),
  };
  buildChapterCore(ctx, makeCoreHelpers(ctx).emitCard);
  const vater = ctx.samples.filter(s => s.factId?.startsWith('chap:Der Vater'));
  const forms = new Set(vater.map(s => s.factId));
  assert.ok(forms.has('chap:Der Vater:short') && forms.has('chap:Der Vater') && forms.has('chap:Der Vater:fig:fig_1'));
  assert.ok(new Set(vater.filter(s => s.factId === 'chap:Der Vater').map(s => s.messages[1].content)).size >= 8, '≥ 8 Fragen');
  for (const s of vater) {
    const a = s.messages[2].content;
    assert.doesNotMatch(a, /Fabio|Dann:|Zuerst:/, a);
    assert.equal(lintAnswer(a), null, a);
  }
  const medium = vater.find(s => s.factId === 'chap:Der Vater').messages[2].content;
  assert.ok(medium.indexOf('1984') < medium.indexOf('1990'), 'chronologisch mit Jahreszahlen');
  assert.equal(ctx.chapterMismatches.length, 1, 'Geburt von Fabio: Kapitel-Zuordnung ≠ Kapitel des Abschnitts');
  assert.ok(ctx.samples.some(s => s.factId === 'book:chapters' && /«Der Vater» und «Fabio»/.test(s.messages[2].content)));
});

// ── Ablehnen ────────────────────────────────────────────────────────────
function refusalCtx(extra = {}) {
  const figRows = [
    { fig_id: 'fig_1', pk: 1, name: 'Stefan', typ: 'hauptfigur', geschlecht: 'männlich', beruf: 'Polymechaniker' },
    { fig_id: 'fig_2', pk: 2, name: 'Renate Studer', typ: 'hauptfigur', geschlecht: 'weiblich', beruf: 'Reformierte Pfarrerin' },
  ];
  const ctx = {
    langIsEn: false, displayName: 'Der Amoklauf', unifiedSys: 'S', samples: [], counts: {}, opts: { valSeed: 0 },
    figRows, locRows: [], pageContents: [{ id: 1, text: 'Stefan und Renate Studer gingen nach Olten.' }],
    tierByFig: new Map([['fig_1', 'main'], ['fig_2', 'main']]), chapterKeys: [1, 2, 3],
    relationFacts: [{ key: 'fig_1|fig_2', a: figRows[0], b: figRows[1], typ: 'ehepartner', core: true }],
    ...extra,
  };
  buildRefusalSamples(ctx, makeReaderPush(ctx));
  return ctx;
}

test('Ablehnen: Kontrastpaare in Porträt-Form, ähnliche Namen, Teil-Ablehnung, Meta, Off-Topic', () => {
  const ctx = refusalCtx({ publication: { author_name: 'David Berger', year: '' } });
  const unknown = ctx.samples.filter(s => s.id.startsWith('refusal|unknown'));
  const portrait = unknown.filter(s => s.form === 'portrait');
  assert.ok(portrait.length / unknown.length > 0.5, 'Porträt-Form überwiegt');
  const templates = PORTRAIT_QUESTIONS.de.core.map(t => new RegExp('^' + t.replace(/[.?]/g, '\\$&').replace(/\{n(:\w+)?\}/g, '.+') + '$'));
  assert.ok(portrait.every(s => templates.some(re => re.test(s.messages[1].content))), 'gleiche Vorlagen wie echte Porträts');
  assert.ok(unknown.some(s => /^Stefan /.test(s.messages[1].content.replace(/^.*?(Stefan \S+).*$/, '$1')) && /Meinst du vielleicht Stefan|Vielleicht meinst du Stefan/.test(s.messages[2].content)), 'echter Vorname + fremder Nachname');
  assert.ok(unknown.some(s => / Studer\b/.test(s.messages[1].content) && /Renate Studer/.test(s.messages[2].content)), 'fremder Vorname + echter Nachname');
  const fakes = new Set(EVAL_FAKES.de.map(n => n.toLowerCase()));
  assert.ok(!unknown.some(s => [...fakes].some(f => s.messages[1].content.toLowerCase().includes(f))), 'Eval-Namen nie im Train');
  const mixed = ctx.samples.filter(s => s.id.startsWith('refusal|mixed'));
  assert.ok(mixed.length && mixed.every(s => /nicht/.test(s.messages[2].content)));
  // Vorstellung, Vergleich, Beziehung, Szene: die echte Figur kurz eingeordnet;
  // beim Ereignis steht das Ereignis vorn.
  assert.ok(mixed.filter(s => s.form !== 'mixed-event').every(s => /(Stefan|Renate Studer) (ist|kenne)/.test(s.messages[2].content)));
  const meta = ctx.samples.filter(s => s.id.startsWith('refusal|meta'));
  assert.ok(meta.some(s => /David Berger/.test(s.messages[2].content)), 'Autor aus den Projektdaten');
  assert.ok(meta.some(s => /Wann ich entstanden bin, steht nicht in meinen Seiten|Ein Jahr nennen meine Seiten nicht/.test(s.messages[2].content)), 'ohne Jahr: ablehnen');
  assert.ok(meta.some(s => /3 Kapitel/.test(s.messages[2].content)));
  const noAuthor = refusalCtx().samples.filter(s => s.id.startsWith('refusal|meta|author'));
  assert.ok(noAuthor.every(s => /nicht in meinen Seiten|nennen meine Seiten nicht/.test(s.messages[2].content)), 'nie raten');
  assert.ok(OFF_TOPIC.de.length >= 60 && OFF_TOPIC.en.length >= 60);
  assert.ok(OFF_TOPIC.de.some(([q]) => /E-Mail/.test(q)) && OFF_TOPIC.de.some(([q]) => /Bewerbung/.test(q)));
});

test('Falschannahme: volle Form, bis zu drei je Kernbeziehung, Beruf klein im Satz', () => {
  const ctx = refusalCtx();
  // Bis zu drei Falschannahmen je Kernbeziehung, dazu das Rollenspiel in der Ich-Form.
  const rel = ctx.samples.filter(s => s.id.startsWith('refusal|falsePremise|rel'));
  assert.ok(rel.length >= 2 && rel.length <= 4, String(rel.length));
  for (const s of rel) {
    assert.match(s.messages[2].content, /sondern (Stefans|Renate Studers|der|die|eine?|ein) \S+\.$|, nicht /, s.messages[2].content);
    assert.deepEqual(s.factIds, ['rel:fig_1|fig_2']);
    assert.equal(s.unit, 'ref:fp:fig_1|fig_2');
  }
  const job = ctx.samples.find(s => s.id === 'refusal|falsePremise|job|fig_1');
  assert.match(job.messages[1].content + job.messages[2].content, /reformierte Pfarrerin/);
});

test('Val-Ablehnungen je Untertyp mit Mindestzahl, höchstens die Hälfte', () => {
  const e = (task, unit) => ({ family: 'refusal', s: { task, unit } });
  const entries = [
    ...Array.from({ length: 40 }, (_, i) => e('unknownEntity', 'u' + i)),
    ...Array.from({ length: 12 }, (_, i) => e('metaQuestion', 'm' + (i % 6))),
    ...Array.from({ length: 6 }, (_, i) => e('mixedRefusal', 'x' + i)),
  ];
  const val = pickRefusalVal(entries, { valSplit: 0.05, valSeed: 0, valRefusalMin: { unknownEntity: 8, metaQuestion: 4, mixedRefusal: 4 } });
  const count = (task) => entries.filter(x => x.s.task === task && val.has(x.s.unit)).length;
  assert.ok(count('unknownEntity') >= 8);
  assert.ok(count('metaQuestion') >= 4 && count('metaQuestion') <= 6);
  assert.ok(count('mixedRefusal') <= 3, 'höchstens die Hälfte');
});

// ── Lint und Antwortformen ──────────────────────────────────────────────
test('Lint: Doppelpunkt-Listen und Wiederholungen fallen weg', () => {
  assert.equal(lintAnswer('Renate ist: abwesend, abweisend, aufopfernd.'), 'colonList');
  assert.equal(lintAnswer('Zur Familie von Rudolf gehören: Johanna (Ehefrau).'), 'colonList');
  assert.equal(lintAnswer('Rudolfs Ehefrau ist Johanna.'), null);
  assert.equal(lintAnswer('Zeitpunkt von «A»: 1990.'), null);
  const loop = Array(3).fill('Er sieht die Vergewaltigung der Penelope.').join(' ');
  assert.equal(lintAnswer(loop), 'repetition');
});

test('Eigenschaften: höchstens drei als Satz, ohne Dubletten und Doppelpunkt', () => {
  const samples = [];
  const ctx = {
    langIsEn: false, figRows: [{ fig_id: 'fig_2', name: 'Renate', tags_csv: 'abwesend,hilfsbereit,aufopfernd,Hilfsbereit,stur,leise,Pflichtbewusstsein', konflikt: 'Sie ist hilfsbereit, stellt aber die eigenen Wünsche zurück.' }],
    pushQA: (id, q, a) => samples.push({ id, q, a }), pickVariants: (_, v, n) => [...Array(Math.min(n, v.length)).keys()], PARAPHRASES: 2,
  };
  buildFigureBaseSamples(ctx);
  const traits = samples.filter(s => s.id.startsWith('authorChat|figTraits'));
  assert.ok(traits.length);
  for (const { a } of traits) {
    assert.equal(lintAnswer(a), null, a);
    const list = a.split('.')[0];
    assert.ok((list.match(/,/g) || []).length <= 1 && !/Pflichtbewusstsein/.test(list), a);
    assert.doesNotMatch(list, /hilfsbereit.*Hilfsbereit/i);
  }
  assert.ok(traits.some(t => /stellt aber die eigenen Wünsche zurück/.test(t.a)), 'Beleg aus der Analyse');
});

// ── Statistik ───────────────────────────────────────────────────────────
test('Statistik: Kontrastquote und Kernfakt-Varianten', () => {
  const s = (task, extra = {}) => ({ task, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }], ...extra });
  const q = buildQualityStats([s('figureCore'), s('figureCore'), s('unknownEntity', { form: 'portrait' }), s('unknownEntity')], []);
  assert.equal(q.refusalPortraitRatio, 0.5);
  const v = coreFactVariants([s('coreFact', { factIds: ['a', 'b'] }), s('coreFact', { factId: 'a' })], new Map([['fig_1', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]]]));
  assert.deepEqual([v.min, v.median], [1, 1]);
  assert.equal(v.figures.fig_1.facts, 2);
});

// ── Profile und Beilagen ────────────────────────────────────────────────
test('Profile: Qwen3 14B mit ChatML und eigener Token-Schätzung; Studio-Config mit empfohlener Länge', () => {
  const qwen = finetuneProfileById('qwen3-14b-16gb');
  assert.equal(qwen.id, 'qwen3-14b-16gb');
  assert.deepEqual([qwen.seq, qwen.batch, qwen.accum, qwen.r], [2048, 1, 16, 16]);
  assert.equal(qwen.chatTemplate, 'chatml');
  assert.ok(qwen.charsPerToken.de < finetuneProfileById('ministral3-8b-16gb').charsPerToken.de);
  assert.ok(FINETUNE_PROFILES.every(p => p.charsPerToken && p.chatTemplate));
  const t = (k, p) => k + (p ? JSON.stringify(p) : '');
  const stats = { profileId: 'ministral3-8b-16gb', train: 6000, recommendedSeqLen: 1024, maxSeqTokens: 4096, tokensP95: 740, tokensMax: 3158, overRecommendedSeq: 32, systemPrompt: 'Du bist «X».' };
  const yaml = studioYamlFor({ profileId: stats.profileId, stats, t });
  assert.match(yaml, /^ {2}max_seq_length: 1024$/m);
  assert.match(yaml, /^ {2}save_steps: 100$/m);
  assert.match(yaml, /^ {2}eval_steps: 0\.1$/m);
  assert.match(yaml, /^ {2}early_stopping_patience: 0$/m);
  assert.match(yaml, /seqLen.*"max":3158.*"over":32/);
  assert.match(modelfileFor({ stats: { ...stats, profileId: 'qwen3-14b-16gb' }, t }), /<\|im_start\|>[\s\S]*PARAMETER stop "<\|im_end\|>"/);
  assert.doesNotMatch(modelfileFor({ stats, t }), /im_start/);
});

test('KI-Fragevarianten: alle Namen der Vorlage, keine fremden', () => {
  const names = ['Stefan', 'Renate', 'Gisela'];
  assert.ok(keepsQuestion('Mit wem ist Stefan verheiratet?', 'Wer ist Stefans Ehefrau?', names));
  assert.ok(!keepsQuestion('Wer ist Giselas Schwiegertochter?', 'Wer ist Stefans Ehefrau?', names), 'Name fehlt, fremder Name');
  assert.ok(!keepsQuestion('Stefan', 'Wer ist Stefans Ehefrau?', names), 'zu kurz');
});
