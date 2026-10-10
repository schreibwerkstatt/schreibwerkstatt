'use strict';
// Katalog-Anker: der bestehende Katalog ist die Identitäts-Autorität eines Folgelaufs.
//
// Ohne Anker erfindet jeder Lauf den Katalog neu (frische fig_N/ort_N) und bildet ihn
// danach über Namen und Indizien auf den Bestand zurück — Rename-Fallback, Teilnamen,
// Token-Fallback, Judge. Genau dort entstanden die Verwechslungen (eine neue Figur
// übernahm die id einer gepflegten). Mit Anker sieht die Extraktion den Bestand mit
// stabilen IDs (K<figures.id>, O<locations.id>) und sagt selbst, welchen Eintrag sie
// meint; der Text entscheidet, nicht die Heuristik. Die Regel-Schicht bleibt für das,
// was das Modell nicht verankert (echte Neuzugänge, erster Lauf).
const { listKatalogAnker } = require('../../../db/katalog-anker');

// Deckel für den Katalog-Block im Prompt. Ein Buch mit mehr Einträgen bekommt die
// ersten (aktive vor ausgemusterten, dann Katalog-Reihenfolge); der Rest fällt auf die
// Regel-Schicht zurück, wie ohne Anker.
const MAX_FIGUREN = 400;
const MAX_ORTE = 400;

function _variants(f) {
  const out = [];
  const seen = new Set([String(f.name || '').trim().toLowerCase()]);
  for (const v of [f.ki_name, f.kurzname, ...(f.aliases || [])]) {
    const s = String(v || '').trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

/** Lädt den Katalog und baut den Prompt-Block. Leerer Katalog (erster Lauf) → null. */
function loadKatalogAnker(bookId, email) {
  const { figuren, orte } = listKatalogAnker(bookId, email);
  if (!figuren.length && !orte.length) return null;
  const fig = figuren.slice(0, MAX_FIGUREN);
  const ort = orte.slice(0, MAX_ORTE);
  const lines = [];
  if (fig.length) {
    lines.push('Figuren:');
    for (const f of fig) {
      const v = _variants(f);
      lines.push(`K${f.id} · ${f.name}${v.length ? ` (auch: ${v.join(', ')})` : ''}${f.typ ? ` · ${f.typ}` : ''}${f.stale ? ' · zuletzt nicht im Text gefunden' : ''}`);
    }
  }
  if (ort.length) {
    lines.push('Schauplätze:');
    for (const o of ort) {
      const alt = o.ki_name && o.ki_name !== o.name ? ` (auch: ${o.ki_name})` : '';
      lines.push(`O${o.id} · ${o.name}${alt}${o.typ ? ` · ${o.typ}` : ''}${o.stale ? ' · zuletzt nicht im Text gefunden' : ''}`);
    }
  }
  return {
    block: lines.join('\n'),
    figIds: new Set(figuren.map(f => f.id)),
    ortIds: new Set(orte.map(o => o.id)),
  };
}

/** `K12` / `k12` / `12` → 12, sonst null. */
function parseAnker(raw, prefix) {
  const m = new RegExp(`^\\s*${prefix}?\\s*(\\d+)\\s*$`, 'i').exec(String(raw ?? ''));
  return m ? parseInt(m[1], 10) : null;
}

/** Hint-Map (Lauf-id → Bestands-id) aus den Ankern einer Liste. Nur IDs, die es im
 *  Bestand gibt; beansprucht ein zweiter Eintrag dieselbe Bestandszeile, bekommt keiner
 *  von beiden den Anker (das Modell war sich dann selbst nicht einig — die Regel-Schicht
 *  entscheidet). `keyOf` muss dieselbe Funktion sein wie im Matcher (figureHintKey …). */
function ankerHints(items, { prefix, validIds, keyOf }) {
  const claims = new Map();
  for (const it of (items || [])) {
    const id = parseAnker(it?.katalog_id, prefix);
    if (id == null || !validIds?.has(id)) continue;
    if (!claims.has(id)) claims.set(id, []);
    claims.get(id).push(keyOf(it));
  }
  const hint = new Map();
  let conflicts = 0;
  for (const [id, keys] of claims) {
    if (keys.length === 1) hint.set(keys[0], id);
    else conflicts++;
  }
  return { hint, conflicts };
}

/** Zwei Hint-Maps vereinen; der Anker schlägt den Judge — auch dort, wo der Judge eine
 *  vom Anker beanspruchte Bestandszeile einem anderen Eintrag zusprechen wollte. */
function mergeHints(primary, secondary) {
  const taken = new Set((primary || new Map()).values());
  const out = new Map();
  for (const [k, v] of (secondary || [])) if (!taken.has(v)) out.set(k, v);
  for (const [k, v] of (primary || [])) out.set(k, v);
  return out;
}

module.exports = { loadKatalogAnker, parseAnker, ankerHints, mergeHints, MAX_FIGUREN, MAX_ORTE };
