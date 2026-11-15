'use strict';
// Lektorat in Stücken (lib/lektorat-chunks.js + routes/jobs/lektorat-split.js).
//
// Lange Abschnitte prüft der Split je Stück von ~7'000 Zeichen (Objektiv + Stil
// ohne Bewertung), dazu EIN Bewertungs-Pass über den ganzen Abschnitt. Geprüft
// wird hier: die Stücke sind exakte Teilstrings an Absatzgrenzen, die Schwelle
// greift nur im Split und nicht lokal, und lektoratAnalyze schickt genau die
// erwarteten Calls — ohne szenen im Stück-Schema, mit Stück-Kontext, unter der
// Semaphore des Batch.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('lektorat-chunks');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
require('../../db/migrations');

const ROOT = path.resolve(__dirname, '..', '..');
const appSettings = require('../../lib/app-settings');
const { chunkText, chunkContext, chunkingApplies, CHUNK_TARGET_CHARS } = require('../../lib/lektorat-chunks');

// aiCall vor dem Laden von lektorat-split ersetzen (das Modul destrukturiert beim Laden).
const shared = require('../../routes/jobs/shared');
const calls = [];
let active = 0;
let maxActive = 0;
shared.aiCall = async (jobId, tok, prompt, system, fromPct, toPct, est, temp, maxTokens, _x, schema) => {
  active++; maxActive = Math.max(maxActive, active);
  calls.push({ prompt, schema });
  await new Promise(r => setTimeout(r, 5));
  active--;
  const props = schema?.properties || {};
  if (!props.fehler) return { szenen: [{ titel: 'Ganz', wertung: 'stark', kommentar: 'k' }], stilanalyse: 'S', fazit: 'F' };
  const m = /<originaltext[^>]*>\n([\s\S]*?)\n<\/originaltext>/.exec(prompt);
  const first = (m ? m[1] : '').split(/\s+/).slice(0, 3).join(' ');
  const objektiv = !props.szenen && !/STILISTISCHE|Bewerte ausserdem/.test(prompt) && /Rechtschreib/.test(prompt) && !props.stilanalyse;
  return { fehler: [{ typ: objektiv ? 'grammatik' : 'stil', original: first, korrektur: first + '!', erklaerung: 'x' }] };
};
const { lektoratAnalyze } = require('../../routes/jobs/lektorat-split');
const { makeSemaphore } = require('../../lib/ai/shared');

let promptsPromise;
function prompts() {
  promptsPromise ||= import(pathToFileURL(path.join(ROOT, 'public', 'js', 'prompts.js')).href).then(p => {
    p.configurePrompts(JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-config.json'), 'utf8')), 'claude');
    return p;
  });
  return promptsPromise;
}

// Absätze mit eindeutigem Anfang, damit jede Fundstelle im Text eindeutig ist.
const longText = (n, len = 1000) => Array.from({ length: n }, (_, i) =>
  `Absatz${i} beginnt hier. ` + 'Ein Satz, der den Absatz füllt. '.repeat(Math.ceil(len / 32)).trim()).join('\n\n');

test('chunkText: exakte Teilstrings an Absatzgrenzen, kurzer Rest hängt am letzten Stück', () => {
  const text = longText(30);
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 3 && chunks.length <= 5, `Stücke: ${chunks.length}`);
  for (const c of chunks) {
    assert.equal(text.slice(c.start, c.start + c.text.length), c.text);
    assert.ok(/^Absatz\d+ beginnt/.test(c.text), 'jedes Stück beginnt mit einem Absatz');
  }
  for (const c of chunks.slice(0, -1)) assert.ok(c.text.length >= CHUNK_TARGET_CHARS);
  // Lückenlos: alles zwischen den Stücken ist nur Absatz-Trenner.
  for (let i = 1; i < chunks.length; i++) {
    const gap = text.slice(chunks[i - 1].start + chunks[i - 1].text.length, chunks[i].start);
    assert.match(gap, /^\n+$/);
  }
  const rest = chunkText(longText(7) + '\n\nKurzer Schluss.');
  assert.ok(rest.at(-1).text.endsWith('Kurzer Schluss.'));
  assert.ok(rest.every(c => c.text !== 'Kurzer Schluss.'), 'kein Mini-Stück am Ende');
});

test('chunkText: ein Riesenabsatz wird nicht mitten im Absatz geschnitten', () => {
  const giant = 'Wort '.repeat(5000).trim();
  assert.deepEqual(chunkText(giant).map(c => c.text), [giant]);
});

test('chunkContext: Text davor/danach desselben Abschnitts, gekürzt an Absatzgrenzen', () => {
  const text = longText(30);
  const chunks = chunkText(text);
  const { before, after } = chunkContext(text, chunks[1]);
  assert.ok(before && text.slice(0, chunks[1].start).trimEnd().endsWith(before));
  assert.ok(after && text.slice(chunks[1].start + chunks[1].text.length).trimStart().startsWith(after));
  assert.ok(before.length <= 2600 && after.length <= 2600);
  assert.equal(chunkContext(text, chunks[0]).before, null);
});

test('chunkingApplies: nur im Split, nicht lokal, über der Schwelle; 0 = aus', () => {
  appSettings.set('ai.lektorat_chunk_chars', 10000);
  assert.equal(chunkingApplies(12000, { split: true }), true);
  assert.equal(chunkingApplies(9000, { split: true }), false);
  assert.equal(chunkingApplies(12000, { split: false }), false);
  assert.equal(chunkingApplies(12000, { split: true, local: true }), false);
  appSettings.set('ai.lektorat_chunk_chars', 0);
  assert.equal(chunkingApplies(50000, { split: true }), false);
  appSettings.set('ai.lektorat_chunk_chars', 10000);
});

test('lektoratAnalyze in Stücken: Calls je Stück + ein Bewertungs-Pass, Merge über den ganzen Text', async () => {
  const p = await prompts();
  appSettings.set('ai.lektorat_split', true);
  appSettings.set('ai.lektorat_chunk_chars', 10000);
  const text = longText(30);
  const chunks = chunkText(text);
  calls.length = 0; maxActive = 0;
  const limit = makeSemaphore(() => 3);
  const result = await lektoratAnalyze({
    jobId: null, tok: {}, text, local: false, prompts: p, system: 'SYS', buchtyp: 'roman',
    fromPct: null, toPct: null, callLimit: limit,
    promptOpts: { langCode: 'de', locale: 'de-CH', figuren: [], orte: [], previousExcerpt: 'VORSEITE', nextExcerpt: 'NACHSEITE', schreibfront: true },
  });
  assert.equal(calls.length, chunks.length * 2 + 1, 'je Stück Objektiv + Stil, dazu die Bewertung');
  assert.ok(maxActive <= 3, `Semaphore gehalten (max ${maxActive})`);

  const bewertung = calls.filter(c => !c.schema.properties.fehler);
  assert.equal(bewertung.length, 1);
  assert.ok(bewertung[0].prompt.includes(text), 'Bewertung sieht den ganzen Abschnitt');
  assert.ok(!bewertung[0].prompt.includes('"fehler": ['), 'Bewertungs-Pass verlangt keine Einzelbefunde');
  const stil = calls.filter(c => c.schema.properties.fehler && /Bewerte|STILISTISCHE/.test(c.prompt));
  assert.equal(stil.length, chunks.length);
  for (const c of stil) {
    assert.equal(c.schema.properties.szenen, undefined, 'Stück-Stil-Pass ohne szenen');
    assert.ok(!c.prompt.includes('Bewerte ausserdem'));
  }
  // Rand-Stücke tragen die echten Nachbarauszüge, innere den Text desselben Abschnitts.
  const firstStil = stil.find(c => c.prompt.includes('Absatz0 beginnt'));
  assert.ok(firstStil.prompt.includes('VORSEITE') && firstStil.prompt.includes('im selben Abschnitt'));
  const lastStil = stil.find(c => c.prompt.includes(`Absatz29 beginnt`));
  assert.ok(lastStil.prompt.includes('NACHSEITE') && lastStil.prompt.includes('SCHREIBSTELLE'));
  assert.equal(stil.filter(c => c.prompt.includes('SCHREIBSTELLE')).length, 1, 'Schreibstelle nur im letzten Stück');

  assert.deepEqual(result.szenen, [{ titel: 'Ganz', wertung: 'stark', kommentar: 'k' }]);
  assert.equal(result.stilanalyse, 'S');
  // Je Stück ein objektiver + ein Stil-Fund an derselben Stelle → verschmolzen zu einem.
  assert.equal(result.fehler.length, chunks.length);
});

test('lektoratAnalyze unter der Schwelle: unverändert zwei Calls, Bewertung aus dem Stil-Pass', async () => {
  const p = await prompts();
  appSettings.set('ai.lektorat_chunk_chars', 10000);
  calls.length = 0;
  const result = await lektoratAnalyze({
    jobId: null, tok: {}, text: longText(5), local: false, prompts: p, system: 'SYS', buchtyp: 'roman',
    fromPct: null, toPct: null, promptOpts: { langCode: 'de', locale: 'de-CH', figuren: [], orte: [] },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.some(c => c.schema.properties.szenen), 'Stil-Pass trägt die Bewertung');
  assert.ok(Array.isArray(result.fehler));
});
