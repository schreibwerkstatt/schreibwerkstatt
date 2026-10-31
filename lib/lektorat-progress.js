'use strict';
// Fortschritt eines Abschnitts seit dem vorherigen Lektorat — deterministischer
// Vergleich zweier Läufe, keine KI. Beantwortet „was habe ich seither behoben,
// was ist geblieben, was ist neu" (Abschnitts-Lektorat, docs/lektorat.md).
//
//   fixed       → Befunde des Vorlaufs, deren `original` nicht mehr im Text
//                 steht. Nur der Text entscheidet, nicht das Modell: was nicht
//                 mehr dasteht, ist umgeschrieben (`viaApply` = davon per
//                 Übernahme aus dem Vorlauf eingearbeitet).
//   remaining   → Befunde des aktuellen Laufs, die schon der Vorlauf meldete
//   added       → Befunde des aktuellen Laufs ohne Gegenstück im Vorlauf
//   notReported → Befunde des Vorlaufs, deren Stelle unverändert dasteht, die der
//                 aktuelle Lauf aber nicht mehr meldet — Modell-Streuung oder
//                 geänderter Kontext, ausdrücklich KEINE Verbesserung
//
// Abgleich per `original` als Multimenge in der Normalform `norm` — der Job
// reicht die der Fundstellen-Suche herein (public/js/utils/text-match.js#
// normalizeMatchText: Whitespace kollabiert, Anführungszeichen gefaltet), damit
// eine Stelle, die das Modell mit anderen Anführungszeichen zitiert, nicht als
// „behoben" zählt, solange das Frontend sie im Text findet (Default: nur
// Whitespace). Ein Befund des Vorlaufs deckt genau einen gleichlautenden des
// aktuellen Laufs. Befunde
// ohne `original` lassen sich nicht abgleichen: im aktuellen Lauf zählen sie als
// neu, im Vorlauf werden sie übergangen.

const { parseFindings } = require('./lektorat-findings');

const _wsNorm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** @param prev   Vorlauf: { checked_at, errors_json, applied_errors_json? } oder null
 *  @param fehler Befunde des aktuellen Laufs
 *  @param text   geprüfter Abschnittstext
 *  @param norm   Normalform für `original` und Text (Default: Whitespace)
 *  @returns null ohne Vorlauf, sonst { prevCheckedAt, prevCount, count, fixed,
 *           viaApply, remaining, added, notReported, byType, fixedItems } */
function lektoratProgress(prev, fehler, text, norm = _wsNorm) {
  if (!prev) return null;
  const _norm = (s) => norm(String(s || ''));
  const before = parseFindings(prev.errors_json);
  const now = Array.isArray(fehler) ? fehler : [];
  const hay = _norm(text);
  const applied = new Set(parseFindings(prev.applied_errors_json).map(e => _norm(e?.original)).filter(Boolean));

  // Noch nicht verbrauchte Vorlauf-Befunde je normalisiertem `original`.
  const pool = new Map();
  for (const e of before) {
    const k = _norm(e?.original);
    if (!k) continue;
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(e);
  }

  let remaining = 0, added = 0;
  for (const e of now) {
    const k = _norm(e?.original);
    const left = k ? pool.get(k) : null;
    if (left?.length) { left.shift(); remaining++; } else added++;
  }

  let notReported = 0, viaApply = 0;
  const fixedItems = [];
  for (const [k, left] of pool) {
    for (const e of left) {
      if (hay.includes(k)) { notReported++; continue; }
      if (applied.has(k)) viaApply++;
      fixedItems.push({ typ: e.typ || null, original: e.original, korrektur: e.korrektur || null });
    }
  }

  // Veränderung je Fehlertyp über alle Befunde beider Läufe; nur Typen mit Delta.
  const counts = new Map();
  const bump = (typ, d) => counts.set(typ, (counts.get(typ) || 0) + d);
  for (const e of before) if (e?.typ) bump(e.typ, -1);
  for (const e of now) if (e?.typ) bump(e.typ, +1);
  const byType = [...counts]
    .filter(([, d]) => d !== 0)
    .map(([typ, delta]) => ({ typ, delta }))
    .sort((a, b) => a.delta - b.delta || a.typ.localeCompare(b.typ));

  return {
    prevCheckedAt: prev.checked_at || null,
    prevCount: before.length,
    count: now.length,
    fixed: fixedItems.length, viaApply, remaining, added, notReported,
    byType, fixedItems,
  };
}

// Befunde, die der Autor im Vorlauf bewusst stehen liess: aus dem Vorlauf wurde
// übernommen (`applied_errors_json` gesetzt), dieser Befund aber nicht, und seine
// Stelle steht unverändert im Text. Meldet der aktuelle Lauf dieselbe Stelle mit
// demselben Typ wieder, trägt der Befund `abgelehnt: true` — das Frontend wählt
// ihn nicht vor und zeigt «früher abgelehnt». Ohne Übernahme im Vorlauf ist
// nichts entschieden (der Autor kann die Liste nur geschlossen haben): dann
// bleibt alles unmarkiert. Transient — steht nur im Job-Ergebnis, nicht in
// `page_checks.errors_json`.
function markPreviouslyRejected(prev, fehler, text, norm = _wsNorm) {
  if (!Array.isArray(fehler) || !prev?.applied_errors_json) return fehler;
  const _norm = (s) => norm(String(s || ''));
  const applied = parseFindings(prev.applied_errors_json);
  if (!applied.length) return fehler;
  const appliedKeys = new Set(applied.map(e => _norm(e?.original)));
  const hay = _norm(text);
  const rejected = new Set();
  for (const e of parseFindings(prev.errors_json)) {
    const k = _norm(e?.original);
    if (!k || appliedKeys.has(k) || !hay.includes(k)) continue;
    rejected.add(`${e.typ || ''}|${k}`);
  }
  if (!rejected.size) return fehler;
  return fehler.map(f => (f?.original && rejected.has(`${f.typ || ''}|${_norm(f.original)}`) ? { ...f, abgelehnt: true } : f));
}

module.exports = { lektoratProgress, markPreviouslyRejected };
