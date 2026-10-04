'use strict';
// Within-Run-Dedup der Komplettanalyse: Varianten desselben Orts bzw. derselben Szene
// INNERHALB eines Laufs zusammenführen. Teil von lib/entity-match.js (Facade, die diese
// Funktionen re-exportiert); die Paar-Verdikte kommen von dort.
//
// Die Facade wird erst beim Aufruf geladen (nicht beim require dieses Moduls): sie
// selbst lädt dieses Modul beim Start, ein Top-Level-require wäre zirkulär.
function _em() { return require('../entity-match'); }
function _pageOf(s) { return s.pageId ?? s.page_id ?? null; }

// Verschmilzt Varianten desselben Orts INNERHALB eines Laufs (die Completeness-Gap-
// Pässe ziehen Schreibvarianten nach). Konservativ: nur bei Verdikt SAME — ein
// Within-Run-Merge verliert einen Eintrag wirklich. Union von figuren/kapitel; die
// reichste beschreibung/stimmung gewinnt. Gibt { orte, unsure, aliases } zurück: die
// unsicheren Paare gehen an den Judge, statt still als Dublette zu bleiben; `aliases[i]`
// sind die Namen, die in orte[i] aufgegangen sind (der kürzere Name verliert, Szenen
// tragen ihn aber noch — phases/orte.js#buildOrtNameLookup macht ihn auflösbar).
function dedupeLocationsWithinRun(orte) {
  const { scoreLocationPair, SAME, UNSURE } = _em();
  const kept = [];
  const aliases = [];
  const unsure = [];
  const addAlias = (i, name) => {
    if (!name || name === kept[i].name || aliases[i].includes(name)) return;
    aliases[i].push(name);
  };
  for (const o of (orte || [])) {
    let ti = -1;
    for (let i = 0; i < kept.length; i++) {
      const r = scoreLocationPair(kept[i], o);
      if (r.verdict === SAME) { ti = i; break; }
      if (r.verdict === UNSURE) unsure.push({ a: kept[i].name, b: o.name, sim: r.sim, evidence: r.evidence });
    }
    if (ti < 0) { kept.push({ ...o }); aliases.push([]); continue; }
    const target = kept[ti];
    const figs = new Set([...(target.figuren_namen || []), ...(o.figuren_namen || [])]);
    target.figuren_namen = [...figs];
    const kap = new Map();
    for (const src of [target.kapitel, o.kapitel]) {
      for (const k of (src || [])) {
        const name = typeof k === 'object' && k ? k.name : k;
        if (name && !kap.has(name)) kap.set(name, k);
      }
    }
    if (kap.size) target.kapitel = [...kap.values()];
    if ((o.beschreibung || '').length > (target.beschreibung || '').length) target.beschreibung = o.beschreibung;
    if (!target.stimmung && o.stimmung) target.stimmung = o.stimmung;
    // Längeren, spezifischeren Namen bevorzugen (mehr Qualifizierer).
    if (String(o.name || '').length > String(target.name || '').length) {
      const prev = target.name;
      target.name = o.name;
      aliases[ti] = aliases[ti].filter(n => n !== o.name);
      addAlias(ti, prev);
    } else {
      addAlias(ti, o.name);
    }
  }
  return { orte: kept, unsure, aliases };
}

// Within-Run-Dedup Szenen. Bisher gab es hier NUR den exakten `titel|kapitel`-
// Schlüssel im Gap-Pass — zwei Titel-Varianten derselben Szene aus zwei Pässen
// landeten als zwei Szenen und beim nächsten Lauf als stale-Dublette. Konservativ
// (Verdikt SAME, also Kapitel gleich + Titel-Teilmenge bzw. Indizien); der reichere
// Eintrag (Kommentar/Wertung/Figuren) gewinnt.
//
// Läuft in zwei Formen: roh (Klarnamen `figuren_namen`/`orte_namen`) und — in
// remap.js#resolveSzenenForSave — bereits aufgelöst (`fig_ids`/`ort_ids`, `pageId`).
// Indizien lesen, was da ist; der Merge vereinigt BEIDE Formen, sonst fielen die
// Verknüpfungen der aufgegangenen Szene still weg. `seite` und `pageId` wandern nur
// gemeinsam, sonst zeigte der Titel einer Seite auf die id einer anderen.
function _sceneMatchView(s) {
  return {
    ...s,
    figures: s.figures ?? s.fig_ids ?? s.figuren_namen,
    locations: s.locations ?? s.ort_ids ?? s.orte_namen,
  };
}
function _unionInto(target, src, field) {
  if (!Array.isArray(target[field]) && !Array.isArray(src[field])) return;
  const set = new Set([...(target[field] || []), ...(src[field] || [])]);
  target[field] = [...set];
}
function dedupeScenesWithinRun(szenen) {
  const { scoreScenePair, SAME, UNSURE } = _em();
  const kept = [];
  const views = [];
  const unsure = [];
  for (const s of (szenen || [])) {
    const sv = _sceneMatchView(s);
    let ti = -1;
    for (let i = 0; i < kept.length; i++) {
      const r = scoreScenePair(views[i], sv);
      if (r.verdict === SAME) { ti = i; break; }
      if (r.verdict === UNSURE) unsure.push({ a: kept[i].titel, b: s.titel, sim: r.sim, evidence: r.evidence });
    }
    if (ti < 0) { kept.push({ ...s }); views.push(sv); continue; }
    const target = kept[ti];
    for (const f of ['figuren_namen', 'orte_namen', 'fig_ids', 'ort_ids']) _unionInto(target, s, f);
    if ((s.kommentar || '').length > (target.kommentar || '').length) target.kommentar = s.kommentar;
    if (!target.wertung && s.wertung) target.wertung = s.wertung;
    const tPage = _pageOf(target), sPage = _pageOf(s);
    if ((!target.seite && s.seite) || (tPage == null && sPage != null)) {
      target.seite = s.seite;
      if ('pageId' in s || 'pageId' in target) target.pageId = s.pageId ?? null;
      if ('page_id' in s || 'page_id' in target) target.page_id = s.page_id ?? null;
    }
    if (String(s.titel || '').length > String(target.titel || '').length) target.titel = s.titel;
    // Die Vergleichs-Sicht nachziehen: spätere Kandidaten sehen die vereinigten Indizien.
    views[ti] = _sceneMatchView(target);
  }
  return { szenen: kept, unsure };
}

module.exports = { dedupeLocationsWithinRun, dedupeScenesWithinRun };
