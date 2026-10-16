// Hilfe-Katalog — Vollstaendigkeit und Filterlogik des Reiters „Funktionen"
// ([help-catalog.js](public/js/cards/help-catalog.js)).
//
// Die Hilfe listet jede Karte der Feature-Registry. Ohne Gate bekommt eine neue
// Karte keinen Hilfetext, und die Hilfe zeigt `help.feat.xyz` als Rohschluessel
// — oder die Karte fehlt still, genau die Luecke, die dieser Katalog schliesst.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FEATURES } from '../../public/js/cards/feature-registry.js';
import {
  buildHelpSections, helpCatalogKeys, helpDescKey, HELP_EXTRAS, HELP_GROUPS, HELP_ACTION_KEYS,
} from '../../public/js/cards/help-catalog.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const locales = Object.fromEntries(['de', 'en'].map(l =>
  [l, JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'js', 'i18n', `${l}.json`), 'utf8'))]));

const DESC_MIN = 60;
const DESC_MAX = 320;

const allEntries = (sections) => sections.flatMap(s => s.entries);

test('Hilfe-Katalog: jeder benoetigte Key existiert in de und en', () => {
  const missing = [];
  for (const k of helpCatalogKeys()) {
    for (const [loc, dict] of Object.entries(locales)) if (!dict[k]) missing.push(`${loc}: ${k}`);
  }
  assert.deepEqual(missing, []);
});

test('Hilfe-Katalog: keine verwaisten help.feat.*/help.extra.*-Keys', () => {
  const used = new Set(helpCatalogKeys());
  const orphans = Object.keys(locales.de)
    .filter(k => /^help\.(feat|extra)\./.test(k) && !used.has(k));
  assert.deepEqual(orphans, [], 'Key ohne Katalog-Eintrag — Karte entfernt/umbenannt?');
});

test(`Hilfe-Katalog: Hilfetexte ${DESC_MIN}–${DESC_MAX} Zeichen`, () => {
  const bad = [];
  for (const k of helpCatalogKeys().filter(k => /^help\.feat\.|\.desc$/.test(k))) {
    for (const [loc, dict] of Object.entries(locales)) {
      const n = (dict[k] || '').length;
      if (n < DESC_MIN || n > DESC_MAX) bad.push(`${loc} ${k}: ${n}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('Hilfe-Katalog: ohne Buch erscheint jede Registry-Karte ausser der Hilfe', () => {
  const keys = new Set(allEntries(buildHelpSections({})).map(e => e.key));
  const missing = FEATURES
    .filter(f => f.kind === 'toggle' && f.key !== 'help' && !keys.has(f.key))
    .map(f => f.key);
  assert.deepEqual(missing, []);
  for (const a of HELP_ACTION_KEYS) assert.ok(keys.has(a), `Aktion ${a} fehlt`);
  for (const x of HELP_EXTRAS) assert.ok(keys.has(`extra.${x.key}`), `Extra ${x.key} fehlt`);
  assert.ok(!keys.has('help'));
});

test('Hilfe-Katalog: Gruppen in HELP_GROUPS-Reihenfolge, keine leeren', () => {
  const sections = buildHelpSections({});
  const order = sections.map(s => s.group);
  assert.deepEqual(order, HELP_GROUPS.filter(g => order.includes(g)));
  assert.ok(sections.every(s => s.entries.length > 0));
  assert.equal(order[0], 'write');
});

test('Hilfe-Katalog: Buchtyp filtert wie die Registry', () => {
  const roman = new Set(allEntries(buildHelpSections({ selectedBookId: 1, bookRole: 'owner', buchtyp: 'roman' })).map(e => e.key));
  assert.ok(roman.has('figuren'));
  assert.ok(!roman.has('struktur'), 'Struktur-Check nur in publizistischen Buechern');
  assert.ok(!roman.has('tagebuchRueckblick'));
  assert.ok(!roman.has('extra.blogSync'));

  const journ = new Set(allEntries(buildHelpSections({ selectedBookId: 1, bookRole: 'owner', buchtyp: 'journalismus' })).map(e => e.key));
  assert.ok(journ.has('struktur'));
  assert.ok(journ.has('titelwerkstatt'));
  assert.ok(journ.has('extra.interview'));
  assert.ok(!journ.has('figuren'), 'Figuren sind im Ressort ausgeblendet');
  assert.ok(!journ.has('action.komplett'));

  // Der redaktionelle Apparat gilt fuer beide publizistischen Typen — die
  // Struktur-Karte ist dort auch der einzige Ort, an dem die Textsorte gesetzt wird.
  const blog = new Set(allEntries(buildHelpSections({ selectedBookId: 1, bookRole: 'owner', buchtyp: 'blog' })).map(e => e.key));
  assert.ok(blog.has('struktur'), 'Struktur-Check auch im Blog');
  assert.ok(blog.has('titelwerkstatt'));
});

test('Hilfe-Katalog: Rolle blendet Karten ueber der eigenen Rolle aus', () => {
  const viewer = new Set(allEntries(buildHelpSections({ selectedBookId: 1, bookRole: 'viewer', buchtyp: 'roman' })).map(e => e.key));
  assert.ok(viewer.has('export'));
  assert.ok(!viewer.has('review'), 'Bewertung ist editor+');
});

test('Hilfe-Katalog: Cloud-Modell-Karten bleiben sichtbar, aber nicht oeffenbar', () => {
  const ctx = { selectedBookId: 1, bookRole: 'owner', buchtyp: 'roman', cloudModelEffective: false };
  const e = allEntries(buildHelpSections(ctx)).find(x => x.key === 'kontinuitaet');
  assert.ok(e, 'Kontinuitaet muss erklaert werden, auch wenn sie nicht verfuegbar ist');
  assert.equal(e.available, false);
  assert.equal(e.reasonKey, 'palette.disabled.needCloudModel');
  assert.ok(e.needs.some(n => n.key === 'help.need.cloudModel'));
});

test('Hilfe-Katalog: ohne Buch sind buchgebundene Karten nicht oeffenbar', () => {
  const byKey = new Map(allEntries(buildHelpSections({})).map(e => [e.key, e]));
  assert.equal(byKey.get('plot').available, false);
  assert.equal(byKey.get('plot').reasonKey, 'palette.disabled.needBook');
  assert.equal(byKey.get('search').available, true);
  assert.deepEqual(byKey.get('plot').open, { toggle: 'togglePlotCard' });
  assert.deepEqual(byKey.get('action.myStats').open, { run: 'action.myStats' });
});

test('Hilfe-Katalog: helpDescKey kuerzt das action.-Praefix', () => {
  assert.equal(helpDescKey('action.komplett'), 'help.feat.komplett');
  assert.equal(helpDescKey('plot'), 'help.feat.plot');
});
