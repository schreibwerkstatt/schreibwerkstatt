// Änderungsvorschlag eines Reviewers (Share-Link, Review-Modus) in den
// Abschnitt übernehmen — pure Rechnung, kein Netz, kein Karten-State.
// Konsumenten: der geteilte Leisten-Kern (comment-rail-core.js) für beide
// Owner-Oberflächen (Notebook-Leseansicht + Bucheditor). Der Share-Reader
// übernimmt nie (Leser-Seite).
//
// Regeln (docs/share-link.md → „Änderungsvorschläge"):
//   - Ersetzt wird nur INNERHALB des verankerten Blocks (`data-bid`): ein
//     gleichlautender Satz in einem anderen Absatz bleibt unangetastet.
//   - Die markierte Stelle muss im Block GENAU EINMAL vorkommen. Kein Treffer
//     (Text seither geändert) und mehrere Treffer (welcher war gemeint?) sind
//     ein Abbruch, keine Wahl — der Autor entscheidet dann von Hand. Ausnahme:
//     fehlt die Stelle, steht aber der Ersatztext genau einmal im Block, ist
//     der Vorschlag schon übernommen (`alreadyApplied`) — nur Status setzen.
//   - Eingesetzt wird Klartext (`replaceInHtml` maskiert), nie Markup aus dem
//     öffentlichen Reader; eine Stelle, die einen Quellen-Chip oder Querverweis
//     umschliesst, blockt `replaceInHtml` selbst.

import { countInHtml, replaceInHtml } from '../utils.js';

/**
 * @param {string} pageHtml  aktueller Abschnitt (frisch geladen)
 * @param {{ bid: string, quote: string, replacement: string }} s
 * @returns {{ html: string } | { reason: 'blockGone'|'quoteGone'|'ambiguous'|'blocked'|'alreadyApplied' }}
 */
export function applySuggestionToHtml(pageHtml, { bid, quote, replacement }) {
  // Inertes Dokument: kein Bild lädt, kein Handler läuft (anders als ein
  // <div> im Live-Dokument), und innerHTML spiegelt jede Änderung zurück.
  const doc = document.implementation.createHTMLDocument('');
  const root = doc.body;
  root.innerHTML = String(pageHtml || '');
  let block = null;
  try { block = root.querySelector(`[data-bid="${CSS.escape(String(bid || ''))}"]`); } catch { block = null; }
  if (!block) return { reason: 'blockGone' };
  const needle = String(quote || '');
  if (!needle.trim()) return { reason: 'quoteGone' };
  const blockHtml = block.outerHTML;
  const n = countInHtml(blockHtml, needle);
  if (n === 0) {
    // Ersatztext steht schon genau einmal da (von Hand übernommen oder ein
    // früherer Versuch hat gespeichert, aber den Status nicht gesetzt): dann
    // nur den Entscheid festhalten, nichts ersetzen.
    const repl = String(replacement ?? '');
    if (repl.trim() && countInHtml(blockHtml, repl) === 1) return { reason: 'alreadyApplied' };
    return { reason: 'quoteGone' };
  }
  if (n > 1) return { reason: 'ambiguous' };
  const next = replaceInHtml(blockHtml, needle, String(replacement ?? ''));
  if (next === blockHtml) return { reason: 'blocked' };
  const holder = doc.createElement('div');
  holder.innerHTML = next;
  const fresh = holder.firstElementChild;
  if (!fresh) return { reason: 'blocked' };
  block.replaceWith(fresh);
  return { html: root.innerHTML };
}

/** i18n-Key der Abbruch-Meldung (`share.comments.suggestion.*`). */
export function suggestionReasonKey(reason) {
  return `share.comments.suggestion.${reason || 'failed'}`;
}
