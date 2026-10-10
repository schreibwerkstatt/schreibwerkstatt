// Klassischer Buch-Chat: Gliederung im gecachten Block 1, Auszüge in Block 2 mit
// Kapitelpfad. Der Gliederungs-Block muss seinen Zeichendeckel halten — zuerst
// fallen die Abschnittsnamen, dann wird ausgewiesen gekürzt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const cfg = JSON.parse(readFileSync(new URL('../../prompt-config.json', import.meta.url), 'utf8'));
const facade = await import('../../public/js/prompts.js');
facade.configurePrompts(cfg, 'claude');
const { buildGliederungBlock, buildBookChatSystemPrompt } = facade;
const { buildOutline } = createRequire(import.meta.url)('../../lib/content-store/outline.js');

const chapters = [
  { id: 1, name: 'Teil Eins' }, { id: 11, name: 'Kapitel 1.1' }, { id: 2, name: 'Teil Zwei' },
];
const pages = [
  { id: 100, name: 'Prolog' }, { id: 101, name: 'Intro', chapter_id: 1 },
  { id: 111, name: 'Szene A', chapter_id: 11 }, { id: 102, name: 'Zwischenspiel', chapter_id: 1 },
  { id: 201, name: 'Finale', chapter_id: 2 },
];
const tree = [
  { type: 'page', id: 100 },
  { type: 'chapter', id: 1, children: [
    { type: 'page', id: 101 },
    { type: 'chapter', id: 11, children: [{ type: 'page', id: 111 }] },
    { type: 'page', id: 102 },
  ] },
  { type: 'chapter', id: 2, children: [{ type: 'page', id: 201 }] },
];
const outline = buildOutline(tree, chapters, pages);

test('buildOutline: Tree-Reihenfolge, Tiefe, Pfad; Unbekanntes hinten statt verschluckt', () => {
  assert.deepEqual(outline.map(n => n.name),
    ['Prolog', 'Teil Eins', 'Intro', 'Kapitel 1.1', 'Szene A', 'Zwischenspiel', 'Teil Zwei', 'Finale']);
  assert.deepEqual(outline.find(n => n.id === 111 && n.type === 'page').path, ['Teil Eins', 'Kapitel 1.1']);
  const extra = buildOutline(tree, chapters, [...pages, { id: 999, name: 'Verwaist', chapter_id: 11 }]);
  const last = extra[extra.length - 1];
  assert.equal(last.name, 'Verwaist');
  assert.equal(last.chapter_id, 11);
});

test('buildGliederungBlock: eingerückt in Lesereihenfolge', () => {
  const text = buildGliederungBlock(outline);
  const body = text.split('\n').slice(1);
  assert.deepEqual(body, [
    '· Prolog',
    '▸ Teil Eins',
    '  · Intro',
    '  ▸ Kapitel 1.1',
    '    · Szene A',
    '  · Zwischenspiel',
    '▸ Teil Zwei',
    '  · Finale',
  ]);
  assert.equal(buildGliederungBlock([]), null);
});

test('buildGliederungBlock: Deckel — erst Abschnittsnamen weg, dann ausgewiesen gekürzt', () => {
  const many = buildOutline(
    [{ type: 'chapter', id: 1, children: Array.from({ length: 200 }, (_, i) => ({ type: 'page', id: 1000 + i })) }],
    [{ id: 1, name: 'Einziges Kapitel' }],
    Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, name: `Abschnitt mit langem Namen ${i}`, chapter_id: 1 })),
  );
  const compact = buildGliederungBlock(many, { maxChars: 500 });
  assert.ok(compact.length <= 500);
  assert.match(compact, /▸ Einziges Kapitel \(200 Abschnitte\)/);
  assert.doesNotMatch(compact, /Abschnitt mit langem Namen/);

  const chaptersOnly = buildOutline(
    Array.from({ length: 100 }, (_, i) => ({ type: 'chapter', id: i + 1, children: [] })),
    Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `Kapitel Nummer ${i + 1}` })), [],
  );
  const cut = buildGliederungBlock(chaptersOnly, { maxChars: 400 });
  assert.ok(cut.length <= 400);
  assert.match(cut, /Gliederung gekürzt/);
});

test('buildBookChatSystemPrompt: Gliederung im gecachten Block, Kapitelpfad an den Auszügen', () => {
  const gliederung = buildGliederungBlock(outline);
  const blocks = buildBookChatSystemPrompt('Buch', [
    { name: 'Szene A', chapter_path: 'Teil Eins › Kapitel 1.1', text: 'Text A' },
    { name: 'Prolog', chapter_path: '', text: 'Text P' },
  ], [], null, null, { excerpt: true, gliederung });
  assert.equal(blocks[0].ttl, '1h');
  assert.ok(blocks[0].text.includes(gliederung));
  assert.ok(!blocks[1].text.includes('GLIEDERUNG'));
  assert.match(blocks[1].text, /in Lesereihenfolge/);
  assert.match(blocks[1].text, /--- Auszug aus Abschnitt: Szene A \(Kapitel: Teil Eins › Kapitel 1\.1\) ---/);
  assert.match(blocks[1].text, /--- Auszug aus Abschnitt: Prolog ---/);
});
