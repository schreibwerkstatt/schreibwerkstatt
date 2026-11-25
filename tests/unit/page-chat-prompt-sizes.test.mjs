// Abschnitts-Chat: Prompt-Zusammensetzung fürs Job-Log. buildChatSystemPrompt
// füllt opts.sizes (Zeichen je Baustein), ohne die Blöcke zu verändern;
// formatPromptSizes macht daraus die Log-Zeile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { buildChatSystemPrompt } = await import('../../public/js/prompts.js');
const require = createRequire(import.meta.url);
const { formatPromptSizes } = require('../../routes/jobs/chat/page-chat-context.js');

const figuren = [{ id: 'f1', name: 'Adrian', beschreibung: 'Bruder der Erzählerin.' }];
const review = { gesamtnote: 4.5, fazit: 'Trägt.', staerken: ['Ton'], schwaechen: ['Tempo'] };
const lektorat = { fehler: [{ typ: 'stil', original: 'sehr sehr', korrektur: 'sehr' }], fazit: 'Gut.' };

test('sizes: Blocklängen stimmen mit den gebauten Blöcken überein', () => {
  const sizes = {};
  const blocks = buildChatSystemPrompt('Anfang', 'Der Text des Abschnitts.', figuren, review, null, null, [], lektorat, { sizes });
  assert.equal(sizes.block1, blocks[0].text.length);
  assert.equal(sizes.block2, blocks[1].text.length);
  assert.equal(sizes.abschnitt, 'Der Text des Abschnitts.'.length);
  assert.ok(sizes.figuren > 0 && sizes.figuren < sizes.block1);
  assert.match(sizes.figurenModus, /^voll 1\/1$/);
  assert.ok(sizes.review > 0);
  assert.ok(sizes.lektorat > 0 && sizes.lektorat < sizes.block2);
});

test('sizes: ändert die Blöcke nicht', () => {
  const a = buildChatSystemPrompt('Anfang', 'Text.', figuren, review, null, null, [], lektorat, {});
  const b = buildChatSystemPrompt('Anfang', 'Text.', figuren, review, null, null, [], lektorat, { sizes: {} });
  assert.deepEqual(a, b);
});

test('sizes: ohne Figuren, Bewertung und Lektorat stehen Nullen, kein Fehler', () => {
  const sizes = {};
  buildChatSystemPrompt('Anfang', 'Text.', [], null, null, null, [], null, { sizes });
  assert.equal(sizes.figuren, 0);
  assert.equal(sizes.figurenModus, '-');
  assert.equal(sizes.review, 0);
  assert.equal(sizes.lektorat, 0);
});

test('formatPromptSizes: eine Zeile mit allen Bausteinen in K-Zeichen', () => {
  const line = formatPromptSizes(
    { block1: 219400, system: 5000, figuren: 210900, figurenModus: 'voll 30/30', review: 2100, titel: 3100, block2: 42000, abschnitt: 30000, aenderungen: 0, ideen: 500, welt: 800, lektorat: 9000 },
    { buchKontext: 6669, verlauf: 12000, verlaufNachrichten: 2 },
  );
  assert.match(line, /Block1 219\.4K/);
  assert.match(line, /Figuren 210\.9K \[voll 30\/30\]/);
  assert.match(line, /Lektorat 9\.0K/);
  assert.match(line, /Buch-Kontext 6\.7K/);
  assert.match(line, /Verlauf 12\.0K \(2 Nachrichten\)/);
});

// ── Figuren-Modus (Setting jobs.page_chat.figuren_modus) ─────────────────────
const ensemble = [
  { id: 'f1', name: 'Adrian', beschreibung: 'Bruder.', szenen: [{ titel: 'Am See', kommentar: 'tragend' }], beziehungen: [{ mit: 'f2', typ: 'geschwister' }] },
  { id: 'f2', name: 'Lea', beschreibung: 'Erzählerin.', schauplätze: [{ name: 'Küche' }] },
];

test('figurenModus kompakt: gleicher Inhalt wie voll, ohne Einrückung, kleiner', () => {
  const sv = {}, sk = {};
  const voll = buildChatSystemPrompt('A', 'Text.', ensemble, null, null, null, [], null, { sizes: sv });
  const kompakt = buildChatSystemPrompt('A', 'Text.', ensemble, null, null, null, [], null, { figurenModus: 'kompakt', sizes: sk });
  assert.match(sk.figurenModus, /^kompakt 2\/2$/);
  assert.ok(sk.figuren < sv.figuren);
  for (const f of ensemble) assert.ok(kompakt[0].text.includes(JSON.stringify(f)), `${f.id} vollständig`);
  assert.equal(voll[1].text, kompakt[1].text);
});

test('figurenModus ohne_listen: Szenen- und Ortslisten fallen weg, ihre Anzahl bleibt, der Rest vollständig', () => {
  const sizes = {};
  const blocks = buildChatSystemPrompt('A', 'Text.', ensemble, null, null, null, [], null, { figurenModus: 'ohne_listen', sizes });
  const b1 = blocks[0].text;
  assert.ok(!b1.includes('Am See') && !b1.includes('Küche'), 'keine Szenen/Orte');
  assert.match(b1, /"beziehungen":\[\{"mit":"f2","typ":"geschwister"\}\]/);
  assert.match(b1, /"weggelassen":\{"szenen":1\}/);
  assert.match(b1, /"weggelassen":\{"schauplätze":1\}/);
  assert.match(b1, /Volldossiers ohne die Listen `szenen` und `schauplätze`/);
  assert.match(sizes.figurenModus, /^ohne_listen 2\/2$/);
});

test('figurenModus ohne_listen: Block 1 bleibt für jeden Abschnitt gleich (Cache)', () => {
  const a = buildChatSystemPrompt('A', 'Erster.', ensemble, null, null, null, [], null, { figurenModus: 'ohne_listen' });
  const b = buildChatSystemPrompt('B', 'Zweiter.', ensemble, null, null, null, [], null, { figurenModus: 'ohne_listen' });
  assert.equal(a[0].text, b[0].text);
});
