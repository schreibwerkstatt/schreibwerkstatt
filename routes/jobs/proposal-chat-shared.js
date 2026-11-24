'use strict';
// Gemeinsame Bausteine der beiden Vorschlags-Chats (Plot-Chat, Ideen-Chat) neben
// dem Job-Gerüst (proposal-chat.js): Handler-Eingabe säubern, Vorschlag sammeln,
// Status eines gespeicherten Vorschlags und das Session-Gedächtnis früherer
// Vorschläge. Die chat-eigenen Achsen (Label je Vorschlag, ob das Angelegte noch
// existiert) kommen als Callback herein. Der Nur-Vorschläge-Hinweis samt Leer-Markern
// gilt zusätzlich für den Recherche-Chat.

const { db } = require('../../db/schema');
const { str } = require('../../lib/proposal-input');

const MAX_BEGRUENDUNG = 600;
// Länge eines Vorschlags im Gedächtnis-Block — beide Chats gleich.
const MEMORY_LABEL_MAX = 140;
const MEMORY_LIMIT = 40;

// Abgelehnter Vorschlag: `msg` ist der Korrekturhinweis fürs Modell (deutsch), `kind`
// der Grund fürs UI — `chat.toolError.proposal<Kind>`; der Werkzeug-Verlauf zeigt ihn
// neutral als «abgelehnt», nicht als Werkzeugfehler (public/js/chat/tool-log.js).
const PROPOSAL_REJECT_KINDS = new Set([
  'unknown', 'ambiguous', 'notInBook', 'missing', 'invalid', 'noChange', 'wrongCell',
  'conflict', 'duplicate', 'evidence', 'limit', 'notAllowed',
]);
function err(msg, kind) {
  const k = PROPOSAL_REJECT_KINDS.has(kind) ? kind[0].toUpperCase() + kind.slice(1) : 'Rejected';
  return { error: msg, errorKey: `chat.toolError.proposal${k}` };
}

// Platzhalter des Loops für «keine Antwort» (agentic-chat/loop.js). Mit gesammelten
// Vorschlägen ist das kein Fehlschlag — gilt für jeden Chat mit propose_*-Werkzeugen
// (Plot, Ideen, Recherche). Frontend-Pendant: research-chat-render.js.
const MAX_ITER_MARKER = '__i18n:chat.errors.maxIterReached__';
const EMPTY_MARKERS = new Set([MAX_ITER_MARKER, '__i18n:chat.errors.emptyAnswer__']);

/**
 * Zwei Vorspann-Blöcke teilen sich ein Zeichenbudget (proposal-chat.js#outlineBudgetChars):
 * der Nebenblock (Figurenliste, Gliederung) wird zuerst gebaut, mit höchstens der
 * Hälfte; der Hauptblock (Board, Ideenliste) bekommt, was übrig bleibt. Ist der
 * Nebenblock klein, steht dem Hauptblock fast das ganze Budget offen.
 * `buildSecond(budget) → String`, `buildFirst(budget) → beliebig`.
 */
function splitOutlineBudget(total, buildSecond, buildFirst) {
  const finite = Number.isFinite(total);
  const second = buildSecond(finite ? Math.floor(total / 2) : Infinity);
  const first = buildFirst(finite ? Math.max(0, total - second.length - 1) : Infinity);
  return { first, second };
}

/**
 * Antworttext ohne Inhalt (leer oder Loop-Platzhalter), aber mit `n` Vorschlägen →
 * eigener Hinweis statt Fehlermeldung. `cutMarker` (optional) ersetzt den Abbruch-
 * Platzhalter (Iterationen erschöpft), `onlyMarker` alles andere Leere.
 */
function proposalsOnlyFallback(antwort, n, { onlyMarker, cutMarker = null }) {
  const a = String(antwort || '').trim();
  if (!(n > 0) || (a && !EMPTY_MARKERS.has(a))) return a;
  return a === MAX_ITER_MARKER && cutMarker ? cutMarker : onlyMarker;
}

/**
 * Leere Werte entfernen, BEVOR ein Vorschlags-Handler sie sieht — in beiden
 * Pfaden gleich (klassisch: Constrained Decoding schickt jedes Feld mit,
 * agentisch: Modelle füllen optionale Felder gern mit null/""/0). Ein leerer
 * Wert heisst darum überall «nicht angegeben»; Leeren ist eine eigene, explizite
 * Angabe im Werkzeug (`leeren` bzw. `anker_loesen`).
 */
function cleanProposalInput(v) {
  const out = {};
  for (const [k, val] of Object.entries(v || {})) {
    if (k === 'werkzeug') continue;
    if (val === null || val === undefined || val === 0) continue;
    if (typeof val === 'string' && !val.trim()) continue;
    if (Array.isArray(val) && !val.length) continue;
    out[k] = val;
  }
  return out;
}

// ── Bezüge zwischen Vorschlägen derselben Antwort (act_ref, idee_ref, …) ──────
// Das Modell nummeriert seine Vorschläge in Aufrufreihenfolge — klassisch die
// Einträge von `vorschlaege`, agentisch die propose_*-Aufrufe einer Runde, bevor es
// eine Quittung sieht. Ein abgelehnter Vorschlag zählt dabei mit. Gespeichert wird
// aber nur, was durchkam (ref = Index + 1, so löst das Frontend auf). Die
// Aufrufnummer (`seq`) ist darum die Nummer des Modells; ctx.seqToRef übersetzt sie
// in den gespeicherten ref. Ohne diese Übersetzung zeigte ein Bezug nach einer
// Ablehnung still auf den nächsten Vorschlag gleichen Typs.

/** Nächste Aufrufnummer vergeben — einmal je Vorschlags-Aufruf, auch wenn er scheitert. */
function nextProposalSeq(ctx) {
  if (!ctx.seqToRef) ctx.seqToRef = {};
  ctx.proposalSeq = (ctx.proposalSeq || 0) + 1;
  ctx.currentSeq = ctx.proposalSeq;
  return ctx.proposalSeq;
}

/**
 * Bezug `n` (Nummer des Modells) auf einen Vorschlag dieser Antwort auflösen.
 * @returns {{ ref: number, p: object } | { error: string }}  ref = gespeicherter ref
 */
function refProposal(ctx, n, type, what) {
  let ref = n;
  if (ctx.seqToRef) {
    ref = ctx.seqToRef[n];
    if (!ref) {
      return err(n <= (ctx.proposalSeq || 0)
        ? `${what} ${n}: dieser Vorschlag wurde abgelehnt und gibt es nicht — korrigiere ihn zuerst oder verweise auf einen bestehenden Eintrag.`
        : `${what} ${n}: einen Vorschlag mit dieser Nummer gibt es in dieser Antwort nicht.`, 'unknown');
    }
  }
  const p = ctx.proposals[ref - 1];
  if (!p || p.type !== type) return err(`${what} ${n} zeigt auf keinen passenden Vorschlag dieser Antwort.`, 'unknown');
  return { ref, p };
}

/** Vorschlag an ctx.proposals hängen (ref = Index + 1) und dem Modell quittieren. */
function pushProposal(ctx, proposal, input) {
  const begruendung = str(input?.begruendung, MAX_BEGRUENDUNG);
  const p = { ...proposal, ref: ctx.proposals.length + 1, ...(begruendung ? { begruendung } : {}) };
  ctx.proposals.push(p);
  // Quittiert wird die Nummer des Modells (Aufrufnummer), nicht der Index.
  const seq = ctx.seqToRef && ctx.currentSeq ? ctx.currentSeq : p.ref;
  if (ctx.seqToRef) ctx.seqToRef[seq] = p.ref;
  return { ok: true, ref: seq, hinweis: 'Vorschlag gesammelt — der User übernimmt ihn selbst. Nicht wiederholen.' };
}

/**
 * Status eines gespeicherten Vorschlags: applied / removed / discarded / open.
 * `removed` = übernommen, aber das damit Angelegte gibt es nicht mehr (Undo,
 * gelöscht) — `createdExists(p)` liefert dafür false; für Vorschläge, die nichts
 * anlegen, undefined.
 */
function proposalState(p, createdExists = null) {
  if (p?.applied_at) {
    if (createdExists && createdExists(p) === false) return 'removed';
    return 'applied';
  }
  if (p?.status === 'discarded') return 'discarded';
  return 'open';
}

/**
 * Frühere Vorschläge einer Session, kompakt — für den Gedächtnis-Block im Prompt
 * („nimm den dritten", „nicht nochmal vorschlagen").
 * @param {number} sessionId
 * @param {{ label(p): string, typeLabels: object, createdExists?: (p) => boolean|undefined }} opts
 */
function sessionProposalMemory(sessionId, { label, typeLabels, createdExists = null, limit = MEMORY_LIMIT }) {
  const rows = db.prepare(
    `SELECT context_info FROM chat_messages
      WHERE session_id = ? AND role = 'assistant' AND context_info LIKE '%"proposals"%'
      ORDER BY created_at ASC, id ASC`
  ).all(sessionId);
  const out = [];
  for (const r of rows) {
    let ci;
    try { ci = JSON.parse(r.context_info); } catch { continue; }
    for (const p of Array.isArray(ci?.proposals) ? ci.proposals : []) {
      const l = label(p);
      if (!l) continue;
      out.push({
        type: typeLabels[p.type] || p.type,
        label: String(l).slice(0, MEMORY_LABEL_MAX),
        state: proposalState(p, createdExists),
      });
    }
  }
  return out.slice(-limit);
}

function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

module.exports = {
  MAX_ITER_MARKER, EMPTY_MARKERS, proposalsOnlyFallback, splitOutlineBudget,
  nextProposalSeq, refProposal,
  MAX_BEGRUENDUNG, MEMORY_LABEL_MAX,
  err, PROPOSAL_REJECT_KINDS, cleanProposalInput, pushProposal, proposalState, sessionProposalMemory, oneLine,
};
