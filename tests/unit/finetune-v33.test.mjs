// Unit: Finetune-Export v3.3 (docs/finetuning.md) — was ein Export still
// falsch lernen liesse, ohne dass er fehlschlägt: ein Profilsatz, der in
// hunderten Antworten wörtlich steht (das Modell legt ihn auf jede Warum-Frage),
// eine «Vorgeschichte» aus späteren Ereignissen, eine Ich-Antwort, die in die
// 3. Person fällt, zwei Stufen für dieselbe Figur, ein Meta-«Weiss nicht», das
// doch Jahre und Titel nennt, ein Vergleich mit einem erfundenen Namen, ein
// erwähnter Ort als Schauplatz — und eine Eval-Regel, die eine richtige
// Ablehnung als falsch zählt.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = new URL('../../', import.meta.url).pathname;
const FT = '../../routes/jobs/finetune-export/';
const { makeCoreHelpers } = require(FT + 'samples/core-facts/variants.js');
const { buildEventWhy } = require(FT + 'samples/core-facts/why.js');
const { buildPsycheFacets, nameFirst } = require(FT + 'samples/core-facts/psyche.js');
const { buildSceneWhy } = require(FT + 'samples/core-facts/scene-why.js');
const { applyBlockReuse, maxBlockReuse } = require(FT + 'lib/block-reuse.js');
const { hasAnaphora, personaThirdPerson, lintAnswer } = require(FT + 'lib/answer-lint.js');
const { tierIndex, tierMismatchOf, precedingAfterTarget } = require(FT + 'lib/consistency-check.js');
const { mentionOnly } = require(FT + 'samples/author-chat/locations.js');
const { withoutQuotes } = require(FT + 'samples/author-chat/event-data.js');
const { toFirstPerson, backgroundToFirstPerson } = require(FT + 'samples/reader/first-person.js');
const { buildMetaSamples } = require(FT + 'samples/reader/meta.js');
const { META_TEXT } = require(FT + 'samples/reader/meta-text.js');
const { buildRefusalSamples, REFUSAL_TEXT } = require(FT + 'samples/reader/refusals.js');
const { makeReaderPush } = require(FT + 'samples/reader/push.js');
const { scoreRules, hasTerm } = require(FT + 'lib/eval/score.js');
const { REFUSAL_MARKERS } = require(FT + 'lib/eval/criteria.js');
const { mixByTokens, isProtected } = require(FT + 'lib/token-mix.js');

const F = (fig_id, name) => ({ fig_id, name, names: [name] });
const STEFAN = {
  fig_id: 'f1', pk: 1, name: 'Stefan', typ: 'hauptfigur', geschlecht: 'männlich',
  motivation: 'Äusserlich will er eine ungestörte Routine bei der Arbeit und Kontrolle über seine Frau. Innerlich fehlen ihm Sinn und Zugehörigkeit.',
  konflikt: 'Äusserlich kämpft er gegen den Modernisierer Hans. Innerlich lebt er ein Doppelleben aus Alkohol und Gewalt.',
  hintergrund: 'Seine Mutter lenkt seine Geschicke; der Vater ist kaum präsent.',
};
const SAMUEL = {
  fig_id: 'f5', pk: 5, name: 'Samuel', typ: 'hauptfigur', geschlecht: 'männlich',
  motivation: 'Want: Er will Kontrolle, Einfluss auf Menschen und Spektakel; er erfindet sich in Chaträumen neu.',
  konflikt: 'Innerlich schwankt er zwischen Selbststilisierung und der Angst, nie aus der Isolation herauszufinden.',
};
const RENATE = { fig_id: 'f2', pk: 2, name: 'Renate', typ: 'hauptfigur', geschlecht: 'weiblich', motivation: '', konflikt: '' };
const ev = (i, ereignis, year, figs, extra = {}) => ({ i, ereignis, year, figs, bedeutung: '', typ: 'persoenlich', pageIds: [], locs: [], ...extra });
const EVENTS = [
  ev(1, 'Geburt von Stefan', 1968, [F('f1', 'Stefan')], { subtyp: 'geburt', bedeutung: 'Anfang.' }),
  ev(2, 'Erster Kuss zwischen Stefan und Renate an der Dünnern', 1983, [F('f1', 'Stefan'), F('f2', 'Renate')], { bedeutung: 'Beginn einer heimlichen, prägenden Beziehung.', pageIds: [10] }),
  ev(3, 'Stefan bezieht das Miethaus in Rickenbach', 1988, [F('f1', 'Stefan'), F('f2', 'Renate')], { bedeutung: 'Er gründet einen eigenen Haushalt fern der Eltern.' }),
  ev(4, 'Schliessung der Werkstatt im Stahlwerk', 1988, [F('f1', 'Stefan')], { bedeutung: 'Er verliert seine Arbeit.' }),
];
const ctxBase = (extra = {}) => ({
  langIsEn: false, samples: [], counts: { core: 0 }, unifiedSys: 'S', opts: { valSeed: 0, factParaphrases: 4, aiWhyQuestions: false },
  figRows: [STEFAN, RENATE, SAMUEL], events: EVENTS,
  tierByFig: new Map([['f1', 'main'], ['f2', 'main'], ['f5', 'main']]), eligibleFigIds: new Set(['f1', 'f2', 'f5']), figNameInfo: new Map(),
  eventsByFigPk: new Map([[1, [{ subtyp: 'geburt', datum_year: 1968, ereignis: 'Geburt von Stefan' }]]]),
  ...extra,
});

// ── Warum ───────────────────────────────────────────────────────────────
test('eventWhy: nie ein späteres Ereignis als Vorgeschichte, höchstens ein Profil-Teilsatz, Lage zum Zeitpunkt', () => {
  const ctx = ctxBase();
  buildEventWhy(ctx, makeCoreHelpers(ctx).emitCard);
  const kuss = ctx.samples.filter(s => s.factId === 'evt:2:motive:f1' || s.factId === 'evt:2:motive');
  for (const s of ctx.samples.filter(x => x.task === 'eventWhy')) {
    const a = s.messages[2].content;
    assert.doesNotMatch(a, /Äusserlich will er/, 'kein Profilsatz wörtlich');
    assert.ok((a.match(/Dahinter steht|Das passt zu einem Zug/g) || []).length <= 1, 'höchstens ein Profil-Teilsatz');
  }
  for (const s of kuss) assert.doesNotMatch(s.messages[2].content, /Miethaus|Werkstatt/, 'Kuss 1983: Haus und Werkstatt liegen später');
  assert.equal(precedingAfterTarget(ctx.samples, EVENTS).length, 0);
  const haus = ctx.samples.filter(s => s.factId === 'evt:3:motive').map(s => s.messages[2].content).join(' ');
  assert.match(haus, /20 Jahre alt/, 'Alter zum Zeitpunkt aus dem sicheren Geburtsjahr');
  // Die Prüfung im Export erkennt eine falsche Vorgeschichte.
  const bad = [{ task: 'eventWhy', factId: 'evt:2:motive', messages: [{ role: 'assistant', content: 'Vorausgegangen ist «Stefan bezieht das Miethaus in Rickenbach» (1988). Rest.' }] }];
  assert.equal(precedingAfterTarget(bad, EVENTS).length, 1);
});

test('sceneWhy: Szene × Hauptfigur × Ereignis mit Bezug zum Titel, je Frage eine Fassung', () => {
  const ctx = ctxBase({
    sceneRows: [{ id: 7, titel: 'Erster Kuss an der Dünnern', page_id: 10 }],
    figsByScene: new Map([[7, ['f1']]]), eventsBySceneId: new Map([[7, [EVENTS[1]]]]),
  });
  buildSceneWhy(ctx, makeCoreHelpers(ctx).emitCard);
  const s = ctx.samples.filter(x => x.task === 'sceneWhy');
  assert.ok(s.length >= 2);
  assert.ok(s.some(x => x.messages[1].content === 'Warum handelt Stefan in der Szene «Erster Kuss an der Dünnern» so?'));
  assert.equal(new Set(s.map(x => x.messages[2].content)).size, s.length);
  assert.ok(s.every(x => /Erster Kuss an der Dünnern/.test(x.messages[2].content) && /heimlichen, prägenden Beziehung/.test(x.messages[2].content)));
});

// ── Psyche ──────────────────────────────────────────────────────────────
test('Psyche: eine Antwort je Facette, Figur im ersten Satz, Kontrast, keine Facette ohne Feld', () => {
  const ctx = ctxBase({ relationFacts: [] });
  buildPsycheFacets(ctx, makeCoreHelpers(ctx).emitCard);
  const psy = ctx.samples.filter(s => s.task === 'psyche');
  const ids = new Set(psy.map(s => s.factId));
  assert.ok(ids.has('fig:f1:psy:ziel') && ids.has('fig:f1:psy:sehnsucht') && ids.has('fig:f1:psy:aussen') && ids.has('fig:f1:psy:innen'));
  assert.ok(ids.has('fig:f5:psy:angst'), 'Angst nur, wo der Text sie nennt');
  assert.ok(!ids.has('fig:f1:psy:angst') && !ids.has('fig:f2:psy:ziel'), 'ohne Feld keine Frage');
  for (const s of psy.filter(x => !x.factId.startsWith('psy:contrast'))) {
    const fig = s.factId.includes('f5') ? 'Samuel' : 'Stefan';
    assert.match(s.messages[2].content.split(/[.!?]/)[0], new RegExp(fig), 'Figur im ersten Satz');
  }
  const profile = psy.filter(s => s.factId === 'fig:f1:psy:profil');
  assert.equal(new Set(profile.map(s => s.messages[2].content)).size, profile.length, 'jede Profil-Frage eigene Fassung');
  const contrast = psy.find(s => s.factId.startsWith('psy:contrast'));
  assert.match(contrast.messages[1].content, /unterscheide/);
  assert.match(contrast.messages[2].content, /Stefan.*Samuel dagegen|Samuel.*Stefan dagegen/);
  assert.equal(nameFirst('Äusserlich will er Ruhe.', 'Stefan', false), 'Stefan will Ruhe.');
  assert.equal(nameFirst('Want: Er will Kontrolle.', 'Samuel', false), 'Samuel will Kontrolle.');
});

// ── Lints ───────────────────────────────────────────────────────────────
test('blockReuse: langer Satz höchstens 5× wörtlich — überzählig gekürzt, ohne Rest verworfen', () => {
  const long = 'Stefan will eine ungestörte Routine bei der Arbeit, Kontrolle über seine Frau und eine Ordnung, die ihm Halt gibt.';
  const mk = (i, a, extra = {}) => ({ family: 'facts', s: { id: 'x|' + i, task: 'factFigure', messages: [{ role: 'user', content: 'q' + i }, { role: 'assistant', content: a }], ...extra } });
  const entries = [
    ...['eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht'].map((w, i) => mk(i, `Kurzer eigener Satz ${w}. ${long}`)),
    ...Array.from({ length: 3 }, (_, i) => mk('only' + i, long)),
    { family: 'writing', s: { id: 'w', task: 'continue', messages: [{ role: 'assistant', content: long }] } },
  ];
  const r = applyBlockReuse(entries, { isProtected: () => false });
  assert.equal(maxBlockReuse(r.kept.map(e => e.s), (s) => s.task === 'continue').max, 5);
  assert.ok(r.trimmed >= 3 && r.dropped >= 1);
  assert.ok(r.kept.some(e => e.s.messages[1].content.startsWith('Kurzer eigener Satz') && !e.s.messages[1].content.includes('Routine')), 'gekürzt, nicht verworfen');
  assert.ok(r.kept.some(e => e.s.id === 'w'), 'Buchtext zählt nicht');
  // Eine Deutung ohne ihren Kern fällt weg, statt als Rumpf zu bleiben.
  const why = Array.from({ length: 7 }, (_, i) => ({ family: 'facts', s: { id: 'y|' + i, task: 'eventWhy', messages: [{ role: 'assistant', content: `Kurz ${['eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben'][i]}. ${long}` }] } }));
  const r2 = applyBlockReuse(why, { isProtected: () => false });
  assert.equal(r2.kept.length, 5);
});

test('selfRepeat/personaThirdPerson: Anaphern-Kette, Rollenbruch, Anrede als Freund', () => {
  assert.equal(hasAnaphora('Er wollte Geld. Er wollte Macht. Er wollte Ruhe. Er wollte Liebe.'), true);
  assert.equal(hasAnaphora('Er wollte Geld. Sie ging. Er wollte Ruhe.'), false);
  assert.equal(lintAnswer('Er wollte Geld. Er wollte Macht. Er wollte Ruhe. Er wollte Liebe.'), 'anaphora');
  assert.equal(personaThirdPerson('Ich bin Robert. Gymnasiast. Robert ist ein begabtes Kind.', 'Robert'), 'personaThirdPerson');
  assert.equal(personaThirdPerson('Ich bin Robert. Ich male, wann immer ich kann.', 'Robert'), null);
  assert.equal(personaThirdPerson('Ich vertraue Stefan. Du bist mein bester Freund.', 'Renate'), 'personaFamiliar');
  assert.equal(toFirstPerson('Stefan empfindet sich als unsichtbar und sucht Wirksamkeit über Arbeit.', 'Stefan', 'm'),
    'Ich empfinde mich als unsichtbar und suche Wirksamkeit über Arbeit.');
  assert.equal(toFirstPerson('Stefan fehlen Sinn und Zugehörigkeit.', 'Stefan', 'm'), 'Mir fehlen Sinn und Zugehörigkeit.');
  assert.equal(toFirstPerson('Renate sehnt sich nach Liebe, die sie nie erhält.', 'Renate', 'f'), '', 'unsicheres «sie»: weglassen');
  assert.equal(backgroundToFirstPerson('Ihre religiösen Eltern verstossen sie wegen des Kindes.', 'Renate', 'f'), 'Meine religiösen Eltern verstossen mich wegen des Kindes.');
});

test('tierMismatch: dieselbe Stufe in allen Aufgaben', () => {
  const index = tierIndex([{ fig_id: 'f2', name: 'Renate', typ: 'hauptfigur' }], false);
  const s = (a) => ({ messages: [{ role: 'assistant', content: a }] });
  assert.equal(tierMismatchOf(s('Renate ist eine der Hauptfiguren meiner Geschichte.'), index), null);
  assert.deepEqual(tierMismatchOf(s('Renate ist eine Nebenfigur meiner Geschichte.'), index), { name: 'Renate', found: 'eine Nebenfigur', want: 'eine der Hauptfiguren' });
  assert.equal(tierMismatchOf(s('Renate kennt Stefan, eine Nebenfigur? Nein.'), tierIndex([{ fig_id: 'f2', name: 'Renate', typ: 'hauptfigur' }, { fig_id: 'f1', name: 'Stefan', typ: 'nebenfigur' }], false)), null,
    'die Stufe gehört dem näheren Namen');
});

test('Schauplatz: Ort im Ausland mit < 2 Szenen ist nur erwähnt', () => {
  const ctx = { homeLand: 'ch', scenesByLocPk: new Map([[1, [1, 2]], [2, [3]]]) };
  assert.equal(mentionOnly(ctx, { pk: 2, land: 'us' }), true, 'Columbine: Ausland, eine Szene');
  assert.equal(mentionOnly(ctx, { pk: 9, land: 'eg' }), true, 'Ägypten: keine Szene');
  assert.equal(mentionOnly(ctx, { pk: 1, land: 'us' }), false, 'zwei Szenen: Schauplatz');
  assert.equal(mentionOnly(ctx, { pk: 9, land: 'ch' }), false, 'im Schauplatz-Land');
  assert.equal(mentionOnly({ homeLand: '', scenesByLocPk: new Map() }, { pk: 9, land: 'us' }), false, 'ohne Schauplatz-Land nichts unterdrücken');
  // Ortsnamen in Titeln und wörtlicher Rede zählen in der Buchstelle nicht.
  const t = withoutQuotes('Beim Song «Big In Japan» packte Robert das Benzin aus. «Woher kommst du?» «Aus Olten.» Im Kantiwald brannte es.');
  assert.doesNotMatch(t, /Japan|Olten/);
  assert.match(t, /Kantiwald/);
  assert.doesNotMatch(withoutQuotes('«Er sagte ‹Ascona› und ging.» Danach Ruhe.'), /Ascona/, 'verschachtelt');
});

// ── Meta und Ablehnen ───────────────────────────────────────────────────
function metaCtx(extra = {}) {
  return {
    langIsEn: false, displayName: 'Der Amoklauf', unifiedSys: 'S', samples: [], counts: {}, opts: { valSeed: 0 },
    publication: { author_name: 'Daniel Tannenberg', year: '2026', publisher: 'David Berger Books' },
    bookSettings: { is_finished: 0, buchtyp: 'gesellschaft' }, homeLand: 'ch',
    chapterKeys: [1, 2], chapterNameByKey: new Map([[1, 'Der Vater'], [2, 'Der Künstler']]),
    locRows: [{ pk: 1, name: 'Olten', land: 'ch' }], scenesByLocPk: new Map([[1, [1, 2, 3]]]),
    events: [ev(1, 'A', 1984, []), ev(2, 'B', 2003, [])], figRows: [STEFAN], tierByFig: new Map([['f1', 'main']]),
    ...extra,
  };
}
test('Meta: Felder aus den Projektdaten, «entstanden» solange unfertig, ehrliche Ablehnungen ohne Titel/Jahr', () => {
  const ctx = metaCtx();
  buildMetaSamples(ctx, makeReaderPush(ctx));
  const meta = ctx.samples.filter(s => s.id.startsWith('refusal|meta'));
  assert.ok(meta.length >= 120, String(meta.length));
  const a = (topic) => meta.filter(s => s.id.startsWith(`refusal|meta|${topic}|`)).map(s => s.messages[2].content);
  assert.ok(a('year').every(x => /2026/.test(x)) && a('year').some(x => /entstanden/.test(x)) && !a('year').some(x => /ist 2026 erschienen/.test(x)));
  assert.ok(a('author').every(x => /Daniel Tannenberg/.test(x)));
  assert.ok(a('count').every(x => /2 Kapitel/.test(x)));
  assert.ok(a('region').every(x => /Olten/.test(x)));
  assert.ok(a('span').every(x => /1984/.test(x) && /2003/.test(x)));
  for (const t of ['works', 'origin', 'edition', 'film', 'bio']) {
    const r = a('no-' + t);
    assert.ok(r.length >= 8, t);
    assert.ok(r.every(x => /Ich heisse «Der Amoklauf» und stamme von Daniel Tannenberg\./.test(x)), t);
    assert.ok(r.every(x => !/\b(19|20)\d{2}\b/.test(x) && !/David Berger Books|«Der Vater»/.test(x)), 'keine Jahre, Verlage, Titel: ' + t);
  }
  const ch = meta.filter(s => s.id.startsWith('refusal|meta|chapterBook'));
  assert.ok(ch.some(s => s.messages[1].content === 'Ist «Der Vater» ein eigenes Buch?' && /«Der Vater» ist mein erstes Kapitel/.test(s.messages[2].content)));
  assert.ok(new Set(meta.map(s => s.messages[1].content)).size === meta.length, 'jede Frage einmal');
  const du = meta.filter(s => /\b(du|dich|dir)\b/.test(s.messages[1].content)).length;
  assert.ok(du >= 40, 'Du-Formen: ' + du);
  // Ohne Jahr: ablehnen, nicht weglassen.
  const noYear = metaCtx({ publication: { author_name: 'X' } });
  buildMetaSamples(noYear, makeReaderPush(noYear));
  assert.ok(noYear.samples.filter(s => s.id.startsWith('refusal|meta|year|')).every(s => /nicht in meinen Seiten|nennen meine Seiten nicht/.test(s.messages[2].content)));
});

test('mixedRefusal: Vergleich, Beziehung, Szene, Ereignis — der erfundene Name wird nie verglichen', () => {
  const figRows = [{ fig_id: 'fig_1', pk: 1, name: 'Stefan', typ: 'hauptfigur', geschlecht: 'männlich' }];
  const ctx = {
    langIsEn: false, displayName: 'Der Amoklauf', unifiedSys: 'S', samples: [], counts: {}, opts: { valSeed: 0 },
    figRows, locRows: [], pageContents: [{ id: 1, text: 'Stefan ging nach Olten.' }], tierByFig: new Map([['fig_1', 'main']]),
    events: [ev(1, 'Stefan beginnt die Lehre', 1984, [F('fig_1', 'Stefan')])], relationFacts: [], chapterKeys: [],
  };
  buildRefusalSamples(ctx, makeReaderPush(ctx));
  const mixed = ctx.samples.filter(s => s.id.startsWith('refusal|mixed'));
  assert.ok(mixed.length >= 200, String(mixed.length));
  const compare = mixed.filter(s => s.form === 'mixed-compare');
  assert.ok(compare.some(s => /^Wer ist älter, Stefan oder /.test(s.messages[1].content)));
  for (const s of compare) {
    const x = s.messages[1].content.match(/(?:oder|,) ([A-ZÄÖÜ]\S+ [A-ZÄÖÜ]\S+)\?$/)?.[1] || '';
    assert.match(s.messages[2].content, /Stefan (ist|kenne ich gut:) eine der Hauptfiguren/);
    assert.doesNotMatch(s.messages[2].content, new RegExp(`(älter|wichtiger) als ${x}`));
  }
  for (const form of ['mixed-relation', 'mixed-scene', 'mixed-event']) assert.ok(mixed.some(s => s.form === form), form);
  const fp = REFUSAL_TEXT.de;
  assert.ok(fp.fpRelQ.some(q => q.startsWith('Erzähl mir')) && fp.fpRelQ.some(q => q.startsWith('Ich habe gelesen')) && fp.fpRelYesNoQ.some(q => q.startsWith('Stimmt es')));
  assert.ok(fp.fpRoleQ.every(q => q.startsWith('{y},')) && fp.fpRoleA.every(a => /Ich bin/.test(a)));
});

// ── Mischung ────────────────────────────────────────────────────────────
test('Mischung: Ereignis-Facetten und Zeitstrahl zuerst gekürzt, Deutungen nur in der ersten Fassung geschützt', () => {
  assert.equal(isProtected({ core: true, task: 'eventWhy', type: 'core', id: 'core|evt:1:motive|0' }), true);
  assert.equal(isProtected({ core: true, task: 'eventWhy', type: 'core', id: 'core|evt:1:motive|2', tier: 'main' }), false);
  assert.equal(isProtected({ core: true, task: 'eventWhy', type: 'core', id: 'core|evt:1:motive|why0', tier: 'main' }), false, 'KI-Varianten nach den Vorlagen');
  const e = (id, task, len) => ({ family: task === 'continue' ? 'writing' : 'facts', s: { id, task, type: 'core', messages: [{ role: 'assistant', content: 'x'.repeat(len) }] } });
  const entries = [e('w', 'continue', 3300), ...Array.from({ length: 10 }, (_, i) => e(`core|evt:${i}:when|1`, 'eventCore', 330)), e('core|fig:f1:psy:ziel|1', 'psyche', 3000)];
  const r = mixByTokens(entries, { familyTokenShares: { writing: 0.45, facts: 0.42, persona: 0, refusal: 0 } });
  assert.ok(r.kept.some(x => x.s.task === 'psyche'), 'Innenleben bleibt, Facetten fallen');
  assert.ok(r.kept.filter(x => x.s.task === 'eventCore').length < 10);
});

// ── Eval-Regeln ─────────────────────────────────────────────────────────
test('Eval: Ablehnungsmarker mit Lücke decken jede Ablehnungs-Vorlage des Trains', () => {
  assert.ok(hasTerm('Von Aurelia Pfändler erzähle ich nirgends. Diese Figur gibt es in «Der Amoklauf» nicht.', 'gibt es … nicht'));
  const fill = (t) => t.replace(/\{\w+\}/g, 'Konrad Zwyssig');
  const T = REFUSAL_TEXT.de;
  const templates = [...T.figA, ...T.figRelA, ...T.placeA, ...T.eventA, ...T.offA, ...T.mixedFake, ...T.mixedFakeFirst,
    ...Object.values(T.mixed).flatMap(m => m.a), ...META_TEXT.de.refuseA.map(a => a.replace('{lead}', 'Davon weiss ich nichts.')),
    ...Object.values(META_TEXT.de.refuseLead).flat(), META_TEXT.de.fields.author.unknown[0], META_TEXT.de.fields.year.unknown[0]];
  for (const t of templates) assert.ok(REFUSAL_MARKERS.de.some(m => hasTerm(fill(t), m)), 'kein Marker für: ' + t);
});

test('Eval: minAny, mustNotContain deckelt, Profil-Überlappung, Stil', () => {
  const fig = { category: 'figure', mustContainAny: [['Renate'], ['Gisela'], ['Der Vater']], minAny: 2 };
  assert.equal(scoreRules('Stefan ist Renates Ehemann und steht im Kapitel «Der Vater» im Zentrum.', fig).cap, 2);
  assert.equal(scoreRules('Stefan ist Renates Ehemann.', fig).cap, 1);
  const unk = { category: 'unknown', mustContainAny: [REFUSAL_MARKERS.de], mustNotContain: ['Hauptfigur'] };
  assert.equal(scoreRules('Von Aurelia Pfändler erzähle ich nirgends. Diese Figur gibt es in «Der Amoklauf» nicht.', unk).cap, 2);
  assert.equal(scoreRules('Aurelia ist eine Hauptfigur.', unk).cap, 0);
  const profile = 'Äusserlich will er eine ungestörte Routine bei der Arbeit, Kontrolle über seine Frau und sexuelle Befriedigung.';
  const why = { category: 'why', mustContainAny: [['Grenze', 'Gewalt']], maxOverlapWithProfile: { text: profile, max: 0.6 } };
  assert.equal(scoreRules('Äusserlich will er eine ungestörte Routine bei der Arbeit, Kontrolle über seine Frau und sexuelle Befriedigung. Gewalt.', why).cap, 1);
  assert.equal(scoreRules('Er überschreitet die Grenze zur offenen Gewalt.', why).cap, 2);
  const prose = { category: 'newChapter', mustContain: ['Hans'], style: { noEszett: true, noRepeat: true, noMeta: true, tense: 'past' } };
  assert.equal(scoreRules('Hans kam spät. Er war müde und sagte nichts.', prose).cap, 2);
  assert.equal(scoreRules('«Stefan und Oliver im Bolero», Kapitel 11. Hans war da.', prose).cap, 1);
  assert.equal(scoreRules('Die erste Begegnung Hans. Die erste Begegnung Hans. Die erste Begegnung Hans.', prose).cap, 1);
  assert.equal(scoreRules('Hans ging ins Erdgeschoß und war still.', prose).cap, 1);
});

test('Eval: compare_models.py bewertet wie lib/eval/score.js', { skip: !hasPython() }, () => {
  const rows = [
    [{ category: 'figure', mustContainAny: [['Renate'], ['Gisela'], ['Der Vater']], minAny: 2 }, 'Stefan ist Renates Ehemann.'],
    [{ category: 'unknown', mustContainAny: [REFUSAL_MARKERS.de], mustNotContain: ['Hauptfigur'] }, 'Diese Figur gibt es in «Der Amoklauf» nicht.'],
    [{ category: 'unknown', mustContainAny: [REFUSAL_MARKERS.de], mustNotContain: ['Hauptfigur'] }, 'Aurelia ist eine Hauptfigur.'],
    [{ category: 'newChapter', mustContain: ['Hans'], style: { noEszett: true, noRepeat: true, noMeta: true, tense: 'past' } }, 'Hans ging ins Erdgeschoß.'],
    [{ category: 'why', mustContainAny: [['Gewalt']], maxOverlapWithProfile: { text: 'eins zwei drei vier fünf sechs sieben acht neun', max: 0.6 } }, 'eins zwei drei vier fünf sechs sieben acht neun Gewalt'],
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-score-'));
  const file = path.join(dir, 'rows.json');
  fs.writeFileSync(file, JSON.stringify(rows));
  const py = `import json,sys,importlib.util\nspec=importlib.util.spec_from_file_location('cm',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nprint(json.dumps([m.score_rules(a,r)[1] for r,a in json.load(open(sys.argv[2]))]))`;
  const out = JSON.parse(execFileSync('python3', ['-I', '-c', py, path.join(ROOT, 'docs/unsloth-config/compare_models.py'), file], { encoding: 'utf8' }));
  assert.deepEqual(out, rows.map(([r, a]) => scoreRules(a, r).cap));
});

function hasPython() {
  try { execFileSync('python3', ['--version']); return true; } catch { return false; }
}

// ── Richter-Script ──────────────────────────────────────────────────────
test('eval-judge: Richter über OpenAI-kompatiblen Endpunkt, gedeckelt auf das Regel-Maximum, Tabelle je Kategorie und holdout', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '{"score": 2, "reason": "passt"}' } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-judge-'));
  const evalRows = [
    { category: 'unknown', holdout: 'phrasing', judge: 'ablehnen', mustContainAny: [REFUSAL_MARKERS.de], mustNotContain: ['Hauptfigur'], messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Wer ist Aurelia?' }] },
    { category: 'figure', holdout: false, judge: 'Porträt', mustContainAny: [['Renate'], ['Gisela']], minAny: 2, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Wer ist Stefan?' }] },
  ];
  fs.writeFileSync(path.join(dir, 'eval.jsonl'), evalRows.map(r => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [{ i: 0, answer: 'Aurelia ist eine Hauptfigur.' }, { i: 1, answer: 'Stefan ist Renates Mann, Gisela ist seine Mutter.' }].map(r => JSON.stringify(r)).join('\n'));
  // Asynchron starten: der Fake-Endpunkt läuft in diesem Prozess.
  const { stdout: out } = await promisify(execFile)('node', [path.join(ROOT, 'scripts/eval-judge.js'), path.join(dir, 'eval.jsonl'), path.join(dir, 'a.jsonl'),
    '--endpoint', `http://127.0.0.1:${port}`, '--model', 'judge-model', '--out', path.join(dir, 'r.jsonl')], { encoding: 'utf8' });
  server.close();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].model, 'judge-model');
  assert.match(seen[0].messages[1].content, /Bewertungsanweisung: ablehnen/);
  const res = fs.readFileSync(path.join(dir, 'r.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(res[0].judge, 2);
  assert.equal(res[0].score, 0, 'verletztes mustNotContain bei einer Ablehnung: 0, egal was der Richter sagt');
  assert.equal(res[1].score, 2);
  assert.match(out, /\| unknown \| 1 \| 0 \/ 2 \| 0 % \|/);
  assert.match(out, /\| holdout:phrasing \| 1 \|/);
  assert.match(out, /\| Total \| 2 \| 2 \/ 4 \| 50 % \|/);
});
