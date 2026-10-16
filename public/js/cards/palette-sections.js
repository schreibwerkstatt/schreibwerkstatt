// Sektions-Aufbau der Command-Palette — rein, ohne Alpine-State. palette-card.js
// ruft `buildPaletteSections` memoisiert auf; Unit-Tests fahren es direkt
// (tests/unit/palette-sections.test.mjs).
//
// Sektion: { key, labelKey, items }. Item-Arten:
//   kind 'toggle' — Karte aus FEATURES (`feature` = Registry-Eintrag)
//   kind 'action' — globale Aktion aus ACTIONS
//   kind 'page' / Provider-Items — `run(root)` (Schema in palette-providers.js)

import {
  FEATURES, ACTIONS, FEATURE_GROUPS, GROUP_LABEL_KEY,
  DEFAULT_RECENT_KEYS,
  featureByKey, isFeatureAvailable, unavailabilityReasonKey,
  featuresVisibleFor, actionsVisibleFor,
  hiddenForBuchtyp, matchesRequiredBuchtyp,
} from './feature-registry.js';
import { fuzzyMatch, hasWordPrefix } from './palette-fuzzy.js';
import { parseQuery } from './palette-providers.js';

// Score-Budget pro Query-Char für Provider-Treffer im Mix-Modus.
// Höhere Query-Länge = grössere absolute fuzzyMatch-Scores (Gap-Penalty
// + length-Faktor), Limit muss mit-skalieren damit überhaupt Treffer durchkommen.
// Kleiner = strenger, grösser = mehr (auch schwächere) Provider-Treffer.
export const FUZZY_SCORE_BUDGET_PER_CHAR = 6;
export const RECENT_TARGET_COUNT = 3;
const RECENT_PAGES_MAX = 5;
// Aufschlag für Treffer in Beschreibung/Gruppe/Alias — Label-Treffer gehen vor.
const SECONDARY_PENALTY = 4;

// Karten, die im aktuellen Kontext überhaupt erscheinen. Mit Buch-Rolle filtert
// `featuresVisibleFor` auch nach Rolle; ohne Buch (Home-Screen) bleiben Karten
// mit `requiresBook` stehen und werden als deaktiviert gezeigt.
export function visiblePaletteFeatures(ctx) {
  if (ctx.bookRole) {
    return featuresVisibleFor(FEATURES, ctx.bookRole, ctx.buchtyp, ctx.cloudModelEffective);
  }
  return FEATURES.filter(f => matchesRequiredBuchtyp(f, ctx.buchtyp)
    && !hiddenForBuchtyp(f, ctx.buchtyp)
    && (!f.requiresCloudModel || ctx.cloudModelEffective));
}

export function visiblePaletteActions(ctx, devMode) {
  const actions = actionsVisibleFor(ACTIONS, ctx.bookRole, ctx.buchtyp, ctx.cloudModelEffective);
  return devMode ? actions.filter(a => a.key !== 'action.logout') : actions;
}

// Label fuzzy (liefert die Highlight-Indices); Beschreibung, Gruppen-Label und
// Aliasse zählen nur bei einem Wortanfangs-Treffer, mit Aufschlag.
export function matchFeatureFuzzy(feature, q, t) {
  const label = (feature.labelKey ? t(feature.labelKey) : '') || '';
  const desc  = (feature.descKey  ? t(feature.descKey)  : '') || '';
  const groupLabel = feature.group ? (t(GROUP_LABEL_KEY[feature.group]) || '') : '';
  const labelMatch = fuzzyMatch(q, label);
  let best = labelMatch ? { score: labelMatch.score, indices: labelMatch.indices } : null;
  for (const o of [desc, groupLabel, ...(feature.aliases || [])]) {
    if (!hasWordPrefix(q, o)) continue;
    const m = fuzzyMatch(q, o);
    if (!m) continue;
    const score = m.score + SECONDARY_PENALTY;
    if (!best || score < best.score) best = { score, indices: labelMatch?.indices || [] };
  }
  return best;
}

export function featureItem(feature, ctx) {
  const available = isFeatureAvailable(feature, ctx);
  const item = {
    key: feature.key,
    kind: feature.kind === 'action' ? 'action' : 'toggle',
    feature,
    labelKey: feature.labelKey,
    descKey: feature.descKey,
    available,
    reasonKey: available ? null : unavailabilityReasonKey(feature, ctx),
    score: 0,
    indices: [],
  };
  if (item.kind === 'toggle') item.dependsOnKomplett = !!feature.dependsOnKomplett;
  return item;
}

// Erst gegen das sichtbare Subset filtern, dann mit DEFAULT_RECENT_KEYS auffüllen —
// umgekehrt bliebe eine Lücke, sobald ein Default für Buchtyp/Rolle ausgeblendet ist.
export function recentFeatures(trackedKeys, visibleFeatures) {
  const visibleKeys = new Set(visibleFeatures.map(f => f.key));
  const out = [];
  const seen = new Set();
  for (const k of [...(trackedKeys || []), ...DEFAULT_RECENT_KEYS]) {
    if (!k || seen.has(k) || !visibleKeys.has(k)) continue;
    const f = featureByKey(k);
    if (!f) continue;
    seen.add(k);
    out.push(f);
    if (out.length >= RECENT_TARGET_COUNT) break;
  }
  return out;
}

function recentPageItems(recentPageIds, pages) {
  const pageById = new Map((pages || []).map(p => [p.id, p]));
  return (recentPageIds || [])
    .map(id => pageById.get(id))
    .filter(Boolean)
    .slice(0, RECENT_PAGES_MAX)
    .map(p => ({
      key: 'page:' + p.id,
      providerKey: 'pages',
      kind: 'page',
      label: p.name || '',
      sub: p.chapterName || '',
      score: 0,
      indices: [],
      available: true,
      run: (r) => r.gotoPageById(p.id),
    }));
}

function matchAll(entries, q, ctx, t) {
  const out = [];
  for (const e of entries) {
    const item = featureItem(e, ctx);
    if (!q) { out.push(item); continue; }
    const m = matchFeatureFuzzy(e, q, t);
    if (!m) continue;
    item.score = m.score;
    item.indices = m.indices;
    out.push(item);
  }
  if (q) out.sort((a, b) => a.score - b.score);
  return out;
}

// args: { query, ctx, devMode, recentFeatureKeys, recentPageIds, t, root, providers }
// ctx: { selectedBookId, pages, bookRole, buchtyp, cloudModelEffective }
export function buildPaletteSections(args) {
  const { query, ctx, devMode, recentFeatureKeys, recentPageIds, t, root, providers } = args;
  const parsed = parseQuery(query);

  // Provider-Modus: nur dieser eine Provider.
  if (parsed.mode === 'provider') {
    const items = parsed.provider.search(root, parsed.q, t);
    return items.length ? [{ key: parsed.provider.key, labelKey: parsed.provider.sectionKey, items }] : [];
  }

  const actions = visiblePaletteActions(ctx, devMode);

  // Befehls-Modus: nur Aktionen.
  if (parsed.mode === 'commands') {
    const items = matchAll(actions, parsed.q, ctx, t);
    return items.length ? [{ key: 'commands', labelKey: 'palette.section.commands', items }] : [];
  }

  const q = parsed.q;
  const features = visiblePaletteFeatures(ctx);
  const sections = [];

  if (!q) {
    // „Zuletzt"-Blöcke + Karten gruppiert nach FEATURE_GROUPS, App-Aktionen separat.
    const recent = recentFeatures(recentFeatureKeys, features);
    if (recent.length) {
      sections.push({ key: 'recent', labelKey: 'palette.recent', items: recent.map(f => featureItem(f, ctx)) });
    }
    const pages = recentPageItems(recentPageIds, ctx.pages);
    if (pages.length) {
      sections.push({ key: 'recentPages', labelKey: 'palette.section.recentPages', items: pages });
    }
    for (const groupKey of FEATURE_GROUPS) {
      if (groupKey === 'app') continue;
      const items = matchAll(features.filter(f => f.group === groupKey), '', ctx, t);
      if (items.length) sections.push({ key: groupKey, labelKey: GROUP_LABEL_KEY[groupKey], items });
    }
    const actionItems = matchAll(actions, '', ctx, t);
    if (actionItems.length) sections.push({ key: 'app', labelKey: GROUP_LABEL_KEY.app, items: actionItems });
    return sections;
  }

  // Mit Query: Karten + Aktionen in EINE sortierte Treffer-Sektion, damit ein
  // Top-Match (z.B. "eins" → "Einstellungen") nicht hinter einer Gruppe mit
  // schwächerem Treffer versteckt wird.
  const matched = matchAll([...features, ...actions], q, ctx, t);
  if (matched.length) sections.push({ key: 'matches', labelKey: 'palette.section.matches', items: matched });

  // Such-Provider ab 2 Zeichen, sofern der Score gut genug ist.
  if (q.length >= 2) {
    const limit = Math.max(3, Math.ceil(q.length * FUZZY_SCORE_BUDGET_PER_CHAR));
    for (const provider of providers || []) {
      const items = provider.search(root, q, t).filter(it => it.score < limit);
      if (items.length) sections.push({ key: provider.key, labelKey: provider.sectionKey, items });
    }
  }
  return sections;
}
