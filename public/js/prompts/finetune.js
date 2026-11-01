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

// Kernwissen-Varianten (samples/core-facts/ai-paraphrase.js): eine Antwort
// N-mal anders formulieren, Fakten unverändert. Der Export prüft danach
// Namen, Jahreszahlen und Beziehungswörter gegen die Vorlage und verwirft
// jede Variante, der etwas davon fehlt.
export function buildFinetuneParaphrasePrompt({ question, answer, count = 3, langIsEn = false, bookName = '' }) {
  const lines = langIsEn
    ? [
        `Rephrase the following answer from the book «${bookName || 'the book'}» ${count} times, each time differently worded.`,
        '',
        'Rules:',
        '- Keep every fact exactly: all names, years, numbers and relationship words (mother, son, …) appear unchanged in every variant.',
        '- Add nothing, leave nothing out.',
        '- Prose, 1–4 sentences, no lists, no labels.',
        '- The variants must differ from the original and from each other in wording or sentence structure.',
      ]
    : [
        `Formuliere die folgende Antwort aus dem Buch «${bookName || 'dem Buch'}» ${count}-mal neu, jedes Mal anders.`,
        '',
        'Regeln:',
        '- Jede Tatsache bleibt genau erhalten: alle Namen, Jahreszahlen, Zahlen und Beziehungswörter (Mutter, Sohn, …) stehen unverändert in jeder Variante.',
        '- Nichts hinzufügen, nichts weglassen.',
        '- Fliesstext, 1–4 Sätze, keine Liste, keine Etiketten.',
        '- Die Varianten unterscheiden sich vom Original und voneinander in Wortwahl oder Satzbau.',
      ];
  lines.push('', 'Schema:\n{ "varianten": ["...", "..."] }', '');
  lines.push(langIsEn ? 'Question:' : 'Frage:', question, '');
  lines.push(langIsEn ? 'Answer:' : 'Antwort:', answer);
  return lines.join('\n');
}

export const SCHEMA_FT_PARAPHRASE = _obj({ varianten: { type: 'array', items: _str } });
