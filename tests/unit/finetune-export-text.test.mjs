// Unit: Finetune-Export — Schnitte an Satzgrenzen, Unicode-Namensgrenzen,
// all.jsonl, Testprompts, Modelfile-Gleichstand und Antworten im Buchton.
//
// Jede dieser Stellen ging still kaputt, ohne dass ein Export fehlschlug:
// harte Zeichen-Schnitte liessen Antworten mitten im Wort enden (und den Rest
// langer Abschnitte weg), `\b` fand keinen Namen mit Umlaut am Rand, und ein
// Modelfile mit anderem System-Prompt als im Training kostet die Persona.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';
import { buildModelfile, MODELFILE_TEMPLATE } from '../../public/js/book/finetune-modelfile.js';

const require = createRequire(import.meta.url);
useTmpDb('ft-text');
const schema = require('../../db/schema');
const shared = require('../../routes/jobs/shared');
const { clipAtSentence, tailFromSentence, chunkAtSentence } = require('../../routes/jobs/finetune-export/lib/text.js');
const { nameRegex, findSpeaker } = require('../../routes/jobs/finetune-export/lib/names.js');
const { buildSceneSamples } = require('../../routes/jobs/finetune-export/samples/scene.js');
const { finalizeFinetuneSamples } = require('../../routes/jobs/finetune-export/finalize.js');
const { buildEvalPrompts } = require('../../routes/jobs/finetune-export/lib/eval-prompts.js');
const { hashSplit } = require('../../routes/jobs/finetune-export/lib/names.js');

const sentences = (n, from = 0) => Array.from({ length: n }, (_, i) => `Satz Nummer ${from + i + 1} erzählt etwas vom langen Tag am See.`).join(' ');
const endsClean = (s) => /[.!?…»«“"]$/.test(s);

test('clipAtSentence/tailFromSentence: nie über dem Deckel, nie mitten im Satz', () => {
  const text = sentences(40);
  for (const max of [100, 333, 1000]) {
    const head = clipAtSentence(text, max);
    assert.ok(head.length <= max && endsClean(head), `${max}: ${head.slice(-30)}`);
    const tail = tailFromSentence(text, max);
    assert.ok(tail.length <= max && /^Satz/.test(tail), `${max}: ${tail.slice(0, 30)}`);
  }
  assert.equal(clipAtSentence('kurz.', 100), 'kurz.');
  // Ohne Satzgrenze: Wortgrenze statt Wortmitte.
  assert.equal(clipAtSentence('aaaa bbbb cccc dddd eeee ffff', 17), 'aaaa bbbb cccc');
});

test('chunkAtSentence: deckt den ganzen Text ab, jedes Stück unter dem Deckel', () => {
  const text = sentences(60);
  const chunks = chunkAtSentence(text, 300);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 300 && endsClean(c));
  assert.equal(chunks.join(' '), text);
});

test('nameRegex: Namen mit Umlaut/Akzent am Rand, keine Teilwörter', () => {
  assert.ok(nameRegex('Ömer').test('Da sagte Ömer leise etwas.'));
  assert.ok(nameRegex('René').test('René nickte.'));
  assert.ok(nameRegex('Zoë').test('Und dann kam Zoë, endlich.'));
  assert.ok(!nameRegex('Anna').test('Annalena lachte.'));
  assert.ok(!nameRegex('Jörg').test('Jörgensen kam.'));
  const text = '»Ich bleibe hier«, sagte Ömer. René war längst gegangen.';
  assert.equal(findSpeaker(text, 0, text.indexOf('«') + 1, ['Ömer', 'René']), 'Ömer');
});

function sceneCtx(pageText, maxChars) {
  return {
    samples: [], counts: { scene: 0 }, langIsEn: false, unifiedSys: 'SYS', bookName: 'Buch',
    bookIdInt: 1, userEmail: 'x@test.dev',
    opts: { minChars: 200, maxChars, maxFullChars: 8000, fulltext: false },
    pageContents: [{ id: 1, chapter_id: 5, chapter: 'Kap', title: 'Abschnitt', text: pageText }],
    pageTextById: new Map([[1, pageText]]), pageChapterById: new Map([[1, 'Kap']]),
    sceneRows: [], figsByScene: new Map(), locsByScene: new Map(), figById: new Map(), locById: new Map(),
    chapterKeys: [], chapterFullTextByKey: new Map(), chapterNameByKey: new Map(), pagesByChapter: new Map(),
    figRows: [], locRows: [], appearancesByFigPk: new Map(), chaptersByLocPk: new Map(),
  };
}

test('Szenen-Sampler: langer Abschnitt in Teilen, keine Antwort endet mitten im Wort', () => {
  const text = sentences(200); // ~10000 Zeichen
  const ctx = sceneCtx(text, 2000);
  buildSceneSamples(ctx);
  const answers = ctx.samples.map(s => s.messages.at(-1).content);
  for (const a of answers) assert.ok(endsClean(a), a.slice(-40));
  const parts = ctx.samples.filter(s => s.id.startsWith('page|'));
  assert.ok(parts.length >= 4, 'mehrere Teile');
  assert.match(parts[1].messages[1].content, /Teil 2 von/);
  assert.ok(parts.every(s => s.noTruncate));
  assert.ok(answers.some(a => a.includes('Satz Nummer 200 ')), 'auch das Ende des Abschnitts ist trainiert');
});

test('finalize: all.jsonl = train + val, leer ohne val', () => {
  const samples = Array.from({ length: 60 }, (_, i) => ({
    id: 's' + i, type: 'style', sourceKey: 'ch:' + (i % 30),
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'u' + i }, { role: 'assistant', content: 'a' + i }],
  }));
  const run = (valSplit) => finalizeFinetuneSamples({
    samples, langIsEn: false, opts: { valSplit, valSeed: 0, maxSeqTokens: 0, emitText: false, truncateLong: false },
  });
  const r = run(0.3);
  const lines = (s) => s.trim().split('\n').filter(Boolean);
  assert.ok(r.stats.val > 0);
  assert.equal(lines(r.allJsonl).length, r.stats.train + r.stats.val);
  assert.deepEqual(new Set(lines(r.allJsonl)), new Set([...lines(r.trainJsonl), ...lines(r.valJsonl)]));
  assert.equal(run(0).allJsonl, '');
});

test('Testprompts: Holdout-Markierung folgt dem Split von finalize', () => {
  const chapterKeys = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const ctx = {
    langIsEn: false, unifiedSys: 'SYS', opts: { valSplit: 0.3, valSeed: 0 },
    figRows: [{ fig_id: 'a', name: 'Anna' }, { fig_id: 'b', name: 'Ben' }],
    figById: new Map([['a', { name: 'Anna' }], ['b', { name: 'Ben' }]]),
    figRelRows: [{ from_fig_id: 'a', to_fig_id: 'b' }],
    chapterKeys,
    chapterNameByKey: new Map(chapterKeys.map(k => [k, 'Kapitel ' + k])),
    chapterFullTextByKey: new Map(chapterKeys.map(k => [k, sentences(20, k * 100)])),
    pageContents: chapterKeys.map(k => ({ id: k, chapter_id: k, text: sentences(5) })),
    sceneRows: [], figsByScene: new Map(),
  };
  const rows = buildEvalPrompts(ctx);
  const cats = new Set(rows.map(r => r.category));
  for (const c of ['figure', 'relation', 'chapter', 'continuation', 'newChapter', 'offTopic']) assert.ok(cats.has(c), c);
  assert.ok(!cats.has('reverseLookup'), 'keine Abschnitt-Suche');
  for (const r of rows) assert.equal(r.messages[0].content, 'SYS');
  const val = (k) => hashSplit('ch:' + k, 0) < 0.3;
  for (const r of rows.filter(r => r.category === 'continuation')) {
    const k = chapterKeys.find(k => r.messages[1].content.includes(ctx.chapterFullTextByKey.get(k).split('.')[0] + '.'));
    assert.equal(r.holdout, val(k));
  }
});

test('Modelfile: Muster in der Doku == Generator, Template ohne literales <s>', () => {
  const doc = fs.readFileSync(new URL('../../docs/unsloth-config/Modelfile.example', import.meta.url), 'utf8');
  const body = (s) => s.split('\n').filter(l => !l.startsWith('#')).join('\n').trim();
  const sys = /SYSTEM """([\s\S]*?)"""/.exec(doc)[1];
  assert.equal(body(doc), body(buildModelfile({ systemPrompt: sys })));
  assert.ok(!MODELFILE_TEMPLATE.includes('<s>'));
  assert.match(buildModelfile({ systemPrompt: 'Du bist die Stimme von «X».' }), /SYSTEM """Du bist die Stimme von «X»\."""/);
});

test('Buchton: neue Antwort ersetzt die Analyse-Antwort in allen Samples der Entität', async () => {
  const BOOK = 732;
  const USER = 'ftvoice@test.dev';
  schema.db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(USER);
  schema.upsertBookByName(BOOK, 'Finetune-Buchton');
  const calls = [];
  const orig = shared.aiCall;
  // ai-augment.js zieht aiCall beim Laden aus shared → vorher ersetzen.
  shared.aiCall = async (_job, _tok, prompt) => {
    calls.push(prompt);
    return { antwort: prompt.includes('«Anna»') ? 'Anna, die stets zu früh kam, führte den Laden am Markt.' : '' };
  };
  delete require.cache[require.resolve('../../routes/jobs/finetune-export/samples/ai-augment.js')];
  const { rewriteAnswersInBookVoice } = require('../../routes/jobs/finetune-export/samples/ai-augment.js');
  const prompts = await import('../../public/js/prompts.js');
  const analysis = 'Anna ist Ladenbesitzerin. Beruf: Händlerin.';
  const qa = (id, key) => ({ id, type: 'authorChat', voiceKey: key,
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Wer ist Anna?' }, { role: 'assistant', content: analysis }] });
  const samples = [qa('a1', 'fig:a'), qa('a2', 'fig:a'), qa('b1', 'fig:b')];
  const ctx = {
    samples, counts: {}, langIsEn: false, bookName: 'Buch', bookIdInt: BOOK, userEmail: USER,
    voiceTargets: new Map([['fig:a', { kind: 'figure', name: 'Anna', text: analysis }],
                           ['fig:b', { kind: 'figure', name: 'Ben', text: 'Ben ist Bäcker.' }]]),
    pageContents: [{ id: 1, text: 'Anna stand schon vor sieben im Laden und zählte die Münzen, eine nach der anderen, bis der Kaffee kalt war und draussen die ersten Marktfahrer ihre Stände aufbauten, laut und gut gelaunt wie jeden Dienstag.' }],
    prompts, augmentSystem: 'SYS', versionTag: 't', jobId: 'j', tok: { in: 0, out: 0, ms: 0 },
    logger: { info() {}, warn() {} },
  };
  try {
    await rewriteAnswersInBookVoice(ctx);
  } finally {
    shared.aiCall = orig;
  }
  assert.equal(samples[0].messages.at(-1).content, 'Anna, die stets zu früh kam, führte den Laden am Markt.');
  assert.equal(samples[1].messages.at(-1).content, samples[0].messages.at(-1).content);
  assert.equal(samples[2].messages.at(-1).content, analysis, 'leere KI-Antwort behält die Analyse-Antwort');
  assert.equal(ctx.counts.voiceRewritten, 2);
  assert.ok(calls.find(p => p.includes('«Anna»')).includes('zählte die Münzen'), 'Originalpassage als Stilprobe');
});
