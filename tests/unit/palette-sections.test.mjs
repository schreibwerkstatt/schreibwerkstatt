// Sektions-Aufbau der Command-Palette (public/js/cards/palette-sections.js):
// Sichtbarkeit von Karten/Aktionen nach Rolle + Buchtyp, Auffüllen des
// „Zuletzt"-Blocks, Wortanfangs-Gate für Sekundärtexte, Kapitel-Sprungziel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildPaletteSections, recentFeatures, visiblePaletteFeatures,
  visiblePaletteActions, matchFeatureFuzzy, RECENT_TARGET_COUNT,
} from '../../public/js/cards/palette-sections.js';
import { hasWordPrefix } from '../../public/js/cards/palette-fuzzy.js';
import { firstPageInChapter } from '../../public/js/cards/palette-providers.js';
import { DEFAULT_RECENT_KEYS, KOMPLETT_HIDDEN_BUCHTYPEN } from '../../public/js/cards/feature-registry.js';

const de = JSON.parse(fs.readFileSync(new URL('../../public/js/i18n/de.json', import.meta.url), 'utf8'));
const t = (k) => de[k] || '';

const ctxFor = (over = {}) => ({
  selectedBookId: 1, pages: [{ id: 1 }], bookRole: 'owner',
  buchtyp: 'roman', cloudModelEffective: true, ...over,
});

const build = (query, ctx, extra = {}) => buildPaletteSections({
  query, ctx, devMode: false, recentFeatureKeys: [], recentPageIds: [],
  t, root: {}, providers: [], ...extra,
});

const actionKeys = (ctx, devMode = false) => visiblePaletteActions(ctx, devMode).map(a => a.key);

test('Komplett-Analyse: nur ab editor sichtbar, ohne Buch deaktiviert statt versteckt', () => {
  assert.ok(actionKeys(ctxFor({ bookRole: 'editor' })).includes('action.komplett'));
  assert.ok(!actionKeys(ctxFor({ bookRole: 'lektor' })).includes('action.komplett'));
  assert.ok(!actionKeys(ctxFor({ bookRole: 'viewer' })).includes('action.komplett'));
  const noBook = ctxFor({ selectedBookId: null, bookRole: null, pages: [] });
  assert.ok(actionKeys(noBook).includes('action.komplett'));
  const item = build('', noBook).find(s => s.key === 'app').items.find(i => i.key === 'action.komplett');
  assert.equal(item.available, false);
  assert.equal(item.reasonKey, 'palette.disabled.needBook');
});

test('Aktionen ohne minRole stehen auch Lesern offen', () => {
  const keys = actionKeys(ctxFor({ bookRole: 'viewer' }));
  assert.ok(keys.includes('action.theme.cycle'));
  assert.ok(keys.includes('action.logout'));
});

test('hiddenForBuchtyp versteckt auch Aktionen', () => {
  for (const typ of KOMPLETT_HIDDEN_BUCHTYPEN) {
    assert.ok(!actionKeys(ctxFor({ buchtyp: typ })).includes('action.komplett'), typ);
  }
});

test('devMode blendet Abmelden aus', () => {
  assert.ok(!actionKeys(ctxFor(), true).includes('action.logout'));
});

test('„Zuletzt": erst filtern, dann mit Defaults auffüllen', () => {
  const ctx = ctxFor();
  const visible = visiblePaletteFeatures(ctx);
  // tagebuchRueckblick ist im Roman unsichtbar und darf keinen Platz belegen.
  const recent = recentFeatures(['tagebuchRueckblick', 'stil'], visible).map(f => f.key);
  assert.equal(recent.length, RECENT_TARGET_COUNT);
  assert.equal(recent[0], 'stil');
  assert.ok(!recent.includes('tagebuchRueckblick'));
  assert.deepEqual(recent.slice(1), DEFAULT_RECENT_KEYS.filter(k => k !== 'stil').slice(0, 2));
});

test('„Zuletzt": keine Duplikate zwischen Tracking und Defaults', () => {
  const recent = recentFeatures([DEFAULT_RECENT_KEYS[0]], visiblePaletteFeatures(ctxFor())).map(f => f.key);
  assert.equal(new Set(recent).size, recent.length);
});

test('hasWordPrefix: nur zusammenhängend am Wortanfang, diakritik-tolerant', () => {
  assert.ok(hasWordPrefix('rück', 'Monats-Rückblick'));
  assert.ok(hasWordPrefix('ruck', 'Rückblick'));
  assert.ok(hasWordPrefix('blick', 'Ein Blick zurück'));
  assert.ok(!hasWordPrefix('blick', 'Rückblick'));
  assert.ok(!hasWordPrefix('rot', 'Prüft Ton und Tempo'));
  assert.ok(!hasWordPrefix('', 'egal'));
});

test('Sekundärtexte: Fuzzy-Subsequenz in der Beschreibung allein reicht nicht', () => {
  const tx = { 'l.label': 'Stil', 'l.desc': 'Prüft Rhythmus, Ton und Satzlängen' };
  const feat = { key: 'x', labelKey: 'l.label', descKey: 'l.desc' };
  const tt = (k) => tx[k] || '';
  assert.equal(matchFeatureFuzzy(feat, 'rot', tt), null);   // r…o…t nur verstreut
  const m = matchFeatureFuzzy(feat, 'rhyth', tt);            // Wortanfang in der Beschreibung
  assert.ok(m);
  assert.deepEqual(m.indices, []);
  const l = matchFeatureFuzzy(feat, 'stil', tt);             // Label schlägt Beschreibung
  assert.ok(l.score < m.score);
});

test('Mix-Modus: eine Treffer-Sektion, nach Score sortiert', () => {
  const secs = build('einst', ctxFor());
  const matches = secs.find(s => s.key === 'matches');
  assert.ok(matches && matches.items.length);
  const scores = matches.items.map(i => i.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => a - b));
});

test('Befehls-Modus liefert nur Aktionen', () => {
  const secs = build('>', ctxFor());
  assert.equal(secs.length, 1);
  assert.ok(secs[0].items.every(i => i.kind === 'action'));
});

test('firstPageInChapter: Kapitel ohne eigene Abschnitte springt ins erste Unterkapitel', () => {
  const p = { id: 9 };
  const tree = [
    { type: 'chapter', id: 1, depth: 1, pages: [] },
    { type: 'chapter', id: 2, depth: 2, pages: [] },
    { type: 'chapter', id: 3, depth: 3, pages: [p] },
    { type: 'chapter', id: 4, depth: 1, pages: [{ id: 10 }] },
  ];
  assert.equal(firstPageInChapter(tree, 1), p);
  assert.equal(firstPageInChapter(tree, '4').id, 10);
  // Teilbaum endet am nächsten Kapitel gleicher Tiefe.
  const leer = [{ type: 'chapter', id: 1, depth: 1, pages: [] }, { type: 'chapter', id: 2, depth: 1, pages: [p] }];
  assert.equal(firstPageInChapter(leer, 1), null);
  assert.equal(firstPageInChapter(tree, 99), null);
});
