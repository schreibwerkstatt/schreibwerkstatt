'use strict';
// Emotionale Nähe einer Figuren-Beziehung (figure_relations.naehe): ganzzahlig
// −2 … +2, NULL = nicht eingeschätzt. Eine Stelle für die Normalisierung aller
// Schreibwege (Komplettanalyse, Katalog-PUT, Job `figuren-naehe`, Bundle-Import,
// Reihen-Übernahme) — KI-Werte kommen als Zahl, als String oder ausserhalb des
// Bereichs. Bedeutung und Standard je Typ: public/js/book/beziehung-typen.js.

const NAEHE_MIN = -2;
const NAEHE_MAX = 2;

function normNaehe(v) {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(NAEHE_MIN, Math.min(NAEHE_MAX, n));
}

module.exports = { normNaehe, NAEHE_MIN, NAEHE_MAX };
