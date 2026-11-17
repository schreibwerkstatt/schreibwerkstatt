// Geteilter 1h-Buchblock der Komplettanalyse-Familie.
//
// Komplettanalyse (P1 Single-Pass, P3b, Coverage), Erzählprofil und Kontinuität senden
// den Buchtext als denselben 1h-System-Block. Nur ein byte-identischer Block wird aus dem
// Cache gelesen; jede Abweichung schreibt das ganze Buch neu (~500K Tokens zum doppelten
// Input-Preis, gemessen auf Prod: Erzählprofil + Kontinuität $0.38/$0.98 mit Read statt
// $2.66/$3.21 mit Write). Darum gibt es Aufbereitung und Block genau einmal
// (routes/jobs/komplett/book-text.js), und der Bruch-Melder schlägt an, wenn er doch bricht.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpDir } from './_helpers/tmp-dir.js';

const require_ = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function _bootstrap() {
  const dir = makeTmpDir('book-block-');
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/') || key.includes('/routes/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    bookText: require_('../../routes/jobs/komplett/book-text'),
    cacheBreak: require_('../../routes/jobs/shared/cache-break'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function _jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(..._jsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const _pages = () => ([
  { id: 1, title: 'Anfang', chapter: 'Eins', chapter_id: 10, text: 'Es war&nbsp;einmal​  ein Satz.' },
  { id: 2, title: 'Mitte', chapter: 'Eins', chapter_id: 10, text: 'Noch­ein  Satz.' },
  { id: 3, title: 'Ende', chapter: 'Zwei', chapter_id: 20, text: 'Schluss.' },
]);

test('Buchblock: zwei unabhängige Ladevorgänge ergeben byte-identische Blöcke', () => {
  const { bookText, teardown } = _bootstrap();
  try {
    // Jeder Job lädt die Abschnitte selbst — gleiche Eingabe muss denselben Block geben.
    const a = _pages(), b = _pages();
    const pa = bookText.prepareBookText(a, { cloud: true });
    const pb = bookText.prepareBookText(b, { cloud: true });
    const blockA = bookText.bookSystemBlock('Buch', a.length, pa.fullBookText);
    const blockB = bookText.bookSystemBlock('Buch', b.length, pb.fullBookText);
    assert.deepEqual(blockA, blockB);
    assert.equal(blockA.ttl, '1h');
    assert.equal(blockA.sharedPrefix, true);
    // Bereinigung wirkt (mutiert pageContents, damit Chunks denselben Text sehen).
    assert.doesNotMatch(pa.fullBookText, /&nbsp;|​|­/);
    assert.equal(a[0].text, pa.groups.get('10').pages[0].text);
    assert.equal(pa.totalChars, a.reduce((s, p) => s + p.text.length, 0));
    assert.deepEqual(pa.groupOrder, ['10', '20']);
  } finally { teardown(); }
});

test('Buchblock: lokale Provider bekommen den Text unbereinigt', () => {
  const { bookText, teardown } = _bootstrap();
  try {
    const pages = _pages();
    const { fullBookText } = bookText.prepareBookText(pages, { cloud: false });
    assert.match(fullBookText, /&nbsp;/);
  } finally { teardown(); }
});

test('Buchblock: Aufbereitung und Block nur in book-text.js gebaut', () => {
  // Eine zweite Kopie der Aufbereitung (Bereinigungsschleife, eigener Block-Literal)
  // kann still abdriften — dann liest Kontinuität/Erzählprofil das Buch nicht mehr aus
  // dem Cache, und nichts wird rot ausser der Rechnung.
  const komplettDir = join(ROOT, 'routes/jobs/komplett');
  const offenders = [];
  for (const f of _jsFiles(komplettDir)) {
    const rel = relative(ROOT, f);
    if (rel.endsWith('book-text.js') || rel.endsWith('utils.js')) continue;
    const src = readFileSync(f, 'utf8');
    if (/buildBookSystemBlockText\s*\(/.test(src)) offenders.push(`${rel}: baut den Buchblock selbst (bookSystemBlock aus book-text.js nehmen)`);
    if (/cleanPageTextForAi\s*\(/.test(src)) offenders.push(`${rel}: bereinigt den Buchtext selbst (prepareBookText aus book-text.js nehmen)`);
  }
  assert.deepEqual(offenders, []);
  for (const job of ['job-komplett.js', 'job-kontinuitaet.js', 'job-erzaehlprofil.js']) {
    const src = readFileSync(join(komplettDir, job), 'utf8');
    assert.match(src, /prepareBookText\(pageContents/, `${job} muss den Buchtext über prepareBookText aufbereiten`);
  }
});

test('Bruch-Melder: Erst-Write still, Folge-Write desselben Blocks meldet', () => {
  const { bookText, cacheBreak, teardown } = _bootstrap();
  try {
    const { checkSharedPrefixCache, MIN_BREAK_TOKENS } = cacheBreak;
    const block = bookText.bookSystemBlock('Buch', 1, 'x'.repeat(1000));
    const sys = [block, { text: 'Phase', ttl: '1h' }];
    const tok = {};
    const big = MIN_BREAK_TOKENS * 50;
    assert.equal(checkSharedPrefixCache(tok, sys, { cacheCreationIn: big, cacheReadIn: 0 }), false, 'Erst-Write ist kein Bruch');
    assert.equal(checkSharedPrefixCache(tok, sys, { cacheCreationIn: 2000, cacheReadIn: big }), false, 'Read mit kleinem Phasen-Write ist der Normalfall');
    assert.equal(checkSharedPrefixCache(tok, sys, { cacheCreationIn: big, cacheReadIn: 3000 }), true, 'derselbe Block noch einmal geschrieben');
    // Anderer Block (anderes Kapitel) im selben Job: wieder ein Erst-Write.
    const other = [bookText.bookSystemBlock('Buch', 1, 'y'.repeat(1000))];
    assert.equal(checkSharedPrefixCache(tok, other, { cacheCreationIn: big, cacheReadIn: 0 }), false);
    // Ohne geteilten Präfix nie.
    assert.equal(checkSharedPrefixCache(tok, 'System', { cacheCreationIn: big, cacheReadIn: 0 }), false);
    assert.equal(checkSharedPrefixCache(tok, [{ text: 'a', ttl: '1h' }], { cacheCreationIn: big }), false);
    assert.equal(checkSharedPrefixCache(null, sys, { cacheCreationIn: big }), false);
  } finally { teardown(); }
});
