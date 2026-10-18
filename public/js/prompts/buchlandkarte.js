// Buchlandkarte: PCA-Achsen benennen (Job `book-map-label`).
//
// Eine PCA-Achse hat keine vorgegebene Bedeutung — sie ist die Richtung, in der
// sich die Abschnitte am stärksten unterscheiden. Was sie trennt, lässt sich nur
// an den Abschnitten an ihren zwei Enden ablesen. Dieser Prompt bekommt je Achse
// die Auszüge beider Enden und fragt nach dem Unterschied, nicht nach einer
// Zusammenfassung: zwei Gruppen, die beide «Familie» behandeln, unterscheiden
// sich vielleicht in Szene gegen Rückblick, und genau das ist die Achse.

import { _isLocal, JSON_ONLY } from './state.js';
import { _obj, _str } from './schema-utils.js';

export function buildBookMapAxisSystem() {
  const parts = [
    'Du hilfst einer Autorin, eine Landkarte ihres Buchs zu lesen. Die Karte ordnet die Abschnitte entlang von Achsen, die ein statistisches Verfahren gefunden hat; was eine Achse inhaltlich trennt, weiss niemand im Voraus.',
    'Du bekommst je Achse Auszüge der Abschnitte an ihren zwei Enden. Benenne, worin sich die zwei Gruppen unterscheiden.',
    'Regeln:',
    '- Gesucht ist der UNTERSCHIED zwischen den Enden, nicht eine Inhaltsangabe. Was beide Gruppen gemeinsam haben, ist nicht die Achse.',
    '- Der Unterschied kann thematisch sein (Geschäft gegen Familie), erzählerisch (Szene gegen Rückblick, Dialog gegen Beschreibung), räumlich, zeitlich oder eine Figurengruppe. Nenne den, der die Auszüge am deutlichsten trennt.',
    '- Ein Pol-Label hat höchstens vier Wörter, ohne Satzzeichen am Ende.',
    '- Wenn kein klarer Unterschied erkennbar ist, sag das in «unterschied» und gib die Labels trotzdem so vorsichtig wie möglich.',
    '- Erfinde nichts, was nicht in den Auszügen steht. Nenne Figuren nur, wenn sie in den Auszügen vorkommen.',
    '- Antworte in der Sprache der Auszüge.',
  ];
  if (!_isLocal) parts.push('', JSON_ONLY);
  return parts.join('\n');
}

/**
 * @param {Array<{ neg: Array<{name:string, text:string}>, pos: Array<{name:string, text:string}> }>} axes
 */
export function buildBookMapAxisPrompt(axes) {
  const block = (items) => items.map(it => `### ${it.name}\n${it.text}`).join('\n\n');
  const parts = axes.map((ax, i) => [
    `## Achse ${i + 1}`,
    '',
    `### Ende A (negativ)`,
    '',
    block(ax.neg),
    '',
    `### Ende B (positiv)`,
    '',
    block(ax.pos),
  ].join('\n'));
  return [
    `Benenne die folgenden ${axes.length} Achsen. Antworte mit genau einem Eintrag je Achse, in derselben Reihenfolge:`,
    '{"achsen": [{"unterschied": "ein Satz: worin sich Ende A und Ende B unterscheiden", "negativ": "Label für Ende A", "positiv": "Label für Ende B"}]}',
    '',
    ...parts,
  ].join('\n');
}

export const SCHEMA_BOOK_MAP_AXES = _obj({
  achsen: { type: 'array', items: _obj({ unterschied: _str, negativ: _str, positiv: _str }) },
});
