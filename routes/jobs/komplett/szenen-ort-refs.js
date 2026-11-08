'use strict';
// Szene ↔ Schauplatz im Extraktions-Output: das Modell verweist per Kennung, der Server
// trägt den Namen ein.
//
// Orte und Szenen entstehen im selben Call (Pass B, Multi-Pass-Chunk) — die Szene kann
// also auf `orte[].id` derselben Antwort zeigen (`orte_refs: ["ort_3"]`). Ein Klarname
// («Küche») verfehlte den eindeutigen Ortsnamen («Küche der WG») und fiel beim Remap
// weg, sobald zwei Orte so heissen konnten. Die Gap-/Backfill-Pässe bekommen die schon
// erfassten Orte als `bek_N`-Liste und verweisen darauf.
//
// Unmittelbar nach dem Call (vor dem Cache) wird jede Kennung zum exakten Ortsnamen
// aufgelöst und als `orte_namen` gespeichert: Delta-Cache, Remap, Varianten-Aliasse und
// Konsolidierung arbeiten unverändert mit Namen, und der Name ist jetzt per Konstruktion
// derselbe wie der des Orts. Liefert ein Modell doch einen Klarnamen, bleibt er als Name
// stehen (Rettungsweg wie bisher: Remap-Rescue).

const KNOWN_PREFIX = 'bek_';
const REF_RE = /^(?:ort|bek)_\d+$/i;

const _key = (r) => String(r ?? '').trim().toLowerCase();

/** Kennungen der Orte einer Antwort: Map(id → Name). */
function answerOrtRefMap(orte) {
  const map = new Map();
  for (const o of orte || []) {
    if (o?.id && o?.name) map.set(_key(o.id), o.name);
  }
  return map;
}

/** Liste schon erfasster Orte für einen Gap-/Backfill-Prompt: Zeilen «bek_N: Name» und
 *  die Auflösung dazu. Doppelte Namen nur einmal. */
function knownOrtRefs(orte) {
  const lines = [];
  const map = new Map();
  const seen = new Set();
  for (const o of orte || []) {
    const name = typeof o === 'string' ? o : o?.name;
    if (!name || seen.has(_key(name))) continue;
    seen.add(_key(name));
    const ref = `${KNOWN_PREFIX}${lines.length + 1}`;
    lines.push(`${ref}: ${name}`);
    map.set(ref, name);
  }
  return { lines, map };
}

/** Löst `orte_refs` (und ggf. vom Modell trotzdem gelieferte `orte_namen`) jeder Szene
 *  zu `orte_namen` auf. `refMaps`: eine oder mehrere Maps (Antwort + bekannte Orte).
 *  Mutiert die Szenen; gibt die Zahl verworfener Kennungen zurück (zeigt auf keinen Ort). */
function resolveSzenenOrtRefs(szenen, ...refMaps) {
  let dropped = 0;
  for (const s of szenen || []) {
    if (!s || typeof s !== 'object') continue;
    const raw = [
      ...(Array.isArray(s.orte_refs) ? s.orte_refs : []),
      ...(Array.isArray(s.orte_namen) ? s.orte_namen : []),
    ];
    const names = [];
    const seen = new Set();
    for (const r of raw) {
      const str = typeof r === 'string' ? r.trim() : (r?.name || r?.id || '');
      if (!str) continue;
      let name = null;
      for (const m of refMaps) { if (m?.has(_key(str))) { name = m.get(_key(str)); break; } }
      if (!name) {
        if (REF_RE.test(str)) { dropped++; continue; }
        name = str;
      }
      if (seen.has(_key(name))) continue;
      seen.add(_key(name));
      names.push(name);
    }
    s.orte_namen = names;
    delete s.orte_refs;
  }
  return dropped;
}

const _norm = (k) => String(k || '').replace(/^#{1,6}\s+/, '').trim().toLowerCase();

/** Übersetzt `nach` (Nummer in der Liste, die der Gap-Prompt zeigte; 0 = vor allen
 *  Szenen des Kapitels) in einen stabilen Anker: `nach_titel` = Titel der genannten Szene,
 *  `nach_start` = Kapitelanfang. Die Nummer gilt nur für genau diese Liste — ein gecachter
 *  Gap-Treffer (Multi-Pass `:gap`) sähe im nächsten Lauf eine andere. `ordered` ist die
 *  gezeigte Liste als Objekte (bekannte, dann die neuen in Fundreihenfolge). Mutiert. */
function anchorGapSzenen(fresh, ordered) {
  for (const s of fresh || []) {
    if (!s || typeof s !== 'object' || !('nach' in s)) continue;
    const n = Number.isInteger(s.nach) ? s.nach : parseInt(s.nach, 10);
    delete s.nach;
    if (n === 0) s.nach_start = true;
    else if (n > 0 && ordered?.[n - 1]?.titel && ordered[n - 1] !== s) s.nach_titel = ordered[n - 1].titel;
  }
  return fresh;
}

/** Reiht nachgezogene Szenen an ihrem Anker ein (`anchorGapSzenen`): hinter die Szene mit
 *  `nach_titel` im selben Kapitel, an den Kapitelanfang bei `nach_start`. Mehrere neue
 *  Szenen am selben Anker behalten ihre Reihenfolge. Ohne Anker (oder Anker nicht im
 *  Kapitel) hinter die letzte Szene des Kapitels in `target`, sonst ans Ende. Die
 *  Array-Reihenfolge wird zur sort_order (remap.js#remapSzenen). Mutiert `target`. */
function placeGapSzenen(target, fresh) {
  const lastAfter = new Map(); // Anker → zuletzt dahinter eingefügte Szene
  const insertAt = (anchorKey, idx, s) => {
    const last = lastAfter.get(anchorKey);
    const at = last && target.includes(last) ? target.indexOf(last) + 1 : idx;
    target.splice(at, 0, s);
    lastAfter.set(anchorKey, s);
  };
  for (const s of fresh || []) {
    if (!s || typeof s !== 'object') continue;
    const kap = _norm(s.kapitel);
    const start = s.nach_start === true;
    const titel = s.nach_titel;
    delete s.nach_start; delete s.nach_titel; delete s.nach;
    if (start) {
      const first = target.findIndex(t => _norm(t.kapitel) === kap);
      if (first >= 0) { insertAt(`start:${kap}`, first, s); continue; }
    } else if (titel) {
      const prev = target.findIndex(t => _norm(t.kapitel) === kap && _norm(t.titel) === _norm(titel));
      if (prev >= 0) { insertAt(`nach:${kap}:${_norm(titel)}`, prev + 1, s); continue; }
    }
    let at = -1;
    for (let i = target.length - 1; i >= 0; i--) {
      if (_norm(target[i].kapitel) === kap) { at = i; break; }
    }
    if (at >= 0) target.splice(at + 1, 0, s);
    else target.push(s);
  }
  return target;
}

module.exports = { answerOrtRefMap, knownOrtRefs, resolveSzenenOrtRefs, anchorGapSzenen, placeGapSzenen, KNOWN_PREFIX };
