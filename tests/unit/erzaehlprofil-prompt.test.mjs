// Erzählprofil-Prompts + Schemas: der Single-Pass fordert ein kapitel-Array mit den
// erwarteten Feldern, der Multi-Pass ein Einzelobjekt; die POV-/Tempus-Enums sind
// deckungsgleich mit den book_settings-Keys (narrative-labels.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildErzaehlprofilSinglePassPrompt,
  buildErzaehlprofilChapterPrompt,
  SCHEMA_ERZAEHLPROFIL,
  SCHEMA_ERZAEHLPROFIL_CHAPTER,
} = await import('../../public/js/prompts.js');

test('Single-Pass-Prompt: kapitel-Array + alle Profil-Felder + POV-Legende', () => {
  const p = buildErzaehlprofilSinglePassPrompt('Mein Buch', null);
  assert.ok(p.includes('Mein Buch'));
  for (const feld of ['perspektive', 'erzaehlzeit', 'erzaehler_figur', 'pov_konfidenz',
                      'intensitaet', 'zusammenfassung', 'themen']) {
    assert.ok(p.includes(`"${feld}"`), `Feld ${feld} fehlt`);
  }
  // POV-Keys als Enum-Alternative im Prompt.
  assert.ok(p.includes('er_sie_auktorial'));
  // Buchtext-Format: routes/jobs/shared/book-text-format.js (<kapitel pfad>-Tags).
  assert.ok(p.includes('pfad» des <kapitel>-Tags'), 'Kapitelname-aus-Tag-Instruktion');
  // Buchtext im System-Prompt (null-Fall).
  assert.ok(p.includes('System-Prompt'));
});

test('Chapter-Prompt: EIN Objekt, Kapitelname im Prompt', () => {
  const p = buildErzaehlprofilChapterPrompt('Mein Buch', 'Kapitel 3', 'Text hier.');
  assert.ok(p.includes('Kapitel 3'));
  assert.ok(p.includes('Text hier.'));
  assert.ok(p.includes('genau EIN Objekt'));
});

test('Schemas: Single-Pass hat kapitel-Array, Chapter-Schema die Item-Felder', () => {
  assert.deepEqual(Object.keys(SCHEMA_ERZAEHLPROFIL.properties), ['kapitel']);
  assert.equal(SCHEMA_ERZAEHLPROFIL.properties.kapitel.type, 'array');
  const item = SCHEMA_ERZAEHLPROFIL.properties.kapitel.items;
  assert.ok(item.properties.kapitel, 'Single-Pass-Item trägt den Kapitelnamen');
  assert.ok(!SCHEMA_ERZAEHLPROFIL_CHAPTER.properties.kapitel, 'Chapter-Schema OHNE kapitel-Feld');
  // POV-Enum deckungsgleich mit book_settings-Keys.
  assert.deepEqual(
    SCHEMA_ERZAEHLPROFIL_CHAPTER.properties.perspektive.enum,
    ['ich', 'du', 'er_sie_personal', 'er_sie_auktorial', 'wir', 'gemischt'],
  );
  assert.deepEqual(
    SCHEMA_ERZAEHLPROFIL_CHAPTER.properties.erzaehlzeit.enum,
    ['praeteritum', 'praesens', 'gemischt'],
  );
  // Themen tragen mehrere Belege (Array wörtlicher Zitate), nicht mehr einen Einzelstring.
  const thema = SCHEMA_ERZAEHLPROFIL_CHAPTER.properties.themen.items;
  assert.equal(thema.properties.belege.type, 'array');
  assert.ok(!thema.properties.beleg, 'kein Einzel-beleg-Feld mehr');
});
