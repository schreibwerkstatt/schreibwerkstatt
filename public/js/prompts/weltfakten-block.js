// Welt-Fakten-Block des agentischen Buch-Chats — aus chat.js ausgelagert,
// chat.js re-exportiert (Facade bleibt prompts.js).
import { toolMentions } from './chat-tools/index.js';

/**
 * Welt-Fakten-Block des AGENTISCHEN Buch-Chats — gebudgetet, buch-stabil.
 *
 * Bewusst nur dort: der klassische Buch-Chat-Pfad füllt sein Textbudget mit
 * Buchtext-Passagen, und ein zweiter reservierter Block würde diese Rechnung
 * verschieben. Der Seiten-Chat arbeitet auf EINER Seite, für die die buchweiten
 * Weltregeln selten den Ausschlag geben.
 *
 * `world_facts` ist deklaratives Buch-Wissen aus der Komplettanalyse: etablierte
 * Weltregeln, Geografie, Daten, Technik, Kultur. Kurz, verdichtet, und damit die
 * billigste Antwort auf «welche Regel gilt hier», «was ist über X etabliert» —
 * Stufe 1 der Kosten-Leiter. Ohne den Block muss der Agent dieselbe Auskunft
 * über ein Werkzeug oder, schlimmer, über einen Kapitel-Volltext holen.
 *
 * Der Block gehört in den STABILEN, gecachten System-Anteil (nicht in den
 * Erst-Kontext): er hängt am Buch, nicht an der Frage. Im Erst-Kontext-Block
 * (`cache: false`) würde er jede Iteration neu bezahlt.
 *
 * ZWEI DINGE WERDEN NIE VERSCHWIEGEN:
 *  · Was der Deckel geschluckt hat, steht im Block (sonst hält das Modell eine
 *    gekappte Liste für den ganzen Kanon).
 *  · Ein NICHT erhobener Index liefert KEINEN Block (`scanned: false` → null) —
 *    ein leerer Block würde als «diese Welt hat keine Regeln» gelesen. Dass der
 *    Index fehlt, sagt dem Agenten das Werkzeug `list_world_facts`, wenn er fragt.
 *
 * Die Fakten stammen aus der KI-Extraktion, nicht von der Autorin — der Kopf
 * sagt das, damit das Modell sie nicht als kuratierten Kanon über den Buchtext
 * stellt.
 *
 * @param {{scanned:boolean, fakten:Array}|null} welt  Ausgabe von
 *        db/world-facts.js#listWorldFacts + #worldFactsScanState
 * @param {Object} opts { maxChars }
 * @returns {{ text, shown, total, chars }|null}  null = kein Block
 */
export const WELTFAKTEN_BLOCK_DEFAULT_MAX_CHARS = 8000;
const WELTFAKTEN_HEAD = '=== ETABLIERTE WELT-FAKTEN DES BUCHS ===';

// Rangfolge NUR fuer das Kappen, keine Taxonomie (die ist FAKT_KATEGORIE_WL in
// db/world-facts.js): die tragenden Weltgesetze stehen vorn, damit der Deckel
// zuerst das Beiwerk frisst und nicht die Regel, an der die Welt haengt.
function _weltKatRank(kategorie) {
  if (kategorie === 'regel' || kategorie === 'technik') return 0;
  if (kategorie === 'sonstiges') return 2;
  return 1;
}

export function buildWeltfaktenBlock(welt, opts = {}) {
  if (!welt || welt.scanned === false) return null;
  const list = (Array.isArray(welt.fakten) ? welt.fakten : []).filter(f => f && f.fakt);
  if (!list.length) return null;
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : WELTFAKTEN_BLOCK_DEFAULT_MAX_CHARS;

  const sorted = list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => _weltKatRank(a.f.kategorie) - _weltKatRank(b.f.kategorie) || a.i - b.i)
    .map(x => x.f);

  const rows = sorted.map(f => {
    const subj = f.subjekt ? `${f.subjekt}: ` : '';
    const kap = (f.kapitel || []).length ? ` (${f.kapitel.slice(0, 3).join(', ')})` : '';
    return `- [${f.kategorie || 'sonstiges'}] ${subj}${String(f.fakt).trim()}${kap}${f.widerlegt ? ' [real widerlegt]' : ''}`;
  });

  const lead = [
    WELTFAKTEN_HEAD,
    '(Aus der Komplettanalyse extrahiert, nicht von der Autorin kuratiert — im Zweifel gilt der Buchtext.',
    'Form: [kategorie] Subjekt: Aussage (Kapitel). Beantwortet die Frage schon hier, rufe direkt `final_answer`.)',
  ];
  if (sorted.some(f => f.widerlegt)) {
    lead.push('([real widerlegt] = der Faktencheck hat die Aussage per Quelle als real falsch belegt: sie steht so im Buch, ist aber keine reale Tatsache — nie als real bestätigen.)');
  }
  // Der Kappungs-Hinweis waechst mit den Zahlen darin, ein geschaetzter Overhead
  // reisst den Deckel deshalb gelegentlich. Darum EXAKT: rendern, und solange Zeilen
  // zurueckziehen, bis der fertige Block passt.
  const render = (shown) => {
    const rest = rows.length - shown.length;
    const parts = [...lead];
    if (rest > 0) {
      parts.push(`(NUR ${shown.length} von ${rows.length} Fakten aufgeführt — ${rest} weitere fehlen hier. `
        + (toolMentions(opts.toolNames).has('list_world_facts')
          ? 'Die Liste ist NICHT der vollständige Kanon; fehlt ein Fakt, frage `list_world_facts` mit kategorie/subjekt.)'
          : 'Die Liste ist NICHT der vollständige Kanon — schliesse aus dem Fehlen eines Fakts nichts.)'));
    }
    return [...parts, ...shown].join('\n');
  };
  // Grob vorfuellen (linear), damit ein Buch mit tausenden Fakten nicht tausendmal
  // gerendert wird; die Feinkorrektur unten braucht danach nur noch Einzelschritte.
  const estOverhead = lead.join('\n').length + 200;
  let fit = 0, used = 0;
  while (fit < rows.length && used + rows[fit].length + 1 + estOverhead <= maxChars) {
    used += rows[fit].length + 1;
    fit++;
  }
  let shown = rows.slice(0, Math.max(fit, 1));
  let text = render(shown);
  while (shown.length && text.length > maxChars) {
    shown = shown.slice(0, -1);
    text = render(shown);
  }
  if (!shown.length) return null;
  return { text, shown: shown.length, total: rows.length, chars: text.length };
}
