'use strict';

// Aufgabentyp eines Samples aus seiner ID (Präfix des Samplers). Er trägt die
// Statistik («Anzahl je Aufgabentyp»), den Fakten-Deckel in finalize.js und den
// Karten-Schutz. Ein Sampler kann `task` auch selbst setzen.
//
// Familien (Mischung nach Antwort-Tokens, lib/token-mix.js):
//   `writing`: das Ziel ist echter Buchtext (Fortsetzen, Szene schreiben,
//              Abschnittsanfang, Szene aus Figurensicht, Dialogzeile,
//              Erzählen aus Figurensicht, Wörtlich, Buchstelle);
//   `persona`: Leser-Gespräch, Ich-Form, Innenleben (samples/reader/);
//   `refusal`: Ablehnen — unbekannte Namen, Teil-Ablehnung, Off-Topic,
//              Meta-Fragen zum Werk, falsche Annahme;
//   `editor`:  Lektorats-Feedback, nur mit `editorFeedback` (Standard aus);
//   alles andere ist `facts`.
const TASK_RULES = [
  [/^(style|styleCtx|styleCont|chapWin|pageCont|chapCont|chapBridge)\|/, 'continue'],
  [/^(chapTrans|scnTrans)\|/, 'transition'],
  [/^(chapOpen|chapterOpening)\|/, 'chapterOpening'],
  [/^sceneBrief\|/, 'sceneBrief'],
  [/^(scene|sceneWrite|page|pageMulti|chapFull|chapFullChunk)\|/, 'sceneWrite'],
  [/^pageCloze\|/, 'cloze'],
  [/^verb(Page|Chap)\|/, 'verbatim'],
  [/^dialog\|/, 'dialogLine'],
  [/^dialogRev\|/, 'whoSays'],
  [/^aiRev\|/, 'reversePrompt'],
  [/^aiQA\|/, 'factAi'],
  [/^authorChat\|(scenePov|evtTextFig)\|/, 'povPassage'],
  [/^authorChat\|(evtText|figPass|figPassCh|ortPass|figVoice|figQuote)\|/, 'passage'],
  [/^authorChat\|evt/, 'factEvent'],
  [/^authorChat\|scene/, 'factScene'],
  [/^authorChat\|(ort|loc)/, 'factPlace'],
  [/^authorChat\|fig/, 'factFigure'],
  [/^authorChat\|(rel|cast|family|power|tag|schicht|hierarchy)/, 'factRelation'],
  [/^authorChat\|(fact|wfact)/, 'factWorld'],
  [/^authorChat\|song/, 'factSong'],
  [/^authorChat\|sl/, 'factStoryline'],
  [/^refusal\|unknown/, 'unknownEntity'],
  [/^refusal\|offTopic/, 'offTopic'],
  [/^refusal\|falsePremise/, 'falsePremise'],
  [/^refusal\|mixed/, 'mixedRefusal'],
  [/^refusal\|meta/, 'metaQuestion'],
  [/^refusal\|notInBook/, 'notInBook'],
  [/^reader\|challenge\|/, 'factChallenge'],
  [/^reader\|(conv|personaConv)\|/, 'readerConversation'],
  [/^reader\|(persona|personaVoice|personaFact)\|/, 'readerPersona'],
  [/^reader\|/, 'reader'],
];

const WRITING_TASKS = new Set([
  'continue', 'transition', 'sceneWrite', 'cloze', 'verbatim',
  'dialogLine', 'povPassage', 'passage', 'reversePrompt', 'chapterOpening', 'sceneBrief',
]);

function taskOf(sample) {
  if (sample.task) return sample.task;
  const id = String(sample.id || '');
  for (const [re, task] of TASK_RULES) if (re.test(id)) return task;
  return 'other';
}

const PERSONA_TASKS = new Set(['reader', 'readerPersona', 'readerConversation']);
const REFUSAL_TASKS = new Set(['unknownEntity', 'offTopic', 'falsePremise', 'mixedRefusal', 'metaQuestion', 'notInBook']);

// Kernwissen (samples/core-facts/): eigene Typen, Familie `facts`.
const CORE_TASKS = new Set(['figureCore', 'figureAttr', 'relationCore', 'eventCore', 'eventWhy', 'sceneWhy', 'psyche', 'eventTimeline', 'chapterCore', 'coreFact']);

function familyOf(task) {
  if (WRITING_TASKS.has(task)) return 'writing';
  if (PERSONA_TASKS.has(task)) return 'persona';
  if (REFUSAL_TASKS.has(task)) return 'refusal';
  if (task === 'editorFeedback') return 'editor';
  return 'facts';
}

// Faktenkarte statt Prosa: mindestens zwei Feld-Etiketten der Ereignis-,
// Szenen- oder Ortskarten. Eine Schreibaufgabe mit so einer Antwort brächte dem
// Modell bei, eine Erzählbitte mit Stichpunkten zu beantworten.
const CARD_LABELS = /(?:^|[\s.])(Zeitpunkt|Art|Beteiligte Figuren|Schauplätze|Schauplatz|Szenen|In Kapitel|Handlungsstrang|Bedeutung|Figuren|Kapitel|When|Type|Characters involved|Characters|Locations|Setting|Scenes|In chapter\(s\)|Chapter|Storyline|Why it matters):\s/g;
function looksLikeCard(text) {
  const found = new Set();
  for (const m of String(text || '').matchAll(CARD_LABELS)) found.add(m[1]);
  return found.size >= 2;
}

module.exports = { taskOf, familyOf, looksLikeCard, WRITING_TASKS, REFUSAL_TASKS, CORE_TASKS };
