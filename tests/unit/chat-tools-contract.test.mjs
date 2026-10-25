// Vertrag des gemeinsamen Werkzeug-Katalogs der agentischen Chats (Buch, Plot,
// Ideen, Recherche). Regeln und Begründungen: routes/jobs/chat-tools/CLAUDE.md.
// Jede Regel hier ist mechanisch, damit ein neues Werkzeug nicht driftet:
//   - Definition ↔ Handler ↔ Zugriffszeile ↔ Doku, je genau einmal
//   - Namens- und Schema-Form, Grössen-Budgets (Ratsche: nur senken)
//   - kein Werkzeugname im Fliesstext ausser über `see` (Definition), toolMentions
//     (Prompt) bzw. toolHint/offeredList (Handler-Ergebnis)
//   - verhaltensbasiert: fehlt ein Werkzeug im Lauf, nennt es keine Beschreibung und
//     kein System-Prompt mehr
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = new URL('../../', import.meta.url).pathname;
const P = await import('../../public/js/prompts.js');
const { TOOLS, AVAILABILITY } = require('../../routes/jobs/chat-tools');
const { OWN_TOOLS: RESEARCH_OWN_TOOLS } = require('../../routes/jobs/research-chat-tools');

const CATALOG = P.CHAT_TOOLS;
const NAMES = CATALOG.map(t => t.name);
const OUTPUTS = {
  book: P.BOOK_CHAT_OUTPUT_TOOLS,
  plot: P.PLOT_CHAT_PROPOSE_TOOLS,
  ideen: P.IDEEN_CHAT_PROPOSE_TOOLS,
  research: [...P.buildResearchChatTools({ webSearchMode: 'searxng' }), ...P.buildResearchChatTools({ webSearchMode: 'anthropic' })],
};
const OUTPUT_NAMES = new Set(Object.values(OUTPUTS).flat().map(t => t.name));
const ALL_NAMES = [...new Set([...NAMES, ...OUTPUT_NAMES, ...P.RETIRED_CHAT_TOOL_NAMES])];

// Budgets — Ratsche: senken ja, anheben nur mit Begründung in der CLAUDE.md.
const MAX_CORE_DESC = 650;
const MAX_RENDERED_DESC = 900;
const MAX_PARAM_DESC = 250;
const MAX_SEE_SENTENCE = 160;
const MAX_PARAMS = 8;
const MAX_SCHEMA_DEPTH = 3;
const SET_BUDGET = {   // [Werkzeuge inkl. Ausgabe, Zeichen JSON]
  'book/full': [37, 38000], 'book/slim': [21, 22000],
  'plot/full': [27, 27000], 'plot/slim': [15, 16500],
  'ideen/full': [25, 24500], 'ideen/slim': [10, 11500],
  'research/full': [9, 8500], 'research/slim': [9, 8500],
};
const NAME_RE = /^(list|get|search|read|quote|find|lookup|generate)_[a-z]+(_[a-z]+)*$/;

const mentionRe = (name) => new RegExp(`(?<![a-z_])${name}(?![a-z_])`);
const mentions = (text, name) => mentionRe(name).test(text);
// `final_answer` ist in jedem Chat der Pflicht-Endpunkt — der einzige Name, den jeder Text nennen darf.
const forbiddenIn = (text, self) => ALL_NAMES.filter(n => n !== 'final_answer' && n !== self && mentions(text, n));

function schemaDepth(s, d = 0) {
  if (!s || typeof s !== 'object') return d;
  let m = d;
  for (const v of Object.values(s.properties || {})) m = Math.max(m, schemaDepth(v, d + 1));
  if (s.items) m = Math.max(m, schemaDepth(s.items, d + 1));
  return m;
}

// ── Inventar ─────────────────────────────────────────────────────────────────

test('jede Definition hat genau einen Handler, jeder Handler eine Definition', () => {
  assert.deepEqual([...NAMES].sort(), Object.keys(TOOLS).sort());
  assert.equal(new Set(NAMES).size, NAMES.length, 'doppelter Werkzeugname im Katalog');
  for (const name of Object.keys(AVAILABILITY)) assert.ok(TOOLS[name], `AVAILABILITY ohne Werkzeug: ${name}`);
});

test('Zugriffstabelle: eine Zeile je Werkzeug, nur bekannte Chats und Stufen, jeder Chat bekommt etwas', () => {
  assert.deepEqual(Object.keys(P.CHAT_TOOL_ACCESS).sort(), [...NAMES].sort());
  for (const [name, row] of Object.entries(P.CHAT_TOOL_ACCESS)) {
    assert.ok(Object.keys(row).length > 0, `${name}: von keinem Chat genutzt — Werkzeug löschen statt mitschleppen`);
    for (const [chat, level] of Object.entries(row)) {
      assert.ok(P.CHAT_KINDS.includes(chat), `${name}: unbekannter Chat «${chat}»`);
      assert.ok(level === 'slim' || level === 'full', `${name}.${chat}: «${level}»`);
    }
  }
  for (const chat of P.CHAT_KINDS) assert.ok(P.chatToolNames(chat, { slim: true }).length > 0, chat);
});

test('Ausgabe-Werkzeuge kollidieren nicht mit dem Katalog; Recherche-Handler decken ihre Definitionen', () => {
  for (const name of OUTPUT_NAMES) assert.ok(!NAMES.includes(name), `${name}: Ausgabe- und Katalog-Werkzeug zugleich`);
  for (const t of OUTPUTS.research) {
    if (t.name === 'final_answer' || t.type) continue;   // Endpunkt bzw. Anthropic-Server-Tool
    assert.ok(RESEARCH_OWN_TOOLS[t.name], `Recherche-Werkzeug ohne Handler: ${t.name}`);
  }
});

test('abgelöste Namen bleiben abgelöst', () => {
  for (const name of P.RETIRED_CHAT_TOOL_NAMES) {
    assert.ok(!NAMES.includes(name) && !OUTPUT_NAMES.has(name), `${name} ist abgelöst und darf nicht wiederkehren`);
  }
});

test('jedes Katalog-Werkzeug steht in docs/chat-tools.md', () => {
  const doc = readFileSync(join(ROOT, 'docs/chat-tools.md'), 'utf8');
  for (const name of NAMES) assert.ok(doc.includes(`| \`${name}\``), `docs/chat-tools.md: Zeile für ${name} fehlt`);
});

// ── Form und Budgets ─────────────────────────────────────────────────────────

test('Namen: Verb_Objekt in snake_case, Verb aus der festen Liste', () => {
  for (const name of NAMES) {
    assert.match(name, NAME_RE, name);
    assert.ok(name.length <= 40, `${name}: länger als 40 Zeichen`);
  }
});

test('Schema: object, required ⊂ properties, jede Property typisiert und beschrieben, flach', () => {
  for (const t of CATALOG) {
    const s = t.input_schema;
    assert.equal(s?.type, 'object', t.name);
    const props = s.properties || {};
    assert.ok(Object.keys(props).length <= MAX_PARAMS, `${t.name}: mehr als ${MAX_PARAMS} Parameter`);
    for (const r of s.required || []) assert.ok(props[r], `${t.name}: required «${r}» ohne Property`);
    for (const [k, v] of Object.entries(props)) {
      assert.ok(v.type, `${t.name}.${k}: ohne type`);
      assert.ok(v.description, `${t.name}.${k}: ohne description`);
      if (v.type === 'array') assert.ok(v.items, `${t.name}.${k}: array ohne items`);
    }
    assert.ok(schemaDepth(s) <= MAX_SCHEMA_DEPTH, `${t.name}: Schema tiefer als ${MAX_SCHEMA_DEPTH}`);
  }
});

test('Längen-Budgets: Kernbeschreibung, gerenderte Beschreibung, Parameter, see-Sätze', () => {
  for (const t of CATALOG) {
    assert.ok(t.description.length <= MAX_CORE_DESC, `${t.name}: Beschreibung ${t.description.length} > ${MAX_CORE_DESC}`);
    const seeLen = Object.values(t.see || {}).reduce((n, s) => n + s.length + 1, 0);
    assert.ok(t.description.length + seeLen <= MAX_RENDERED_DESC, `${t.name}: gerendert > ${MAX_RENDERED_DESC}`);
    for (const [k, v] of Object.entries(t.input_schema.properties || {})) {
      assert.ok(v.description.length <= MAX_PARAM_DESC, `${t.name}.${k}: Parameter-Beschreibung > ${MAX_PARAM_DESC}`);
    }
    for (const [target, s] of Object.entries(t.see || {})) {
      assert.ok(s.length <= MAX_SEE_SENTENCE, `${t.name}.see.${target}: > ${MAX_SEE_SENTENCE}`);
    }
  }
});

test('Werkzeugsatz je Chat: Anzahl und Grösse unter der Ratsche', () => {
  for (const chat of P.CHAT_KINDS) {
    for (const slim of [false, true]) {
      const key = `${chat}/${slim ? 'slim' : 'full'}`;
      const set = P.buildChatToolset(chat, { slim, outputTools: chat === 'research' ? P.buildResearchChatTools({ webSearchMode: 'searxng' }) : OUTPUTS[chat] });
      const [maxCount, maxChars] = SET_BUDGET[key];
      assert.ok(set.length <= maxCount, `${key}: ${set.length} Werkzeuge > ${maxCount}`);
      const chars = JSON.stringify(set).length;
      assert.ok(chars <= maxChars, `${key}: ${chars} Zeichen > ${maxChars}`);
      for (const t of set) if (t.description) assert.ok(t.description.length <= MAX_RENDERED_DESC, `${key}/${t.name}`);
    }
  }
});

// ── Querverweise ─────────────────────────────────────────────────────────────

test('Katalog-Fliesstext nennt keine Werkzeuge — Querverweise nur über see', () => {
  for (const t of CATALOG) {
    assert.deepEqual(forbiddenIn(t.description, t.name), [], `${t.name}: Werkzeugname in der Beschreibung — gehört in see`);
    for (const [k, v] of Object.entries(t.input_schema.properties || {})) {
      assert.deepEqual(forbiddenIn(JSON.stringify(v), t.name), [], `${t.name}.${k}: Werkzeugname in der Parameter-Beschreibung`);
    }
    for (const [target, sentence] of Object.entries(t.see || {})) {
      assert.ok(NAMES.includes(target) || OUTPUT_NAMES.has(target), `${t.name}.see: unbekanntes Ziel ${target}`);
      assert.ok(sentence.includes(`\`${target}\``), `${t.name}.see.${target}: Satz nennt sein Ziel nicht als \`${target}\``);
      assert.deepEqual(forbiddenIn(sentence, target).filter(n => n !== t.name), [], `${t.name}.see.${target}: nennt weitere Werkzeuge`);
    }
  }
});

test('fehlt ein Werkzeug im Lauf, nennt es keine Beschreibung des Satzes', () => {
  for (const chat of P.CHAT_KINDS) {
    for (const slim of [false, true]) {
      for (const missing of P.chatToolNames(chat, { slim })) {
        const set = P.buildChatToolset(chat, { slim, unavailable: new Set([missing]), outputTools: OUTPUTS[chat] });
        for (const t of set) {
          if (!t.description) continue;
          assert.ok(!mentions(JSON.stringify({ d: t.description, s: t.input_schema }), missing),
            `${chat}/${slim ? 'slim' : 'full'}: ${t.name} nennt ${missing}, obwohl es fehlt`);
        }
      }
    }
  }
});

// ── System-Prompts ───────────────────────────────────────────────────────────

const FIGUREN = [{ id: 'fig_1', name: 'Anna', typ: 'hauptfigur', beschreibung: 'x'.repeat(400) }];
const WELT = { scanned: true, fakten: Array.from({ length: 80 }, (_, i) => ({ kategorie: 'regel', subjekt: `S${i}`, fakt: `Fakt ${i} ${'y'.repeat(60)}` })) };
const PASSAGES = [{ kind: 'page', entity_id: 1, title: 'P', rank: 1, similarity: 0.5, text: 'Text' }];
const INCOMPLETE = { indexIncomplete: true, stalePages: 2 };
const textOf = (blocks) => (Array.isArray(blocks) ? blocks.map(b => b.text ?? b).join('\n') : String(blocks));

function promptsFor(chat, toolNames) {
  if (chat === 'book') {
    return [
      textOf(P.buildBookChatAgentSystemPrompt('B', FIGUREN, null, null, 6, { toolNames, figurenMaxChars: 200, welt: WELT, weltfaktenMaxChars: 600 })),
      P.buildBookChatPreContext(PASSAGES, INCOMPLETE, { toolNames }),
      P.buildBookChatPreContext([], INCOMPLETE, { toolNames }),
      P.buildBookChatOutsideWorldRule(toolNames),
    ];
  }
  if (chat === 'plot') {
    return [textOf(P.buildPlotChatSystemPrompt('B', { mode: 'agent', toolNames, passages: PASSAGES, passageStatus: INCOMPLETE }))];
  }
  if (chat === 'ideen') {
    return [textOf(P.buildIdeenChatSystemPrompt('B', { mode: 'agent', toolNames, passages: PASSAGES, passageStatus: INCOMPLETE }))];
  }
  return ['anthropic', 'searxng'].flatMap(webSearchMode => [
    P.buildResearchChatAgentSystemPrompt('B', 3, 6, [], [], {}, { toolNames, webSearchMode, maxWebSearches: 5 }),
    P.buildResearchProposalMemoryBlock([{ title: 't', kind: 'note' }], { toolNames }),
    P.buildResearchWritingContextBlock({ kind: 'page', name: 'P', items: [{ id: 1, kind: 'note', status: 'offen', title: 't' }] }, { toolNames }),
  ]);
}

test('fehlt ein Werkzeug im Lauf, nennt es kein System-Prompt-Baustein des Chats', () => {
  for (const chat of P.CHAT_KINDS) {
    const outputNames = OUTPUTS[chat].map(t => t.name);
    for (const slim of [false, true]) {
      const offered = [...P.chatToolNames(chat, { slim }), ...outputNames];
      for (const missing of P.chatToolNames(chat, { slim })) {
        const toolNames = offered.filter(n => n !== missing);
        for (const text of promptsFor(chat, toolNames)) {
          assert.ok(!mentions(text, missing), `${chat}/${slim ? 'slim' : 'full'}: Prompt nennt ${missing}, obwohl es fehlt`);
        }
      }
    }
  }
});

// ── Handler-Ergebnisse ───────────────────────────────────────────────────────

const HANDLER_FILES = [
  ...readdirSync(join(ROOT, 'routes/jobs/chat-tools')).filter(f => f.endsWith('.js')).map(f => `routes/jobs/chat-tools/${f}`),
  'routes/jobs/research-chat-tools.js', 'routes/jobs/research-web-tools.js',
  'routes/jobs/plot-chat-tools.js', 'routes/jobs/ideen-chat-tools.js',
];
const HINT_HELPER = /\b(toolHint|offeredList|offered)\(/;

test('Handler nennen andere Werkzeuge nur über toolHint/offeredList', () => {
  const offenders = [];
  for (const rel of HANDLER_FILES) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (/logger\??\.\w+\??\.?\(/.test(line)) return;   // Logs gehen nicht ans Modell
      for (const lit of line.match(/(['"`])(?:\\.|(?!\1).)*\1/g) || []) {
        if (/^['"]\w+['"]$/.test(lit)) continue;   // nackter Name als Schlüssel/Vergleich
        const named = NAMES.filter(n => mentions(lit, n));
        if (!named.length) continue;
        if (HINT_HELPER.test(line) || HINT_HELPER.test(lines[i - 1] || '')) continue;
        offenders.push(`${rel}:${i + 1} ${named.join(',')}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'Werkzeugname im Ergebnistext ohne toolHint/offeredList');
});
