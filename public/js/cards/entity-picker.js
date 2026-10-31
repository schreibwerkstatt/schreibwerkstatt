// Entity-Picker: vereinheitlichte Auswahl-Combobox für Buch-Entitäten.
//
// Eine Komponente für alle wiederkehrenden Entitäts-Picker (Figuren, Kapitel,
// Werkstatt-Figuren, cascading Kategorie→Ziel). Erbt die volle Combobox-Mechanik
// von `comboboxData` (combobox.js) und baut die Optionen SELBST aus der Quelle —
// kein Consumer-`x-effect` mehr nötig. `options` ist ein Getter, der die
// reaktiven Quellen (Stores bzw. übergebene Thunks) bei jedem Lesen anfasst →
// Alpine trackt die Deps automatisch; ein interner Memo verhindert teure
// Rebuilds (gleiche Disziplin wie das `_memo`-Pattern der Karten).
//
// Verwendung (DESIGN.md-konform, 3 Attribute wie combobox, OHNE x-effect):
//
//   <div x-data="entityPicker({ entity: 'chapter', placeholder: $app.t('…') })"
//        x-modelable="value" x-model="beatDraft.chapter_id"></div>
//
//   <div x-data="entityPicker({ entity: 'figur', grouped: true, multiple: true,
//                               placeholder: $app.t('…'),
//                               noGroupLabel: $app.t('…') })"
//        x-modelable="value" x-model="beatDraft.figure_ids"></div>
//
//   <div x-data="entityPicker({ entity: 'werkstatt', multiple: true,
//                               items: () => draftFiguren })"
//        x-modelable="value" x-model="beatDraft.draft_figure_ids"></div>
//
//   <!-- cascading: Optionen hängen reaktiv am Kategorie-Picker -->
//   <div x-data="entityPicker({ entity: 'target',
//                               items: () => linkTargets, kind: () => linkPickerKind })"
//        x-modelable="value" x-model="linkPickerTargetId"></div>
//
//   <!-- frei: Optionen kommen aus einem Thunk (Mapping im Karten-Scope) -->
//   <div x-data="entityPicker({ entity: 'custom', items: () => tensionFigurOptions() })"
//        x-modelable="value" x-model="tensionFocusFigur"></div>
//
// Entity-Quellen:
//   chapter   — Kapitel aus $store.nav.tree                       (global)
//   figur     — Katalog-Figuren aus $store.catalog (flach;        (global)
//               grouped:true → nach Kapitel gruppiert)
//   ort       — Schauplätze aus $store.catalog.orte                (global)
//   werkstatt — Werkstatt-/Draft-Figuren aus `items`-Thunk        (karten-lokal)
//   target    — cascading: `items`-Map[`kind`] → {id,label}       (karten-lokal)
//   custom    — beliebige fertige Option-Liste aus `items`-Thunk  (karten-lokal)
//
// Neue Entity-Quelle: in BUILDERS ergänzen (Funktion liefert { deps, build }).

import { comboboxData } from '../combobox.js';
import { compareText } from '../i18n.js';

function _store(name) { return window.Alpine?.store?.(name) || {}; }

// Interner Memo pro Picker-Instanz: rebuilt nur, wenn sich die Dep-Referenzen
// ändern (shallow ===). Deps werden VOR dem Memo gelesen (im Builder), damit
// Alpine die reaktiven Reads auch bei Memo-Treffer registriert.
function _memo(self, deps, build) {
  const prev = self._epMemo;
  if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
    return prev.val;
  }
  const val = build();
  self._epMemo = { deps, val };
  return val;
}

const _figLabel = (f) => f.kurzname || f.name;

// Jede Builder-Funktion liest ihre reaktiven Quellen und liefert { deps, build }.
const BUILDERS = {
  chapter() {
    const tree = _store('nav').tree || [];
    return {
      deps: [tree],
      build: () => tree.filter(it => it.type === 'chapter').map(c => ({ value: c.id, label: c.name })),
    };
  },

  // Schauplätze: `orte[].id` ist bereits die TEXT-loc_id (routes/locations.js
  // mappt `id: r.loc_id`), also dieselbe Frontend-Identität wie bei Figuren —
  // der Wert geht unverändert als `location_ids` an den Server.
  ort() {
    const orte = _store('catalog').orte || [];
    return {
      deps: [orte],
      build: () => orte.map(o => ({ value: o.id, label: o.name })),
    };
  },

  figur(spec) {
    const figs = _store('catalog').figuren || [];
    if (!spec.grouped) {
      return { deps: [figs], build: () => figs.map(f => ({ value: f.id, label: _figLabel(f) })) };
    }
    // Gruppiert nach Kapitel: eine Figur erscheint unter jedem Kapitel, in dem
    // sie auftritt (f.kapitel via figure_appearances); ohne Auftritt → „ohne
    // Kapitel"-Gruppe. Gruppen in Buch-Kapitelreihenfolge ($store.nav.tree),
    // innerhalb nach Figurname.
    const tree = _store('nav').tree || [];
    const noGroup = spec.noGroupLabel || '—';
    return {
      deps: [figs, tree],
      build: () => {
        const order = new Map();
        tree.filter(it => it.type === 'chapter').forEach((c, i) => order.set(c.name, i));
        const rows = [];
        for (const f of figs) {
          const label = _figLabel(f);
          const chapters = [...new Set((f.kapitel || []).map(k => k.name).filter(Boolean))];
          if (!chapters.length) {
            rows.push({ value: f.id, label, group: noGroup, _ord: Number.MAX_SAFE_INTEGER });
          } else {
            for (const ch of chapters) rows.push({ value: f.id, label, group: ch, _ord: order.has(ch) ? order.get(ch) : order.size });
          }
        }
        rows.sort((a, b) => (a._ord - b._ord) || compareText(a.group, b.group) || compareText(a.label, b.label));
        return rows;
      },
    };
  },

  werkstatt(spec) {
    const list = (spec.items?.()) || [];
    return { deps: [list], build: () => list.map(d => ({ value: d.id, label: d.name })) };
  },

  target(spec) {
    const map = (spec.items?.()) || {};
    const kind = spec.kind?.() || '';
    const arr = map[kind] || [];
    return {
      deps: [arr],
      build: () => arr.map(o => ({ value: String(o.id), label: o.label, sublabel: o.sublabel })),
    };
  },

  custom(spec) {
    const arr = (spec.items?.()) || [];
    return { deps: [arr], build: () => arr };
  },
};

export function registerEntityPicker() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('entityPicker', (spec = {}) => {
    const builder = BUILDERS[spec.entity];
    if (!builder) throw new Error(`entityPicker: unbekannte entity '${spec.entity}'`);
    const base = comboboxData({
      placeholder: spec.placeholder,
      emptyLabel: spec.emptyLabel,
      multiple: spec.multiple,
      compact: spec.compact,
    });
    // `options` als reaktiver Getter statt Daten-Feld: baut aus der Quelle,
    // trackt deren Reads automatisch, memoisiert das Ergebnis.
    Object.defineProperty(base, 'options', {
      configurable: true,
      enumerable: true,
      get() {
        const { deps, build } = builder(spec, this);
        return _memo(this, deps, build);
      },
    });
    return base;
  });
}
