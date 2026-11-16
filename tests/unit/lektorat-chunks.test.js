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
const events = [];
shared.aiCall = async (jobId, tok, rawPrompt, system, fromPct, toPct, est, temp, maxTokens, _x, schema, _tier, onStart) => {
  active++; maxActive = Math.max(maxActive, active);
  // Claude-Cache-Form: Content-Blöcke, aneinandergehängt = der Prompt.
  const prompt = Array.isArray(rawPrompt) ? rawPrompt.map(b => b.text).join('') : rawPrompt;
  const id = calls.length;
  calls.push({ prompt, rawPrompt, schema });
  events.push(['launch', id]);
  await new Promise(r => setTimeout(r, 2));
  events.push(['start', id]);
  onStart?.();
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

test('lektoratAnalyze in Stücken mit Claude-Cache: gemeinsamer Kopf je Pass, gestaffelter Start', async () => {
  const p = await prompts();
  appSettings.set('ai.lektorat_split', true);
  appSettings.set('ai.lektorat_chunk_chars', 10000);
  const text = longText(30);
  const chunks = chunkText(text);
  calls.length = 0; events.length = 0;
  await lektoratAnalyze({
    jobId: null, tok: {}, text, local: false, prompts: p, system: 'SYS', buchtyp: 'roman',
    fromPct: null, toPct: null, cacheBlocks: true,
    promptOpts: { langCode: 'de', locale: 'de-CH', figuren: [], orte: [], previousExcerpt: 'VORSEITE', nextExcerpt: 'NACHSEITE', schreibfront: true },
  });
  assert.equal(calls.length, chunks.length * 2 + 1);
  const passes = {
    objektiv: calls.filter(c => c.schema.properties.fehler && !/Bewerte|STILISTISCHE/.test(c.prompt)),
    stil: calls.filter(c => c.schema.properties.fehler && /Bewerte|STILISTISCHE/.test(c.prompt)),
  };
  for (const [name, list] of Object.entries(passes)) {
    assert.equal(list.length, chunks.length, name);
    const heads = list.map(c => c.rawPrompt[0]);
    for (const c of list) {
      assert.ok(Array.isArray(c.rawPrompt) && c.rawPrompt.length === 2, `${name}: Kopf + Rest`);
      assert.deepEqual(c.rawPrompt[0].cache_control, { type: 'ephemeral' });
      assert.equal(c.rawPrompt[1].cache_control, undefined, `${name}: Rest ohne Breakpoint`);
    }
    assert.ok(heads.every(h => h.text === heads[0].text), `${name}: Kopf in allen Stücken byte-gleich`);
    assert.ok(heads[0].text.length > 5000, `${name}: Kopf trägt den Regel-Korpus (${heads[0].text.length})`);
    assert.ok(!heads[0].text.includes('SCHREIBSTELLE') && !heads[0].text.includes('VORSEITE'), `${name}: Variables bleibt ausserhalb`);
    // Gestaffelt: erst ein Stück, die übrigen erst nach dessen Stream-Start.
    const ids = list.map(c => calls.indexOf(c));
    const firstStart = events.findIndex(([k, id]) => k === 'start' && id === ids[0]);
    for (const id of ids.slice(1)) {
      assert.ok(events.findIndex(([k, i]) => k === 'launch' && i === id) > firstStart, `${name}: Stück ${id} vor dem Erst-Start gestartet`);
    }
  }
  // Schreibstelle steht im Objektiv-Pass nur im letzten Stück, hinter dem Kopf.
  assert.equal(passes.objektiv.filter(c => c.prompt.includes('SCHREIBSTELLE')).length, 1);
  // Bewertung: ein einzelner Call, bleibt String.
  assert.equal(typeof calls.find(c => !c.schema.properties.fehler).rawPrompt, 'string');
});

test('sharedHeadBlocks: Präfix bis Zeilenende, zu kurz oder einzeln bleibt String', () => {
  const { sharedHeadBlocks } = require('../../routes/jobs/lektorat-split');
  const head = 'Regel\n'.repeat(500);
  const out = sharedHeadBlocks([head + 'Alpha beta', head + 'Alpaka']);
  assert.equal(out[0][0].text, head, 'Schnitt am letzten Zeilenende, nicht mitten im gemeinsamen «Alp»');
  assert.equal(out[0].map(b => b.text).join(''), head + 'Alpha beta');
  assert.equal(out[1][1].text, 'Alpaka');
  assert.deepEqual(sharedHeadBlocks(['kurz\na', 'kurz\nb']), ['kurz\na', 'kurz\nb']);
  assert.deepEqual(sharedHeadBlocks([head + 'x']), [head + 'x']);
});

test('staggered: scheitert der erste vor dem Start, starten die übrigen nie', async () => {
  const { staggered } = require('../../routes/jobs/lektorat-split');
  let launched = 0;
  const ps = staggered([
    async () => { throw new Error('kaputt'); },
    async () => { launched++; },
  ]);
  await assert.rejects(Promise.all(ps), /kaputt/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(launched, 0);
});

test('Stück mit Riesenabsatz (eigene Stil-Obergrenze) bricht den gemeinsamen Kopf nicht', async () => {
  const p = await prompts();
  appSettings.set('ai.lektorat_split', true);
  appSettings.set('ai.lektorat_chunk_chars', 10000);
  const giant = 'Riese beginnt hier. ' + 'Ein langer Satz ohne Absatz. '.repeat(500).trim();
  const text = [longText(8), giant, longText(8).replace(/Absatz(\d+)/g, 'Teil$1')].join('\n\n');
  calls.length = 0; events.length = 0;
  await lektoratAnalyze({
    jobId: null, tok: {}, text, local: false, prompts: p, system: 'SYS', buchtyp: 'roman',
    fromPct: null, toPct: null, cacheBlocks: true,
    promptOpts: { langCode: 'de', locale: 'de-CH', figuren: [], orte: [] },
  });
  const stil = calls.filter(c => c.schema.properties.fehler && /STILISTISCHE/.test(c.prompt));
  const caps = new Set(stil.map(c => /MENGEN-OBERGRENZE[^:]*: höchstens (\d+)/.exec(c.prompt)[1]));
  assert.ok(caps.size > 1, `Obergrenzen verschieden: ${[...caps]}`);
  assert.ok(stil.every(c => Array.isArray(c.rawPrompt) && c.rawPrompt[0].text === stil[0].rawPrompt[0].text));
  assert.ok(stil[0].rawPrompt[0].text.length > 20000, `Kopf trägt den Regel-Korpus (${stil[0].rawPrompt[0].text.length})`);
});

// ── Andere Provider der Cloud-Klasse (openai-compat mit `cloud`) ─────────────────
// Der Objektiv/Stil-Split ist Claude vorbehalten: er lebt von Prompt-Caching und
// parallelen Calls. Ein lokaler Endpunkt der Cloud-Klasse (Qwen über LocalAI, seriell)
// zahlte sonst 11 Calls je 34K-Abschnitt (gemessen 600 s). Dort prüft der volle
// Kombi-Prompt, lange Abschnitte trotzdem in Stücken, dazu EIN Bewertungs-Pass.

test('chunkingApplies: ohne Split nur für Claude am Stück, andere Provider in Stücken', () => {
  appSettings.set('ai.lektorat_chunk_chars', 10000);
  assert.equal(chunkingApplies(12000, { split: false, provider: 'openai-compat' }), true);
  assert.equal(chunkingApplies(9000, { split: false, provider: 'openai-compat' }), false);
  assert.equal(chunkingApplies(12000, { split: false, provider: 'openai-compat', local: true }), false, 'lokal nie');
  assert.equal(chunkingApplies(12000, { split: false, provider: 'claude' }), false, 'Claude ohne Split bleibt am Stück');
});

test('splitApplies: Split nur für Claude, nie lokal', () => {
  const { splitApplies } = require('../../routes/jobs/lektorat-split');
  appSettings.set('ai.lektorat_split', true);
  assert.equal(splitApplies(false, 'claude'), true);
  assert.equal(splitApplies(false, 'openai-compat'), false);
  assert.equal(splitApplies(true, 'claude'), false);
  appSettings.set('ai.lektorat_split', false);
  assert.equal(splitApplies(false, 'claude'), false);
  appSettings.set('ai.lektorat_split', true);
});

test('lektoratAnalyze openai-compat (Cloud-Klasse), langer Abschnitt: Kombi je Stück + ein Bewertungs-Pass', async () => {
  const p = await prompts();
  appSettings.set('ai.lektorat_split', true);
  appSettings.set('ai.lektorat_chunk_chars', 10000);
  const text = longText(30);
  const chunks = chunkText(text);
  calls.length = 0;
  const result = await lektoratAnalyze({
    jobId: null, tok: {}, text, local: false, provider: 'openai-compat', prompts: p, system: 'SYS', buchtyp: 'roman',
    fromPct: null, toPct: null,
    promptOpts: { langCode: 'de', locale: 'de-CH', figuren: [], orte: [], previousExcerpt: 'VORSEITE', nextExcerpt: 'NACHSEITE', schreibfront: true },
  });
  assert.equal(calls.length, chunks.length + 1, 'je Stück ein Kombi-Call, dazu die Bewertung');
  const bewertung = calls.filter(c => !c.schema.properties.fehler);
  assert.equal(bewertung.length, 1);
  assert.ok(bewertung[0].prompt.includes(text), 'Bewertung sieht den ganzen Abschnitt');
  const kombi = calls.filter(c => c.schema.properties.fehler);
  for (const c of kombi) {
    assert.ok(!/STILISTISCHE Schwächen/.test(c.prompt), 'kein Stil-Pass: voller Kombi-Prompt');
    assert.ok(/Rechtschreibfehler, Grammatikfehler/.test(c.prompt), 'Kombi prüft auch die objektiven Typen');
    assert.equal(c.schema.properties.szenen, undefined, 'Stück ohne szenen');
    assert.equal(c.schema.properties.fazit, undefined, 'Stück ohne fazit');
    assert.ok(!c.prompt.includes('Bewerte ausserdem'), 'Stück bewertet nicht');
    assert.ok(!c.prompt.includes('"szenen": ['), 'Stück-Schema im Prompt ohne szenen');
    assert.equal(typeof c.rawPrompt, 'string', 'kein Claude-Cache-Block');
  }
  const first = kombi.find(c => c.prompt.includes('Absatz0 beginnt'));
  assert.ok(first.prompt.includes('VORSEITE') && first.prompt.includes('im selben Abschnitt'));
  assert.equal(kombi.filter(c => c.prompt.includes('SCHREIBSTELLE')).length, 1, 'Schreibstelle nur im letzten Stück');
  assert.deepEqual(result.szenen, [{ titel: 'Ganz', wertung: 'stark', kommentar: 'k' }]);
  assert.equal(result.fazit, 'F');
  assert.equal(result.fehler.length, chunks.length);
});

test('lektoratAnalyze openai-compat (Cloud-Klasse), kurzer Abschnitt: ein Kombi-Call mit Bewertung', async () => {
  const p = await prompts();
  appSettings.set('ai.lektorat_split', true);
  appSettings.set('ai.lektorat_chunk_chars', 10000);
  calls.length = 0;
  await lektoratAnalyze({
    jobId: null, tok: {}, text: longText(5), local: false, provider: 'openai-compat', prompts: p, system: 'SYS', buchtyp: 'roman',
    fromPct: null, toPct: null, promptOpts: { langCode: 'de', locale: 'de-CH', figuren: [], orte: [] },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].schema.properties.szenen, 'Kombi trägt die Bewertung');
  assert.ok(calls[0].prompt.includes('Bewerte ausserdem'));
});

test('applyLektoratAiOverrides openai-compat: Denkbudget des Lektorats in den Job-Bag, nur mit Thinking', async () => {
  const { applyLektoratAiOverrides } = require('../../routes/jobs/lektorat-split');
  const { runWithContext, getContext } = require('../../lib/log-context');
  const quiet = { info() {} };
  appSettings.set('ai.openai-compat.think', true);
  appSettings.set('ai.openai-compat.reasoning_budget.lektorat', 4000);
  await runWithContext({}, async () => {
    const r = applyLektoratAiOverrides('openai-compat', quiet);
    assert.equal(getContext().aiJob?.reasoningBudget, 4000);
    assert.match(r.cacheSuffix, /:rb=4000$/, 'Budget formt den Output → Cache-Version');
  });
  appSettings.set('ai.openai-compat.reasoning_budget.lektorat', 0);
  await runWithContext({}, async () => {
    const r = applyLektoratAiOverrides('openai-compat', quiet);
    assert.equal(getContext().aiJob?.reasoningBudget, undefined, '0 = Alias-Default');
    assert.equal(r.cacheSuffix, '');
  });
  appSettings.set('ai.openai-compat.reasoning_budget.lektorat', 4000);
  appSettings.set('ai.openai-compat.think', false);
  await runWithContext({}, async () => {
    const r = applyLektoratAiOverrides('openai-compat', quiet);
    assert.equal(getContext().aiJob?.reasoningBudget, undefined, 'ohne Thinking kein Budget');
    assert.equal(r.cacheSuffix, '');
  });
  appSettings.set('ai.openai-compat.reasoning_budget.lektorat', 0);
});
