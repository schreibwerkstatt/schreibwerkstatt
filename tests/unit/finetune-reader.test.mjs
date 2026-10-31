// Unit: Finetune-Export, Zielgruppe «Leser» (docs/finetuning.md#leser-modell).
//
// Was hier still kaputtgehen würde, ohne dass ein Export fehlschlägt: ein
// erfundener «unbekannter» Name, der im Buch doch vorkommt (das Modell lernte,
// eine echte Figur zu leugnen); eine KI-Deutung ohne prüfbaren Beleg (klingt im
// Buchton wie Kanon); ein Gespräch, das Buchtext aus Train- und Val-Kapiteln
// mischt (Holdout aufgerissen); Werkstatt-Notizen, die als i18n-Marker im
// Training landen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('ft-reader');
const schema = require('../../db/schema');
const shared = require('../../routes/jobs/shared');
const prompts = await import('../../public/js/prompts.js');

// reader/ai.js zieht aiCall/getPrompts beim Laden aus shared → vorher ersetzen.
let aiReply = () => ({ paare: [] });
const aiPrompts = [];
shared.aiCall = async (_job, _tok, prompt) => { aiPrompts.push(prompt); return aiReply(prompt); };
shared.getPrompts = async () => prompts;

const { createDraftFigure } = require('../../db/draft-figures');
const { collectNotes } = require('../../routes/jobs/finetune-export/samples/reader/figures.js');
const { unknownNames } = require('../../routes/jobs/finetune-export/samples/reader/boundaries.js');
const { buildReaderConversations: runConversations } = require('../../routes/jobs/finetune-export/samples/reader/conversations.js');
const { makeReaderPush } = require('../../routes/jobs/finetune-export/samples/reader/push.js');
const {
  buildReaderSamples, buildReaderAiSamples, buildReaderConversations, buildReaderSystem,
} = require('../../routes/jobs/finetune-export/samples/reader/index.js');
const { buildEvalPrompts } = require('../../routes/jobs/finetune-export/lib/eval-prompts.js');

const BOOK = 741;
const USER = 'ftreader@test.dev';
schema.db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(USER);
schema.upsertBookByName(BOOK, 'Finetune-Leser');

const mindmap = (subtext) => ({
  meta: {}, format: 'node_tree',
  data: { id: 'root', topic: 'Anna', children: [
    { id: 'steckbrief', topic: '__i18n:werkstatt.tree.steckbrief__', children: [
      { id: 'bogen', topic: '__i18n:werkstatt.tree.bogen__', children: [{ id: 'b1', topic: 'lernt loszulassen' }] },
    ] },
    { id: 'subtext', topic: '__i18n:werkstatt.tree.subtext__', children: [
      { id: 'want', topic: '__i18n:werkstatt.tree.want__', children: subtext.want.map((t, i) => ({ id: 'w' + i, topic: t })) },
      { id: 'wound', topic: '__i18n:werkstatt.tree.wound__', children: [
        { id: 'wd', topic: 'Tod der Mutter', children: [{ id: 'wd1', topic: 'am Bahnhof' }] },
      ] },
    ] },
  ] },
});

const PAGE_TEXT = 'Anna stand am Fenster und sah dem Zug nach, der ihre Mutter nie zurückgebracht hatte. «Ich gehe nicht mehr zum Bahnhof», sagte sie leise.';

function makeCtx(extra = {}) {
  const figRows = [
    { fig_id: 'anna', pk: 1, name: 'Anna', typ: 'hauptfigur', beschreibung: 'Ladenbesitzerin am Markt.' },
    { fig_id: 'ben', pk: 2, name: 'Ben', typ: 'nebenfigur', beschreibung: 'Bäcker.' },
  ];
  return {
    jobId: 'j', logger: { info() {}, warn() {} },
    bookIdInt: BOOK, bookName: 'Finetune-Leser', userEmail: USER,
    langIsEn: false, displayName: 'Finetune-Leser',
    unifiedSys: buildReaderSystem('Finetune-Leser', false),
    opts: { valSeed: 0, valSplit: 0.3, minChars: 40, ai: {} },
    counts: {}, samples: [], voiceTargets: new Map(),
    figRows, figById: new Map(figRows.map(f => [f.fig_id, f])),
    locRows: [{ name: 'Marktplatz' }],
    dialogsByFigure: new Map([['anna', [
      { quote: 'Ich gehe nicht mehr zum Bahnhof', chapterId: 1 },
      { quote: 'Der Laden macht um acht auf', chapterId: 1 },
      { quote: 'Mutter hätte gelacht', chapterId: 2 },
      { quote: ', sagte sie, und dann schwieg sie lange', chapterId: 2 },
    ]]]),
    sceneRows: [{ id: 5, titel: 'Am Fenster', kapitel: 'Eins', page_id: 10 }],
    figsByScene: new Map([[5, ['anna']]]),
    pageTextById: new Map([[10, PAGE_TEXT]]),
    pageContents: [{ id: 10, chapter_id: 1, chapter: 'Eins', text: PAGE_TEXT }],
    figRelRows: [], chapterKeys: [1], chapterNameByKey: new Map([[1, 'Eins']]),
    chapterFullTextByKey: new Map([[1, PAGE_TEXT]]),
    ...extra,
  };
}

test('collectNotes: nur Notizen des Autors, keine i18n-Marker, Unterknoten mit Eltern', () => {
  const notes = collectNotes(mindmap({ want: ['Anerkennung vom Vater'] }));
  assert.deepEqual(notes.want, ['Anerkennung vom Vater']);
  assert.deepEqual(notes.wound, ['Tod der Mutter', 'Tod der Mutter: am Bahnhof']);
  assert.deepEqual(notes.bogen, ['lernt loszulassen']);
  assert.ok(!JSON.stringify(notes).includes('__i18n:'));
});

test('unknownNames: kein erfundener Name, dessen Wort im Buch vorkommt', () => {
  const kept = unknownNames(['Konrad Albisser', 'Helene Brunnmeier'], 'konrad ging nach hause.');
  assert.deepEqual(kept, ['Helene Brunnmeier']);
});

// Werkstatt-Figur zur Katalog-Hauptfigur Anna (Verknüpfung per Name).
createDraftFigure(BOOK, USER, { name: 'Anna', mindmap: mindmap({ want: ['Anerkennung vom Vater', 'ein eigenes Haus'] }) });

test('Leser-Samples: Innenleben aus der Werkstatt, Stimm-Anker, Grenzen', () => {
  const ctx = makeCtx();
  buildReaderSamples(ctx);
  const ids = ctx.samples.map(s => s.id);
  assert.ok(ctx.samples.every(s => s.type === 'reader' && s.messages[0].content === ctx.unifiedSys));

  const want = ctx.samples.find(s => s.id.startsWith('reader|psyche|fig:anna|want|'));
  assert.match(want.messages[2].content, /Anerkennung vom Vater; ein eigenes Haus/);
  assert.equal(want.convKey, 'fig:anna');
  assert.ok(ctx.voiceTargets.has(want.voiceKey), 'Psyche-Antwort für den Buchton angemeldet');
  assert.ok(ids.some(id => id.startsWith('reader|psycheAll|fig:anna|')), 'Übersicht ab zwei Kernen');

  // Stimm-Anker: wörtliche Dialogzeilen, Split mit ihrem Kapitel.
  const voice = ctx.samples.filter(s => s.id.startsWith('reader|personaVoice|'));
  assert.deepEqual(voice.map(s => s.sourceKey).sort(), ['ch:1', 'ch:2']);
  assert.ok(!voice.some(s => s.messages[2].content.includes('sagte sie')), 'Erzählfetzen ist keine Rede');
  assert.match(voice[0].messages[1].content, /Anna/);

  for (const kind of ['unknownFig', 'unknownPlace', 'afterEnd', 'offTopic', 'meta', 'jailbreak']) {
    assert.ok(ids.some(id => id.startsWith(`reader|${kind}|`)), kind);
  }
  const off = ctx.samples.find(s => s.id.startsWith('reader|offTopic|'));
  assert.match(off.messages[2].content, /Finetune-Leser/);
  // Ben ist Nebenfigur ohne Werkstatt → keine Ich-Form, keine Psyche.
  assert.ok(!ids.some(id => id.includes('fig:ben')));
});

test('KI-Phasen: Paare ohne auffindbaren Beleg fallen weg, Ich-Form mit Einstieg', async () => {
  const ctx = makeCtx({ opts: { ...makeCtx().opts, ai: { persona: true, deutung: true } } });
  buildReaderSamples(ctx);
  aiPrompts.length = 0;
  aiReply = (prompt) => prompt.includes('Ich-Form')
    ? { paare: [
        { frage: 'Warum meidest du den Bahnhof?', antwort: 'Weil dort alles endete, was ich hatte.', beleg: 'Ich gehe nicht mehr zum Bahnhof' },
        { frage: 'Hast du Geschwister?', antwort: 'Drei Brüder, alle in Amerika verschollen.', beleg: 'Meine Brüder sind in Amerika' },
      ] }
    : { paare: [
        { frage: 'Warum sieht Anna dem Zug nach?', antwort: 'Sie wartet noch immer: «der ihre Mutter nie zurückgebracht hatte».', beleg: 'der ihre Mutter nie zurückgebracht hatte' },
        { frage: 'Warum hasst Anna Züge?', antwort: 'Ein Zug hat ihr einmal den Koffer gestohlen, sagt sie.', beleg: 'Ein Zug stahl ihren Koffer' },
      ] };
  await buildReaderAiSamples(ctx);
  const persona = ctx.samples.filter(s => s.id.startsWith('reader|persona|'));
  assert.equal(persona.length, 1);
  assert.match(persona[0].messages[1].content, /Anna.*Warum meidest du den Bahnhof\?/);
  const deutung = ctx.samples.filter(s => s.id.startsWith('reader|deutung|'));
  assert.equal(deutung.length, 1);
  assert.equal(deutung[0].sourceKey, 'ch:1');
  assert.equal(ctx.personaPairs.get('fig:anna').pairs.length, 1);
  assert.ok(aiPrompts.some(p => p.includes('Anerkennung vom Vater')), 'Werkstatt-Notizen im Material');
});

test('Gespräche: drei Runden je Thema, kein Mix von Buchtext aus zwei Kapiteln', () => {
  const ctx = makeCtx({ readerFigures: [{ key: 'fig:anna', name: 'Anna' }] });
  ctx.personaPairs = new Map([['fig:anna', { name: 'Anna', pairs: [['Wer bist du?', 'A1'], ['Was willst du?', 'A2'], ['Wen liebst du?', 'A3']] }]]);
  const push = makeReaderPush(ctx);
  const qa = (i, sourceKey) => push({ id: 'x' + i, turns: [[`Frage ${i}?`, `Antwort ${i}`]], sourceKey, convKey: 'fig:anna' });
  qa(1); qa(2); qa(3, 'ch:1'); qa(4, 'ch:2'); qa(5); qa(6);
  push({ id: 'y1', turns: [['Wer ist Ben?', 'Bäcker']], convKey: 'fig:ben' });
  push({ id: 'y2', turns: [['Was macht Ben?', 'backt']], convKey: 'fig:ben' });
  push({ id: 'y3', turns: [['Wo wohnt Ben?', 'am Markt']], convKey: 'fig:ben' });
  runConversations(ctx, push);
  assert.ok(!ctx.samples.some(s => s.id.startsWith('reader|conv|fig:ben')), 'keine Gespräche über Nebenfiguren');
  const convs = ctx.samples.filter(s => s.id.startsWith('reader|conv|'));
  assert.ok(convs.length >= 1);
  for (const c of convs) {
    assert.equal(c.messages.length, 7);
    const answers = c.messages.filter(m => m.role === 'assistant').map(m => m.content);
    assert.ok(!(answers.includes('Antwort 3') && answers.includes('Antwort 4')), 'zwei Kapitel gemischt');
    if (answers.includes('Antwort 3')) assert.equal(c.sourceKey, 'ch:1');
    if (answers.includes('Antwort 4')) assert.equal(c.sourceKey, 'ch:2');
  }
  const pconv = ctx.samples.find(s => s.id === 'reader|personaConv|fig:anna|0');
  assert.match(pconv.messages[1].content, /Anna/);
  assert.match(pconv.messages.at(-2).content, /wieder mit dem Buch/, 'Rückweg zum Buch');
});

test('Testprompts Leser: Innenleben, Ich-Form, Warum, Unbekanntes, Off-Topic — keine Abschnitt-Suche', () => {
  const ctx = makeCtx();
  buildReaderSamples(ctx);
  const cats = new Set(buildEvalPrompts(ctx).map(r => r.category));
  for (const c of ['psyche', 'persona', 'why', 'unknown', 'offTopic']) assert.ok(cats.has(c), c);
  assert.ok(!cats.has('reverseLookup'));
});

test('Prompts: Belegpflicht und Anzahl im gebauten Prompt', () => {
  const p = prompts.buildFinetunePersonaPrompt({ name: 'Anna', bookName: 'B', material: 'M', count: 5 });
  assert.match(p, /5 Fragen/);
  assert.match(p, /beleg/);
  const d = prompts.buildFinetuneDeutungPrompt({ passage: 'P', count: 3, langIsEn: true });
  assert.match(d, /3 questions/);
  assert.match(d, /word for word/);
});

const { buildFigureDepthSamples, arcProse } = require('../../routes/jobs/finetune-export/samples/author-chat/depth.js');
const { loadReaderFigures, personaMaterial } = require('../../routes/jobs/finetune-export/samples/reader/figures.js');

test('Tiefe-Felder der Analyse: Bogen als Prosa, Analyse-Prosa im Buchton angemeldet, Zitate wörtlich', () => {
  const f = {
    fig_id: 'stefan', name: 'Stefan',
    motivation: 'Er will Kontrolle über sein Leben.', konflikt: 'Er schwankt zwischen Trotz und Scham.',
    arc: JSON.stringify({ typ: 'bogen', anfang: 'Ein unauffälliges Kind.', wendepunkte: ['Das Militär gibt ihm Halt.'], ende: 'Er verliert alles.' }),
    schluesselzitate: JSON.stringify(['«Nein, ich bin kein Bürogummi», erwiderte Stefan entschieden.']),
  };
  assert.equal(arcProse(f), 'Ein unauffälliges Kind. Das Militär gibt ihm Halt. Er verliert alles.');
  assert.equal(arcProse({ arc: null, entwicklung: 'Vom Kind zum Täter.' }), 'Vom Kind zum Täter.');
  const samples = [];
  const voiced = new Map();
  const pushQA = (id, q, a, sourceKey, voice) => { samples.push({ id, q, a }); if (voice) voiced.set(id, voice.key); };
  buildFigureDepthSamples({ langIsEn: false, figRows: [f], pushQA });
  const byQ = (q) => samples.find(s => s.q === q);
  assert.equal(byQ('Was treibt Stefan an?').a, f.motivation);
  assert.equal(byQ('Wie verändert sich Stefan im Lauf der Geschichte?').a, arcProse(f));
  assert.equal(byQ('Was geht in Stefan vor?').a, `${f.motivation} ${f.konflikt}`);
  const quote = samples.find(s => s.id.startsWith('authorChat|figQuote|stefan|'));
  assert.equal(quote.a, '«Nein, ich bin kein Bürogummi», erwiderte Stefan entschieden.');
  assert.ok(!voiced.has(quote.id), 'Zitat bleibt wörtlich');
  assert.ok(voiced.has(samples.find(s => s.q === 'Womit ringt Stefan?').id));
  assert.ok(!samples.some(s => s.id.includes('|aeusseres|')), 'leeres Feld → kein Sample');
  const filler = [];
  buildFigureDepthSamples({ langIsEn: false, figRows: [{ fig_id: 't', name: 'Tom', motivation: 'Will Anerkennung.', konflikt: 'Kein expliziter Konflikt.' }],
    pushQA: (id, q, a) => filler.push({ id, a }) });
  assert.ok(!filler.some(s => /Kein expliziter/.test(s.a)), 'Leerformel der Analyse ist kein Wissen');
  const { figureDepth } = require('../../routes/jobs/finetune-export/samples/author-chat/depth.js');
  assert.equal(figureDepth({ motivation: 'Nicht Geld treibt ihn, sondern Scham.' }).motivation, 'Nicht Geld treibt ihn, sondern Scham.');
  assert.equal(figureDepth({ konflikt: 'unbekannt' }).konflikt, '');
  assert.equal(figureDepth({ konflikt: 'No explicit conflict.' }).konflikt, '');
});

test('Tragende Figuren ohne Werkstatt: Präsenz «zentral» zählt, Analyse speist die Ich-Form', () => {
  const ctx = makeCtx();
  ctx.figRows.push({ fig_id: 'rene', pk: 3, name: 'Renate', typ: 'nebenfigur', praesenz: 'zentral',
    motivation: 'Sie will weg aus dem Dorf.', stimme: 'Leise, spöttisch.' });
  ctx.figById.set('rene', ctx.figRows.at(-1));
  const figs = loadReaderFigures(ctx);
  const renate = figs.find(r => r.key === 'fig:rene');
  assert.ok(renate, 'Präsenz zentral → tragend');
  assert.ok(!figs.some(r => r.key === 'fig:ben'), 'Nebenfigur bleibt draussen');
  const material = personaMaterial(renate, false);
  assert.match(material, /Motivation: Sie will weg aus dem Dorf\./);
  assert.match(material, /Sprechweise: Leise, spöttisch\./);
});
