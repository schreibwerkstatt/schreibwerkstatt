// Unit: Finetune-Export v3 (docs/finetuning.md#kernwissen, #ablehnen-lernen):
// Lektorat bleibt aus Inhaltsantworten, Beziehungen in beiden Richtungen,
// Paraphrasen eines Fakts auf derselben Split-Seite, Ablehnungen ohne echte
// Figuren, Antwortlänge an Satzgrenzen, «Wer sagt das?» nur bei eindeutigen
// Zitaten, eval_steps als Anteil in der Studio-YAML.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildStudioYaml, studioSteps, finetuneProfileById, exportOptions, EXPORT_DEFAULTS } from '../../public/js/book/finetune-profiles.js';
import * as relTypes from '../../public/js/book/beziehung-typen.js';

const require = createRequire(import.meta.url);
const { isCritique, makeCritiqueRegex } = require('../../routes/jobs/finetune-export/lib/critique.js');
const { capAnswerLengths } = require('../../routes/jobs/finetune-export/lib/answer-length.js');
const { finalizeFinetuneSamples } = require('../../routes/jobs/finetune-export/finalize.js');
const { makeCoreHelpers } = require('../../routes/jobs/finetune-export/samples/core-facts/variants.js');
const { buildRelationCore } = require('../../routes/jobs/finetune-export/samples/core-facts/relations.js');
const { buildRefusalSamples } = require('../../routes/jobs/finetune-export/samples/reader/refusals.js');
const { makeReaderPush } = require('../../routes/jobs/finetune-export/samples/reader/push.js');
const { buildDialogSamples } = require('../../routes/jobs/finetune-export/samples/dialog.js');
const { paragraphTargetMax } = require('../../routes/jobs/finetune-export/lib/paragraph-budget.js');

const sample = (id, user, answer, extra = {}) => ({
  id, type: extra.type || 'authorChat', ...extra,
  messages: [{ role: 'system', content: 'S' }, { role: 'user', content: user }, { role: 'assistant', content: answer }],
});
const finalize = (samples, opts = {}, pageContents = []) => finalizeFinetuneSamples({
  samples, langIsEn: false, pageContents,
  opts: { valSplit: 0, valSeed: 0, maxSeqTokens: 0, emitText: false, truncateLong: false, ...opts },
});

// ── 1. Kritik-Filter ─────────────────────────────────────────────────────
test('Kritik-Filter: Lektorats-Sprache erkannt, Inhalt und Figurenbeschreibung nicht', () => {
  const critique = [
    'Das Porträt ist atmosphärisch, bleibt aber reines Telling.',
    'Eine kurze, konkrete Szene würde die Wirkung deutlich stärker machen.',
    'Das auslösende Ereignis wird nur zusammengefasst und ohne Bild erzählt.',
    'Die Szene etabliert durch den humorvollen Vortrag die familiäre Dynamik.',
    'Der Dialog ist etwas statisch. Verbesserung: Mehr Interaktion zeigen.',
    'Der Abschnitt wirkt wie Füllstoff.',
    'Die These bleibt thesenhaft.',
    'Hier liesse sich die Spannung erhöhen.',
  ];
  for (const c of critique) assert.ok(isCritique(c), c);
  const content = [
    'Gisela ist Stefans Mutter; Stefan ist ihr Sohn.',
    'Er wirkt wie ein Fremder in seinem eigenen Haus.',
    'Im Kapitel «Der Vater» geht es um: Stefan zieht aus; Gisela erkrankt.',
    'Renate würde am liebsten fortgehen, bleibt aber bei ihrer Familie.',
    'Die Szene spielt am Bahnhof von Olten.',
  ];
  for (const c of content) assert.ok(!isCritique(c), c);
  // Konfigurierbar: eigene Muster ersetzen die Standardliste.
  assert.ok(makeCritiqueRegex(['\\bGurke\\b']).test('eine Gurke'));
  assert.ok(!makeCritiqueRegex(['\\bGurke\\b']).test('bleibt aber reines Telling'));
});

test('Kritik-Filter in finalize: Inhaltsantworten raus und gezählt, Buchtext als Schreibziel bleibt', () => {
  const r = finalize([
    sample('authorChat|scene|1|0', 'Was passiert in «Rauferei»?', 'Das auslösende Ereignis wird nur zusammengefasst und ohne Bild erzählt.'),
    sample('authorChat|scene|2|0', 'Was passiert in «Abschied»?', 'In «Abschied» geschieht: Stefan verlässt das Haus.'),
    sample('style|1', 'Setze fort.', 'Sie stand am Fenster, und der Hof wirkt wie ein leerer Teller, bleibt aber hell.', { type: 'style' }),
  ]);
  assert.equal(r.stats.critiqueDropped, 1);
  const answers = r.trainJsonl.trim().split('\n').map(l => JSON.parse(l).messages[2].content);
  assert.ok(answers.some(a => a.startsWith('In «Abschied»')));
  assert.ok(answers.some(a => a.startsWith('Sie stand am Fenster')), 'Buchtext wird nicht gefiltert');
  const re = makeCritiqueRegex();
  for (const l of r.trainJsonl.trim().split('\n')) {
    const s = JSON.parse(l);
    if (!s.messages[1].content.startsWith('Setze')) assert.ok(!re.test(s.messages[2].content));
  }
});

// ── 2. Beziehung in beide Richtungen ─────────────────────────────────────
function relCtx(rows, figs, opts = {}) {
  const figRows = figs;
  const ctx = {
    langIsEn: false, opts: { valSeed: 0, factParaphrases: 4, maxVariantsPerFact: 5, ...opts },
    samples: [], counts: {}, unifiedSys: 'S', relTypes,
    figRows, figById: new Map(figRows.map(f => [f.fig_id, f])), figRelRows: rows,
    eligibleFigIds: new Set(figRows.map(f => f.fig_id)),
  };
  const { emitCard, variantCount } = makeCoreHelpers(ctx);
  const res = buildRelationCore(ctx, emitCard, variantCount);
  return { ctx, ...res };
}
const STEFAN = { fig_id: 'f_stefan', name: 'Stefan', geschlecht: 'männlich' };
const GISELA = { fig_id: 'f_gisela', name: 'Gisela', geschlecht: 'weiblich' };

test('Beziehung: beide Richtungen, Rolle ausgeschrieben, kein Präfix «Elternteil:»', () => {
  // Stefan –elternteil→ Gisela: Gisela ist der Elternteil von Stefan.
  const { ctx, facts } = relCtx([{ from_fig_id: 'f_stefan', to_fig_id: 'f_gisela', typ: 'elternteil', beschreibung: 'Sie zieht ihn allein gross.' }], [STEFAN, GISELA]);
  assert.equal(facts.length, 1);
  const qa = ctx.samples.map(s => [s.dir, s.messages[1].content, s.messages[2].content]);
  // Je Richtung nennt jede Antwort zuerst die Rolle des Gegenübers: aus
  // Stefans Sicht «Mutter», aus Giselas Sicht «Sohn».
  const firstRole = (a) => (/(Mutter|Sohn)/.exec(a) || [])[1];
  const roles = (dir) => new Set(qa.filter(x => x[0] === dir).map(x => firstRole(x[2])));
  assert.equal(roles('ab').size, 1, JSON.stringify(qa));
  assert.equal(roles('ba').size, 1, JSON.stringify(qa));
  assert.notDeepEqual(roles('ab'), roles('ba'));
  for (const [, q, a] of qa) {
    if (/^Wie steht Stefan zu Gisela\?$|^Was ist Gisela für Stefan\?$/.test(q)) assert.equal(firstRole(a), 'Mutter', `${q} → ${a}`);
    if (/^Wie steht Gisela zu Stefan\?$|^Was ist Stefan für Gisela\?$/.test(q)) assert.equal(firstRole(a), 'Sohn', `${q} → ${a}`);
  }
  assert.ok(qa.filter(x => x[0] === 'ab').length >= 2 && qa.filter(x => x[0] === 'ba').length >= 2);
  assert.ok(qa.some(([, , a]) => a.startsWith('Gisela ist Stefans Mutter')));
  assert.ok(qa.some(([, , a]) => a.startsWith('Stefan ist Giselas Sohn')));
  assert.ok(qa.every(([, , a]) => !/^(Elternteil|Kind):/.test(a)));
  // Alle Varianten tragen dieselbe Fakt-ID, beide Richtungen sind markiert.
  assert.equal(new Set(ctx.samples.map(s => s.factId)).size, 1);
  assert.deepEqual(new Set(ctx.samples.map(s => s.dir)), new Set(['ab', 'ba']));
  // Paraphrasen: verschiedene Antworttexte, nicht nur andere Fragen.
  assert.ok(new Set(ctx.samples.map(s => s.messages[2].content)).size >= 3);
});

test('Beziehung: widersprüchliche Paare fallen weg und werden gezählt', () => {
  const { facts, conflicts } = relCtx([
    { from_fig_id: 'f_stefan', to_fig_id: 'f_gisela', typ: 'elternteil', beschreibung: 'Mutter' },
    { from_fig_id: 'f_gisela', to_fig_id: 'f_stefan', typ: 'geschwister', beschreibung: '' },
  ], [STEFAN, GISELA]);
  assert.equal(facts.length, 0);
  assert.equal(conflicts, 1);
  const kin = relCtx([{ from_fig_id: 'f_stefan', to_fig_id: 'f_gisela', typ: 'kind', beschreibung: 'Enkelin Gisela' }], [STEFAN, GISELA]);
  assert.equal(kin.facts.length, 0, '«Enkelin» passt nicht zu «kind»');
});

// ── 3. Paraphrasen in derselben Split-Gruppe ─────────────────────────────
test('Paraphrasen eines Fakts landen auf derselben Seite, Kernfakten immer im Train', () => {
  const samples = [];
  for (let c = 0; c < 40; c++) {
    for (let v = 0; v < 4; v++) {
      samples.push(sample(`core|evt:${c}:when|${v}`, `Wann passiert Ereignis ${c}, Variante ${v}?`, `Ereignis Nummer ${c} passiert im Jahr ${1900 + c}, Fassung ${v}.`,
        { type: 'core', task: 'eventCore', factId: `evt:${c}:when`, unit: `evt:${c}` }));
    }
  }
  for (let c = 0; c < 10; c++) {
    samples.push(sample(`core|fig:${c}:core|0`, `Wer ist Figur ${c}?`, `Figur ${c} ist eine der Hauptfiguren.`,
      { type: 'core', task: 'figureCore', factId: `fig:${c}:core`, unit: `fig:${c}`, core: true }));
  }
  const r = finalize(samples, { valSplit: 0.3, maxPerAnswer: 0 });
  const side = new Map();
  const train = r.trainJsonl.trim().split('\n').map(l => JSON.parse(l).messages[1].content);
  const val = r.valJsonl.trim().split('\n').map(l => JSON.parse(l).messages[1].content);
  const factOf = (q) => (/Ereignis (\d+)/.exec(q) || [])[1];
  for (const q of train) if (factOf(q)) side.set(factOf(q), (side.get(factOf(q)) || '') + 'T');
  for (const q of val) if (factOf(q)) side.set(factOf(q), (side.get(factOf(q)) || '') + 'V');
  assert.ok(val.length > 0, 'Val nicht leer');
  for (const [f, s] of side) assert.ok(/^T+$|^V+$/.test(s), `Fakt ${f} auf beiden Seiten: ${s}`);
  assert.ok(!val.some(q => q.startsWith('Wer ist Figur')), 'Kernfakten nie in Val');
  assert.deepEqual(r.stats.quality.overlapByVal['val-facts'], { prompt: 0, answer: 0, shingle: 0 });
});

// ── 4. Ablehnungen ohne echte Figuren ────────────────────────────────────
test('Ablehnungen: erfundene Namen sind keine echten Figuren, Antworten nennen keine', () => {
  const figRows = [
    { fig_id: 'f1', pk: 1, name: 'Stefan Meier', geschlecht: 'männlich', beruf: 'Lehrer' },
    { fig_id: 'f2', pk: 2, name: 'Gisela Meier', geschlecht: 'weiblich', beruf: 'Ärztin' },
    { fig_id: 'f3', pk: 3, name: 'Konrad Albisser', geschlecht: 'männlich' },
  ];
  const ctx = {
    langIsEn: false, displayName: 'Testbuch', opts: { valSeed: 0 }, unifiedSys: 'S',
    samples: [], counts: {}, voiceTargets: new Map(),
    pageContents: [{ id: 1, text: 'Stefan Meier ging mit Gisela Meier nach Olten. Konrad Albisser wartete.' }],
    figRows, locRows: [{ pk: 1, loc_id: 'l1', name: 'Olten' }],
    figById: new Map(figRows.map(f => [f.fig_id, f])),
    figRelRows: [{ from_fig_id: 'f1', to_fig_id: 'f2', typ: 'elternteil', beschreibung: '' }],
    relTypes, eligibleFigIds: new Set(['f1', 'f2', 'f3']), eventsByFigPk: new Map(),
  };
  buildRefusalSamples(ctx, makeReaderPush(ctx));
  const real = figRows.map(f => f.name);
  const kinds = new Set(ctx.samples.map(s => s.id.split('|')[1]));
  for (const k of ['unknownFig', 'unknownNear', 'unknownPlace', 'offTopic', 'falsePremise']) assert.ok(kinds.has(k), k);
  for (const s of ctx.samples.filter(x => x.id.startsWith('refusal|unknownFig|'))) {
    const fake = s.id.split('|')[2];
    assert.ok(!real.includes(fake), `${fake} ist eine echte Figur`);
    assert.ok(!/Albisser/.test(fake), 'Nachname einer echten Figur nie im erfundenen Namen');
    const q = s.messages[1].content;
    const a = s.messages[2].content;
    // Eine Beziehungsfrage nennt die echte Figur in der Frage — die Antwort darf sie wiederholen.
    for (const r of real) if (!q.includes(r)) assert.ok(!a.includes(r), `${a} nennt ${r}`);
  }
  // Ähnlicher Name: Hinweis auf die echte Figur statt sie zu leugnen.
  const near = ctx.samples.find(x => x.id.startsWith('refusal|unknownNear|'));
  assert.match(near.messages[2].content, /Meinst du vielleicht (Stefan|Gisela) Meier\?/);
  // Falsche Annahme korrigiert mit der richtigen Rolle.
  const fp = ctx.samples.find(x => x.id.startsWith('refusal|falsePremise|rel|'));
  assert.match(fp.messages[2].content, /nicht .*sondern|nicht\./);
  assert.ok(ctx.samples.every(s => s.unit && s.unit.startsWith('ref:')));
});

// ── 5. maxAnswerChars an der Satzgrenze ──────────────────────────────────
test('maxAnswerChars: an der Satzgrenze gekürzt, «Teil N von M» verworfen statt gekappt', () => {
  const long = 'Erster Satz steht hier. Zweiter Satz folgt sogleich. Dritter Satz ist deutlich länger als die anderen beiden zusammen.';
  const e1 = { s: { ...sample('pageCont|1|10', 'Setze fort', long), task: 'continue' }, tokens: 0 };
  const e2 = { s: { ...sample('chapFullChunk|1|0', 'Teil 1', long), task: 'sceneWrite', noTruncate: true }, tokens: 0 };
  const e3 = { s: { ...sample('authorChat|evt|1|0', 'Frage', long), task: 'factEvent' }, tokens: 0 };
  const r = capAnswerLengths([e1, e2, e3], { continue: 60, sceneWrite: 60 }, () => 1);
  assert.equal(r.clipped, 1);
  assert.equal(r.dropped, 1);
  assert.equal(e1.s.messages[2].content, 'Erster Satz steht hier. Zweiter Satz folgt sogleich.');
  assert.ok(/[.!?»]$/.test(e1.s.messages[2].content), 'endet am Satzende');
  assert.equal(e3.s.messages[2].content, long, 'Typ ohne Deckel bleibt');
  assert.ok(!r.kept.includes(e2));
});

// ── 6. «Wer sagt das?» ───────────────────────────────────────────────────
test('whoSays: nur lange, einmalige Zitate einer eindeutig benannten Figur', () => {
  const text = [
    'Anna sagte: «Ich werde morgen früh ganz allein zum alten Bahnhof gehen.»',
    'Anna sagte: «Ich weiss nicht.»',
    'Anna sagte: «Das wiederholte Zitat steht hier gleich zweimal im Buch.»',
    'Ben rief: «Das wiederholte Zitat steht hier gleich zweimal im Buch.»',
    'Meier meinte: «Wir müssen das Haus noch vor dem ersten Schnee verkaufen.»',
  ].join('\n\n');
  const figRows = [
    { fig_id: 'a', name: 'Anna' }, { fig_id: 'b', name: 'Ben' },
    { fig_id: 'm1', name: 'Hans Meier', kurzname: 'Meier' }, { fig_id: 'm2', name: 'Eva Meier', kurzname: 'Meier' },
  ];
  const ctx = {
    samples: [], counts: { dialog: 0 }, langIsEn: false, unifiedSys: 'S',
    opts: { types: { dialog: true }, valSeed: 0, whoSaysMinWords: 6, biasBoost: 1 },
    pageContents: [{ id: 1, chapter: 'K1', chapter_id: 1, title: 'A1', text }],
    figRows, figNamesSorted: ['Hans Meier', 'Eva Meier', 'Anna', 'Meier', 'Ben'], dialogsByFigure: new Map(),
  };
  buildDialogSamples(ctx);
  const who = ctx.samples.filter(s => s.id.startsWith('dialogRev|')).map(s => [s.messages[1].content, s.messages[2].content]);
  assert.equal(who.length, 1, JSON.stringify(who));
  assert.match(who[0][0], /alten Bahnhof/);
  assert.match(who[0][1], /^Das sagt Anna im Kapitel «K1»\.$/);
});

// ── 7. Studio-YAML ───────────────────────────────────────────────────────
test('Studio-YAML: eval_steps als Anteil, feste Länge ohne Early Stopping, Gesamtschritte', () => {
  const p = finetuneProfileById('ministral3-8b-16gb');
  const yaml = buildStudioYaml(p, { maxSeqTokens: 4096, trainCount: 9637 });
  const val = (k) => Number(new RegExp(`^  ${k}: (.+)$`, 'm').exec(yaml)[1]);
  assert.ok(val('eval_steps') > 0 && val('eval_steps') < 1, 'Anteil 0–1');
  assert.equal(val('early_stopping_patience'), 0);
  assert.equal(val('learning_rate'), 1e-4);
  assert.equal(val('lora_dropout'), 0.05);
  assert.equal(val('num_epochs'), 1);
  const steps = studioSteps(p, 9637);
  assert.equal(steps.perEpoch, Math.ceil(9637 / 16));
  assert.equal(val('save_steps'), Math.round(steps.total * 0.1));
  // max_steps-Variante: ≈ 1.5 Epochen.
  const yamlSteps = buildStudioYaml({ ...p, trainBy: 'steps', trainEpochs: 1.5 }, { trainCount: 9637 });
  assert.equal(Number(/^  max_steps: (\d+)$/m.exec(yamlSteps)[1]), Math.ceil(Math.ceil(9637 / 16) * 1.5));
  // Export-Vorgaben: Profil-Overrides gehen über die Basis, Rest bleibt.
  const o = exportOptions({ export: { maxAnswerChars: { continue: 1000 } } });
  assert.equal(o.maxAnswerChars.continue, 1000);
  assert.equal(o.maxAnswerChars.sceneWrite, EXPORT_DEFAULTS.maxAnswerChars.sceneWrite);
  assert.equal(o.types.verbatim, false, 'verbatim standardmässig aus');
});

// ── Absatz-Budget ────────────────────────────────────────────────────────
test('Absatz-Budget: höchstens maxTargetsPerParagraph Samples mit demselben Absatz als Ziel', () => {
  const para = 'eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn sechzehn.';
  const pageContents = [{ id: 1, chapter_id: 1, text: para }];
  const samples = [
    sample('pageCont|1|10', 'A', para, { type: 'scene' }),
    sample('page|1', 'B', para, { type: 'scene' }),
    sample('pageCloze|1', 'C', para, { type: 'scene' }),
    sample('chapCont|1|10', 'D', para, { type: 'scene' }),
  ];
  const r = finalize(samples, { maxTargetsPerParagraph: 2, maxPerAnswer: 0 }, pageContents);
  assert.equal(r.stats.train, 2);
  assert.equal(r.stats.paragraphTargetMax, 2);
  assert.equal(paragraphTargetMax(samples, pageContents), 4);
});
