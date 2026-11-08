// Unit-Tests für Songs-/Musik-Prompts und -Schemas.
//
// Deckt ab:
//  - SONGS_SCHEMA und SONGS_RULES sind in SYSTEM_KOMPLETT_EXTRAKTION eingebettet
//  - buildSongsConsolidationPrompt produziert Konsolidierungs-Prompt mit Inputs
//  - SCHEMA_SONGS_KONSOL hat songs-Array mit erwarteten Feldern
//  - SCHEMA_KOMPLETT_EXTRAKTION enthält songs-Array (Pass-B-Erweiterung)
//  - SCHEMA_KOMPLETT_ORTE_PASS enthält songs-Array (Split-Pass-B)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.resolve(here, '..', '..', 'prompt-config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const promptsUrl = new URL('../../public/js/prompts.js', import.meta.url).href;

async function freshPrompts(provider = 'claude') {
  const mod = await import(`${promptsUrl}?t=${Date.now()}_${Math.random()}`);
  mod.configurePrompts(cfg, provider);
  return mod;
}

test('SYSTEM_KOMPLETT_EXTRAKTION enthält Songs-Schema + -Regeln', async () => {
  const m = await freshPrompts('claude');
  const sys = m.SYSTEM_KOMPLETT_EXTRAKTION;
  assert.match(sys, /"songs":/, 'Songs-Schema im System-Prompt fehlt');
  assert.match(sys, /"kontext_typ"/, 'kontext_typ-Feld im Schema fehlt');
  assert.match(sys, /hört\|spielt\|erwähnt\|leitmotiv\|diegetisch/,
    'kontext_typ-Enum fehlt');
  assert.match(sys, /Musik-Regeln:/, 'Musik-Regeln-Block fehlt');
});

test('SCHEMA_KOMPLETT_EXTRAKTION hat songs-Array (Claude)', async () => {
  const m = await freshPrompts('claude');
  const s = m.SCHEMA_KOMPLETT_EXTRAKTION;
  assert.ok(s, 'SCHEMA_KOMPLETT_EXTRAKTION existiert');
  assert.ok(s.properties && s.properties.songs, 'songs-Property fehlt');
  assert.equal(s.properties.songs.type, 'array');
});

test('SCHEMA_KOMPLETT_ORTE_PASS hat songs (Split-Pass-B für lokale Provider)', async () => {
  const m = await freshPrompts('ollama');
  const s = m.SCHEMA_KOMPLETT_ORTE_PASS;
  assert.ok(s, 'SCHEMA_KOMPLETT_ORTE_PASS existiert');
  assert.ok(s.properties && s.properties.songs, 'songs-Property fehlt im Pass-B-Schema');
  assert.equal(s.properties.songs.type, 'array');
});

test('SCHEMA_SONGS_KONSOL hat erwartete Felder', async () => {
  const m = await freshPrompts('claude');
  const s = m.SCHEMA_SONGS_KONSOL;
  assert.ok(s, 'SCHEMA_SONGS_KONSOL existiert');
  assert.ok(s.properties.songs.items.properties.id);
  assert.ok(s.properties.songs.items.properties.titel);
  assert.ok(s.properties.songs.items.properties.interpret);
  assert.ok(s.properties.songs.items.properties.genre);
  assert.ok(s.properties.songs.items.properties.kontext_typ);
  assert.ok(s.properties.songs.items.properties.figuren_namen,
    'Songs referenzieren Figuren über figuren_namen (Klarnamen), nicht fig_id');
});

test('buildSongsConsolidationPrompt: Inputs werden eingebettet', async () => {
  const m = await freshPrompts('claude');
  const chapterSongs = [
    {
      kapitel: 'Kapitel 1',
      songs: [
        { titel: 'Heroes', interpret: 'Bowie', genre: 'Rock',
          kontext_typ: 'hört', beschreibung: 'Im Auto', stimmung: 'melancholisch',
          figuren_namen: [{ name: 'Anna', rolle: 'singt' }], kapitel: [{ name: 'Kapitel 1', haeufigkeit: 2 }] },
      ],
    },
  ];
  const figurenKompakt = [{ id: 'fig_1', name: 'Anna' }];
  const prompt = m.buildSongsConsolidationPrompt('Testbuch', chapterSongs, figurenKompakt);

  assert.match(prompt, /Testbuch/);
  assert.match(prompt, /Heroes/);
  assert.match(prompt, /Bowie/);
  assert.match(prompt, /Kapitel 1/);
  // Figuren-Referenz per Klarname (nicht fig_id): Input-Zeile + Hinweisliste kanonischer Namen.
  assert.match(prompt, /Figuren: Anna \(singt\)/);
  assert.match(prompt, /verwende in «figuren_namen» exakt diese Schreibweise/);
  assert.match(prompt, /"songs":/, 'SONGS_SCHEMA im Prompt eingebettet');
});

test('PROMPTS_VERSION ist gebumpt nach Songs-Einführung', async () => {
  const m = await freshPrompts('claude');
  // Version 15 oder höher (Songs-Pipeline = 14 → 15 Bump).
  const v = parseInt(m.PROMPTS_VERSION, 10);
  assert.ok(v >= 15, `PROMPTS_VERSION = ${m.PROMPTS_VERSION}, erwartet ≥ 15`);
});

test('Songs-Schema: figuren_namen tragen Name + Rolle, Rollen = lib/song-fig-rollen.js', async () => {
  const m = await freshPrompts('claude');
  const { createRequire } = await import('node:module');
  const { SONG_FIG_ROLLEN } = createRequire(import.meta.url)('../../lib/song-fig-rollen.js');
  const { FIG_ROLLEN } = await import('../../public/js/book/songs.js');
  assert.deepEqual([...FIG_ROLLEN].sort(), [...SONG_FIG_ROLLEN].sort(), 'Detailansicht kennt alle Rollen');
  for (const s of [m.SCHEMA_SONGS_KONSOL, m.SCHEMA_KOMPLETT_EXTRAKTION]) {
    const item = s.properties.songs.items.properties.figuren_namen.items;
    assert.ok(item.properties.name);
    assert.deepEqual([...item.properties.rolle.enum].sort(), [...SONG_FIG_ROLLEN].sort());
  }
  assert.match(m.SYSTEM_KOMPLETT_EXTRAKTION, /"rolle": "spielt\|singt\|komponiert\|hört\|erwähnt"/);
});
