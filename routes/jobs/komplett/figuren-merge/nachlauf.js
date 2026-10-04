'use strict';
// Nachlauf der Figuren-Konsolidierung (Phase 2): Sozialschicht-Mehrheitsvotum,
// Backfill aus Szenen/Events, ID-Eindeutigkeit, Alias-Cluster. Facade:
// ../figuren-merge.js.

const { _refToString } = require('../utils');
const { normName: _normalizeName, nameTokens: _nameTokens } = require('../../../../lib/name-normalize');

/** Welle 4 · #12 – Mode-Vote für Sozialschicht (lokale Modelle).
 *  Phase 2 (Konsolidierung) bei kleinen Modellen wählt die sozialschicht
 *  manchmal aus einem Nebenkapitel, obwohl drei andere Kapitel einheitlich
 *  anders votiert haben. Hier korrigieren wir per Mehrheitsabstimmung über
 *  die Phase-1-Rohdaten (nach rollierendem Pre-Merge normalisiert per Name).
 *  Claude läuft durch den holistischen Refine-Call und braucht das nicht. */
function applySozialschichtModeVote(chapterFiguren, figuren) {
  const votes = new Map();
  for (const c of (chapterFiguren || [])) {
    for (const f of (c.figuren || [])) {
      if (!f?.name || !f?.sozialschicht) continue;
      const key = _normalizeName(f.name);
      if (!votes.has(key)) votes.set(key, {});
      votes.get(key)[f.sozialschicht] = (votes.get(key)[f.sozialschicht] || 0) + 1;
    }
  }
  let changes = 0;
  for (const f of figuren) {
    const v = votes.get(_normalizeName(f.name));
    if (!v) continue;
    const entries = Object.entries(v);
    if (entries.length < 2) continue;
    entries.sort((a, b) => b[1] - a[1]);
    if (entries[0][1] === entries[1][1]) continue;
    const mode = entries[0][0];
    if (mode && mode !== f.sozialschicht) {
      f.sozialschicht = mode;
      changes++;
    }
  }
  return changes;
}

/** Backfill: Namen, die in Szenen/Events referenziert werden, aber in keiner
 *  konsolidierten Figur auftauchen, werden als Minimal-Figuren angelegt.
 *  Phase-1-Figurenextraktion hat unvollständigen Recall (v.a. Nebenfiguren);
 *  ohne Backfill droppen remapSzenen/remapAssignments diese Namen und der
 *  Charakter existiert gar nicht – obwohl er in Szenen/Orten/Events vorkommt.
 *  Schwelle: ≥2 Vorkommen (mehrere Szenen ODER zusätzlich als Assignment), um
 *  Einmal-Halluzinationen zu filtern. Token-Subset zu einer bestehenden Figur
 *  («Gerold» bei vorhandenem «Gerold Brunner») → kein Backfill, der
 *  Token-Fallback in buildFigNameLookup löst das auf. Mutiert `figuren`
 *  (append) und gibt die Anzahl neu angelegter Figuren zurück. */
const NAME_HAS_LETTER_RE = /\p{L}/u;
function backfillFiguren(figuren, chapterSzenen, chapterAssignments, log) {
  const resolved = new Set();
  const figTokens = [];
  for (const f of figuren) {
    resolved.add(_normalizeName(f.name));
    if (f.kurzname) resolved.add(_normalizeName(f.kurzname));
    const t = _nameTokens(f.name);
    if (t.length) figTokens.push(t);
  }

  const refs = new Map(); // normKey → { display, count }
  const bump = (raw) => {
    const name = _refToString(raw);
    if (!name) return;
    const key = _normalizeName(name);
    if (!key) return;
    const e = refs.get(key) || { display: name, count: 0 };
    e.count++;
    refs.set(key, e);
  };
  for (const { szenen: chSz } of (chapterSzenen || []))
    for (const s of (chSz || []))
      for (const n of (s?.figuren_namen || [])) bump(n);
  for (const { assignments: chAss } of (chapterAssignments || []))
    for (const a of (chAss || [])) bump(a?.figur_name);

  let maxIdx = 0;
  for (const f of figuren) {
    const m = /^fig_(\d+)$/.exec(f.id || '');
    if (m) maxIdx = Math.max(maxIdx, parseInt(m[1], 10));
  }

  let created = 0;
  for (const { display, count } of refs.values()) {
    if (count < 2) continue;
    const key = _normalizeName(display);
    if (resolved.has(key)) continue;
    if (display.length < 2 || !NAME_HAS_LETTER_RE.test(display)) continue;
    const tk = _nameTokens(display);
    if (tk.length && figTokens.some(ft =>
      tk.every(t => ft.includes(t)) || ft.every(t => tk.includes(t)))) continue;
    maxIdx++;
    figuren.push({
      id: 'fig_' + maxIdx,
      name: display,
      typ: 'andere',
      beziehungen: [],
      kapitel: [],
      eigenschaften: [],
    });
    resolved.add(key);
    created++;
    log.info(`Backfill-Figur «${display}» aus Szenen/Events (${count} Vorkommen) – Phase-1 hatte sie ausgelassen.`);
  }
  return created;
}

/** Letzte Absicherung vor saveFigurenToDb gegen das UNIQUE(book_id, fig_id,
 *  user_email): garantiert, dass jede Figur eine eindeutige, nicht-leere `id`
 *  trägt. mergeDuplicateFiguren dedupliziert nur nach Namen – liefert die
 *  Phase-2-Konsolidierung zwei verschieden benannte Figuren mit derselben `id`
 *  (oder kollidiert eine explizite `fig_N` mit einer index-generierten), würden
 *  sonst beide eingefügt und der INSERT bricht ab. Die ERSTE Figur einer ID
 *  behält sie (eingehende beziehungen.figur_id bleiben gültig); jede weitere
 *  Kollision bzw. leere ID bekommt eine frische `fig_<maxIdx+1>`.
 *
 *  **Doppelte Objekt-Referenzen zuerst kollabieren:** liegt dieselbe Figur-Instanz
 *  zweimal im Array (Merge-/Backfill-Pfad teilt versehentlich eine Referenz), würde
 *  die ID-Neuvergabe unten DASSELBE Objekt mutieren – beide Slots blieben identisch
 *  und der INSERT bräche trotzdem mit UNIQUE. Darum werden exakte Referenz-Duplikate
 *  (erste Vorkommen bleibt) vorab entfernt; das ist semantisch korrekt (dieselbe
 *  Figur soll nur einmal gespeichert werden). Mutiert `figuren` (in-place, ggf.
 *  verkürzt) und gibt die Anzahl neu vergebener IDs zurück. */
function ensureUniqueFigIds(figuren, log = null) {
  // Schritt 1: exakte Objekt-Referenz-Duplikate entfernen (erste Position behalten).
  const objSeen = new Set();
  let w = 0;
  for (let r = 0; r < figuren.length; r++) {
    if (objSeen.has(figuren[r])) continue;
    objSeen.add(figuren[r]);
    figuren[w++] = figuren[r];
  }
  figuren.length = w;

  // Schritt 2: eindeutige, nicht-leere id pro (jetzt distinkter) Figur.
  let maxIdx = 0;
  for (const f of figuren) {
    const m = /^fig_(\d+)$/.exec(f.id || '');
    if (m) maxIdx = Math.max(maxIdx, parseInt(m[1], 10));
  }
  const seen = new Set();
  const collidedIds = new Set(); // Original-IDs, die wegen Kollision neu vergeben wurden
  let reassigned = 0;
  for (const f of figuren) {
    if (!f.id || seen.has(f.id)) {
      if (f.id) collidedIds.add(f.id);
      f.id = 'fig_' + (++maxIdx);
      reassigned++;
    }
    seen.add(f.id);
  }
  // Inbound-Ref-Hinweis: zeigt eine beziehungen.figur_id auf eine kollidierte (jetzt
  // mehrdeutige) ID, ist nicht eindeutig entscheidbar, welche Figur gemeint war — die
  // Heuristik «erste behält die ID» kann dann fehl-attribuieren. Kein Datenfehler
  // (dedupRelations + validIds-Filter halten Refs konsistent), aber für die Diagnose
  // protokollieren. Sehr seltener Edge-Case (zwei verschieden benannte Figuren mit
  // identischer ID + eine dritte, die darauf referenziert).
  if (log && collidedIds.size > 0) {
    const affected = figuren.some(f => (f.beziehungen || []).some(b => collidedIds.has(b.figur_id)));
    if (affected) log.warn(`ensureUniqueFigIds: ${collidedIds.size} kollidierte ID(s) mit eingehenden Beziehungs-Refs – mögliche Fehl-Attribution (Heuristik: erste Figur behält ID).`);
  }
  return reassigned;
}

/** Alias-Cluster (F3) auf die (pre-merged) Kapitel-Figuren anwenden: Namensvarianten, die laut
 *  Alias-Pass dieselbe Figur bezeichnen (Epitheta/Spitznamen/Umbenennungen), auf den kanonischen
 *  Namen umschreiben — der Originalname bleibt als kurzname erhalten, falls noch keiner gesetzt
 *  ist. Die nachfolgende KI-Konsolidierung + mergeDuplicateFiguren führen die nun gleichnamigen
 *  Einträge zusammen. Gibt `{ renamed, aliasMap }` zurück; aliasMap (lowercased Alias →
 *  kanonischer Name) geht in buildFigNameLookup, damit Szenen/Events mit dem Alias-Namen weiter
 *  auf die kanonische Figur auflösen (kein Drop). Mutiert die übergebenen figuren in place.
 *  Pure, testbar. */
function applyAliasClusters(chapterFiguren, clusters, log = null) {
  const aliasMap = {};
  // Kandidaten = die Namen, die der Alias-Pass zu sehen bekam. Ein Cluster, dessen
  // kanonischer Name oder Alias darin nicht vorkommt, hat das Modell (teilweise)
  // erfunden — er wird ganz verworfen: ein erfundener Kanon benennte echte Figuren
  // auf einen Namen um, den es im Buch nicht gibt.
  const candidates = new Set();
  for (const ch of (chapterFiguren || [])) {
    for (const f of (ch.figuren || [])) {
      const k = _normalizeName(f?.name);
      if (k) candidates.add(k);
    }
  }
  const invented = [];
  for (const c of (clusters || [])) {
    const canon = _refToString(c?.kanonisch);
    if (!canon) continue;
    const aliases = (c?.aliase || []).map(_refToString).filter(Boolean);
    const unknown = [canon, ...aliases].filter(n => !candidates.has(_normalizeName(n)));
    if (unknown.length) { invented.push(...unknown); continue; }
    for (const alias of aliases) {
      if (_normalizeName(alias) === _normalizeName(canon)) continue;
      aliasMap[alias.toLowerCase()] = canon;
    }
  }
  if (invented.length && log) {
    log.warn(`Alias-Cluster: ${invented.length} Name(n) nicht unter den Kandidaten – Cluster verworfen: `
      + `${invented.slice(0, 6).join(', ')}${invented.length > 6 ? ' …' : ''}`);
  }
  if (!Object.keys(aliasMap).length) return { renamed: 0, aliasMap };
  let renamed = 0;
  for (const ch of (chapterFiguren || [])) {
    for (const f of (ch.figuren || [])) {
      const canon = aliasMap[String(f.name || '').toLowerCase()];
      if (canon && canon !== f.name) {
        if (!f.kurzname || f.kurzname === f.name) f.kurzname = f.name;
        f.name = canon;
        renamed++;
      }
    }
  }
  if (renamed && log) log.info(`Alias-Cluster: ${renamed} Figuren-Nennung(en) auf kanonische Namen vereinheitlicht (${Object.keys(aliasMap).length} Aliasse).`);
  return { renamed, aliasMap };
}

module.exports = { applySozialschichtModeVote, backfillFiguren, ensureUniqueFigIds, applyAliasClusters };
