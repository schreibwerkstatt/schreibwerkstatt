// Finetune-Export · AI-Augmentation. Drei Builder für die Sample-Multiplizierung:
//   1) buildFinetuneReversePromptsPrompt — N natürliche User-Instructions zu
//      einer gegebenen Buchpassage. Assistant-Content bleibt der Originaltext;
//      nur die User-Seite wird KI-generiert. Verhindert Stil-Drift, weil die
//      Trainings-Antwort immer Autorprosa ist.
//   2) buildFinetuneFactQAPrompt — synthetische Q&A-Paare aus strukturierten
//      DB-Feldern (Figuren/Orte/Ereignisse). Trainiert Welt-Wissen.
//   3) buildFinetuneVoiceRewritePrompt — Figuren-/Orts-Antwort aus der Analyse
//      im Erzählton des Buchs neu fassen, Fakten unverändert. Stilvorlage sind
//      Originalpassagen; ohne sie lernte das Modell auf «Wer ist X?» den Ton
//      der Analyse statt den des Autors.
//
// Locale-aware: alle nehmen `langIsEn` als Hinweis fürs Output-Format
// (Felder bleiben deutsch, damit Schemas stabil sind, aber die Strings selbst
// kommen in der Buch-Sprache zurück).

import { _jsonOnly } from './state.js';
import { _obj, _str } from './schema-utils.js';

const FT_AUGMENT_SYSTEM_DE = 'Du unterstützt die Aufbereitung von Trainingsdaten aus einem Roman. Du erfindest keine Inhalte, sondern formulierst Instruktionen, Fragen oder Begründungen, die zu vorgegebenem Originaltext passen. Antworte präzise, in natürlicher Sprache, ohne Floskeln.';
const FT_AUGMENT_SYSTEM_EN = 'You help prepare training data from a novel. You do not invent content; you phrase instructions, questions, or justifications that match the given source text. Answer precisely, in natural language, no fluff.';

export function buildFinetuneAugmentSystem(langIsEn) {
  const base = langIsEn ? FT_AUGMENT_SYSTEM_EN : FT_AUGMENT_SYSTEM_DE;
  return `${base}${_jsonOnly()}`;
}

export function buildFinetuneReversePromptsPrompt({ passage, count = 4, langIsEn = false, bookName = '', chapter = '', pageTitle = '' }) {
  const lines = langIsEn
    ? [
        `Generate ${count} different, natural user instructions or questions that would lead an author to write the following passage from «${bookName || 'the book'}». Each instruction must be answerable by exactly the given text — no extra context.`,
        '',
        'Rules:',
        '- Each instruction in plain natural language, 4–25 words, no quotation marks around the whole instruction.',
        '- Vary phrasing: imperative ("Write …"), question ("What happens when …"), context-setting ("Imagine …"), perspective shift, action focus, character focus, location focus.',
        '- Do not name the section or chapter title literally; describe content instead.',
        '- Do not invent facts not present in the passage.',
        '- Output the instructions only, no commentary.',
      ]
    : [
        `Erzeuge ${count} verschiedene, natürliche User-Instructions oder Fragen, die einen Autor zur folgenden Passage aus «${bookName || 'dem Buch'}» führen würden. Jede Instruction muss durch genau diesen Text beantwortet werden — kein Zusatzkontext.`,
        '',
        'Regeln:',
        '- Jede Instruction in natürlicher Sprache, 4–25 Wörter, keine Anführungszeichen um die ganze Instruction.',
        '- Variation: Imperativ ("Schreibe …"), Frage ("Was passiert, wenn …"), Kontext-Setzung ("Stell dir vor …"), Perspektivwechsel, Handlungsfokus, Figurenfokus, Ortsfokus.',
        '- Kapitel- oder Abschnittstitel nicht wörtlich nennen; stattdessen den Inhalt beschreiben.',
        '- Keine Fakten erfinden, die nicht in der Passage stehen.',
        '- Nur die Instructions ausgeben, kein Kommentar.',
      ];
  if (chapter) lines.push((langIsEn ? `Chapter context: ${chapter}` : `Kapitel-Kontext: ${chapter}`));
  if (pageTitle) lines.push((langIsEn ? `Section title (do not name literally): ${pageTitle}` : `Abschnittstitel (nicht wörtlich nennen): ${pageTitle}`));
  lines.push('');
  lines.push(langIsEn
    ? 'Schema:\n{ "instructions": ["...", "..."] }'
    : 'Schema:\n{ "instructions": ["...", "..."] }');
  lines.push('');
  lines.push(langIsEn ? 'Passage:' : 'Passage:');
  lines.push(passage);
  return lines.join('\n');
}

export const SCHEMA_FT_REVERSE_PROMPTS = _obj({
  instructions: { type: 'array', items: _str },
});

export function buildFinetuneFactQAPrompt({ entityType, entityJson, count = 4, langIsEn = false, bookName = '' }) {
  const intro = langIsEn
    ? `Generate ${count} self-contained question–answer pairs about the following ${entityType} from «${bookName || 'the book'}». Use only facts present in the JSON; do not invent details.`
    : `Erzeuge ${count} eigenständige Frage–Antwort-Paare zu folgender(m) ${entityType} aus «${bookName || 'dem Buch'}». Nutze nur Fakten aus dem JSON, erfinde nichts dazu.`;
  const rules = langIsEn
    ? [
        '- Each question 4–20 words, natural reader phrasing.',
        '- Each answer 1–3 sentences, in the author\'s tone, factually grounded in the JSON.',
        '- Vary question forms: identity, relation, location, time, motivation, characteristic.',
        '- Do not repeat the entity name in every question; use pronouns where natural.',
        '- Skip a slot rather than fabricate when the JSON lacks the info.',
      ]
    : [
        '- Jede Frage 4–20 Wörter, natürliche Leserformulierung.',
        '- Jede Antwort 1–3 Sätze, im Ton des Autors, faktentreu zum JSON.',
        '- Frageformen variieren: Identität, Beziehung, Ort, Zeit, Motivation, Eigenschaft.',
        '- Nicht in jeder Frage den Entitäts-Namen wiederholen; wo natürlich, Pronomen nutzen.',
        '- Lieber einen Slot weglassen als zu erfinden, wenn das JSON die Info nicht hergibt.',
      ];
  const schema = '{ "qa": [ { "frage": "...", "antwort": "..." } ] }';
  return [
    intro,
    '',
    langIsEn ? 'Rules:' : 'Regeln:',
    ...rules,
    '',
    langIsEn ? `Schema:\n${schema}` : `Schema:\n${schema}`,
    '',
    `JSON (${entityType}):`,
    typeof entityJson === 'string' ? entityJson : JSON.stringify(entityJson),
  ].join('\n');
}

export const SCHEMA_FT_FACT_QA = _obj({
  qa: { type: 'array', items: _obj({ frage: _str, antwort: _str }) },
});

export function buildFinetuneVoiceRewritePrompt({ entityType, name, text, styleSamples = [], langIsEn = false, bookName = '' }) {
  const lines = langIsEn
    ? [
        `Rewrite the following description of the ${entityType} «${name}» from «${bookName || 'the book'}» so it reads as if the author wrote it in the book's own narrative voice: same tone, rhythm, vocabulary and perspective as the style samples.`,
        '',
        'Rules:',
        '- Keep every fact of the description; add none, drop none, change none (names, places, chapter titles, relations, occupations stay exactly as given).',
        '- Prose only — no list, no labels like "Occupation:", no headings.',
        '- Roughly the same length as the description.',
        '- Do not copy sentences from the style samples; they only show the voice.',
      ]
    : [
        `Fasse die folgende Beschreibung von ${entityType} «${name}» aus «${bookName || 'dem Buch'}» neu, als hätte der Autor sie in der Erzählstimme des Buchs geschrieben: gleicher Ton, Rhythmus, Wortschatz und Blickwinkel wie in den Stilproben.`,
        '',
        'Regeln:',
        '- Jede Tatsache der Beschreibung bleibt erhalten; keine hinzufügen, keine weglassen, keine ändern (Namen, Orte, Kapiteltitel, Beziehungen, Berufe bleiben genau wie angegeben).',
        '- Nur Fliesstext — keine Liste, keine Etiketten wie «Beruf:», keine Überschriften.',
        '- Ungefähr gleich lang wie die Beschreibung.',
        '- Keine Sätze aus den Stilproben übernehmen; sie zeigen nur die Stimme.',
      ];
  lines.push('', 'Schema:\n{ "antwort": "..." }', '');
  if (styleSamples.length) {
    lines.push(langIsEn ? 'Style samples from the book:' : 'Stilproben aus dem Buch:');
    for (const s of styleSamples) lines.push('---', s);
    lines.push('---', '');
  }
  lines.push(langIsEn ? 'Description:' : 'Beschreibung:', text);
  return lines.join('\n');
}

export const SCHEMA_FT_VOICE_REWRITE = _obj({ antwort: _str });

// Kernwissen-Varianten (samples/core-facts/ai-paraphrase.js): eine FRAGE
// N-mal anders formulieren, so wie Leser sie stellen. Die Antwort bleibt die
// Vorlage — eine umformulierte Antwort könnte einen neuen, falschen Fakt
// enthalten. Der Export prüft danach, dass jede Frage alle Namen der Vorlage
// trägt und keine anderen, und schickt sie durch Dedup und Overlap-Prüfung.
export function buildFinetuneParaphrasePrompt({ question, answer, count = 3, langIsEn = false, bookName = '' }) {
  const lines = langIsEn
    ? [
        `Rephrase the following reader question about the book «${bookName || 'the book'}» ${count} times, each time differently worded.`,
        '',
        'Rules:',
        '- Every variant asks for exactly the same thing; the answer below must fit every variant.',
        '- Keep all names exactly as written; add no other names, years or facts.',
        '- Mix direct, indirect and colloquial wording, as different readers would ask.',
        '- One question per variant, no lists, no labels.',
      ]
    : [
        `Formuliere die folgende Leserfrage zum Buch «${bookName || 'dem Buch'}» ${count}-mal neu, jedes Mal anders.`,
        '',
        'Regeln:',
        '- Jede Variante fragt genau dasselbe; die Antwort unten muss zu jeder Variante passen.',
        '- Alle Namen bleiben genau so geschrieben; keine weiteren Namen, Jahreszahlen oder Fakten hinzufügen.',
        '- Direkte, indirekte und umgangssprachliche Formulierungen mischen, wie verschiedene Leser fragen würden.',
        '- Eine Frage pro Variante, keine Liste, keine Etiketten.',
      ];
  lines.push('', 'Schema:\n{ "varianten": ["...", "..."] }', '');
  lines.push(langIsEn ? 'Question:' : 'Frage:', question, '');
  lines.push(langIsEn ? 'Answer (stays unchanged):' : 'Antwort (bleibt unverändert):', answer);
  return lines.join('\n');
}

export const SCHEMA_FT_PARAPHRASE = _obj({ varianten: { type: 'array', items: _str } });

// Warum-Leserfragen zu einer Warum-Karte (samples/core-facts/ai-paraphrase.js
// #buildAiWhyQuestions): so gefragt, wie Leser fragen — Perfekt, Präsens,
// umgangssprachlich, ohne den Ereignistitel in Anführungszeichen. Die Antwort
// bleibt die geprüfte aus den Daten; Schema wie die Fragevarianten.
export function buildFinetuneWhyQuestionsPrompt({ event, figure, own = true, answer, count = 6, langIsEn = false, bookName = '' }) {
  const lines = langIsEn
    ? [
        `A reader of the book «${bookName || 'the book'}» wants to understand an event. Write ${count} different questions a reader would ask about it, ${own ? `about why ${figure} acts this way` : `about how ${figure} experiences it and what goes on inside ${figure}`}.`,
        '',
        'Rules:',
        '- Ask the way readers talk: past and present tense mixed, direct and colloquial, e.g. "Why did … ?", "What made … ?".',
        '- Describe the event in your own words; never quote its title in «» or quotation marks.',
        '- Use every name from the event exactly as written; add no other names, years or facts.',
        '- The answer below must fit every question.',
        '- One question per variant, no lists, no labels.',
      ]
    : [
        `Eine Leserin des Buchs «${bookName || 'dem Buch'}» will ein Ereignis verstehen. Formuliere ${count} verschiedene Fragen, wie Leser sie stellen würden, ${own ? `danach, warum ${figure} so handelt` : `danach, wie ${figure} es erlebt und was in ${figure} vorgeht`}.`,
        '',
        'Regeln:',
        '- Frag so, wie Leser reden: Perfekt und Präsens gemischt, direkt und umgangssprachlich, z. B. «Warum hat … ?», «Was hat … dazu gebracht, …?».',
        '- Beschreib das Ereignis mit eigenen Worten; nie den Titel in «» oder Anführungszeichen zitieren.',
        '- Jeden Namen aus dem Ereignis genau so verwenden; keine weiteren Namen, Jahreszahlen oder Fakten hinzufügen.',
        '- Die Antwort unten muss zu jeder Frage passen.',
        '- Eine Frage pro Variante, keine Liste, keine Etiketten.',
      ];
  lines.push('', 'Schema:\n{ "varianten": ["...", "..."] }', '');
  lines.push(langIsEn ? 'Event:' : 'Ereignis:', event, '');
  lines.push(langIsEn ? 'Answer (stays unchanged):' : 'Antwort (bleibt unverändert):', answer);
  return lines.join('\n');
}
