'use strict';
// Kontext-Budget des Seiten-Chats (kind='page'). Pure Helfer, ohne DB und ohne
// KI — der Job (page-chat.js) misst, diese Datei entscheidet.
//
// Drei Posten wachsen ohne Deckel, wenn niemand sie begrenzt: der Seitentext,
// der Stand beim Chat-Start (eine zweite Vollfassung, sobald der Autor
// editiert hat) und der Verlauf (jede Runde hängt an). Ungekappt scheitert der
// Call irgendwann am Preflight (lib/ai/shared.js#assertPromptFitsContext), und
// weil der Verlauf nur wächst, scheitert danach JEDE weitere Nachricht derselben
// Session — die Session ist tot. Darum:
//   - Seitentext: harter Deckel mit eigener Fehlermeldung (eine gekappte Seite
//     liesse Vorschläge auf Text zu, den das Modell nie gesehen hat).
//   - Stand beim Chat-Start: nie als zweite Vollfassung, sondern als kompakter
//     Wort-Diff gegen den aktuellen Stand (gebudgetet, Rest ausgewiesen).
//   - Verlauf: auf den Rest des Budgets gekürzt, älteste Nachrichten zuerst; das
//     Modell erfährt per Hinweis, dass etwas fehlt.

const { diffWords } = require('diff');

// Anteile am Input-Budget des effektiven Providers (aiCfg.inputBudgetChars).
// Gesamt 90 %: Zeichen→Token ist eine Schätzung, der Preflight rechnet in Tokens.
const PROMPT_FILL = 0.9;
const PAGE_SHARE = 0.45;
const CHANGE_NOTE_SHARE = 0.05;
const CHANGE_NOTE_MIN = 1000;
const CHANGE_NOTE_MAX = 6000;
// Reserve für Rollen-Overhead + Kürzungs-Hinweis im Verlauf.
const HISTORY_OVERHEAD_PER_MSG = 16;
const HISTORY_RESERVE = 300;

// Diff-Darstellung: Kontext je Seite eines Hunks, Kappung langer Hunks,
// Gleichtext-Lücke, unterhalb der zwei Änderungen zu einem Hunk verschmelzen.
const CONTEXT_CHARS = 60;
const HUNK_PART_MAX = 400;
const MERGE_GAP = 24;
// Ab diesem Anteil geänderter Zeichen gilt die Seite als umgeschrieben.
const HEAVY_RATIO = 0.5;
const DIFF_TIMEOUT_MS = 300;

function pageChatBudget(aiCfg) {
  const input = Math.max(8000, Number(aiCfg?.inputBudgetChars) || 0);
  return {
    total: Math.floor(input * PROMPT_FILL),
    pageMax: Math.floor(input * PAGE_SHARE),
    changeNoteMax: Math.min(CHANGE_NOTE_MAX, Math.max(CHANGE_NOTE_MIN, Math.floor(input * CHANGE_NOTE_SHARE))),
  };
}

// Zeichendeckel der Zusatzblöcke (Zeitstrahl, Kontinuität, Buch-Ideen, frühere Szenen) als Anteil am
// Input-Budget, mit Boden und Decke: ein kleines lokales Fenster bekommt wenige
// Zeilen statt eines gesprengten Prompts, ein grosses keinen Block über die Decke —
// was nicht passt, weist der Prompt-Baustein als gekappt aus.
const KONTEXT_CAPS = {
  zeitstrahl:   { share: 0.05, min: 1500, max: 30000 },
  kontinuitaet: { share: 0.03, min: 1000, max: 12000 },
  ideen:        { share: 0.05, min: 1500, max: 30000 },
  szenen:       { share: 0.05, min: 1500, max: 30000 },
};
function pageChatKontextCaps(aiCfg) {
  const input = Math.max(8000, Number(aiCfg?.inputBudgetChars) || 0);
  const out = {};
  for (const [k, { share, min, max }] of Object.entries(KONTEXT_CAPS)) {
    out[k] = Math.min(max, Math.max(min, Math.floor(input * share)));
  }
  return out;
}

function _clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Wort-Diff Chat-Start-Stand → aktueller Stand als kompakte Hunks.
 * @returns {null | { hunks: Array<{before,removed,added,after}>, omitted: number, heavy: boolean }}
 *   null = kein Unterschied (oder kein Ausgangsstand).
 */
function computePageChangeHunks(before, after, { maxChars = CHANGE_NOTE_MAX } = {}) {
  const a = String(before || '').trim();
  const b = String(after || '').trim();
  if (!a || a === b) return null;
  let parts;
  try { parts = diffWords(a, b, { timeout: DIFF_TIMEOUT_MS }); } catch { parts = undefined; }
  // Timeout/Fehler: der Diff wäre zu teuer — dann ist die Seite ohnehin
  // umgeschrieben, und der aktuelle Stand im Prompt ist die Wahrheit.
  if (!Array.isArray(parts)) return { hunks: [], omitted: 0, heavy: true };

  const raw = [];
  let cur = null;
  let changed = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.added || p.removed) {
      if (!cur) cur = { before: parts[i - 1]?.value || '', removed: '', added: '' };
      if (p.removed) cur.removed += p.value; else cur.added += p.value;
      changed += p.value.length;
      continue;
    }
    // Gleichtext: kurze Lücke zwischen zwei Änderungen gehört in den Hunk.
    const nextIsChange = parts[i + 1] && (parts[i + 1].added || parts[i + 1].removed);
    if (cur && nextIsChange && p.value.length <= MERGE_GAP) {
      cur.removed += p.value;
      cur.added += p.value;
      continue;
    }
    if (cur) { cur.after = p.value; raw.push(cur); cur = null; }
  }
  if (cur) { cur.after = ''; raw.push(cur); }

  const hunks = [];
  let used = 0;
  for (const h of raw) {
    const hunk = {
      before: _clip(h.before.length > CONTEXT_CHARS ? h.before.slice(-CONTEXT_CHARS) : h.before, CONTEXT_CHARS + 1).trimStart(),
      removed: _clip(h.removed.trim(), HUNK_PART_MAX),
      added: _clip(h.added.trim(), HUNK_PART_MAX),
      after: _clip(h.after.slice(0, CONTEXT_CHARS), CONTEXT_CHARS + 1).trimEnd(),
    };
    const size = hunk.before.length + hunk.removed.length + hunk.added.length + hunk.after.length + 16;
    if (used + size > maxChars) break;
    used += size;
    hunks.push(hunk);
  }
  return {
    hunks,
    omitted: raw.length - hunks.length,
    heavy: changed > Math.max(a.length, b.length) * HEAVY_RATIO,
  };
}

/**
 * Verlauf auf `maxChars` kürzen — älteste Nachrichten zuerst. Die erste
 * verbleibende Nachricht ist immer eine User-Nachricht (Provider verlangen das,
 * und eine Antwort ohne ihre Frage ist für das Modell wertlos).
 * @returns {{ messages: Array<{role,content}>, dropped: number }}
 */
function fitHistory(history, maxChars) {
  const list = Array.isArray(history) ? history : [];
  const size = (m) => (m.content || '').length + HISTORY_OVERHEAD_PER_MSG;
  const limit = Math.max(0, maxChars - HISTORY_RESERVE);
  let total = list.reduce((s, m) => s + size(m), 0);
  let start = 0;
  while (start < list.length && total > limit) { total -= size(list[start]); start++; }
  while (start < list.length && list[start].role !== 'user') { total -= size(list[start]); start++; }
  return { messages: list.slice(start), dropped: start };
}

// Log-Zeile der Prompt-Zusammensetzung (Zeichen je Baustein): `sizes` füllt
// prompts/chat.js#buildChatSystemPrompt (opts.sizes), `extra` der Job (Buch-Kontext
// in der Frage, gekürzter Verlauf). Zeigt, welcher Baustein den Prompt trägt —
// Grundlage jeder Kontext- oder Cache-Entscheidung im Abschnitts-Chat.
function formatPromptSizes(sizes = {}, extra = {}) {
  const k = (n) => `${((Number(n) || 0) / 1000).toFixed(1)}K`;
  return `Prompt-Zeichen: Block1 ${k(sizes.block1)} (System ${k(sizes.system)}, Figuren ${k(sizes.figuren)} [${sizes.figurenModus || '-'}], `
    + `Buchbewertung ${k(sizes.review)}, Titel ${k(sizes.titel)}, Zeitstrahl ${k(sizes.zeitstrahl)}, Kontinuität ${k(sizes.kontinuitaet)}) · Block2 ${k(sizes.block2)} (Abschnitt ${k(sizes.abschnitt)}, `
    + `Änderungen ${k(sizes.aenderungen)}, Figuren-Nachtrag ${k(sizes.figurenAbschnitt)}, Ideen ${k(sizes.ideen)}, Buch-Ideen ${k(sizes.buchIdeen)}, frühere Szenen ${k(sizes.szenen)}, Welt ${k(sizes.welt)}, Lektorat ${k(sizes.lektorat)}) · `
    + `Buch-Kontext ${k(extra.buchKontext)} · Figuren aus Frage ${k(extra.figurenFrage)} · Verlauf ${k(extra.verlauf)} (${extra.verlaufNachrichten || 0} Nachrichten).`;
}

module.exports = { pageChatBudget, pageChatKontextCaps, computePageChangeHunks, fitHistory, formatPromptSizes };
