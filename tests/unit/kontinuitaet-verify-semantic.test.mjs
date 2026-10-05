// Unit: semantischer Beleg-Fallback der Kontinuitäts-Verify-Stufe.
// (1) _verifyExcerpt signalisiert via `located`, ob das wörtliche Zitat gefunden
//     wurde (steuert den Fallback). (2) verifyKontinuitaetProbleme lädt bei NICHT
//     lokalisiertem Zitat die semantisch nächste Passage nach und speist sie in den
//     Verify-Prompt — statt auf den Kapitel-Anfang zurückzufallen. Best-effort/opt-in:
//     ohne Index/Backend bleibt der keyword-Pfad.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require_ = createRequire(import.meta.url);

useTmpDb('kont-verify');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
require_('../../db/connection');
require_('../../db/migrations').runMigrations();

const jobShared = require_('../../routes/jobs/komplett/job-shared');
const retrieval = require_('../../lib/semantic-retrieval');
const appSettings = require_('../../lib/app-settings');
const { _verifyExcerpt, verifyKontinuitaetProbleme, _semanticExcerpt } = jobShared;


const GROUPS = new Map([
  ['k1', { name: 'Kapitel Eins', pages: [{ id: 5, text: 'Der Wald lag still. Anna ging heim. Am Abend sprach sie mit dem Bruder ueber das Erbe.' }] }],
  ['k2', { name: 'Kapitel Zwei', pages: [{ id: 6, text: 'Ganz anderes Kapitel ueber das Meer.' }] }],
]);
const ORDER = ['k1', 'k2'];

test('_verifyExcerpt: wörtliches Zitat → located:true, Fenster um das Zitat', () => {
  const r = _verifyExcerpt(GROUPS, ORDER, ['Kapitel Eins'], 'Anna ging heim');
  assert.equal(r.located, true);
  assert.match(r.text, /Anna ging heim/);
});

test('_verifyExcerpt: Zitat nicht im Text → located:false, Kapitel-Anfang', () => {
  const r = _verifyExcerpt(GROUPS, ORDER, ['Kapitel Eins'], 'existiert hier nicht');
  assert.equal(r.located, false);
  assert.match(r.text, /Der Wald lag still/);
});

test('_verifyExcerpt: kein passendes Kapitel → leer, located:false', () => {
  const r = _verifyExcerpt(GROUPS, ORDER, ['Kapitel Drei'], 'egal');
  assert.deepEqual(r, { text: '', located: false });
});

function withRetrieval(mock, fn) {
  const orig = { indexReady: retrieval.indexReady, semanticQuery: retrieval.semanticQuery };
  Object.assign(retrieval, mock);
  return Promise.resolve().then(fn).finally(() => Object.assign(retrieval, orig));
}

function ctxFor(seen) {
  return {
    call: async (_j, _t, prompt) => { seen.push(prompt); return { bestaetigt: true }; },
    prompts: { buildKontinuitaetVerifyPrompt: (b, p, exA, exB) => ({ exA, exB }), SCHEMA_KONTINUITAET_VERIFY: {} },
    sys: { SYSTEM_KONTINUITAET_BLOCKS: '' },
    jobId: 'no-such-job', tok: { in: 0, out: 0 }, bookName: 'B',
    groups: GROUPS, groupOrder: ORDER, log: { info() {}, warn() {} }, bookIdInt: 77,
  };
}

test('verifyKontinuitaetProbleme: paraphrasiertes Zitat → Live-Passage aus dem Befund-Kapitel', async () => {
  const calls = [];
  await withRetrieval({
    indexReady: () => true,
    semanticQuery: async (bookId, q, opts) => {
      calls.push({ bookId, opts });
      return [
        // fremdes Kapitel, hoher Score → muss ignoriert werden
        { kind: 'page', entity_id: 6, text: 'Ganz anderes Kapitel ueber das Meer.', score: 0.9, semScore: 0.9 },
        // veralteter Chunk-Text derselben Stelle: Wegweiser, Ausschnitt kommt live
        { kind: 'page', entity_id: 5, text: 'Am Abend sprach sie mit dem Bruder über das Erbe', score: 0.5, semScore: 0.8 },
      ];
    },
  }, async () => {
    const seen = [];
    const out = await verifyKontinuitaetProbleme(ctxFor(seen),
      { zusammenfassung: 'z', probleme: [{ kapitel: ['Kapitel Eins'], stelle_a: '«steht so nicht im Buch»', stelle_b: '' }] }, 95, 97);
    assert.equal(out.probleme.length, 1);
    assert.equal(seen.length, 1);
    assert.match(seen[0].exA, /sprach sie mit dem Bruder ueber das Erbe/, 'Live-Text, nicht Chunk-Text');
    assert.doesNotMatch(seen[0].exA, /Meer/, 'kein Treffer aus fremdem Kapitel');
    assert.equal(seen[0].exB, '', 'leeres stelle_b → kein Ausschnitt');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].opts.kinds, ['page']);
    assert.equal(calls[0].bookId, 77);
  });
});

test('_semanticExcerpt: Cosinus unter embed.min_score bzw. ohne semScore → kein Beleg', async () => {
  const origGet = appSettings.get;
  appSettings.get = (k) => (k === 'embed.min_score' ? 0.5 : origGet(k));
  try {
    await withRetrieval({
      semanticQuery: async () => ([
        { kind: 'page', entity_id: 5, text: 'Anna ging heim', score: 0.03, semScore: 0.3 },
        { kind: 'page', entity_id: 5, text: 'Anna ging heim', score: 0.03, semScore: null },
      ]),
    }, async () => {
      const r = await _semanticExcerpt(77, 'Anna heim', new Map([[5, 'Der Wald lag still. Anna ging heim.']]), undefined);
      assert.equal(r, null);
    });
  } finally { appSettings.get = origGet; }
});

test('verifyKontinuitaetProbleme: semantisch nichts Belastbares → leerer Ausschnitt statt Kapitel-Anfang', async () => {
  await withRetrieval({ indexReady: () => true, semanticQuery: async () => [] }, async () => {
    const seen = [];
    const out = await verifyKontinuitaetProbleme(ctxFor(seen),
      { zusammenfassung: 'z', probleme: [{ kapitel: ['Kapitel Eins'], stelle_a: '«fehlt»', stelle_b: '«Anna ging heim»' }] }, 95, 97);
    assert.equal(out.probleme.length, 1);
    assert.equal(seen[0].exA, '', 'kein Pseudo-Beleg');
    assert.match(seen[0].exB, /Anna ging heim/, 'wörtlich gefundene Seite bleibt');
  });
});

test('verifyKontinuitaetProbleme: ohne Index → keyword-Pfad, keine semantische Suche', async () => {
  let searched = false;
  await withRetrieval({ indexReady: () => false, semanticQuery: async () => { searched = true; return []; } }, async () => {
    const seen = [];
    const out = await verifyKontinuitaetProbleme(ctxFor(seen),
      { zusammenfassung: 'z', probleme: [{ kapitel: ['Kapitel Eins'], stelle_a: '«fehlt im Text»', stelle_b: '' }] }, 95, 97);
    assert.equal(out.probleme.length, 1);
    assert.equal(searched, false);
    assert.match(seen[0].exA, /Der Wald lag still/, 'keyword-Fallback (Kapitel-Anfang) bleibt');
  });
});

test('_verifyExcerpt: Kapitel als Objekt ({ name }) und abweichende Anführungs-/Strichformen', () => {
  const r = _verifyExcerpt(GROUPS, ORDER, [{ name: 'Kapitel Eins' }], '„Am  Abend sprach sie\nmit dem Bruder“');
  assert.equal(r.located, true);
  assert.match(r.text, /Am Abend sprach sie mit dem Bruder/);
});

test('verifyKontinuitaetProbleme: Zeitlücke ohne beide Belege → ungeprüft stehen lassen (kein Call)', async () => {
  await withRetrieval({ indexReady: () => false }, async () => {
    const seen = [];
    const out = await verifyKontinuitaetProbleme(ctxFor(seen),
      { zusammenfassung: 'z', probleme: [{ typ: 'zeitluecke', kapitel: ['Kapitel Eins'], stelle_a: '«Anna ging heim»', stelle_b: '«steht so nirgends im Text»' }] }, 95, 97);
    assert.equal(out.probleme.length, 1);
    assert.equal(seen.length, 0);
  });
});

test('verifyKontinuitaetProbleme: Anachronismus — kein Ausschnitt B (stelle_b ist das Erzähljahr)', async () => {
  await withRetrieval({ indexReady: () => false }, async () => {
    const seen = [];
    await verifyKontinuitaetProbleme(ctxFor(seen),
      { zusammenfassung: 'z', probleme: [{ typ: 'anachronismus', kapitel: ['Kapitel Eins'], stelle_a: '«Anna ging heim»', stelle_b: '1985' }] }, 95, 97);
    assert.equal(seen.length, 1);
    assert.match(seen[0].exA, /Anna ging heim/);
    assert.equal(seen[0].exB, '');
  });
});

test('Verify-Schema und -Prompt: grund vor bestaetigt; Prüffrage typabhängig', async () => {
  const m = await import('../../public/js/prompts/komplett/schemas.js');
  assert.deepEqual(Object.keys(m.SCHEMA_KONTINUITAET_VERIFY.properties), ['grund', 'bestaetigt']);
  const { buildKontinuitaetVerifyPrompt: b } = await import('../../public/js/prompts/komplett/kontinuitaet.js');
  const zl = b('B', { typ: 'zeitluecke', beschreibung: 'x' }, 'a', 'b');
  assert.match(zl, /unmarkiert/);
  assert.ok(zl.indexOf('"grund"') < zl.indexOf('"bestaetigt"'));
  const an = b('B', { typ: 'anachronismus', beschreibung: 'x', stelle_b: '1985' }, 'a', 'b');
  assert.match(an, /NACH der angegebenen Erzählzeit/);
  assert.doesNotMatch(an, /rund um Stelle B/);
  assert.match(b('B', { typ: 'figur' }, 'a', 'b'), /Widerspruch WIRKLICH besteht/);
});
