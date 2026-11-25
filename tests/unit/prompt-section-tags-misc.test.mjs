// Buchtext-Tags (public/js/prompts/book-text-format.js) in den Prompts ausserhalb
// der Chats: Tagebuch-Rückblick, Buchlandkarte, Exposé (Inhaltsangaben).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildRueckblickPrompt, buildRueckblickReducePrompt } = await import('../../public/js/prompts/tagebuch.js');
const { buildBookMapAxisPrompt } = await import('../../public/js/prompts/buchlandkarte.js');
const { buildExposePrompt } = await import('../../public/js/prompts/expose.js');

test('Rückblick: Eintrag als <abschnitt> mit datum, Titel nur wenn er mehr sagt', () => {
  const p = buildRueckblickPrompt([
    { datum: '2024-03-15', titel: '2024-03-15', text: 'Regen.\n\nKaffee.' },
    { datum: '2024-03-16', titel: 'Der Umzug', text: 'Kisten.' },
  ], { zeitraum: 'März 2024' });
  assert.match(p, /<abschnitt titel="2024-03-15" datum="2024-03-15">\nRegen\.\n\nKaffee\.\n<\/abschnitt>/);
  assert.match(p, /<abschnitt titel="Der Umzug" datum="2024-03-16">\nKisten\.\n<\/abschnitt>/);
  assert.doesNotMatch(p, /^### /m);
});

test('Rückblick-Synthese: Teilrückblicke als <teilrueckblick monat>', () => {
  const p = buildRueckblickReducePrompt([{ monat: 'März 2024', bemerkenswerteTage: [], zusammenfassung: 'Ruhig.' }], { zeitraum: '2024' });
  assert.match(p, /<teilrueckblick monat="März 2024">\nBemerkenswerte Tage: –\nZusammenfassung: Ruhig\.\n<\/teilrueckblick>/);
});

test('Buchlandkarte: Achsen mit zwei Enden, Auszüge als <abschnitt>', () => {
  const p = buildBookMapAxisPrompt([{ neg: [{ name: 'Nacht', text: 'Dunkel.' }], pos: [{ name: 'Tag', text: 'Hell.' }] }]);
  assert.match(p, /<achse nr="1">\n<ende pol="A" richtung="negativ">\n<abschnitt titel="Nacht">\nDunkel\.\n<\/abschnitt>\n<\/ende>\n<ende pol="B" richtung="positiv">/);
  assert.doesNotMatch(p, /^##/m);
});

test('Exposé: Inhaltsangaben als <inhaltsangabe kapitel> (kein zweites <kapitel> neben der Kapitelliste)', () => {
  const p = buildExposePrompt({
    profil: 'narrativ', eckdaten: {}, figuren: [], kapitel: [],
    quelle: { kind: 'inhaltsangaben', items: [{ kapitel: 'Teil 1 › Anfang', inhalt: 'Anna kommt an.' }] },
  });
  assert.match(p, /<inhaltsangabe kapitel="Teil 1 › Anfang">\nAnna kommt an\.\n<\/inhaltsangabe>/);
});
