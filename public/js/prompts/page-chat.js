// Seiten-Chat: kompakte Prompt-Bausteine für Verlauf und Seitenänderung.
// Die Auswahl (welche Hunks, wie viel Verlauf) trifft der Job über
// routes/jobs/chat/page-chat-context.js — hier steht nur der Wortlaut.

const CLIP = 160;

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
    const status = v?.applied ? 'übernommen' : v?.status === 'discarded' ? 'verworfen' : 'offen';
    return `${i + 1}. [${status}] «${_clip(v?.original)}» → «${_clip(v?.ersatz)}»`;
  });
  return ['[Deine Änderungsvorschläge in dieser Antwort, Status beim Autor:', ...lines, ']'].join('\n');
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
