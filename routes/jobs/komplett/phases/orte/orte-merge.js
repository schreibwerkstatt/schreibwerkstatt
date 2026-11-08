'use strict';
// Pure Orte-Merges der Phase 3: regelbasierter Fallback, Rückholen weggelassener Orte,
// Alias- und Namens-Lookups für die Szenen. Ohne DB, ohne KI. Aufrufer: ../orte.js.
const { _remapFigNames } = require('../../utils');
const { scoreLocationPair, SAME } = require('../../../../../lib/entity-match');
const { unionKapitel, fillEmpty, copyKap, findOmitted, filterSources } = require('../../../../../lib/entity-match/merge-fields');

/** Regelbasierter Orte-Merge als Fallback, wenn die KI-Konsolidierung scheitert (z.B.
 *  aiTruncated bei kleinem lokalem Modell). Flattet chapterOrte über alle Kapitel, dedupliziert
 *  nach Name + Katalog-Anker (case-insensitive; figuren-Refs und Kapitel vereinigt, leere
 *  Felder aus späteren Vorkommen gefüllt) und löst figuren_namen gegen die kanonische
 *  Figurenliste zu fig_ids auf – analog Single-Pass.
 *  Ohne Kapitel-Union behielte ein Ort, der in mehreren Kapiteln vorkommt, nur das erste. */
function buildFallbackOrte(chapterOrte, figNameToId, figNameToIdLower) {
  const nameKey = o => (o.name || '').trim().toLowerCase();
  const anchorOf = o => (o.katalog_id ? String(o.katalog_id) : '');
  // Schlüssel = Name + Katalog-Anker: zwei Orte mit verschiedener katalog_id sind zwei
  // Orte, auch bei gleichem Namen (ORTE_RULES, dieselbe Haltung wie der Varianten-Dedup).
  const keyOf = o => `${nameKey(o)}\u0000${anchorOf(o)}`;
  const fresh = o => ({
    ...o,
    figuren: [...new Set(_remapFigNames(o.figuren_namen, figNameToId, figNameToIdLower))],
    figuren_namen: [...(o.figuren_namen || [])],
    // Kapitel-Array kopieren: der Merge erweitert es, chapterOrte bleibt roh.
    kapitel: (o.kapitel || []).map(copyKap),
  });
  const merge = (ex, o, opts) => {
    ex.figuren = [...new Set([...ex.figuren, ...(o.figuren || [])])];
    // Klarnamen mitvereinigen: der Varianten-Dedup danach löst `figuren` daraus neu auf.
    ex.figuren_namen = [...new Set([...ex.figuren_namen, ...(o.figuren_namen || [])])];
    unionKapitel(ex, o.kapitel, opts);
    fillEmpty(ex, o, ['katalog_id', 'beschreibung', 'typ', 'land', 'stimmung', 'erste_erwaehnung']);
  };
  // Erst je Chunk (Häufigkeit = Maximum: das Modell nennt denselben Ort mitunter
  // zweimal), dann über die Chunks (Summe: ein grosses Kapitel ist auf mehrere Chunks
  // gleichen Namens verteilt, jeder zählt nur seine eigenen Abschnitte).
  const byKey = new Map();
  for (const ch of (chapterOrte || [])) {
    const local = new Map();
    for (const o of (ch.orte || [])) {
      if (!nameKey(o)) continue;
      const k = keyOf(o);
      if (!local.has(k)) local.set(k, fresh(o));
      else merge(local.get(k), fresh(o), { sum: false });
    }
    for (const [k, o] of local) {
      if (!byKey.has(k)) byKey.set(k, o);
      else merge(byKey.get(k), o, { sum: true });
    }
  }
  // Ein Eintrag ohne Anker geht im einzigen gleichnamigen mit Anker auf; gibt es mehrere
  // verankerte (zwei Katalog-Orte gleichen Namens), bleibt er getrennt — welcher gemeint
  // ist, entscheidet dann der Abgleich, nicht ein Raten hier.
  const byName = new Map();
  for (const k of byKey.keys()) {
    const n = nameKey(byKey.get(k));
    (byName.get(n) ?? byName.set(n, []).get(n)).push(k);
  }
  for (const keys of byName.values()) {
    const anchored = keys.filter(k => anchorOf(byKey.get(k)));
    if (anchored.length !== 1) continue;
    for (const k of keys) {
      if (k === anchored[0]) continue;
      // Maximum, nicht Summe: beide können dieselben Nennungen eines Chunks zählen.
      merge(byKey.get(anchored[0]), byKey.get(k), { sum: false });
      byKey.delete(k);
    }
  }
  // loc_id IMMER sequenziell neu vergeben: die kapitelweise extrahierten Orte tragen
  // pro Kapitel neu startende ids (ort_1, ort_2, …), nach dem Flatten kollidieren also
  // verschiedene Namen auf derselben id → UNIQUE(book_id, loc_id, user_email) in
  // saveOrteToDb. Das run-interne Text-Handle ist frei wählbar (ortNameToId wird daraus
  // gebaut, downstream zählt die DB-id), darum hier kollisionsfrei durchnummerieren.
  return [...byKey.values()].map((o, i) => ({ ...o, id: 'ort_' + (i + 1) }));
}

/** Liest `quellnamen` aus der KI-Konsolidierung der Orte (in place entfernt) und holt
 *  Kapitel-Orte zurück, die das Modell weder übernommen noch zusammengeführt hat.
 *  Abgedeckt ist ein Kapitel-Ort, wenn sein Name (case-insensitive) als Name oder
 *  Quellname eines Ausgabe-Orts steht, sein Katalog-Anker in der Ausgabe vorkommt oder
 *  er nach der Verdikt-Schicht (SAME) zu einem Ausgabe-Ort passt. Ohne `quellnamen` wäre
 *  ein absichtlich aufgegangenes Synonym («die Burg» → «Festung Hohenstein») von einem
 *  vergessenen Ort nicht zu unterscheiden. Die zurückgeholten Orte baut derselbe
 *  regelbasierte Merge wie der Fallback.
 *  Liefert { restored, quellOf }: quellOf = Kapitelname (lowercase) → Name des
 *  Ausgabe-Orts, in den er laut Modell aufgegangen ist (eindeutig, sonst fehlt er). */
function restoreOmittedOrte(kiOrte, chapterOrte, figNameToId, figNameToIdLower) {
  const lc = v => String(v || '').trim().toLowerCase();
  const covered = new Set();
  const anchors = new Set();
  const quellOf = new Map();
  const ambiguous = new Set();
  for (const o of (kiOrte || [])) {
    if (!o) continue;
    if (lc(o.name)) covered.add(lc(o.name));
    if (o.katalog_id) anchors.add(String(o.katalog_id));
    for (const q of (Array.isArray(o.quellnamen) ? o.quellnamen : [])) {
      const k = lc(q);
      if (!k || k === lc(o.name)) continue;
      covered.add(k);
      if (quellOf.has(k) && quellOf.get(k) !== o.name) ambiguous.add(k);
      else quellOf.set(k, o.name);
    }
    delete o.quellnamen;
  }
  for (const k of ambiguous) quellOf.delete(k);
  const omitted = findOmitted(chapterOrte, 'orte', {
    keyOf: o => lc(o?.name),
    isCovered: o => covered.has(lc(o.name))
      || (o.katalog_id && anchors.has(String(o.katalog_id)))
      || (kiOrte || []).some(k => k && scoreLocationPair({ name: o.name, typ: o.typ }, { name: k.name, typ: k.typ }).verdict === SAME),
  });
  if (!omitted.length) return { restored: [], quellOf };
  const keys = new Set(omitted.map(o => lc(o.name)));
  const restored = buildFallbackOrte(filterSources(chapterOrte, 'orte', o => lc(o?.name), keys), figNameToId, figNameToIdLower);
  return { restored, quellOf };
}

/** Name → loc_id-Lookup für remapSzenen. Erst die Namen der Orte selbst, danach die
 *  aufgegangenen Varianten (`aliasesByIdx[i]` = Namen, die in orte[i] verschmolzen sind)
 *  — ein Alias überschreibt nie einen echten Ortsnamen. */
function buildOrtNameLookup(orte, aliasesByIdx = []) {
  const ortNameToId = {}, ortNameToIdLower = {};
  for (const o of orte) {
    if (!o?.name) continue;
    ortNameToId[o.name] = o.id;
    ortNameToIdLower[o.name.toLowerCase()] = o.id;
  }
  orte.forEach((o, i) => {
    for (const alias of (aliasesByIdx[i] || [])) {
      if (!alias) continue;
      if (!(alias in ortNameToId)) ortNameToId[alias] = o.id;
      const lk = alias.toLowerCase();
      if (!(lk in ortNameToIdLower)) ortNameToIdLower[lk] = o.id;
    }
  });
  return { ortNameToId, ortNameToIdLower };
}

/** Multi-Pass: welche Kapitel-Ortsnamen hat die Konsolidierung in einen anders benannten
 *  Ort aufgehen lassen? Zuerst die `quellnamen` des Modells (`quellOf`: Kapitelname →
 *  Name des Ausgabe-Orts; der Ausgabe-Ort kann im Varianten-Dedup selbst aufgegangen
 *  sein, darum über Name UND `dedupAliases` gesucht) — nur so werden reine Synonyme
 *  («die Burg» → «Festung Hohenstein») auflösbar. Ohne Quellnamen deterministisch über
 *  dieselbe Verdikt-Schicht wie der Within-Run-Dedup: Alias genau des EINEN Orts mit
 *  Verdikt SAME. Mehrdeutig oder ohne Treffer → kein Alias (die Szene verliert dann den
 *  Link, statt falsch verknüpft zu werden). */
function ortAliasesFromSources(orte, chapterOrte, quellOf = new Map(), dedupAliases = []) {
  const lc = v => String(v || '').trim().toLowerCase();
  const aliases = orte.map(() => []);
  const known = new Set(orte.map(o => lc(o?.name)).filter(Boolean));
  const idxByName = new Map();
  orte.forEach((o, i) => {
    for (const n of [o?.name, ...(dedupAliases[i] || [])]) {
      const k = lc(n);
      if (k && !idxByName.has(k)) idxByName.set(k, i);
    }
  });
  const seen = new Set();
  for (const ch of (chapterOrte || [])) {
    for (const src of (ch.orte || [])) {
      const name = String(src?.name || '').trim();
      const lk = name.toLowerCase();
      if (!name || known.has(lk) || seen.has(lk)) continue;
      seen.add(lk);
      const viaQuelle = quellOf.has(lk) ? idxByName.get(lc(quellOf.get(lk))) : undefined;
      if (viaQuelle !== undefined) { aliases[viaQuelle].push(name); continue; }
      const hits = [];
      orte.forEach((o, i) => {
        if (scoreLocationPair({ name, typ: src.typ }, { name: o.name, typ: o.typ }).verdict === SAME) hits.push(i);
      });
      if (hits.length === 1) aliases[hits[0]].push(name);
    }
  }
  return aliases;
}

module.exports = { buildFallbackOrte, restoreOmittedOrte, buildOrtNameLookup, ortAliasesFromSources };
