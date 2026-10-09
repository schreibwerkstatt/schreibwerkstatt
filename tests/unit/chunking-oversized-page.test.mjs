// splitGroupsIntoChunks / halveChunkPages (routes/jobs/shared/chunking.js):
// ein Abschnitt über dem Chunk-Limit wird in Teile mit gleicher Identität zerlegt;
// Bücher ohne übergrossen Abschnitt chunken byte-identisch zum reinen Seiten-Split
// (Delta-Cache-Keys + geteilter Prompt-Cache-Präfix der Komplettanalyse).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  splitGroupsIntoChunks, splitPageIntoParts, halveChunkPages, pageSigSuffix,
} = require('../../routes/jobs/shared/chunking.js');

// Referenz: der reine Seiten-Split ohne Teil-Zerlegung.
function legacySplit(groups, groupOrder, perChunkLimit) {
  const chunkOrder = [], chunks = new Map();
  for (const key of groupOrder) {
    const group = groups.get(key);
    const totalChars = group.pages.reduce((s, p) => s + p.text.length, 0);
    if (totalChars <= perChunkLimit) { chunkOrder.push(key); chunks.set(key, group); continue; }
    let currentPages = [], currentChars = 0, subIdx = 0;
    for (const page of group.pages) {
      if (currentChars + page.text.length > perChunkLimit && currentPages.length > 0) {
        chunkOrder.push(`${key}__sub${subIdx}`);
        chunks.set(`${key}__sub${subIdx}`, { name: group.name, pages: currentPages });
        currentPages = []; currentChars = 0; subIdx++;
      }
      currentPages.push(page);
      currentChars += page.text.length;
    }
    if (currentPages.length > 0) {
      chunkOrder.push(`${key}__sub${subIdx}`);
      chunks.set(`${key}__sub${subIdx}`, { name: group.name, pages: currentPages });
    }
  }
  return { chunkOrder, chunks };
}

const render = (chunk) => chunk.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
const sig = (chunk) => chunk.pages.map(p => `${p.id}:${p.updated_at}${pageSigSuffix(p)}`).sort().join('|');

function sentences(n, seed = 0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`Satz ${seed}-${i} erzählt, was Anna am Fluss sah und warum sie schwieg.`);
  return out.join(' ');
}

function makeBook(pageSizes) {
  const groups = new Map(), groupOrder = [];
  let id = 1;
  pageSizes.forEach((sizes, gi) => {
    const key = String(100 + gi);
    groupOrder.push(key);
    groups.set(key, {
      name: `Kapitel ${gi + 1}`,
      pages: sizes.map(n => ({
        id: id, updated_at: `2026-01-0${(id % 9) + 1}`, title: `Abschnitt ${id++}`,
        chapter_id: 100 + gi, chapter: `Kapitel ${gi + 1}`, text: sentences(n, id),
      })),
    });
  });
  return { groups, groupOrder };
}

test('kein übergrosser Abschnitt → byte-identisch zum Seiten-Split', () => {
  // Satz ≈ 70 Zeichen; Limit 3000 → Seiten bis ~40 Sätze passen einzeln.
  const { groups, groupOrder } = makeBook([[10, 20, 30], [40], [5, 5, 5, 5, 5, 5, 5, 5, 5, 5], [38, 39, 2]]);
  for (const limit of [3000, 5000, 100000]) {
    for (const g of groups.values()) for (const p of g.pages) assert.ok(p.text.length <= limit);
    const a = splitGroupsIntoChunks(groups, groupOrder, limit);
    const b = legacySplit(groups, groupOrder, limit);
    assert.deepStrictEqual(a.chunkOrder, b.chunkOrder);
    for (const k of a.chunkOrder) {
      const ca = a.chunks.get(k), cb = b.chunks.get(k);
      assert.equal(ca.name, cb.name);
      assert.equal(ca.pages.length, cb.pages.length);
      ca.pages.forEach((p, i) => assert.strictEqual(p, cb.pages[i], 'gleiche Seiten-Objekte'));
      assert.equal(render(ca), render(cb));
      assert.equal(sig(ca), sig(cb));
    }
  }
});

test('übergrosser Abschnitt wird in Teile ≤ Limit an Satzgrenzen zerlegt', () => {
  const { groups, groupOrder } = makeBook([[5, 200, 5]]);
  const limit = 3000;
  const big = groups.get('100').pages[1];
  assert.ok(big.text.length > limit * 4);
  const { chunkOrder, chunks } = splitGroupsIntoChunks(groups, groupOrder, limit);
  assert.ok(chunkOrder.every(k => k.startsWith('100__sub')));
  const parts = [];
  for (const k of chunkOrder) {
    const c = chunks.get(k);
    assert.ok(c.pages.reduce((s, p) => s + p.text.length, 0) <= limit, `${k} ≤ Limit`);
    const ids = c.pages.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length, 'höchstens ein Eintrag je Abschnitt pro Chunk');
    for (const p of c.pages) if (p.id === big.id) parts.push(p);
  }
  assert.ok(parts.length >= 5);
  parts.forEach((p, i) => {
    // Identität bleibt: id, Titel, Stand, Kapitel.
    assert.equal(p.id, big.id);
    assert.equal(p.title, big.title);
    assert.equal(p.updated_at, big.updated_at);
    assert.equal(p.chapter_id, big.chapter_id);
    assert.equal(p.chapter, big.chapter);
    assert.deepEqual([p.part.nr, p.part.von], [i + 1, parts.length]);
    assert.equal(p.text, big.text.slice(p.part.start, p.part.end), 'Teil ist exakter Ausschnitt');
    if (i < parts.length - 1) assert.match(p.text, /\.$/, 'Schnitt an Satzende');
  });
  // Lückenlos bis auf den trennenden Whitespace.
  assert.equal(parts.map(p => p.text).join(' '), big.text);
  // Teile gleichmässig: kein Zwergteil.
  const sizes = parts.map(p => p.text.length);
  assert.ok(Math.min(...sizes) > limit / 3, `Teilgrössen ${sizes}`);
  // Überschrift im Prompt = echter Titel ohne Teil-Markierung.
  assert.ok(render({ pages: [parts[1]] }).startsWith(`### ${big.title}\n`));
  // Signaturen der Teile unterscheiden sich.
  assert.equal(new Set(parts.map(p => `${p.id}:${p.updated_at}${pageSigSuffix(p)}`)).size, parts.length);
  // Originalseite unverändert.
  assert.equal(big.part, undefined);
});

test('Absatzgrenze hat Vorrang vor Satzgrenze', () => {
  const para1 = sentences(20, 1), para2 = sentences(20, 2);
  const page = { id: 7, title: 'T', updated_at: 'x', text: `${para1}\n\n${para2}` };
  const parts = splitPageIntoParts(page, Math.ceil(page.text.length * 0.6));
  assert.equal(parts.length, 2);
  assert.equal(parts[0].text, para1);
  assert.equal(parts[1].text, para2);
});

test('Text ohne Whitespace wird hart geschnitten', () => {
  const page = { id: 1, title: 'X', text: 'a'.repeat(2500) };
  const parts = splitPageIntoParts(page, 1000);
  assert.equal(parts.length, 3);
  assert.equal(parts.map(p => p.text).join(''), page.text);
  assert.ok(parts.every(p => p.text.length <= 1000));
});

test('halveChunkPages: mehrere Seiten seitenweise wie bisher', () => {
  const pages = [1, 2, 3].map(i => ({ id: i, title: `S${i}`, text: 'x y' }));
  const h = halveChunkPages(pages);
  assert.deepEqual(h.map(x => x.map(p => p.id)), [[1, 2], [3]]);
  assert.strictEqual(h[0][0], pages[0]);
});

test('halveChunkPages: Chunk aus einem Abschnitt wird nahe der Mitte geteilt', () => {
  const page = { id: 42, title: 'Kapitel Eins', updated_at: 'u', chapter_id: 3, text: sentences(41, 9) };
  const h = halveChunkPages([page]);
  assert.equal(h.length, 2);
  const [[a], [b]] = h;
  for (const p of [a, b]) {
    assert.equal(p.id, 42); assert.equal(p.title, 'Kapitel Eins');
    assert.equal(p.updated_at, 'u'); assert.equal(p.chapter_id, 3);
  }
  assert.match(a.text, /\.$/);
  assert.equal(`${a.text} ${b.text}`, page.text);
  const ratio = a.text.length / page.text.length;
  assert.ok(ratio > 0.4 && ratio < 0.6, `ratio ${ratio}`);
  assert.deepEqual([a.part.nr, a.part.von, b.part.nr, b.part.von], [1, 2, 2, 2]);
  assert.equal(page.text.slice(b.part.start, b.part.end), b.text);
});

test('halveChunkPages: ein Teil wird mit absoluten Offsets weiter halbiert', () => {
  const whole = { id: 5, title: 'T', text: sentences(60, 3) };
  const [p1, p2] = splitPageIntoParts(whole, Math.ceil(whole.text.length / 2) + 50);
  const [[a], [b]] = halveChunkPages([p2]);
  assert.equal(whole.text.slice(a.part.start, a.part.end), a.text);
  assert.equal(whole.text.slice(b.part.start, b.part.end), b.text);
  assert.ok(a.part.start === p2.part.start && b.part.end === p2.part.end);
  assert.ok(p1);
});

test('halveChunkPages: nicht teilbar → null', () => {
  assert.equal(halveChunkPages([]), null);
  assert.equal(halveChunkPages([{ id: 1, title: 'x', text: 'abcdefghij' }]), null);
});
