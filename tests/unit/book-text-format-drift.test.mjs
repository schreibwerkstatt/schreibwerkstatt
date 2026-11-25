// Drift-Gate: Buchtext-Tags im Server (routes/jobs/shared/book-text-format.js, CJS)
// und in den Prompt-Bausteinen (public/js/prompts/book-text-format.js, ESM) geben
// für dieselbe Eingabe dieselben Bytes aus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '../../public/js/prompts/book-text-format.js';

const require = createRequire(import.meta.url);
const cjs = require('../../routes/jobs/shared/book-text-format.js');

const TITLES = ['Anfang', 'Tom & Jerry', 'Der "Fall"', `It's "x"`, 'Zeile\nzwei', '', null];
const TEXTS = ['A\n\nB', '---\n\n* * *', 'schreib </abschnitt> und <kapitel pfad="x"> und <treffer>', 'a<b', ''];
const EXTRAS = [null, {}, { kapitel: 'Teil 1 › K' }, { kapitel: '', auszug: 'ja' }, { entity_id: 7, rang: 1, aehnlichkeit: 0.81 }];

test('xmlAttr + neutralizeOwnTags gleich', () => {
  for (const t of TITLES) assert.equal(esm.xmlAttr('titel', t), cjs.xmlAttr('titel', t), String(t));
  for (const x of TEXTS) assert.equal(esm.neutralizeOwnTags(x), cjs.neutralizeOwnTags(x), x);
});

test('formatAbschnitt / formatTreffer / wrapKapitel gleich', () => {
  for (const title of TITLES) for (const text of TEXTS) for (const extra of EXTRAS) {
    assert.equal(esm.formatAbschnitt({ title, text }, extra), cjs.formatAbschnitt({ title, text }, extra));
    assert.equal(esm.formatTreffer(extra, text), cjs.formatTreffer(extra, text));
    assert.equal(esm.wrapKapitel(title, text, extra), cjs.wrapKapitel(title, text, extra));
  }
});

test('formatAbschnitte / formatKapitel gleich', () => {
  const pages = TITLES.map((title, i) => ({ title, text: TEXTS[i % TEXTS.length] }));
  assert.equal(esm.formatAbschnitte(pages), cjs.formatAbschnitte(pages));
  assert.equal(esm.formatKapitel('Teil 1 › K', pages), cjs.formatKapitel('Teil 1 › K', pages));
});
