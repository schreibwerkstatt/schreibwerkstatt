// Unit: Finetune-Export v3.1 (docs/finetuning.md#qualität-des-sets):
// Kurzporträt aus Bausteinen ohne «erlebt:» und ohne Weltgeschehen, Kürzen
// nach Wichtigkeit, Trivial-Filter, Prompt-Dedup, Rollenfiguren ohne
// Beziehungsaufgaben, Deklination, natürliche Beziehungssätze, «Wer sagt
// das?» mit Situation, Val-Familien vollständig, Lint und Schweizer Schreibung.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as relTypes from '../../public/js/book/beziehung-typen.js';

const require = createRequire(import.meta.url);
const { buildCoreFactSamples } = require('../../routes/jobs/finetune-export/samples/core-facts/index.js');
const { declineName, fillCase, isRoleName } = require('../../routes/jobs/finetune-export/samples/core-facts/naming.js');
const { relationAnswers } = require('../../routes/jobs/finetune-export/samples/core-facts/relations.js');
const { mixByTokens } = require('../../routes/jobs/finetune-export/lib/token-mix.js');
const { isTrivial, lintAnswer } = require('../../routes/jobs/finetune-export/lib/answer-lint.js');
const { finalizeFinetuneSamples } = require('../../routes/jobs/finetune-export/finalize.js');
const { buildDialogSamples } = require('../../routes/jobs/finetune-export/samples/dialog.js');
const { buildRefusalSamples, spreadPairs } = require('../../routes/jobs/finetune-export/samples/reader/refusals.js');
const { makeReaderPush } = require('../../routes/jobs/finetune-export/samples/reader/push.js');

const sample = (id, user, answer, extra = {}) => ({
  id, type: extra.type || 'authorChat', ...extra,
  messages: [{ role: 'system', content: 'S' }, { role: 'user', content: user }, { role: 'assistant', content: answer }],
});
const finalize = (samples, opts = {}, pageContents = []) => finalizeFinetuneSamples({
  samples, langIsEn: false, pageContents,
  opts: { valSplit: 0, valSeed: 0, maxSeqTokens: 0, emitText: false, truncateLong: false, maxPerAnswer: 0, ...opts },
});
const lines = (jsonl) => jsonl.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

// Kleines Buch: drei Hauptfiguren-Erwähnungen genügen mit minMentions 1.
const FIGS = [
  { fig_id: 'fig_1', pk: 1, name: 'Stefan', typ: 'hauptfigur', geschlecht: 'männlich', beruf: 'Polymechaniker', beschreibung: 'Stefan ist als Kind unauffällig.' },
  { fig_id: 'fig_2', pk: 2, name: 'Renate', typ: 'hauptfigur', geschlecht: 'weiblich' },
  { fig_id: 'fig_3', pk: 3, name: 'Peter', typ: 'nebenfigur', geschlecht: 'männlich' },
  { fig_id: 'fig_4', pk: 4, name: 'Mario', typ: 'randfigur', geschlecht: 'männlich' },
  { fig_id: 'fig_5', pk: 5, name: 'Fahrer des Mercedes', kurzname: 'Fahrer', typ: 'randfigur', geschlecht: 'männlich' },
  { fig_id: 'fig_6', pk: 6, name: 'Dieter', typ: 'nebenfigur', geschlecht: 'männlich' },
  { fig_id: 'fig_7', pk: 7, name: 'Herr Koch (Primarlehrer)', kurzname: 'Herr Koch', typ: 'mentor', geschlecht: 'männlich' },
  { fig_id: 'fig_8', pk: 8, name: 'Herr Koch', kurzname: 'Koch', typ: 'randfigur', geschlecht: 'männlich' },
];
const EVENTS = new Map([
  [1, [
    { subtyp: 'geburt', typ: 'persoenlich', ereignis: 'Geburt von Stefan', datum: '1968', datum_year: 1968 },
    { subtyp: 'extern_wirtschaftlich', typ: 'extern', ereignis: 'Erste Ölpreiskrise mit autofreien Sonntagen', datum: '1973', bedeutung: 'Er erinnert sich an den Veloausflug.' },
    { subtyp: 'wendepunkt', typ: 'persoenlich', ereignis: 'Lehrbeginn als Polymechaniker im Stahlwerk Gerlafingen', datum: '1984', datum_year: 1984, bedeutung: 'Er will Wirksamkeit spüren.' },
  ]],
  [2, [{ subtyp: 'geburt', typ: 'persoenlich', ereignis: 'Geburt von Renate', datum: '1969', datum_year: 1969 }]],
  [3, [{ subtyp: 'geburt', typ: 'persoenlich', ereignis: 'Geburt von Peter', datum: '1940', datum_year: 1940 }]],
  [4, [{ subtyp: 'extern_kulturell', typ: 'extern', ereignis: 'Länderspiel Schweiz–Italien im Wankdorf Bern', datum: '17.10.1987' }]],
]);
function coreCtx(rows, opts = {}) {
  const text = FIGS.map(f => `${f.name} ${f.kurzname || ''}`).join(' ');
  const ctx = {
    langIsEn: false, displayName: 'Der Amoklauf', unifiedSys: 'S', samples: [], counts: {}, relTypes,
    opts: { valSeed: 0, factParaphrases: 4, maxVariantsPerFact: 5, minMentions: 1, corePerTier: { main: 5, side: 3, minor: 1 }, ...opts },
    figRows: FIGS, figById: new Map(FIGS.map(f => [f.fig_id, f])), figRelRows: rows,
    pageContents: [{ id: 1, text }], eventsByFigPk: EVENTS,
    appearancesByFigPk: new Map([[1, ['Der Vater']]]), figsByLocPk: new Map(), locRows: [],
    events: [], chapterKeys: [], chapterNameByKey: new Map(),
  };
  buildCoreFactSamples(ctx);
  return ctx;
}
const REL_ROWS = [
  { from_fig_id: 'fig_3', to_fig_id: 'fig_1', typ: 'kind', beschreibung: 'Der Sohn enttäuscht ihn.' },
  { from_fig_id: 'fig_1', to_fig_id: 'fig_2', typ: 'ehepartner', beschreibung: '' },
  { from_fig_id: 'fig_6', to_fig_id: 'fig_5', typ: 'untergebener', beschreibung: 'Er fährt Dieter durch die Stadt.' },
  { from_fig_id: 'fig_7', to_fig_id: 'fig_1', typ: 'schuetzling', beschreibung: 'Er bringt ihm das Lesen bei.' },
  { from_fig_id: 'fig_4', to_fig_id: 'fig_1', typ: 'bekannt', beschreibung: '' },
];

// ── 1. Kurzporträt ───────────────────────────────────────────────────────
test('Kurzporträt: Bausteine statt «erlebt:», nur persönliche Wendepunkte, Varianten nach Bedeutung', () => {
  const ctx = coreCtx(REL_ROWS);
  const core = (id) => ctx.samples.filter(s => s.factId === `fig:${id}:core`);
  const stefan = core('fig_1').map(s => s.messages[2].content);
  assert.equal(stefan.length, 5, 'Hauptfigur: corePerTier.main');
  assert.equal(new Set(stefan).size, 5, 'verschiedene Antworten');
  assert.equal(core('fig_3').length, 3, 'Nebenfigur: corePerTier.side');
  assert.equal(core('fig_4').length, 1, 'Randfigur: corePerTier.minor');
  for (const s of ctx.samples.filter(x => x.task === 'figureCore')) {
    const a = s.messages[2].content;
    assert.doesNotMatch(a, /\berlebt:/, a);
    assert.doesNotMatch(a, /Ölpreiskrise|Länderspiel/, 'nie Weltgeschehen: ' + a);
    const sentences = a.split(/(?<=[.!?»])\s+(?=[A-ZÄÖÜ«])/).length;
    assert.ok(sentences >= 1 && sentences <= 4, `${sentences} Sätze: ${a}`);
  }
  assert.ok(stefan.every(a => /eine der Hauptfiguren/.test(a)), 'Rolle im Buch zuerst');
  assert.ok(stefan.some(a => /Gerlafingen/.test(a)), 'persönlicher Wendepunkt');
  assert.ok(stefan.some(a => /Renate/.test(a)), 'engste Beziehung');
  // Mario hat nur Weltgeschehen: kein Ereignis im Porträt.
  assert.doesNotMatch(core('fig_4')[0].messages[2].content, /Wankdorf/);
});

// ── 2. Kürzen nach Wichtigkeit ───────────────────────────────────────────
test('Kürzen: Kernwissen der Hauptfiguren bleibt bei knappem Budget vollständig, Randfiguren fallen zuerst', () => {
  const e = (id, answer, s) => ({ family: s.family || 'facts', s: { id, task: 'factFigure', ...s, messages: [{ role: 'user', content: 'Q' }, { role: 'assistant', content: answer }] } });
  const long = 'x'.repeat(330);
  const entries = [e('style|1', 'y'.repeat(330), { family: 'writing', task: 'continue' })];
  for (let v = 0; v < 5; v++) entries.push(e(`core|fig:fig_1:core|${v}`, long, { type: 'core', task: 'figureCore', core: true, tier: 'main', factId: 'fig:fig_1:core' }));
  for (let v = 0; v < 3; v++) entries.push(e(`core|fig:fig_3:core|${v}`, long, { type: 'core', task: 'figureCore', core: true, tier: 'side', factId: 'fig:fig_3:core' }));
  for (let i = 0; i < 6; i++) entries.push(e(`authorChat|figTraits|fig_4|${i}`, long, {}));
  for (let i = 0; i < 6; i++) entries.push(e(`authorChat|ort|ort_${i}`, long, { task: 'factPlace' }));
  const tierByFig = new Map([['fig_1', 'main'], ['fig_3', 'side'], ['fig_4', 'minor']]);
  // writing:facts 1:1 → Fakten-Budget ≈ eine Antwort.
  const { kept } = mixByTokens(entries, { familyTokenShares: { writing: 0.5, facts: 0.5 }, tierByFig });
  const ids = new Set(kept.map(x => x.s.id));
  for (let v = 0; v < 5; v++) assert.ok(ids.has(`core|fig:fig_1:core|${v}`), `Hauptfigur Variante ${v}`);
  assert.ok(ids.has('core|fig:fig_3:core|0'), 'erste Variante jeder Kernkarte');
  assert.ok(![...ids].some(id => id.includes('fig_4')), 'Randfiguren-Fakten zuerst');
  assert.ok(![...ids].some(id => id.includes('ort_')), 'Orte vor Kernwissen');
  assert.ok(!ids.has('core|fig:fig_3:core|2'), 'Zusatzvarianten der Nebenfigur vor der Hauptfigur');
});

// ── 3. Trivial-Filter und Prompt-Dedup ───────────────────────────────────
test('Trivial-Filter: Antwort ⊆ Frage fällt weg, gezählt', () => {
  assert.ok(isTrivial('Wer ist an «Renate tritt der Damenriege bei» beteiligt?', 'Renate erlebt «Renate tritt der Damenriege bei».'));
  assert.ok(!isTrivial('Wer ist an «Renate tritt der Damenriege bei» beteiligt?', 'Neben Renate sind Stefan und Gisela dabei.'));
  const r = finalize([
    sample('core|evt:1:who|0', 'Wer ist bei «Pamela wechselt an die Kantonsschule» dabei?', 'An «Pamela wechselt an die Kantonsschule» ist Pamela beteiligt.', { type: 'core', task: 'eventCore' }),
    sample('core|evt:2:who|0', 'Wer ist bei «Rauferei» dabei?', 'Neben Dennis ist Tobias dabei.', { type: 'core', task: 'eventCore' }),
  ]);
  assert.equal(r.stats.trivialDropped, 1);
  assert.equal(lines(r.trainJsonl).length, 1);
});

test('Prompt-Dedup: dieselbe Frage nur einmal im Train, Kernwissen gewinnt', () => {
  const r = finalize([
    sample('authorChat|wfact|1|0', 'Wer ist Stefan?', 'Stefan arbeitet in Olten bei den Werkstätten.'),
    sample('core|fig:fig_1:core|0', 'Wer ist Stefan?', 'Stefan ist eine der Hauptfiguren in «Der Amoklauf».', { type: 'core', task: 'figureCore', core: true, tier: 'main' }),
    sample('authorChat|wfact|2|0', 'Was weisst du über Olten?', 'Olten ist eine Eisenbahnerstadt an der Aare.'),
  ]);
  assert.equal(r.stats.promptDeduped, 1);
  const out = lines(r.trainJsonl);
  assert.equal(out.length, 2);
  assert.ok(out.some(s => /Hauptfiguren/.test(s.messages[2].content)));
  const prompts = out.map(s => s.messages[1].content);
  assert.equal(new Set(prompts).size, prompts.length);
});

// ── 4. Rollenfiguren ─────────────────────────────────────────────────────
test('Rollenfiguren: keine Beziehungs-, Attribut- oder Falschannahme-Aufgaben, mehrdeutige Namen ohne Kernwissen', () => {
  assert.ok(isRoleName('Fahrer des Mercedes'));
  assert.ok(isRoleName('Alfreds Vater', new Set(['alfred'])));
  assert.ok(isRoleName('madame_phantasma'));
  assert.ok(!isRoleName('Herr Koch (Primarlehrer)'));
  assert.ok(!isRoleName('Daniel Tannenberg'));
  const ctx = coreCtx(REL_ROWS);
  const touches = (s, re) => s.messages.some(m => re.test(m.content));
  const rel = ctx.samples.filter(s => s.task === 'relationCore' || s.task === 'figureAttr');
  assert.ok(!rel.some(s => touches(s, /Fahrer|Mercedes/)), 'Rollenfigur ohne Beziehung/Attribut');
  assert.ok(!rel.some(s => touches(s, /Koch/)), 'mehrdeutiger Name ohne Beziehung');
  assert.ok(!ctx.samples.some(s => /fig_7|fig_8/.test(s.factId || '')), '«Herr Koch» zweimal → kein Kernwissen');
  // Bekanntschaft ohne Beschreibung ist kein Fakt.
  assert.ok(!rel.some(s => touches(s, /Mario/)));
  // Rollenfigur im Porträt mit Artikel und Fall.
  const fahrer = ctx.samples.filter(s => s.factId === 'fig:fig_5:core');
  assert.ok(fahrer.length >= 1);
  assert.match(fahrer[0].messages[1].content, /(der|den|vom|dem) Fahrer des Mercedes/);
  assert.doesNotMatch(fahrer[0].messages[2].content, /^Fahrer des Mercedes/);
  // Falschannahmen nur zwischen benannten Figuren, generationsplausibel.
  const rctx = { ...ctx, samples: [], counts: { reader: 0 } };
  buildRefusalSamples(rctx, makeReaderPush(rctx));
  const fp = rctx.samples.filter(s => s.id.startsWith('refusal|falsePremise|rel|'));
  assert.ok(!fp.some(s => touches(s, /Fahrer|Koch/)), JSON.stringify(fp.map(s => s.messages[1].content)));
  // Peter (1940) ist Stefans Vater (1968): «Schwester/Bruder» wäre eine andere Generation.
  assert.ok(!fp.some(s => touches(s, /Peter ist nicht Stefans Bruder|Stefan ist nicht Peters Bruder/)));
  assert.ok(!fp.some(s => /(Bruder|Schwester)/.test(s.messages[1].content) && touches(s, /Peter/)));
});

test('Deklination: «Herr Koch» → «Herrn Koch», Rollen mit Artikel und Fall', () => {
  assert.equal(declineName('Herr Koch', 'dat'), 'Herrn Koch');
  assert.equal(declineName('Herr Koch', 'akk'), 'Herrn Koch');
  assert.equal(declineName('Herr Koch', 'nom'), 'Herr Koch');
  assert.equal(declineName('Herr Koch (Primarlehrer)', 'dat'), 'Herrn Koch', 'Klammerzusatz nie im Fliesstext');
  const m = { gender: 'm', role: true };
  assert.equal(declineName('Fahrer des Mercedes', 'nom', m), 'der Fahrer des Mercedes');
  assert.equal(declineName('Fahrer des Mercedes', 'dat', m), 'dem Fahrer des Mercedes');
  assert.equal(declineName('Rektor der Kantonsschule Olten', 'akk', m), 'den Rektor der Kantonsschule Olten');
  assert.equal(declineName('Knigge-Experte', 'dat', m), 'dem Knigge-Experten');
  assert.equal(declineName('Alte Frau an der Ziegelfeldstrasse', 'dat', { gender: 'f', role: true }), 'der alten Frau an der Ziegelfeldstrasse');
  assert.equal(fillCase('Erzähl mir kurz von {n:dat}.', 'Fahrer des Mercedes', m), 'Erzähl mir kurz vom Fahrer des Mercedes.');
  assert.equal(fillCase('Was weisst du über {n:akk}?', 'Herr Koch'), 'Was weisst du über Herrn Koch?');
  assert.equal(declineName('Fahrer des Mercedes', 'dat', { gender: 'n', role: true }), null, 'ohne Geschlecht keine Form');
});

// ── 5. Beziehungssätze ───────────────────────────────────────────────────
test('Beziehungssatz: «Stefan ist Peters Sohn.», nie «Für X ist Y ein …», Beschreibung als zweiter Satz', () => {
  const P = { name: 'Peter', geschlecht: 'männlich' }, S = { name: 'Stefan', geschlecht: 'männlich' };
  const a = relationAnswers({ X: P, Y: S, typY: 'kind', desc: 'Der Sohn enttäuscht ihn.' }, false);
  assert.equal(a[0], 'Stefan ist Peters Sohn. Der Sohn enttäuscht ihn.');
  assert.ok(a.every(x => !/^Für /.test(x)), JSON.stringify(a));
  assert.ok(a.every(x => /^\p{Lu}/u.test(x) && !/^\p{L}+:/u.test(x)));
  const k = relationAnswers({ X: { name: 'Robert', geschlecht: 'männlich' }, Y: { name: 'Herr Koch', geschlecht: 'männlich' }, typY: 'mentor', desc: '' }, false);
  assert.ok(k.some(x => x.startsWith('Herr Koch ist Roberts Mentor; Robert ist sein Schützling.')), JSON.stringify(k));
});

// ── 6. «Wer sagt das?» mit Situation ─────────────────────────────────────
test('whoSays: Antwort nennt Szene und Kapitel, jede Antwort höchstens zweimal', () => {
  const text = [
    'Anna sagte: «Ich werde morgen früh ganz allein zum alten Bahnhof gehen.»',
    'Anna sagte: «Wir müssen das Haus noch vor dem ersten Schnee verkaufen.»',
    'Anna sagte: «Am Sonntag fahren wir alle zusammen an den grossen See.»',
  ].join('\n\n');
  const ctx = {
    samples: [], counts: { dialog: 0 }, langIsEn: false, unifiedSys: 'S',
    opts: { types: { dialog: true }, valSeed: 0, whoSaysMinWords: 6, biasBoost: 1 },
    pageContents: [{ id: 7, chapter: 'Der Vater', chapter_id: 1, title: 'A1', text }],
    figRows: [{ fig_id: 'a', name: 'Anna' }], figNamesSorted: ['Anna'], dialogsByFigure: new Map(),
    sceneRows: [{ id: 11, page_id: 7, titel: 'Abschied am Bahnhof' }], figsByScene: new Map([[11, ['a']]]),
  };
  buildDialogSamples(ctx);
  const who = ctx.samples.filter(s => s.id.startsWith('dialogRev|')).map(s => s.messages[2].content);
  assert.deepEqual(who, Array(2).fill('Das sagt Anna in der Szene «Abschied am Bahnhof» (Kapitel «Der Vater»).'), 'drittes Zitat derselben Szene entfällt');
  // Ohne Szene: Kapitel, dieselbe Antwort höchstens zweimal.
  const many = Array.from({ length: 6 }, (_, i) => `Anna sagte: «Das ist der Satz Nummer ${i} in diesem langen Kapitel hier.»`).join('\n\n');
  const ctx2 = { ...ctx, samples: [], dialogsByFigure: new Map(), sceneRows: [], pageContents: [{ ...ctx.pageContents[0], text: many }] };
  buildDialogSamples(ctx2);
  const who2 = ctx2.samples.filter(s => s.id.startsWith('dialogRev|'));
  assert.equal(who2.length, 2, 'gleiche Kapitel-Antwort höchstens zweimal');
});

// ── 7. Val-Familien vollständig ──────────────────────────────────────────
test('Val: jede Familie hat eine Datei, val = Summe der Familien-Dateien', () => {
  const samples = [];
  for (let i = 0; i < 30; i++) {
    samples.push(sample(`reader|deutung|scene:${i}|0`, `Warum zögert Figur ${i} so lange?`, `Figur ${i} zögert, weil die Angst Nummer ${i} sie lähmt.`, { type: 'reader', unit: `scene:${i}` }));
    samples.push(sample(`authorChat|ort|ort_${i}`, `Was ist Ort ${i}?`, `Ort ${i} ist ein Platz in der Stadt mit Nummer ${i}.`, { unit: `ort:${i}` }));
  }
  const r = finalize(samples, { valSplit: 0.3 });
  const val = lines(r.valJsonl);
  const fam = ['facts', 'writing', 'persona', 'refusal', 'editor'].reduce((a, f) => a + (r.valFamilyJsonl[f] ? lines(r.valFamilyJsonl[f]).length : 0), 0);
  assert.ok(val.length > 0);
  assert.equal(fam, val.length);
  assert.ok(lines(r.valFamilyJsonl.persona).some(s => /^Warum/.test(s.messages[1].content)), '«Warum»-Fragen in val-persona');
  assert.equal(r.stats.valPersona, lines(r.valFamilyJsonl.persona).length);
});

// ── 8. Lint und Schweizer Schreibung ─────────────────────────────────────
test('Lint: kein «etikett:», Grossbuchstabe am Anfang, kein «ß» in Schweizer Schreibung', () => {
  assert.equal(lintAnswer('vorgesetzter: Er führt das Team.'), 'label');
  assert.equal(lintAnswer('Mitglieder: Gisela, Peter.'), 'label');
  assert.equal(lintAnswer('madame_phantasma ist eine Randfigur.'), 'lowercase');
  assert.equal(lintAnswer('«Bambule» gehört zum Genre Rap.'), null);
  assert.equal(lintAnswer('1987 zieht sie nach Olten.'), null);
  assert.equal(lintAnswer('Er weiß es.', true), 'eszett');
  assert.equal(lintAnswer('Er weiß es.', false), null);
  const r = finalize([
    sample('authorChat|power-rel|a|b', 'In welchem Machtverhältnis stehen A und B?', 'vorgesetzter: Er führt das Team.'),
    sample('reader|deutung|scene:1|0', 'Warum schweigt Dennis?', 'Dennis weiß, dass niemand ihm zuhört.', { type: 'reader' }),
    sample('style|1', 'Setze fort.', 'und dann ging er weiter, ohne sich umzusehen.', { type: 'style' }),
  ], {}, [{ id: 1, text: 'Dennis weiss es. Er ging weiter.' }]);
  assert.equal(r.stats.lintDropped, 1);
  const out = lines(r.trainJsonl).map(s => s.messages[2].content);
  assert.ok(out.includes('Dennis weiss, dass niemand ihm zuhört.'), 'ß → ss, wenn der Buchtext kein ß kennt');
  assert.ok(out.some(a => a.startsWith('und dann')), 'Buchtext-Ziele unberührt');
});

test('Lektoratsnotiz im Manuskript fällt in jeder Familie weg', () => {
  const note = 'eine Welt als Wille und Vorstellung – Anspielung auf Schopenhauer, aber im Kontext grammatisch schwebend; besser: «eine Welt nach Wille und Vorstellung», die er gestalten konnte.';
  const r = finalize([
    sample('pageCloze|1|0', 'Ergänze die Lücke.', 'Er verstand, dass dies sein Tor zur Welt sei: ' + note, { type: 'scene' }),
    sample('style|2', 'Setze fort.', 'Er verstand es nicht.', { type: 'style' }),
  ]);
  assert.equal(r.stats.noteDropped, 1);
  assert.equal(lines(r.trainJsonl).length, 1);
});

// ── 9. Erfundene Namen gestreut ──────────────────────────────────────────
test('Ablehnen: Namensvorrat ≥ 40 + 40, kein Nachname gehäuft', () => {
  const { FIRST, LAST, PLACE_A, FAKE_EVENTS } = require('../../routes/jobs/finetune-export/samples/reader/refusals.js');
  assert.ok(FIRST.de.length >= 40 && LAST.de.length >= 40 && FIRST.en.length >= 40 && LAST.en.length >= 40);
  assert.ok(PLACE_A.de.length >= 12 && FAKE_EVENTS.de.length >= 15);
  const ordered = (arr) => [...arr];
  const pairs = spreadPairs(FIRST.de, LAST.de, ordered).slice(0, 100);
  const perLast = new Map();
  for (const p of pairs) { const l = p.split(' ')[1]; perLast.set(l, (perLast.get(l) || 0) + 1); }
  assert.ok(Math.max(...perLast.values()) <= 3, JSON.stringify([...perLast]));
});
