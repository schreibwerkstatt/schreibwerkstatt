// Exposé-Prompts (public/js/prompts/expose.js): Profil je Buchtyp, die drei
// Kopien der «kein Exposé»-Liste (Prompt-Modul, Server-Precheck, Palette) sind
// deckungsgleich, und die Prompts tragen, was sie tragen sollen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const {
  exposeProfil, EXPOSE_HIDDEN_BUCHTYPEN, buildExposeSystem, buildExposePrompt,
  buildExposeSynopsisPrompt, buildExposeSchema, EXPOSE_FIELDS,
} = await import('../../public/js/prompts/expose.js');
const { ACTIONS } = await import('../../public/js/cards/feature-registry.js');

const promptConfig = JSON.parse(fs.readFileSync(new URL('../../prompt-config.json', import.meta.url), 'utf8'));
const ALL_BUCHTYPEN = Object.keys(promptConfig.buchtypen.de);

test('exposeProfil: erzählend → narrativ, Sach/Fach → sachlich, sonst null', () => {
  assert.equal(exposeProfil('roman'), 'narrativ');
  assert.equal(exposeProfil('krimi'), 'narrativ');
  assert.equal(exposeProfil(null), 'narrativ');
  assert.equal(exposeProfil('sachbuch'), 'sachlich');
  assert.equal(exposeProfil('wissenschaft'), 'sachlich');
  assert.equal(exposeProfil('lyrik'), null);
  assert.equal(exposeProfil('tagebuch'), null);
});

test('EXPOSE_HIDDEN_BUCHTYPEN == alle Buchtypen ohne Profil == Server-Precheck == Palette', () => {
  const ohne = ALL_BUCHTYPEN.filter(b => exposeProfil(b) === null).sort();
  assert.deepEqual([...EXPOSE_HIDDEN_BUCHTYPEN].sort(), ohne);
  const { EXPOSE_BUCHTYP_EXCLUDED } = require('../../routes/jobs/expose.js');
  assert.deepEqual([...EXPOSE_BUCHTYP_EXCLUDED].sort(), ohne);
  const action = ACTIONS.find(a => a.key === 'action.expose');
  assert.ok(action, 'Palette-Aktion fehlt');
  assert.deepEqual([...action.hiddenForBuchtyp].sort(), ohne);
});

test('System-Prompt: Persona + Buch-Kontext + JSON-Only', () => {
  const sys = buildExposeSystem('BUCHTYP-KONTEXT: Roman');
  assert.match(sys, /Literaturagentin/);
  assert.match(sys, /BUCHTYP-KONTEXT: Roman/);
  assert.match(sys, /ausschliesslich mit einem JSON-Objekt/);
});

const ECK = { titel: 'Das Haus', autor: 'X', genre: 'Roman', normseiten: 312, zielgruppe: 'Saga-Leser', unfertig: true };

test('Roman-Prompt: Eckdaten als Fakten, Figurenkatalog mit IDs, Volltext, Synopse mit Ende', () => {
  const p = buildExposePrompt({
    profil: 'narrativ', eckdaten: ECK,
    figuren: [{ id: 'fig_1', name: 'Anna', typ: 'hauptfigur', rolle: 'Erbin' }],
    quelle: { kind: 'volltext', text: '## K1\nText' },
  });
  assert.match(p, /<eckdaten>/);
  assert.match(p, /Umfang: ca\. 312 Normseiten/);
  assert.match(p, /noch nicht abgeschlossen/);
  assert.match(p, /\[id=fig_1\] Anna — hauptfigur · Erbin/);
  assert.match(p, /<manuskript>\n## K1/);
  assert.match(p, /MIT Ende/);
  assert.match(p, /OHNE das Ende/);
  assert.doesNotMatch(p, /<kapitel>/);
});

test('Sachbuch-Prompt: Kapitelliste statt Figuren, Inhaltsangaben als Quelle', () => {
  const p = buildExposePrompt({
    profil: 'sachlich', eckdaten: ECK, kapitel: [{ id: 7, name: 'Einleitung' }],
    quelle: { kind: 'inhaltsangaben', items: [{ kapitel: 'Einleitung', inhalt: 'Frage X.' }] },
  });
  assert.match(p, /\[id=7\] Einleitung/);
  assert.match(p, /<inhaltsangaben>/);
  assert.match(p, /## Einleitung\nFrage X\./);
  assert.doesNotMatch(p, /<figurenkatalog>/);
});

test('Schema == Pflichtfelder je Profil', () => {
  for (const profil of ['narrativ', 'sachlich']) {
    const keys = Object.keys(buildExposeSchema(profil).properties).sort();
    const f = EXPOSE_FIELDS[profil];
    assert.deepEqual(keys, [...f.text, f.list].sort(), profil);
  }
});

test('Inhaltsangabe: Teil-Kennzeichnung bei zerlegtem Kapitel', () => {
  const p = buildExposeSynopsisPrompt({ bookName: 'B', kapitel: 'K', teil: { nr: 2, von: 3 }, profil: 'narrativ', text: 'T' });
  assert.match(p, /kapitel="K \(Teil 2 von 3\)"/);
  assert.match(p, /Stand am Ende/);
});
