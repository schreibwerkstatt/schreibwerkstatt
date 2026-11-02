// Unit: KI-Warum-Fragen (docs/finetuning.md#warum-familie): je Warum-Karte
// Leserfragen per KI, Antworten sind geprüfte Fassungen der Karte, die noch
// keine Vorlagen-Frage trägt; Fragen ohne
// alle Namen, mit fremdem Namen oder mit zitiertem Titel fallen weg; der
// zweite Lauf trifft den Cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('ft-why-ai');
const schema = require('../../db/schema');
const shared = require('../../routes/jobs/shared');
const prompts = await import('../../public/js/prompts.js');

// ai-paraphrase.js zieht aiCall/getPrompts beim Laden aus shared → vorher ersetzen.
const calls = [];
let reply = () => ({ varianten: [] });
shared.aiCall = async (_job, _tok, prompt) => { calls.push(prompt); return reply(prompt); };
shared.getPrompts = async () => prompts;

const { makeCoreHelpers } = require('../../routes/jobs/finetune-export/samples/core-facts/variants.js');
const { buildEventWhy } = require('../../routes/jobs/finetune-export/samples/core-facts/why.js');
const { buildAiWhyQuestions } = require('../../routes/jobs/finetune-export/samples/core-facts/ai-paraphrase.js');

const BOOK = 742;
const USER = 'ftwhy@test.dev';
schema.db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(USER);
schema.upsertBookByName(BOOK, 'Finetune-Warum');

const F = (fig_id, name) => ({ fig_id, name, names: [name] });
const figRows = [
  { fig_id: 'f1', name: 'Stefan', typ: 'hauptfigur', motivation: 'Äusserlich will er Kontrolle über seine Frau.', konflikt: 'Er lebt ein Doppelleben aus Alkohol und Gewalt.' },
  { fig_id: 'f2', name: 'Renate', typ: 'hauptfigur', motivation: '', konflikt: '' },
  { fig_id: 'f3', name: 'Gisela', typ: 'nebenfigur', motivation: '', konflikt: '' },
];
const events = [
  { i: 3, ereignis: 'Stefan vergewaltigt Renate am Chilbi-Abend', year: 1994, figs: [F('f1', 'Stefan'), F('f2', 'Renate')], bedeutung: 'Er überschreitet die Grenze zur offenen Gewalt.' },
];
const makeCtx = () => {
  const ctx = {
    langIsEn: false, events, figRows, samples: [], counts: { core: 0 }, unifiedSys: 'S', bookName: 'Der Amoklauf',
    bookIdInt: BOOK, userEmail: USER, jobId: null, aiModel: 'test-model',
    logger: { info() {}, warn() {} },
    opts: { valSeed: 1, factParaphrases: 4 },
    tierByFig: new Map([['f1', 'main'], ['f2', 'main']]), figNameInfo: new Map(),
  };
  const { emitCard } = makeCoreHelpers(ctx);
  buildEventWhy(ctx, emitCard);
  return ctx;
};

test('KI-Warum-Fragen: Leserfragen übernommen, Antworten aus der Karte, Prüfung der Namen', async () => {
  reply = () => ({ varianten: [
    'Warum hat Stefan Renate vergewaltigt?',
    'Was hat Stefan dazu gebracht, Renate am Chilbi-Abend Gewalt anzutun?',
    'Warum hat Stefan das getan?',                       // Renate fehlt
    'Warum hat Stefan Gisela und Renate verletzt?',      // fremder Name
    'Warum passiert «Stefan vergewaltigt Renate»?',      // zitierter Titel
  ] });
  const ctx = makeCtx();
  const cardAnswers = new Set(ctx.samples.map(s => s.messages[2].content));
  const before = ctx.samples.length;
  const added = await buildAiWhyQuestions(ctx);
  assert.equal(added, 2);
  const neu = ctx.samples.slice(before);
  assert.deepEqual(neu.map(s => s.messages[1].content), [
    'Warum hat Stefan Renate vergewaltigt?',
    'Was hat Stefan dazu gebracht, Renate am Chilbi-Abend Gewalt anzutun?',
  ]);
  const pool = new Set(ctx.whyAnswers.get('evt:3:motive'));
  for (const s of neu) {
    // Eine Fassung der Karte, die noch keine Vorlagen-Frage trägt: je Frage
    // eine eigene Antwort (why.js).
    assert.ok(pool.has(s.messages[2].content), 'Antwort ist eine geprüfte Fassung der Karte');
    assert.ok(!cardAnswers.has(s.messages[2].content), 'nicht dieselbe Antwort wie eine Vorlagen-Frage');
    assert.equal(s.task, 'eventWhy');
    assert.equal(s.factId, 'evt:3:motive');
    assert.ok(s.aiParaphrase);
  }
  assert.match(calls.at(-1), /Stefan vergewaltigt Renate am Chilbi-Abend/);
  assert.match(calls.at(-1), /warum Stefan so handelt/);

  // Zweiter Lauf: Cache, kein neuer Call.
  const n = calls.length;
  await buildAiWhyQuestions(makeCtx());
  assert.equal(calls.length, n);
});
