'use strict';
// Feld-Mechanik beim Verschmelzen zweier Einträge derselben Entität (Figur, Ort, Song)
// in der Komplettanalyse. Hier steht nur, WIE zwei Einträge zusammengehen — OB sie
// dieselbe Entität sind, entscheidet jede Gattung selbst (Figuren über Indizien,
// Orte über scoreLocationPair, Songs über Titel+Interpret). Pure, ohne Abhängigkeiten.

const kapName = k => (typeof k === 'object' && k ? k.name : k);
const copyKap = k => (typeof k === 'object' && k ? { ...k } : k);

/** Vereinigt die Kapitel-Liste `src` in `target.kapitel` (in place). Kapitel als String
 *  oder { name, haeufigkeit }; übernommene Einträge werden kopiert (`src` sind meist
 *  Rohdaten der Extraktion).
 *
 *  Häufigkeit je Kapitel:
 *    * `sum: false` (Default) — der höhere Wert. Für Varianten DERSELBEN Nennungen:
 *      zwei Schreibweisen einer Figur oder eines Orts im selben Text zählen dieselben
 *      Abschnitte, eine Summe zählte sie doppelt.
 *    * `sum: true` — die Summe. Nur über Phase-1-Chunks hinweg: ein grosses Kapitel ist
 *      auf mehrere Chunks gleichen Namens verteilt, jeder zählt nur seine Abschnitte.
 *  `fallback`: Häufigkeit eines Eintrags ohne Zahl (Figuren zählen ihn als 1, Orte/Songs
 *  als 0). Ein verschmolzener Eintrag trägt danach eine Zahl, sofern eine Seite eine hatte. */
function unionKapitel(target, src, { sum = false, fallback = 0 } = {}) {
  if (!Array.isArray(target.kapitel)) target.kapitel = [];
  const count = k => Number(k?.haeufigkeit) || fallback;
  for (const kap of (src || [])) {
    const name = kapName(kap);
    if (!name) continue;
    const i = target.kapitel.findIndex(x => kapName(x) === name);
    if (i < 0) { target.kapitel.push(copyKap(kap)); continue; }
    const hit = target.kapitel[i];
    if (typeof kap !== 'object' || !kap) continue;
    const a = typeof hit === 'object' && hit ? count(hit) : fallback;
    const b = count(kap);
    const next = sum ? a + b : Math.max(a, b);
    // Keine Zahl auf beiden Seiten: nichts erfinden, der Eintrag bleibt, wie er ist.
    if (!next) continue;
    target.kapitel[i] = { ...(typeof hit === 'object' && hit ? hit : { name }), haeufigkeit: next };
  }
  return target;
}

/** Füllt leere Felder von `target` aus `src` (in place); belegte bleiben unverändert. */
function fillEmpty(target, src, fields) {
  for (const f of fields) {
    if (!target[f] && src?.[f]) target[f] = src[f];
  }
  return target;
}

/** Quell-Einträge, die eine KI-Konsolidierung weder übernommen noch zusammengeführt hat.
 *  `sources`: Liste von { kapitel, <listKey>: [...] } (Phase-1-Form). `isCovered(e)`
 *  entscheidet je Gattung. Jeder Schlüssel (`keyOf`) höchstens einmal, in Eingabe-
 *  reihenfolge; Einträge ohne Schlüssel fallen weg. Liefert die Quell-Einträge selbst. */
function findOmitted(sources, listKey, { keyOf, isCovered }) {
  const out = [];
  const seen = new Set();
  for (const src of (sources || [])) {
    for (const e of (src?.[listKey] || [])) {
      const k = keyOf(e);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      if (!isCovered(e)) out.push(e);
    }
  }
  return out;
}

/** Schränkt die Phase-1-Quellen auf die Einträge ein, deren Schlüssel in `keys` liegt —
 *  Eingabe für den regelbasierten Fallback-Merge, der dann nur die weggelassenen baut. */
function filterSources(sources, listKey, keyOf, keys) {
  return (sources || []).map(src => ({
    ...src,
    [listKey]: (src?.[listKey] || []).filter(e => keys.has(keyOf(e))),
  }));
}

module.exports = { unionKapitel, fillEmpty, findOmitted, filterSources, copyKap, kapName };
