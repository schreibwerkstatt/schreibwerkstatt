// Hilfe-Katalog — Inhalt des Reiters „Funktionen" der Hilfe-Karte.
//
// Quelle ist die Feature-Registry: jede Karte aus FEATURES (plus die Aktionen,
// die eine eigene Karte oeffnen) bekommt einen Eintrag, gruppiert nach
// FEATURE_GROUPS, mit Titel = `labelKey` und Hilfetext = `help.feat.<key>`.
// Dazu kommen Funktionen ohne eigene Karte (Werkzeuge im Editor, Teilen,
// Clients) als HELP_EXTRAS. Die Landing-Page hat ihren eigenen, kuratierten
// Textsatz (`landing.feat<N>`) — die Hilfe beschreibt, was es gibt und wo es
// liegt, die Landing wirbt.
//
// Pure: kein Alpine, kein DOM — `buildHelpSections(ctx)` ist ohne Browser
// testbar (tests/unit/help-catalog.test.mjs gated die Vollstaendigkeit).

import {
  FEATURES, ACTIONS, FEATURE_GROUPS, GROUP_LABEL_KEY,
  matchesRequiredBuchtyp, hiddenForBuchtyp, hasMinRole,
  isFeatureAvailable, unavailabilityReasonKey,
} from './feature-registry.js';

/** Gruppen in Anzeige-Reihenfolge. `write` (Schreiben im Editor) steht vorn:
 *  dort beginnt jeder, und die Registry kennt diese Funktionen nicht, weil sie
 *  keine Karte haben. */
export const HELP_GROUPS = ['write', ...FEATURE_GROUPS];

export const HELP_GROUP_LABEL_KEY = { write: 'help.group.write', ...GROUP_LABEL_KEY };

/** Karten ohne Hilfe-Eintrag: die Hilfe beschreibt sich nicht selbst. */
const SKIP_FEATURES = new Set(['help']);

/** Aktionen, die eine Karte oeffnen oder eine Funktion starten, die man in der
 *  Hilfe finden will. Theme/Sprache/Logout/Cache sind Bedienung, keine Funktion. */
export const HELP_ACTION_KEYS = [
  'action.komplett', 'action.myStats', 'action.myBooks', 'action.autorenprofil', 'action.shortcuts',
];

/** Aktionen tragen in der Registry alle `group: 'app'` (Palette-Sektion). In
 *  der Hilfe gehoert die Komplettanalyse fachlich zu Welt & Plot: sie fuellt
 *  genau deren Karten. */
const ACTION_HELP_GROUP = { 'action.komplett': 'world' };

/** Voraussetzungen, die die Registry nicht kennt. `semantic` = Semantik-Index
 *  (vom Admin eingerichteter Embedding-Dienst). */
const EXTRA_NEEDS = {
  redundanz: ['semantic'],
  buchlandkarte: ['semantic'],
};

/** Funktionen ohne eigene Hauptkarte. `open` (optional) = Root-Methode, die
 *  die Stelle oeffnet; `needs` = Voraussetzungs-Plaketten; `buchtyp` = nur
 *  bei diesen Buchtypen sinnvoll (filtert wie `requiresBuchtyp`). */
export const HELP_EXTRAS = [
  { key: 'editors',       group: 'write' },
  { key: 'lektorat',      group: 'write' },
  { key: 'pageChat',      group: 'write' },
  { key: 'reference',     group: 'write' },
  { key: 'ideas',         group: 'write' },
  { key: 'spellcheck',    group: 'write', needs: ['service'] },
  { key: 'synonyms',      group: 'write' },
  { key: 'figurLookup',   group: 'write' },
  { key: 'dictation',     group: 'write', needs: ['service'] },
  { key: 'readAloud',     group: 'write', needs: ['service'] },
  { key: 'citations',     group: 'write' },
  { key: 'evidence',      group: 'write', needs: ['semantic'] },
  { key: 'xrefs',         group: 'write' },
  { key: 'diagrams',      group: 'write' },
  { key: 'tables',        group: 'write' },
  { key: 'interview',     group: 'write', buchtyp: ['journalismus', 'blog'], needs: ['service'] },
  { key: 'pageHistory',   group: 'write' },
  { key: 'kapitelReview', group: 'review' },
  { key: 'researchChat',  group: 'world', needs: ['claude'] },
  { key: 'plotChat',      group: 'world', hiddenForBuchtyp: ['journalismus'] },
  { key: 'ideenChat',     group: 'manuscript' },
  { key: 'imageGen',      group: 'tools', needs: ['claude', 'service'] },
  { key: 'comments',      group: 'tools' },
  { key: 'collab',        group: 'tools' },
  { key: 'blogSync',      group: 'export', buchtyp: ['blog'] },
  { key: 'userSettings',  group: 'app', open: 'toggleUserSettingsCard' },
  { key: 'palette',       group: 'app' },
  { key: 'extension',     group: 'app' },
  { key: 'nativeApps',    group: 'app' },
];

/** Hilfetext-Key eines Registry-Eintrags (`action.myStats` → `help.feat.myStats`). */
export function helpDescKey(key) {
  return `help.feat.${String(key).replace(/^action\./, '')}`;
}

function _asList(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/** Plaketten eines Eintrags: `{ key, params? }` fuer `t()`. */
function _needs(entry, extraNeeds) {
  const out = [];
  const req = _asList(entry.requiresBuchtyp || entry.buchtyp);
  if (req.length) {
    out.push({ key: 'help.need.onlyFor', params: { typ: req.map(b => ({ i18n: `help.buchtyp.${b}` })) } });
  }
  const hidden = _asList(entry.hiddenForBuchtyp);
  if (hidden.length) {
    out.push({ key: 'help.need.notFor', params: { typ: hidden.map(b => ({ i18n: `help.buchtyp.${b}` })) } });
  }
  if (entry.dependsOnKomplett) out.push({ key: 'help.need.komplett' });
  if (entry.requiresCloudModel) out.push({ key: 'help.need.cloudModel' });
  for (const n of extraNeeds || []) out.push({ key: `help.need.${n}` });
  return out;
}

/** Passt der Eintrag zum Buchtyp des offenen Buchs? Ohne Buch passt alles —
 *  die Plaketten sagen dann, wofuer eine Funktion gedacht ist. */
function _fitsBuchtyp(entry, buchtyp) {
  if (!buchtyp) return true;
  const probe = { requiresBuchtyp: entry.requiresBuchtyp || entry.buchtyp, hiddenForBuchtyp: entry.hiddenForBuchtyp };
  return matchesRequiredBuchtyp(probe, buchtyp) && !hiddenForBuchtyp(probe, buchtyp);
}

function _registryEntry(f, ctx) {
  const available = isFeatureAvailable(f, ctx)
    && (!ctx.bookRole || !f.minRole || hasMinRole(ctx.bookRole, f.minRole));
  return {
    key: f.key,
    titleKey: f.labelKey,
    descKey: helpDescKey(f.key),
    needs: _needs(f, EXTRA_NEEDS[f.key]),
    open: f.kind === 'action' ? { run: f.key } : { toggle: f.toggle },
    available,
    reasonKey: available ? null : (unavailabilityReasonKey(f, ctx) || 'palette.disabled.needBook'),
  };
}

function _extraEntry(x, ctx) {
  const available = !!x.open && (!x.requiresBook || !!ctx.selectedBookId);
  return {
    key: `extra.${x.key}`,
    titleKey: `help.extra.${x.key}.title`,
    descKey: `help.extra.${x.key}.desc`,
    needs: _needs(x, x.needs),
    open: x.open ? { toggle: x.open } : null,
    available,
    reasonKey: null,
  };
}

/** Sichtbar fuer die Buch-Rolle? Wie die Palette: ohne `minRole` gilt editor.
 *  Ohne Buch (keine Rolle) zeigt die Hilfe alles. */
function _fitsRole(f, role) {
  if (!role) return true;
  return hasMinRole(role, f.minRole || 'editor');
}

/**
 * Sektionen des Reiters „Funktionen".
 * @param {{ selectedBookId?: any, pages?: any[], bookRole?: string|null,
 *           buchtyp?: string|null, cloudModelEffective?: boolean }} ctx
 * @returns {{ group: string, labelKey: string, entries: object[] }[]}
 */
export function buildHelpSections(ctx = {}) {
  const c = { cloudModelEffective: true, ...ctx };
  const byGroup = new Map(HELP_GROUPS.map(g => [g, []]));
  const push = (group, entry) => (byGroup.get(group) || byGroup.get('tools')).push(entry);

  for (const f of FEATURES) {
    if (f.kind !== 'toggle' || SKIP_FEATURES.has(f.key)) continue;
    if (!_fitsBuchtyp(f, c.buchtyp) || !_fitsRole(f, c.bookRole)) continue;
    push(f.group, _registryEntry(f, c));
  }
  for (const key of HELP_ACTION_KEYS) {
    const a = ACTIONS.find(x => x.key === key);
    if (!a || !_fitsBuchtyp(a, c.buchtyp)) continue;
    push(ACTION_HELP_GROUP[key] || a.group, _registryEntry(a, c));
  }
  for (const x of HELP_EXTRAS) {
    if (!_fitsBuchtyp(x, c.buchtyp)) continue;
    push(x.group, _extraEntry(x, c));
  }

  return HELP_GROUPS
    .map(g => ({ group: g, labelKey: HELP_GROUP_LABEL_KEY[g], entries: byGroup.get(g) }))
    .filter(s => s.entries.length > 0);
}

/** Alle i18n-Keys, die der Katalog braucht (fuer den Vollstaendigkeits-Test). */
export function helpCatalogKeys() {
  const keys = new Set(['help.group.write']);
  for (const f of FEATURES) {
    if (f.kind === 'toggle' && !SKIP_FEATURES.has(f.key)) keys.add(helpDescKey(f.key));
  }
  for (const k of HELP_ACTION_KEYS) keys.add(helpDescKey(k));
  for (const x of HELP_EXTRAS) {
    keys.add(`help.extra.${x.key}.title`);
    keys.add(`help.extra.${x.key}.desc`);
  }
  const all = [...FEATURES, ...ACTIONS.filter(a => HELP_ACTION_KEYS.includes(a.key)), ...HELP_EXTRAS];
  for (const e of all) {
    for (const n of _needs(e, e.needs || EXTRA_NEEDS[e.key])) {
      keys.add(n.key);
      for (const t of n.params?.typ || []) keys.add(t.i18n);
    }
  }
  return [...keys];
}
