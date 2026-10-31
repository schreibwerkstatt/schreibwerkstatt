// Finetune-Export · Leser-Modell. Zwei KI-Builder für Samples, die ein Modell
// für Leser trainieren (Zielgruppe `reader`, docs/finetuning.md#leser-modell):
//   1) buildFinetunePersonaPrompt — Fragen an eine Hauptfigur und ihre Antworten
//      in der Ich-Form, gegründet in Beschreibung, Werkstatt-Kernen und echten
//      Dialogzeilen der Figur.
//   2) buildFinetuneDeutungPrompt — «Warum …?»-Fragen zu einer Szene samt
//      Deutung der inneren Beweggründe.
//
// Beide verlangen pro Paar einen `beleg`: ein wörtliches Stück aus dem gelieferten
// Material. Der Server prüft ihn gegen genau dieses Material (lib/quote-verify.js);
// ein Paar ohne auffindbaren Beleg fällt weg. Die Belegpflicht hält die Deutung am
// Text — eine erfundene Motivation klänge im Ton des Buchs wie Kanon.
//
// Locale-aware wie finetune.js: Feldnamen bleiben deutsch, die Strings kommen in
// der Buchsprache zurück.

import { _obj, _str } from './schema-utils.js';

const _list = (lines) => lines.map(l => '- ' + l);

export function buildFinetunePersonaPrompt({ name, bookName = '', material, count = 8, langIsEn = false }) {
  const book = bookName || (langIsEn ? 'the book' : 'dem Buch');
  const intro = langIsEn
    ? `Readers of «${book}» are talking directly to the character ${name}. Write ${count} questions a reader might ask ${name}, and ${name}'s answer to each, in the first person.`
    : `Leserinnen und Leser von «${book}» sprechen direkt mit der Figur ${name}. Schreibe ${count} Fragen, die jemand ${name} stellen könnte, und die Antwort von ${name} darauf, in der Ich-Form.`;
  const rules = langIsEn
    ? [
        'Cover different sides: origin, what the character wants, what they need without knowing it, old wounds, the lie they tell themselves, relationships, a decisive moment, fears.',
        `Answers in ${name}'s own voice: use the way of speaking, phrases and register from the dialogue lines; 2–5 sentences.`,
        'Only what the material carries. Where it says nothing, leave the topic out instead of inventing.',
        'The character knows what they lived through, not the book\'s chapter titles or the author\'s notes; never mention the material, the mind map or "the book".',
        '`beleg`: a short passage copied word for word from the material that supports the answer (a dialogue line, part of the description or a note).',
      ]
    : [
        'Verschiedene Seiten abdecken: Herkunft, was die Figur will, was sie braucht, ohne es zu wissen, alte Wunden, die Lüge, die sie sich erzählt, Beziehungen, ein entscheidender Moment, Ängste.',
        `Antworten in der eigenen Stimme von ${name}: Sprechweise, Wendungen und Tonlage aus den Dialogzeilen übernehmen; 2–5 Sätze.`,
        'Nur was das Material trägt. Sagt es zu einem Thema nichts, das Thema weglassen statt erfinden.',
        'Die Figur weiss, was sie erlebt hat, nicht die Kapiteltitel oder die Notizen des Autors; nie vom Material, der Mindmap oder «dem Buch» sprechen.',
        '`beleg`: ein kurzes Stück, wörtlich aus dem Material kopiert, das die Antwort stützt (Dialogzeile, Teil der Beschreibung oder einer Notiz).',
      ];
  return [
    intro,
    '',
    langIsEn ? 'Rules:' : 'Regeln:',
    ..._list(rules),
    '',
    'Schema:\n{ "paare": [ { "frage": "...", "antwort": "...", "beleg": "..." } ] }',
    '',
    langIsEn ? 'Material:' : 'Material:',
    material,
  ].join('\n');
}

export const SCHEMA_FT_PERSONA = _obj({
  paare: { type: 'array', items: _obj({ frage: _str, antwort: _str, beleg: _str }) },
});

export function buildFinetuneDeutungPrompt({ passage, figures = '', sceneTitle = '', chapter = '', bookName = '', count = 2, langIsEn = false }) {
  const book = bookName || (langIsEn ? 'the book' : 'dem Buch');
  const intro = langIsEn
    ? `Write ${count} questions a reader of «${book}» might ask about the following passage, each asking WHY a character acts, feels or speaks the way they do, together with an answer that interprets the character's inner motives.`
    : `Schreibe ${count} Fragen, die eine Leserin von «${book}» zur folgenden Passage stellen könnte, jede nach dem WARUM: warum eine Figur so handelt, fühlt oder spricht, dazu eine Antwort, die die inneren Beweggründe der Figur deutet.`;
  const rules = langIsEn
    ? [
        'Questions self-contained: name the character and the situation, 6–25 words.',
        'Answers 2–5 sentences in the tone of the book, interpreting the inner life (fear, desire, guilt, self-deception), not retelling the plot.',
        'Build on the passage and, where given, on the character notes; nothing beyond them.',
        'Weave the quotation into the answer as evidence.',
        '`beleg`: one sentence or part of a sentence copied word for word from the passage that carries the interpretation.',
      ]
    : [
        'Fragen eigenständig: Figur und Situation nennen, 6–25 Wörter.',
        'Antworten 2–5 Sätze im Ton des Buchs, deuten das Innenleben (Angst, Sehnsucht, Schuld, Selbsttäuschung), statt die Handlung nachzuerzählen.',
        'Stütze dich auf die Passage und, wo vorhanden, auf die Figuren-Notizen; nichts darüber hinaus.',
        'Das Zitat als Beleg in die Antwort einflechten.',
        '`beleg`: ein Satz oder Satzteil, wörtlich aus der Passage kopiert, der die Deutung trägt.',
      ];
  const lines = [
    intro,
    '',
    langIsEn ? 'Rules:' : 'Regeln:',
    ..._list(rules),
    '',
    'Schema:\n{ "paare": [ { "frage": "...", "antwort": "...", "beleg": "..." } ] }',
    '',
  ];
  if (chapter)    lines.push((langIsEn ? 'Chapter: ' : 'Kapitel: ') + chapter);
  if (sceneTitle) lines.push((langIsEn ? 'Scene: ' : 'Szene: ') + sceneTitle);
  if (figures)    lines.push('', langIsEn ? 'Character notes:' : 'Figuren-Notizen:', figures);
  lines.push('', langIsEn ? 'Passage:' : 'Passage:', passage);
  return lines.join('\n');
}

export const SCHEMA_FT_DEUTUNG = _obj({
  paare: { type: 'array', items: _obj({ frage: _str, antwort: _str, beleg: _str }) },
});
