// Weltfakten-Realitätscheck: Prompt-Builder + Schema + System-Prompt.
import test from 'node:test';
import assert from 'node:assert/strict';

const url = new URL('../../public/js/prompts/komplett/kontinuitaet.js', import.meta.url).href;
const schemasUrl = new URL('../../public/js/prompts/komplett/schemas.js', import.meta.url).href;

test('buildWeltfaktRealityJudgePrompt: enthält Fakt, Fiktions-Abgrenzung, JSON-Schema', async () => {
  const { buildWeltfaktRealityJudgePrompt } = await import(url);
  const p = buildWeltfaktRealityJudgePrompt('Mein Roman',
    { kategorie: 'historie', subjekt: 'Mondlandung', fakt: 'fand 1968 statt' },
    { spanne: '1965–1970' });
  assert.match(p, /Mondlandung/);
  assert.match(p, /fand 1968 statt/);
  assert.match(p, /1965–1970/);        // Zeit-Kontext eingebettet
  assert.match(p, /Web-Suche|web_search|recherchier/i);
  assert.match(p, /fiktiv/i);          // Fiktions-Abgrenzung
  assert.match(p, /"urteil"/);         // Schema-Feld
  assert.match(p, /"quelle"/);
});

test('buildWeltfaktRealityJudgePrompt: ohne Spanne kein Zeit-Hinweis', async () => {
  const { buildWeltfaktRealityJudgePrompt } = await import(url);
  const p = buildWeltfaktRealityJudgePrompt('X', { kategorie: 'ort', fakt: 'Bern liegt in der Schweiz' }, {});
  assert.doesNotMatch(p, /Zeitraum/);
});

test('SYSTEM_FAKTENCHECK: Rolle + JSON-Only, kein Buchtext-Platzhalter', async () => {
  const { SYSTEM_FAKTENCHECK } = await import(url);
  assert.equal(typeof SYSTEM_FAKTENCHECK, 'string');
  assert.match(SYSTEM_FAKTENCHECK, /Faktenpr/i);
  assert.match(SYSTEM_FAKTENCHECK, /JSON/);
});

test('SCHEMA_FAKT_REALITY: Reasoning-First + urteil-Enum + Pflichtfelder', async () => {
  const { SCHEMA_FAKT_REALITY } = await import(schemasUrl);
  const props = SCHEMA_FAKT_REALITY.properties;
  assert.ok(props._reasoning, '_reasoning vorhanden (False-Positive-Abwehr)');
  assert.deepEqual(props.urteil.enum, ['korrekt', 'falsch', 'unklar']);
  assert.ok(props.quelle && props.beschreibung && props.empfehlung && props.schwere);
  // _obj() macht additionalProperties:false — Grammar-safe für lokale Provider.
  assert.equal(SCHEMA_FAKT_REALITY.additionalProperties, false);
});

test('buildWeltfaktRealityJudgePrompt: Recherche-Passagen als Erstbeleg, Web-Suche optional', async () => {
  const { buildWeltfaktRealityJudgePrompt } = await import(url);
  const p = buildWeltfaktRealityJudgePrompt('X', { kategorie: 'historie', fakt: 'Die Mauer fiel 1989' }, {
    recherche: [{ titel: 'Mauerfall', quelle: 'Lexikon', url: 'https://example.org/mauer', text: 'Am 9. November 1989 fiel die Berliner Mauer.' }],
  });
  assert.match(p, /Recherche des Autors \(Erstbeleg\)/);
  assert.match(p, /Am 9\. November 1989 fiel die Berliner Mauer/);
  assert.match(p, /URL: https:\/\/example\.org\/mauer/);
  assert.match(p, /OHNE Web-Suche urteilen/);
  assert.match(p, /"urteil": "korrekt\|falsch\|unklar"/, 'JSON-Vertrag unverändert');
});

test('buildWeltfaktRealityJudgePrompt: leere Recherche → kein Block', async () => {
  const { buildWeltfaktRealityJudgePrompt } = await import(url);
  const p = buildWeltfaktRealityJudgePrompt('X', { kategorie: 'ort', fakt: 'Bern' }, { recherche: [] });
  assert.doesNotMatch(p, /Recherche des Autors/);
  assert.match(p, /Recherchiere aktiv/);
});
