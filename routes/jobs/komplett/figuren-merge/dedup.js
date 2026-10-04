'use strict';
// Figuren-Dedup der Komplettanalyse-Phase 2: rollierender Pre-Merge über die
// Phase-1-Chunks und zweistufiger Merge der konsolidierten Liste. Facade:
// ../figuren-merge.js.

const { normName: _normalizeName, nameTokens: _nameTokens } = require('../../../../lib/name-normalize');
const { figureEvidence } = require('../../../../lib/entity-match');

/** Mergt duplizierte Figuren anhand des normalisierten Namens (case-insensitive).
 *  Fängt Fälle ab, in denen kleine Modelle (Ollama/llama) die Dedup-Regel in
 *  Phase 2 nicht befolgen. Verschmilzt Kapitel, Eigenschaften und Beziehungen.
 *  Remappt beziehungen.figur_id auf die kanonische ID und entfernt Selbst-Referenzen.
 *  Zweistufig:
 *    Stufe 1: exakter normalisierter Name (titel-/whitespace-bereinigt).
 *    Stufe 2: Teilname-Match (ein Name ist Teilmenge des anderen) plus mind. 2 Indizien
 *             (Beruf, Geburtsjahr, gemeinsames Kapitel, gleiches Geschlecht, geteilte Beziehung).
 *             Strenger Schutz: verschiedene Vornamen mit gleichem Nachnamen («Paul Schmidt»
 *             vs. «Marta Schmidt») werden NICHT zusammengeführt.
 *  Namens-Normalisierung (_normalizeName/_nameTokens) kommt aus lib/name-normalize. */

/** Fasst zwei Figuren zu einer kanonischen Figur zusammen. `canon` wird mutiert.
 *  Gibt nichts zurück – Caller kümmert sich um idRemap. */
function _arcWeight(a) {
  if (!a || typeof a !== 'object') return 0;
  return (a.anfang ? 1 : 0) + (a.ende ? 1 : 0) + (Array.isArray(a.wendepunkte) ? a.wendepunkte.length : 0);
}

function _mergeFigurInto(canon, other) {
  for (const field of ['kurzname', 'typ', 'geburtstag', 'geschlecht', 'beruf', 'wohnadresse', 'sozialschicht',
                       'aeusseres', 'stimme', 'hintergrund',
                       'rolle', 'motivation', 'konflikt', 'entwicklung', 'erste_erwaehnung', 'praesenz']) {
    if (!canon[field] && other[field]) canon[field] = other[field];
  }
  // Arc: reichere Variante (mehr belegte Stationen) gewinnt.
  if (_arcWeight(other.arc) > _arcWeight(canon.arc)) canon.arc = other.arc;
  if (!canon.beschreibung && other.beschreibung) canon.beschreibung = other.beschreibung;
  const zit = new Set([...(canon.schluesselzitate || []), ...(other.schluesselzitate || [])]);
  canon.schluesselzitate = [...zit].slice(0, 5);
  const kapByName = new Map();
  for (const k of (canon.kapitel || [])) kapByName.set(k.name, k.haeufigkeit || 1);
  for (const k of (other.kapitel || [])) {
    kapByName.set(k.name, (kapByName.get(k.name) || 0) + (k.haeufigkeit || 1));
  }
  canon.kapitel = [...kapByName.entries()].map(([name, haeufigkeit]) => ({ name, haeufigkeit }));
  const eigSet = new Set([...(canon.eigenschaften || []), ...(other.eigenschaften || [])]);
  canon.eigenschaften = [...eigSet];
  const bzByFig = new Map();
  for (const b of (canon.beziehungen || [])) bzByFig.set(b.figur_id, b);
  for (const b of (other.beziehungen || [])) if (!bzByFig.has(b.figur_id)) bzByFig.set(b.figur_id, b);
  canon.beziehungen = [...bzByFig.values()];
}

/** Indizienpunkte für zwei Figuren. Rechnet `figureEvidence` (SSoT
 *  lib/entity-match.js, geteilt mit dem Cross-Run-Matching) auf der Analyse-Form:
 *  Kapitel liegen hier als [{ name }] vor, Beziehungen als [{ figur_id, name }].
 *  Negativ bei widersprüchlichem Geburtsjahr oder Geschlecht.
 *
 *  `relationsByName`: Beziehungs-Ziele über den angereicherten Zielnamen (`bz.name`)
 *  vergleichen statt über `figur_id`. Pflicht, sobald die beiden Figuren aus
 *  VERSCHIEDENEN Phase-1-Chunks stammen können (Pre-Merge): dort ist `figur_id`
 *  chunk-lokal, und jedes Chunk beginnt bei fig_1 — ein gemeinsames «fig_2» wäre ein
 *  Zufallstreffer, der mit +2 allein die Merge-Schwelle erreicht. Ohne Namen zählt
 *  die Beziehung dann gar nicht. */
function _relKeys(f, byName) {
  return (f.beziehungen || [])
    .map(x => (byName ? _normalizeName(x?.name) : x?.figur_id))
    .filter(Boolean);
}
function _indicatorScore(a, b, { relationsByName = false } = {}) {
  return figureEvidence(
    { ...a, chapters: (a.kapitel || []).map(k => k?.name ?? k), relations: _relKeys(a, relationsByName) },
    { ...b, chapters: (b.kapitel || []).map(k => k?.name ?? k), relations: _relKeys(b, relationsByName) },
  );
}

/** Merkt sich einen aufgegangenen Namen am Kanon (`__aliasNamen`), damit Beziehungs-
 *  Ziele (`rebindBeziehungenByName`) und Szenen/Events (`buildFigNameLookup`), die
 *  noch den alten Namen tragen, weiter auflösen. Ist noch kein `kurzname` gesetzt und
 *  der Alias kürzer (weniger Namens-Token), wird er der Kurzname. */
function _addAlias(canon, aliasName) {
  const key = _normalizeName(aliasName);
  if (!key || key === _normalizeName(canon.name)) return;
  const list = Array.isArray(canon.__aliasNamen) ? canon.__aliasNamen : [];
  if (!list.some(n => _normalizeName(n) === key)) list.push(aliasName);
  canon.__aliasNamen = list;
  if (!canon.kurzname && _nameTokens(aliasName).length < _nameTokens(canon.name).length) {
    canon.kurzname = aliasName;
  }
}

/** Trägt die Beziehungen einer entfernten Kapitel-Dublette an den Kanon (Pre-Merge).
 *  Die `figur_id` der Dublette gehört zu IHREM Chunk und bedeutet im Chunk des Kanons
 *  etwas anderes — mitgenommen wird darum nur, was einen Zielnamen trägt
 *  (`annotateBeziehungenNames`), und zwar mit `figur_id: null`: der Konsolidierungs-
 *  Prompt zeigt dann den Namen, der Fallback bindet über `rebindBeziehungenByName`.
 *  Dedup über den Zielnamen; Selbst-Bezüge fallen weg. */
function _carryRelations(canon, other) {
  const have = new Set();
  for (const b of (canon.beziehungen || [])) {
    const k = _normalizeName(b?.name);
    if (k) have.add(k);
  }
  const self = new Set([_normalizeName(canon.name), _normalizeName(other.name)]);
  const add = [];
  for (const b of (other.beziehungen || [])) {
    const k = _normalizeName(b?.name);
    if (!k || have.has(k) || self.has(k)) continue;
    have.add(k);
    add.push({ ...b, figur_id: null });
  }
  if (add.length) canon.beziehungen = [...(canon.beziehungen || []), ...add];
}

/** Stufe 2: Teilnamens-Fusion. Nur wenn ein Name Teilmenge des anderen ist
 *  (nach Token-Normalisierung) UND die Indizien ≥ 2 sind. Verschiedene Vornamen mit
 *  gleichem Nachnamen → disjunkte Tokens → keine Fusion.
 *
 *  **Mehrdeutiger Kurzname fusioniert nicht:** passt «Anna» als Teilmenge zu zwei
 *  Vollnamen, die einander NICHT enthalten («Anna Weber», «Anna Schmid»), ist offen,
 *  wen sie meint — sie bleibt eigenständig (gleiche Haltung wie das Cross-Run-
 *  Matching: Ambiguität ⇒ kein Merge). Sonst verschmölze der Kurzname transitiv zwei
 *  verschiedene Personen.
 *
 *  Gruppen über Union-Find, Indizien paarweise auf den Ausgangsfiguren (nicht auf dem
 *  wachsenden Kanon) → das Ergebnis hängt nicht von der Array-Reihenfolge ab. Kanon
 *  ist der vollste Name (meiste Token), dann die längere Beschreibung, dann die erste
 *  Position; aufgegangene Namen bleiben als Alias/Kurzname erhalten. */
function _mergeByPartialName(figuren, idRemap) {
  const n = figuren.length;
  const tokens = figuren.map(f => _nameTokens(f.name));
  const isSub = (a, b) => a.length > 0 && a.every(t => b.includes(t));
  const strictSub = (i, j) => isSub(tokens[i], tokens[j]) && !isSub(tokens[j], tokens[i]);

  // Mehrdeutige Kurznamen: echte Teilmenge von ≥ 2 untereinander unverträglichen Namen.
  const ambiguous = new Set();
  for (let s = 0; s < n; s++) {
    if (!tokens[s].length) continue;
    const supers = [];
    for (let j = 0; j < n; j++) if (j !== s && strictSub(s, j)) supers.push(j);
    outer: for (let a = 0; a < supers.length; a++) {
      for (let b = a + 1; b < supers.length; b++) {
        const p = supers[a], q = supers[b];
        if (!isSub(tokens[p], tokens[q]) && !isSub(tokens[q], tokens[p])) { ambiguous.add(s); break outer; }
      }
    }
  }

  const parent = figuren.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) {
    if (!tokens[i].length) continue;
    for (let j = i + 1; j < n; j++) {
      if (!tokens[j].length) continue;
      const iInJ = isSub(tokens[i], tokens[j]);
      const jInI = isSub(tokens[j], tokens[i]);
      if (!iInJ && !jInI) continue;
      // Der kürzere Partner einer echten Teilmenge darf nicht mehrdeutig sein.
      if (iInJ && !jInI && ambiguous.has(i)) continue;
      if (jInI && !iInJ && ambiguous.has(j)) continue;
      if (_indicatorScore(figuren[i], figuren[j]) < 2) continue;
      const ri = find(i), rj = find(j);
      if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
    }
  }

  const groups = new Map(); // root → [indices] (aufsteigend)
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const merged = [];
  for (const idxs of [...groups.values()].sort((a, b) => a[0] - b[0])) {
    if (idxs.length === 1) { merged.push(figuren[idxs[0]]); continue; }
    const canonIdx = [...idxs].sort((a, b) =>
      (tokens[b].length - tokens[a].length)
      || ((figuren[b].beschreibung?.length || 0) - (figuren[a].beschreibung?.length || 0))
      || (a - b))[0];
    const canon = { ...figuren[canonIdx] };
    for (const i of idxs) {
      if (i === canonIdx) continue;
      const other = figuren[i];
      idRemap[other.id] = canon.id;
      _mergeFigurInto(canon, other);
      _addAlias(canon, other.name);
      for (const a of (other.__aliasNamen || [])) _addAlias(canon, a);
    }
    merged.push(canon);
  }
  return merged;
}

/** Rollierender Dedup VOR Phase 2: geht chapterFiguren in Reihenfolge durch,
 *  baut eine kanonische Map (normalisierter Name → Figur) auf und entfernt
 *  Duplikate aus folgenden Kapiteln. Kapitel-Einträge werden aggregiert,
 *  Eigenschaften verschmolzen. Die Beziehungen der Dublette wandern über ihren
 *  Zielnamen an den Kanon (`_carryRelations`) — eine Beziehung, die erst in einem
 *  späteren Kapitel entsteht, steht nur in der Dublette. Läuft darum NACH
 *  `annotateBeziehungenNames`. Bei einem Teilnamen-Treffer wird der vollere Name
 *  Kanon, der kürzere Alias. Liefert Kopien; die Eingabe bleibt unverändert.
 *  Reduziert die Eingabegrösse für den Phase-2-Konsolidierungs-Call und fängt
 *  Fälle ab, in denen Phase 2 trotz Hinweis Duplikate stehen lässt. */
function preMergeChapterFiguren(chapterFiguren) {
  const canonical = new Map();
  const canonicalList = [];
  const merged = chapterFiguren.map(c => ({ kapitel: c.kapitel, figuren: [] }));
  let dupesRemoved = 0;

  for (let ci = 0; ci < chapterFiguren.length; ci++) {
    for (const f of (chapterFiguren[ci].figuren || [])) {
      const key = _normalizeName(f.name);
      if (!key) continue;
      let canon = canonical.get(key);
      let partial = false;

      if (!canon) {
        const tokA = _nameTokens(f.name);
        if (tokA.length) {
          for (const entry of canonicalList) {
            const tokB = _nameTokens(entry.figur.name);
            if (!tokB.length) continue;
            const aInB = tokA.every(t => tokB.includes(t));
            const bInA = tokB.every(t => tokA.includes(t));
            if (!aInB && !bInA) continue;
            // Beziehungen über Zielnamen: `figur_id` ist chunk-lokal (siehe _indicatorScore).
            if (_indicatorScore(entry.figur, f, { relationsByName: true }) >= 2) {
              canon = entry.figur; partial = true; break;
            }
          }
        }
      }

      if (canon) {
        for (const field of ['kurzname', 'typ', 'geburtstag', 'geschlecht', 'beruf', 'wohnadresse', 'sozialschicht',
                             'aeusseres', 'stimme', 'hintergrund',
                             'rolle', 'motivation', 'konflikt', 'entwicklung', 'erste_erwaehnung', 'praesenz',
                             'beschreibung']) {
          if (!canon[field] && f[field]) canon[field] = f[field];
        }
        if (_arcWeight(f.arc) > _arcWeight(canon.arc)) canon.arc = f.arc;
        const zit = new Set([...(canon.schluesselzitate || []), ...(f.schluesselzitate || [])]);
        canon.schluesselzitate = [...zit].slice(0, 5);
        const eig = new Set([...(canon.eigenschaften || []), ...(f.eigenschaften || [])]);
        canon.eigenschaften = [...eig];
        const kapByName = new Map();
        for (const k of (canon.kapitel || [])) kapByName.set(k.name, k.haeufigkeit || 1);
        for (const k of (f.kapitel || [])) {
          kapByName.set(k.name, (kapByName.get(k.name) || 0) + (k.haeufigkeit || 1));
        }
        canon.kapitel = [...kapByName.entries()].map(([name, haeufigkeit]) => ({ name, haeufigkeit }));
        _carryRelations(canon, f);
        if (partial) {
          // Der vollere Name wird Kanon; der kürzere bleibt als Alias/Kurzname.
          if (_nameTokens(f.name).length > _nameTokens(canon.name).length) {
            const alt = canon.name;
            canon.name = f.name;
            canonical.set(key, canon);
            _addAlias(canon, alt);
          } else {
            _addAlias(canon, f.name);
          }
        }
        dupesRemoved++;
      } else {
        // Kopie: der Pre-Merge reichert den Kanon an (Felder, Beziehungen, Name) —
        // die rohen Phase-1-Daten bleiben für Mode-Vote und Namens-Lookup unverändert.
        const copy = { ...f };
        merged[ci].figuren.push(copy);
        canonical.set(key, copy);
        canonicalList.push({ normKey: key, figur: copy });
      }
    }
  }

  return { chapterFiguren: merged, dupesRemoved };
}

function mergeDuplicateFiguren(figuren) {
  const groups = new Map();
  for (const f of figuren) {
    const key = _normalizeName(f.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const idRemap = {};
  let stage1 = [];
  // Figuren ohne verwertbaren Namen bleiben unverändert stehen (nicht still verwerfen).
  for (const f of figuren) if (!_normalizeName(f.name)) stage1.push(f);
  for (const group of groups.values()) {
    if (group.length === 1) { stage1.push(group[0]); continue; }
    group.sort((a, b) => (b.beschreibung?.length || 0) - (a.beschreibung?.length || 0));
    const canon = { ...group[0] };
    for (const other of group.slice(1)) {
      idRemap[other.id] = canon.id;
      _mergeFigurInto(canon, other);
    }
    stage1.push(canon);
  }
  const stage1Saved = figuren.length - stage1.length;

  const stage2 = _mergeByPartialName(stage1, idRemap);
  const stage2Saved = stage1.length - stage2.length;

  // Ketten auflösen: Stufe 1 bildet fig_7 → fig_3 ab, Stufe 2 danach fig_3 → fig_1.
  // Ein einstufiger Lookup landete auf fig_3, das es nicht mehr gibt — die Kante fiele.
  const resolve = (id) => {
    let cur = id;
    const seen = new Set();
    while (cur != null && idRemap[cur] != null && !seen.has(cur)) { seen.add(cur); cur = idRemap[cur]; }
    return cur;
  };
  for (const k of Object.keys(idRemap)) idRemap[k] = resolve(k);

  const validIds = new Set(stage2.map(f => f.id));
  for (const f of stage2) {
    const seen = new Map();
    for (const b of (f.beziehungen || [])) {
      const mappedId = resolve(b.figur_id);
      if (mappedId === f.id || !validIds.has(mappedId)) continue;
      if (!seen.has(mappedId)) seen.set(mappedId, { ...b, figur_id: mappedId });
    }
    f.beziehungen = [...seen.values()];
  }

  return { figuren: stage2, mergedCount: stage1Saved + stage2Saved, stage1Saved, stage2Saved, idRemap };
}

module.exports = { preMergeChapterFiguren, mergeDuplicateFiguren };
