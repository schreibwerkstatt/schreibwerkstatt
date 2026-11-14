// Gate für Reiter-Permalinks (URL_TABS in public/js/cards/card-request.js):
// die Reiter-Liste dort entscheidet, welcher Reiter aus einer URL angenommen
// und welcher in die URL geschrieben wird. Benennt eine Karte einen Reiter um
// oder kommt einer dazu, ohne dass URL_TABS mitzieht, verwirft der Lifecycle den
// Deep-Link still bzw. die URL verliert den Reiter.
//
// Geprüft wird:
//   1. Jeder Eintrag zeigt auf eine Karte aus EXCLUSIVE_CARDS und auf einen
//      Reiter-Wunsch (*_TAB) mit genau einer tabRequest-Anmeldung samt `current`.
//   2. Grund-Reiter steht in der Liste.
//   3. Jeder gelistete Reiter kommt im Template der Karte als Literal vor.
//   4. Jede Reiter-Liste des Templates (`tabs([...])`) ist vollständig gelistet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { URL_TABS, CARD_REQUEST } from '../../public/js/cards/card-request.js';
import { EXCLUSIVE_CARDS } from '../../public/js/cards/feature-registry.js';
import { SHELF_TABS } from '../../public/js/cards/my-books-compute.js';
import { ADMIN_SETTINGS_TABS } from '../../public/js/admin/admin-settings-tabs.js';

// Karten, deren Reiter-Reihe aus einer JS-Konstante gerendert wird (x-for), nicht
// aus einem Template-Literal: URL_TABS muss genau diese Konstante tragen.
const TABS_FROM_JS = { myBooks: SHELF_TABS, adminSettings: ADMIN_SETTINGS_TABS };

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS = join(REPO_ROOT, 'public', 'partials');
const JS_DIR = join(REPO_ROOT, 'public', 'js');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}
const jsSources = walk(JS_DIR).map(f => readFileSync(f, 'utf8'));

// Template einer Karte: ihr Partial plus die abgespaltenen `<partial>-*.html`.
function templateOf(partial) {
  return readdirSync(PARTIALS)
    .filter(f => f === partial + '.html' || f.startsWith(partial + '-'))
    .map(f => readFileSync(join(PARTIALS, f), 'utf8'))
    .join('\n');
}

const requestName = (value) => Object.keys(CARD_REQUEST).find(k => CARD_REQUEST[k] === value);

for (const [cardKey, spec] of Object.entries(URL_TABS)) {
  test(`URL_TABS.${cardKey}`, () => {
    const card = EXCLUSIVE_CARDS.find(c => c.key === cardKey);
    assert.ok(card, `${cardKey}: keine Karte in EXCLUSIVE_CARDS`);

    const name = requestName(spec.request);
    assert.ok(name && name.endsWith('_TAB'), `${cardKey}: request muss ein CARD_REQUEST.*_TAB sein`);
    const regs = jsSources.flatMap(src =>
      [...src.matchAll(new RegExp(`tabRequest:\\s*\\{\\s*key:\\s*CARD_REQUEST\\.${name}\\b[^\\n]*`, 'g'))].map(m => m[0]));
    assert.equal(regs.length, 1, `${name}: genau eine tabRequest-Anmeldung erwartet`);
    assert.match(regs[0], /current:\s*\(\)\s*=>/, `${name}: tabRequest braucht current() für den Permalink-Spiegel`);

    assert.ok(spec.tabs.includes(spec.default), `${cardKey}: Grund-Reiter «${spec.default}» fehlt in tabs`);

    if (TABS_FROM_JS[cardKey]) {
      assert.equal(spec.tabs, TABS_FROM_JS[cardKey], `${cardKey}: tabs muss die Konstante der Karte sein`);
      return;
    }
    const tpl = templateOf(card.partial);
    const missing = spec.tabs.filter(t => !tpl.includes(`'${t}'`));
    assert.deepEqual(missing, [], `${cardKey}: Reiter nicht im Template (${card.partial}) gefunden`);

    for (const m of tpl.matchAll(/tabs\(\s*(?:\{\s*tabs:\s*)?\[([^\]]*)\]/g)) {
      const listed = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
      // Nur die Hauptreihe: Unter-Reiter (andere tabs()-Instanzen) haben keine Überschneidung.
      if (!listed.includes(spec.default)) continue;
      const extra = listed.filter(t => !spec.tabs.includes(t));
      assert.deepEqual(extra, [], `${cardKey}: Template-Reiter fehlen in URL_TABS`);
    }
  });
}
