// Pure Helfer der semantischen Suche: Chunking, Vektor-(De)Serialisierung,
// Cosinus, Content-Hash. Ohne DB/Netz → hier isoliert getestet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chunkText, vectorToBlob, blobToVector, cosineSim, contentHash, CHUNK_CHARS } = require('../../lib/embed-chunk.js');

test('chunkText: leerer/whitespace Text → []', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\t '), []);
  assert.deepEqual(chunkText(null), []);
});

test('chunkText: kurzer Text → genau ein Chunk, whitespace-normalisiert', () => {
  const out = chunkText('Ein kurzer   Satz.\n\nMit Umbruch.');
  assert.equal(out.length, 1);
  assert.equal(out[0], 'Ein kurzer Satz. Mit Umbruch.');
});

test('chunkText: langer Text → mehrere überlappende Chunks, alle <= maxChars', () => {
  const sentence = 'Dies ist ein Satz mit etwas Inhalt. ';
  const long = sentence.repeat(200); // ~7200 Zeichen
  const out = chunkText(long, { maxChars: 1000, overlap: 100 });
  assert.ok(out.length >= 6, `erwartet mehrere Chunks, bekam ${out.length}`);
  for (const c of out) assert.ok(c.length <= 1000, `Chunk zu lang: ${c.length}`);
  // Überlappung: das Ende von Chunk n taucht am Anfang von Chunk n+1 wieder auf.
  const tail = out[0].slice(-50);
  assert.ok(out[1].includes(tail.trim().split(' ')[0]), 'Overlap fehlt');
});

test('chunkText: Default-Chunkgrösse greift ohne Optionen', () => {
  const long = 'Wort '.repeat(1000); // 5000 Zeichen
  const out = chunkText(long);
  for (const c of out) assert.ok(c.length <= CHUNK_CHARS);
});

test('vectorToBlob/blobToVector: Roundtrip erhält Werte', () => {
  const v = Float32Array.from([0.1, -0.5, 3.25, 0, 42.0]);
  const blob = vectorToBlob(v);
  assert.ok(Buffer.isBuffer(blob));
  assert.equal(blob.length, v.length * 4);
  const back = blobToVector(blob);
  assert.equal(back.length, v.length);
  for (let i = 0; i < v.length; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-6);
});

test('cosineSim: identische Vektoren → 1', () => {
  const v = Float32Array.from([1, 2, 3, 4]);
  assert.ok(Math.abs(cosineSim(v, v) - 1) < 1e-6);
});

test('cosineSim: orthogonale Vektoren → 0', () => {
  const a = Float32Array.from([1, 0]);
  const b = Float32Array.from([0, 1]);
  assert.ok(Math.abs(cosineSim(a, b)) < 1e-6);
});

test('cosineSim: gegensätzliche Vektoren → -1', () => {
  const a = Float32Array.from([1, 1]);
  const b = Float32Array.from([-1, -1]);
  assert.ok(Math.abs(cosineSim(a, b) + 1) < 1e-6);
});

test('cosineSim: ungleiche Länge oder Nullvektor → -Infinity (nie Treffer)', () => {
  assert.equal(cosineSim(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2])), -Infinity);
  assert.equal(cosineSim(Float32Array.from([0, 0]), Float32Array.from([1, 1])), -Infinity);
});

test('contentHash: stabil + verschieden bei Änderung', () => {
  assert.equal(contentHash('Hallo Welt'), contentHash('Hallo Welt'));
  assert.notEqual(contentHash('Hallo Welt'), contentHash('Hallo Welt!'));
  assert.match(contentHash('x'), /^[0-9a-f]{16}$/);
});

test('_endsSentence: Abkürzungen, Ordinalzahlen, Initialen enden keinen Satz', async () => {
  const { _endsSentence } = require('../../lib/embed-chunk.js');
  const at = (s, needle) => s.indexOf(needle) + needle.length - 1;
  assert.equal(_endsSentence('Er kam z. B. spät', at('Er kam z. B.', 'z. B.')), false);
  assert.equal(_endsSentence('Dr. Meier', 2), false);
  assert.equal(_endsSentence('am 3. März', at('am 3. März', '3.')), false);
  assert.equal(_endsSentence('Anna K. Berger', at('Anna K. Berger', 'K.')), false);
  assert.equal(_endsSentence('Es regnete. Dann', at('Es regnete. Dann', 'regnete.')), true);
  assert.equal(_endsSentence('»Komm!« Sie ging', at('»Komm!« Sie', '»Komm!«')), true);
  assert.equal(_endsSentence('„Ja.“ Er nickte', at('„Ja.“ Er', '„Ja.“')), true);
  assert.equal(_endsSentence('Und dann… Stille', at('Und dann… Stille', 'dann…')), true);
});

test('chunkText: Absatzgrenze schlägt Satzende, Chunks bleiben einzeilig', () => {
  const para = (n) => Array.from({ length: n }, (_, i) => `Satz ${i} im Absatz steht hier.`).join(' ');
  const text = `${para(20)}\n\n${para(20)}\n\n${para(20)}`;
  const out = chunkText(text, { maxChars: 800, overlap: 100 });
  for (const c of out) {
    assert.ok(c.length <= 800, `zu lang: ${c.length}`);
    assert.ok(!/\n/.test(c), 'Chunk enthält Umbruch');
  }
  // Der erste Absatz (~620 Zeichen) passt ganz → der erste Schnitt liegt genau an seinem Ende.
  assert.equal(out[0], para(20));
});

test('chunkText: Folge-Chunk beginnt an Satzanfang, nie mitten im Wort', () => {
  const words = 'Dies ist ein langer Satz über das Meer und den Leuchtturm am Kap';
  const text = Array.from({ length: 60 }, (_, i) => `${words} Nummer ${i}.`).join(' ');
  const out = chunkText(text, { maxChars: 600, overlap: 150 });
  assert.ok(out.length > 3);
  for (const c of out.slice(1)) assert.match(c, /^Dies /, `Start mitten im Satz: «${c.slice(0, 30)}»`);
  for (const c of out.slice(0, -1)) assert.match(c, /\.$/, `Ende mitten im Satz: «${c.slice(-30)}»`);
  // Überlappung: der letzte Satz eines Chunks steht im nächsten wieder.
  const lastSentence = out[0].slice(out[0].lastIndexOf('Dies '));
  assert.ok(out[1].startsWith(lastSentence) || out[1].includes(lastSentence));
});

test('chunkText: Text ohne Satzzeichen → Wortgrenzen, kein Wort zerteilt, alles abgedeckt', () => {
  const text = Array.from({ length: 800 }, (_, i) => `wort${i}`).join(' ');
  const out = chunkText(text, { maxChars: 500, overlap: 80 });
  const seen = new Set(out.flatMap(c => c.split(' ')));
  for (let i = 0; i < 800; i++) assert.ok(seen.has(`wort${i}`), `wort${i} fehlt oder zerteilt`);
  for (const c of out) assert.ok(c.length <= 500);
});

test('chunkText: ein Wort länger als maxChars → harter Schnitt, terminiert', () => {
  const out = chunkText('x'.repeat(3000), { maxChars: 1000, overlap: 100 });
  assert.ok(out.length >= 3 && out.length < 10);
  for (const c of out) assert.ok(c.length <= 1000);
});

test('chunkText: einzelner Umbruch (PDF-Zeilenumbruch) ist kein Absatz', () => {
  assert.deepEqual(chunkText('Eine Zeile\nläuft weiter.'), ['Eine Zeile läuft weiter.']);
});
