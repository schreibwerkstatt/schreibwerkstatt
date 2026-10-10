// Seiten-Chat: kompakte Prompt-Bausteine für Verlauf und Seitenänderung.
// Die Auswahl (welche Hunks, wie viel Verlauf) trifft der Job über
// routes/jobs/chat/page-chat-context.js — hier steht nur der Wortlaut.

import { _obj, _str } from './schema-utils.js';

const CLIP = 160;

// Antwortschema des Abschnitts-Chats (Prompt-Text: chat.js#buildChatSystemPrompt).
export const SCHEMA_CHAT = _obj({
  antwort: _str,
  vorschlaege: {
    type: 'array',
    items: _obj({ original: _str, ersatz: _str, begruendung: _str }),
  },
  titel_varianten: { type: 'array', items: _str },
  ideen: {
    type: 'array',
    items: _obj({ inhalt: _str, begruendung: _str, ort: { type: 'string', enum: ['abschnitt', 'kapitel'] } }),
  },
});

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

function _clip(s, n = CLIP) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/**
 * Frühere Vorschläge einer Assistant-Nachricht für den Verlauf ans Modell.
 * Ohne diesen Anhang sieht das Modell nur seinen Antworttext: es schlägt
 * übernommene Stellen erneut vor (die es so nicht mehr gibt) und weiss nicht,
 * was der Autor verworfen hat.
 */
export function formatHistoryVorschlaege(vorschlaege) {
  if (!Array.isArray(vorschlaege) || vorschlaege.length === 0) return '';
  const lines = vorschlaege.map((v, i) => {
    const status = v?.applied ? 'übernommen'
      : v?.status === 'discarded' ? 'verworfen'
      : v?.match === 'not_found' ? 'offen, Stelle nicht im Text gefunden'
      : 'offen';
    return `${i + 1}. [${status}] «${_clip(v?.original)}» → «${_clip(v?.ersatz)}»`;
  });
  return ['[Deine Änderungsvorschläge in dieser Antwort, Status beim Autor:', ...lines, ']'].join('\n');
}

/**
 * Frühere Ideen-Vorschläge einer Assistant-Nachricht (context_info.proposals)
 * für den Verlauf — sonst schlägt das Modell verworfene erneut vor. Erfasste
 * stehen zusätzlich als OFFENE IDEEN im Prompt, solange sie offen sind.
 */
export function formatHistoryIdeen(proposals) {
  const list = Array.isArray(proposals) ? proposals.filter(p => p?.type === 'idee_create') : [];
  if (list.length === 0) return '';
  const lines = list.map((p, i) => {
    const status = p.applied_at ? 'als Idee erfasst' : p.status === 'discarded' ? 'verworfen' : 'offen';
    return `${i + 1}. [${status}] ${_clip(p.fields?.content)}`;
  });
  return ['[Deine Ideen-Vorschläge in dieser Antwort, Status beim Autor:', ...lines, ']'].join('\n');
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
