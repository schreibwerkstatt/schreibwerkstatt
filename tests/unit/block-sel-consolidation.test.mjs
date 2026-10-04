// Blockselektor-Familien: ein Kern, vier bewusst verschiedene Ableitungen.
//
// WARUM DIESER TEST: die vier Selektoren hiessen alle `BLOCK_SEL`, hatten aber
// vier verschiedene Inhalte. Gleicher Name suggeriert Gleichheit, die nicht
// besteht — und genau deshalb griff `editor/focus/soft-newlines.js` zum
// Notebook-Selektor, während seine Nachbarmodule den Focus-Selektor nutzten,
// ohne dass es auffiel. Seit der Konsolidierung trägt jede Familie einen eigenen
// Namen und komponiert aus `TEXT_BLOCK_TAGS`. Dieser Test hält (a) den Kern in
// allen Familien fest und (b) die Unterschiede EXPLIZIT: wer eine Familie
// erweitert, muss die Erwartung hier mitziehen und trifft dabei auf die Frage,
// ob die anderen Familien denselben Zusatz brauchen.
//
// `TTS_BLOCK_SEL` (public/js/tts-segment.js, Vorlesen auf beiden Oberflaechen)
// ist der Sonderfall: das Modul gehoert zum schlanken, pre-auth ladbaren
// Share-Reader-Modulgraph und kann den Kern nicht importieren (sonst zieht die
// Leseansicht das App-Bundle). Seine Kopie wird hier gegen den Kern geprüft.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  TEXT_BLOCK_TAGS, composeBlockSel, CARET_BLOCK_SEL,
} = await import('../../public/js/editor/shared/dom-block.js');

// Selektorliste → Set von Einzelselektoren (Reihenfolge ist für
// querySelectorAll irrelevant, nur die Menge zählt).
const parts = (sel) => new Set(sel.split(',').map((s) => s.trim()).filter(Boolean));

test('TEXT_BLOCK_TAGS ist der gemeinsame Kern aller Familien', () => {
  assert.deepEqual(TEXT_BLOCK_TAGS,
    ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li'],
    'Kern-Änderung trifft ALLE Blockselektoren — bitte bewusst entscheiden');
});

test('composeBlockSel hängt Zusätze an den Kern, ohne ihn zu verändern', () => {
  const sel = composeBlockSel('pre', 'div.poem');
  const p = parts(sel);
  for (const tag of TEXT_BLOCK_TAGS) assert.ok(p.has(tag), `Kern-Tag ${tag} fehlt`);
  assert.ok(p.has('pre') && p.has('div.poem'), 'Zusätze fehlen');
  assert.equal(p.size, TEXT_BLOCK_TAGS.length + 2, 'keine stillen Extras');
});

// Erwartete Zusätze pro Familie. Jede Zeile ist eine bewusste Entscheidung —
// die Kommentare sagen, warum die Familie von den anderen abweicht.
const FAMILIES = [
  {
    name: 'CARET_BLOCK_SEL (Notebook-Caret-Lookup)',
    sel: () => CARET_BLOCK_SEL,
    // `div.poem`: Gedichtzeilen sind eigene Caret-Blöcke. Kein `figcaption` —
    // sonst behandelten die Merge-Pfade Bildlegenden wie Absätze.
    extra: ['pre', 'div.poem'],
  },
  {
    name: 'FOCUS_BLOCK_SEL (aktiver Absatz im Focus-Editor)',
    sel: async () => (await import('../../public/js/editor/focus/constants.js')).FOCUS_BLOCK_SEL,
    // Tabellenzellen + Bild/Legende zählen mit, damit Klicks dort nicht auf
    // Viewport-Center zurückfallen. Kein `div.poem`.
    extra: ['pre', 'td', 'th', 'figure', 'figcaption'],
  },
  {
    name: 'QUOTE_BLOCK_SEL (Anführungszeichen-Normalisierung)',
    sel: async () => {
      const src = readFileSync('public/js/editor/shared/quote-normalize/walk.js', 'utf8');
      const m = src.match(/const QUOTE_BLOCK_SEL = composeBlockSel\(([^)]*)\)/);
      assert.ok(m, 'QUOTE_BLOCK_SEL nicht als composeBlockSel-Aufruf gefunden');
      return composeBlockSel(...m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')));
    },
    // KEIN `pre`: Code steht in SKIP_SEL und darf keine typografischen
    // Anführungszeichen bekommen.
    extra: ['td', 'th', 'div.poem'],
  },
];

for (const fam of FAMILIES) {
  test(`${fam.name}: Kern vollständig + genau die erwarteten Zusätze`, async () => {
    const p = parts(await fam.sel());
    for (const tag of TEXT_BLOCK_TAGS) {
      assert.ok(p.has(tag), `Kern-Tag ${tag} fehlt in ${fam.name}`);
    }
    const extras = [...p].filter((x) => !TEXT_BLOCK_TAGS.includes(x)).sort();
    assert.deepEqual(extras, [...fam.extra].sort(),
      `Zusätze von ${fam.name} haben sich geändert — bewusst? Dann hier mitziehen `
      + 'und prüfen, ob die anderen Familien denselben Zusatz brauchen.');
  });
}

test('TTS_BLOCK_SEL (Vorlesen, beide Oberflaechen) enthaelt den Kern, obwohl er ihn nicht importieren kann', async () => {
  const { TTS_BLOCK_SEL } = await import('../../public/js/tts-segment.js');
  const p = parts(TTS_BLOCK_SEL);
  for (const tag of TEXT_BLOCK_TAGS) {
    assert.ok(p.has(tag), `Kern-Tag ${tag} fehlt im TTS-Selektor (Drift zur SSoT)`);
  }
  const extras = [...p].filter((x) => !TEXT_BLOCK_TAGS.includes(x)).sort();
  // `pre` + `figcaption` werden vorgelesen; die Container (ul, div, figure …)
  // sind Bloecke ohne eigenen Satz, damit verschachtelter Text weder doppelt
  // noch gar nicht gelesen wird (tts-segment.js#ttsUnits). Kein td/th/caption.
  assert.deepEqual(extras, ['article', 'aside', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption',
    'figure', 'footer', 'header', 'ol', 'pre', 'section', 'summary', 'ul']);
});

test('Share-Reader-TTS und die TTS-Kerne importieren nichts aus dem App-Bundle (Pre-Auth-Grenze)', () => {
  // Gegenprobe zur Begründung der Kopie: der Reader-Modulgraph schlank und
  // pre-auth ladbar — ein Import aus editor/ zöge das App-Bundle nach.
  for (const [file, allowed] of [
    ['public/js/share-reader/tts.js', ['../tts-segment.js', '../tts-player.js', './dom.js']],
    ['public/js/tts-player.js', ['./tts-segment.js']],
    ['public/js/tts-segment.js', []],
  ]) {
    const src = readFileSync(file, 'utf8');
    const specs = [...src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(specs.filter((s) => !allowed.includes(s)), [],
      `${file} darf nur ${allowed.join(', ') || 'nichts'} importieren`);
  }
});
