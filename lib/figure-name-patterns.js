'use strict';
// Namensmuster einer Figur für Erwähnungs-Zählung und Kandidatensuche: Vollname und
// Kurzname (Gewicht 1), weitere Ruf-/Spitznamen aus der Analyse (figures.weitere_namen,
// Gewicht 1, nur ganz) und die Einzel-Tokens mehrteiliger Namen (Gewicht 0.5).
// Konsumenten: lib/page-index.js (Erwähnungs-Index, re-exportiert als
// buildFigureNamePatterns), Alters-Analyse, Idiolekt, Schul-/Berufsweg-Vorschlag.

// Häufige deutsche Tokens, die als einzelner Namensbestandteil zu viele
// False-Positives erzeugen (Anrede, Adelstitel etc.) — werden beim
// Token-Level-Matching übersprungen.
const FIGURE_TOKEN_BLOCKLIST = new Set([
  'herr', 'frau', 'fräulein', 'dame', 'dr', 'prof', 'professor', 'doktor',
  'von', 'zu', 'van', 'der', 'die', 'das', 'den', 'dem',
  'mr', 'mrs', 'ms', 'lord', 'lady',
]);

const { escapeRegex } = require('./regex-escape');

function _weitereNamen(raw) {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { arr = null; } }
  return Array.isArray(arr) ? arr.filter(n => typeof n === 'string' && n.trim().length >= 2) : [];
}

/** Zerlegt einen Vollnamen in matching-taugliche Tokens.
 *  Vollname ist immer ein Muster (Gewicht 1.0). Einzel-Tokens ab 3 Zeichen
 *  und nicht in der Blocklist werden zusätzlich mit Gewicht 0.5 gematcht. */
function buildFigureNamePatterns(fullName, kurzname, weitereNamen = null) {
  const patterns = [];
  const seen = new Set();
  const add = (s, weight) => {
    const t = (s || '').trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    patterns.push({ text: t, weight });
  };

  add(fullName, 1.0);
  add(kurzname, 1.0);
  // Weitere Ruf-/Spitznamen aus der Analyse (figures.weitere_namen, JSON-Array oder Array):
  // «Lotti» ist eine Nennung von Charlotte wie ihr Kurzname. Nur ganz, nicht zerlegt.
  for (const n of _weitereNamen(weitereNamen)) add(n, 1.0);
  for (const raw of [fullName, kurzname]) {
    if (!raw) continue;
    const tokens = raw.split(/\s+/);
    if (tokens.length < 2) continue;
    for (const tok of tokens) {
      if (tok.length < 3) continue;
      if (FIGURE_TOKEN_BLOCKLIST.has(tok.toLowerCase())) continue;
      add(tok, 0.5);
    }
  }
  return patterns;
}

module.exports = { FIGURE_TOKEN_BLOCKLIST, escapeRegex, buildFigureNamePatterns };
