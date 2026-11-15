// Seiten-Chat: kompakte Prompt-Bausteine für Verlauf und Seitenänderung.
// Die Auswahl (welche Hunks, wie viel Verlauf) trifft der Job über
// routes/jobs/chat/page-chat-context.js — hier steht nur der Wortlaut.

import { _obj, _str, _num, _nullableEnum } from './schema-utils.js';

const CLIP = 160;

// Antwortschema des Abschnitts-Chats (Prompt-Text: chat.js#buildChatSystemPrompt).
export const SCHEMA_CHAT = _obj({
  antwort: _str,
  vorschlaege: {
    type: 'array',
    items: _obj({ original: _str, ersatz: _str, begruendung: _str, typ: { type: 'string', enum: ['korrektur', 'stil'] } }),
  },
  titel_varianten: { type: 'array', items: _str },
  ideen: {
    type: 'array',
    items: _obj({ inhalt: _str, begruendung: _str, ort: { type: 'string', enum: ['abschnitt', 'kapitel'] } }),
  },
  // Änderungen an den offenen Ideen im Prompt; leerer Text / null = «nicht angegeben»
  // (Normalisierung lib/chat-idee-proposals.js#normalizeChatIdeeUpdates).
  ideen_aenderungen: {
    type: 'array',
    items: _obj({
      idee_id: _num, inhalt: _str,
      status: _nullableEnum(['offen', 'in_arbeit', 'erledigt', 'verworfen']),
      beleg: _str, begruendung: _str,
    }),
  },
});

// Steht der Abschnitt mit einem Nachrichtenverlauf (div.msg-thread) im Prompt,
// folgt dieser Hinweis dem Abschnittsinhalt. Der Chat-Prompt ist deutsch (nicht
// pro Locale gebaut), die Marken im Abschnittstext stehen aber in der
// Buchsprache — der Hinweis zitiert darum die Marken der Buchsprache
// (`langCode`). Marken-Wortlaut: lib/html-text.js#MSG_THREAD_MARKS, gegated durch
// tests/unit/msg-thread-prompt.test.mjs. Lektorat-Pendant:
// blocks.js#_buildNachrichtenBlock.
const _PAGE_CHAT_MSG_MARKS = {
  de: ['Nachrichtenverlauf (SMS/Chat, Schreibweise der Figuren)', 'Ende Nachrichtenverlauf'],
  en: ['Message thread (text/chat, the characters\' own spelling)', 'End of message thread'],
};
export function pageChatNachrichtenHinweis(langCode = 'de') {
  const [label, end] = _PAGE_CHAT_MSG_MARKS[langCode] || _PAGE_CHAT_MSG_MARKS.de;
  return `Hinweis Nachrichtenverlauf: Text zwischen «[${label}]» und «[${end}]» sind Handy-/Chatnachrichten der Figuren, jede Zeile eine Nachricht, ein Absendername oder ein Zeitstempel. Kleinschreibung, Abkürzungen, fehlende oder doppelte Satzzeichen, Emojis und Umgangssprache sind dort gewollte Figurenrede — schlage dafür keine vorschlaege vor, ausser der Autor fragt ausdrücklich danach. Ein Vorschlag dort betrifft immer nur EINE Zeile, nie Absendername oder Zeitstempel, und zitiert nie die Marken selbst.`;
}

// Regeln zum Feld `ideen`: Pendenzen, die der Autor als Idee am Abschnitt
// oder an dessen Kapitel festhält (er bestätigt jede einzeln; Normalisierung
// lib/chat-idee-proposals.js).
export const PAGE_CHAT_IDEEN_RULES = [
  'IDEEN-REGELN:',
  '- ideen sind Pendenzen, die der Autor an diesem Abschnitt oder an seinem Kapitel festhalten kann (er bestätigt jede einzeln). Nutze sie für einen Widerspruch (auch zu einer anderen Stelle des Buchs), einen inhaltlichen Fehler, eine Unstimmigkeit oder einen offenen Punkt, den du bemerkst und der sich NICHT als vorschlaege-Ersetzung lösen lässt — z.B. weil er eine andere Stelle, eine Entscheidung des Autors oder eine Recherche braucht. Oder wenn der Autor ausdrücklich bittet, etwas zu notieren.',
  '- ort: "abschnitt", wenn die Korrektur in diesem Abschnitt ansetzt; "kapitel", wenn der Punkt das ganze Kapitel betrifft (z.B. Zeitlinie, Ablauf über mehrere Abschnitte).',
  '- inhalt ist ein knapper, eigenständig verständlicher Stichpunkt (keine Prosa, kein Bezug auf diesen Chat), z.B. «Augenfarbe von Lena: hier grün, in Kapitel 2 blau — vereinheitlichen».',
  '- Keine Idee für etwas, das ein Eintrag in vorschlaege schon behebt, und keine, die inhaltlich schon bei den offenen Ideen des Autors steht. Höchstens 3. Sonst ein leeres Array.',
];

// Block OFFENE IDEEN im seiten-stabilen Prompt-Teil (Block 2): offene Ideen des
// Abschnitts + des umliegenden Kapitels (routes/jobs/shared/queries.js#getOpenIdeen)
// mit [#id] — Ziel von `ideen_aenderungen`. Leer ohne Ideen.
export function pageChatIdeenLines(ideen) {
  if (!Array.isArray(ideen) || ideen.length === 0) return [];
  const lines = ['=== OFFENE IDEEN (Notizen des Autors für diesen Abschnitt + das umliegende Kapitel) ==='];
  for (const i of ideen) {
    const datum = i.created_at ? ` (${i.created_at.slice(0, 10)})` : '';
    const tag = i.scope === 'chapter' ? '[Kapitel] ' : '[Abschnitt] ';
    const id = i.id != null ? `[#${i.id}] ` : '';
    const stufe = i.status && i.status !== 'offen' ? ` — Stufe: ${i.status}` : '';
    lines.push(`- ${id}${tag}${i.content}${datum}${stufe}`);
  }
  lines.push(
    '',
    'Hinweis: Diese Ideen sind Notizen des Autors zu möglichen Fortsetzungen, Szenen oder inhaltlichen Ankern. [Kapitel]-Notizen gelten fürs ganze Kapitel, [Abschnitt]-Notizen nur für diesen Abschnitt. Greife sie auf, hinterfrage oder ergänze sie konversationell — wandle sie aber nicht eigenmächtig in vorschlaege-Einträge um, solange der Autor nicht danach fragt. Ist eine davon im Abschnitt eingelöst, schlage sie über ideen_aenderungen als erledigt vor (Regeln unten).',
    '',
  );
  return lines;
}

// Regeln zum Feld `ideen_aenderungen`: Änderungen an den OFFENEN IDEEN, die der
// Chat im Prompt mit [#id] sieht. Nur wenn es solche Ideen gibt. «erledigt» nur
// mit einem wörtlichen Beleg aus diesem Abschnitt — der Server prüft ihn
// (lib/chat-idee-proposals.js#normalizeChatIdeeUpdates), ein nicht gefundener
// Beleg lässt den Vorschlag fallen. `stages` = im Buch aktive Stufen.
export function pageChatIdeenAenderungRules(stages, { hatIdeen = true } = {}) {
  if (!hatIdeen) return ['- ideen_aenderungen ist ein leeres Array (es gibt keine offenen Ideen).'];
  const list = (Array.isArray(stages) && stages.length ? stages : ['offen', 'erledigt']).join(', ');
  return [
    'IDEEN-ÄNDERUNGEN:',
    '- ideen_aenderungen ändert bestehende OFFENE IDEEN (idee_id = die Zahl aus [#id]); der Autor übernimmt jede einzeln. Je Idee höchstens ein Eintrag, höchstens 5. Sonst ein leeres Array.',
    `- status: neue Stufe oder null (unverändert). Erlaubt: ${list}.`,
    '- «erledigt» schlägst du von dir aus vor, sobald der aktuelle Abschnittsinhalt die Pendenz vollständig einlöst — auch eine [Kapitel]-Idee, wenn die Einlösung in diesem Abschnitt steht. Dann ist beleg Pflicht: eine kurze, zusammenhängende Textstelle WÖRTLICH aus dem Abschnittsinhalt oben (mindestens drei Wörter, höchstens zwei Auslassungen «…»), die die Einlösung zeigt. Ohne passende Stelle kein «erledigt» — nur teilweise eingelöst ist nicht erledigt; sag es dann in antwort.',
    '- «verworfen» nur, wenn der Autor sagt, dass er die Idee fallen lässt oder sie sich erübrigt hat. «in_arbeit»/«offen» nur auf seinen Wunsch.',
    '- inhalt: neuer Wortlaut der Idee, nur wenn der Autor darum bittet oder die Pendenz im Gespräch präzisiert (knapper Stichpunkt wie bei ideen). Sonst leerer Text.',
    '- beleg sonst leer. begruendung: kurz, warum.',
    '- Eine neue Pendenz gehört in ideen, eine Änderung an einer bestehenden hierher — nie beides für denselben Punkt.',
  ];
}

// Abschnittstitel des Buchs in Lesereihenfolge (Block 1, buch-stabil): das
// Modell leitet bei Titelfragen das Muster der übrigen Titel ab (Satzanfang,
// Form, Länge, Ton) und meidet Doppelungen. Über dem Deckel fallen zuerst die
// Kapitelpfade weg, danach wird ausgewiesen gekürzt.
// Der Block ist für alle Abschnitte eines Buchs byte-gleich — den aktuellen
// Abschnitt markiert er bewusst NICHT, sonst wäre Block 1 je Abschnitt ein anderer
// Cache-Präfix und ein Seitenwechsel schriebe ihn ganz neu. Wo der aktuelle
// Abschnitt steht, sagt buildCurrentTitleLine im seiten-spezifischen Block 2.
const TITLES_MAX_CHARS = 6000;

/**
 * @param {Array<{id:number, name:string, chapter?:string}>} titles  Lesereihenfolge
 * @returns {string} Block oder '' (weniger als zwei Abschnitte)
 */
export function buildBookTitlesBlock(titles, { maxChars = TITLES_MAX_CHARS } = {}) {
  const list = _titleList(titles);
  if (list.length < 2) return '';
  const line = (t, withChapter) => {
    const ch = withChapter && t.chapter ? `[${_clip(t.chapter, 60)}] ` : '';
    return `- ${ch}${_clip(t.name, 120)}`;
  };
  let lines = list.map(t => line(t, true));
  if (lines.join('\n').length > maxChars) lines = list.map(t => line(t, false));
  let omitted = 0;
  while (lines.length > 1 && lines.join('\n').length > maxChars) { lines.pop(); omitted++; }
  return [
    '=== ABSCHNITTSTITEL DES BUCHS (Lesereihenfolge) ===',
    ...lines,
    ...(omitted ? [`(… ${omitted} weitere Abschnitte nicht aufgeführt)`] : []),
    '',
    'Hinweis Titel: Fragt der Autor nach einem Titel, einer Überschrift oder Headline, erkenne zuerst das Muster der bestehenden Titel (gemeinsamer Satzanfang oder Satzbau, Länge, Ton, Sprache) und halte dich daran, sofern der Autor nichts anderes verlangt. Jede Variante zeigt konkret, worum es in DIESEM Abschnitt geht, statt allgemein zu bleiben, und verrät die Pointe nicht. Schlage keinen Titel vor, der einem anderen Abschnittstitel gleicht oder ihm sehr ähnelt; weise auf solche Doppelungen unter den bestehenden Titeln hin, wenn sie den aktuellen Abschnitt betreffen.',
  ].join('\n');
}

/**
 * Stellung des aktuellen Abschnitts in der Titelliste (Block 2): Nummer, Kapitel und
 * Nachbarn — eindeutig auch bei gleichnamigen Abschnitten.
 * @returns {string} Zeile oder '' (keine Titelliste / Abschnitt nicht darin)
 */
export function buildCurrentTitleLine(titles, currentPageId) {
  const list = _titleList(titles);
  if (list.length < 2) return '';
  const i = list.findIndex(t => t.id === currentPageId);
  if (i < 0) return '';
  const t = list[i];
  const ch = t.chapter ? `, Kapitel ${_clip(t.chapter, 60)}` : '';
  const prev = i > 0 ? `nach «${_clip(list[i - 1].name, 120)}»` : 'erster Abschnitt';
  const next = i < list.length - 1 ? `vor «${_clip(list[i + 1].name, 120)}»` : 'letzter Abschnitt';
  return `Stellung in der Titelliste: Nr. ${i + 1} von ${list.length}${ch}; ${prev}, ${next}.`;
}

function _titleList(titles) {
  return (Array.isArray(titles) ? titles : []).filter(t => t && String(t.name || '').trim());
}

/** Normalform für den Titel-Vergleich: Kleinschrift, ohne Satzzeichen/Anführungszeichen. */
export function normalizeTitle(s) {
  return String(s ?? '').toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _clip(s, n = CLIP) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Hinweis vor dem gekürzten Verlauf. */
export function historyTrimNote(dropped) {
  return `[Hinweis: ${dropped} ältere Nachrichten dieses Gesprächs wurden aus Platzgründen weggelassen.]`;
}

/**
 * Änderungen seit Chat-Start als Wort-Diff-Liste (`[-entfernt-] {+eingefügt+}`).
 * @param {{ hunks: Array<{before,removed,added,after}>, omitted: number, heavy: boolean }} change
 */
export function formatPageChange(change) {
  if (!change) return '';
  const out = [];
  if (change.heavy) out.push('Der Abschnitt wurde seit Chat-Start umfangreich überarbeitet.');
  for (const h of change.hunks || []) {
    const del = h.removed ? `[-${h.removed}-]` : '';
    const ins = h.added ? `{+${h.added}+}` : '';
    out.push(`- …${h.before}${del}${ins}${h.after}…`);
  }
  if (change.omitted > 0) out.push(`(${change.omitted} weitere Änderungen nicht aufgeführt)`);
  return out.join('\n');
}

/**
 * Buchweiter Kontext-Block des Seiten-Chats: die semantisch nächsten Stellen zur
 * Frage aus ANDEREN Teilen des Buchs (aktuelle Seite ausgeschlossen). Rein lesend —
 * Vorschläge beziehen sich nur auf die aktuelle Seite, sonst zeigte `original` auf
 * Text, den es auf dieser Seite nicht gibt. Leer/null → '' (kein Block).
 * @param {Array<{kind:string,title:string,text:string}>} passages
 */
export function buildPageChatBookContext(passages) {
  const list = Array.isArray(passages) ? passages.filter(p => p && p.text) : [];
  if (!list.length) return '';
  const kindLabel = { page: 'Abschnitt', scene: 'Szene', figure: 'Figur', location: 'Ort', fact: 'Welt-Fakt' };
  const out = [
    '=== KONTEXT AUS ANDEREN TEILEN DES BUCHS (nur lesend) ===',
    '(Automatisch geholt: die semantisch nächsten Stellen zur Frage, nicht aus diesem Abschnitt; Ausschnitte können unvollständig sein. Nutze sie, um Bezüge zum übrigen Buch herzustellen — Figurenwissen, frühere Ereignisse, Widersprüche. Änderungsvorschläge (`vorschlaege`) beziehen sich AUSSCHLIESSLICH auf den ABSCHNITTSINHALT oben; `original` nie aus diesem Block nehmen.)',
  ];
  for (const p of list) {
    out.push(`--- ${kindLabel[p.kind] || p.kind}: «${p.title}» ---`, String(p.text).trim(), '');
  }
  return out.join('\n');
}
