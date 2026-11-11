// Sortierbare Tabelle als Alpine.data-Komponente.
//
// Verwendung (Pattern wie combobox/numInput):
//
//   <table x-data="sortableTable({
//                    rows: () => adminUsersList,
//                    defaultKey: 'email',
//                    defaultDir: 'asc',
//                    persistKey: 'admin.users',
//                    types: { last_seen_at: 'date', acl_count: 'number' },
//                  })">
//     <thead><tr>
//       <th x-bind="sortTh('email')">Email</th>
//       …
//     </tr></thead>
//     <tbody>
//       <template x-for="r in sorted" :key="r.email">…</template>
//     </tbody>
//   </table>
//
// `rows` ist eine **Funktion**, damit reaktive Quellen (Methods wie
// `ownerlessBooks()` oder Listen wie `adminUsersList`) bei Aenderung neue
// `sorted`-Berechnung ausloesen. Keine `:rows`-Bindung — Alpine-`x-data`
// koennte sonst nur 1× zur Init evaluiert werden.
//
// `types` ist optional (Auto-Detection via Sample-Wert):
//   - 'number'  → Number(v)-Vergleich, NaN behandelt als 0
//   - 'date'    → ISO-String/Date-Objekt → ms-Timestamp; null sinkt ans Ende
//   - 'string'  → compareText (i18n.js: Kollation der UI-Sprache, numerisch)
//
// `sortTh(key)` ist der Spread fuer jede sortierbare `<th>`: setzt die
// Klasse `sortable-th` (+ `--asc`/`--desc`), `aria-sort`, `tabindex=0` und
// loest `sortBy(key)` per Klick, Enter und Leertaste aus — der Kopf ist damit
// per Tastatur bedienbar. Weitere Klassen/Attribute bleiben am `<th>` stehen.
//
// `persistKey` (optional): merkt key+dir in localStorage unter
// `sortableTable.<persistKey>`. Ohne Key: kein Persist.
//
// Schrittweise Rendern ist Default: sortiert wird die ganze Liste
// (`sortedAll`), `sorted` liefert aber nur das Fenster vom Anfang her
// (LIST_WINDOW_STEP Zeilen, list-window.js). Den «Weitere anzeigen»-Knopf hängt
// die Komponente selbst als `<tfoot class="sortable-table-more">` an die Tabelle;
// er lädt beim Heranscrollen nach. **Why:** eine Zeile mit Entitäts-Referenzen
// kostet Alpine Millisekunden — eine Tabelle über alle Schauplätze eines grossen
// Buchs blockierte beim Öffnen Sekunden den Main-Thread. `window: false` schaltet
// das Fenster ab (nur, wenn die Tabelle nie gross wird und ihr Template alle
// Zeilen auf einmal braucht).

import { lsGetJSON, lsSetJSON } from './safe-storage.js';
import { compareText, tRaw } from './i18n.js';
import { LIST_WINDOW_STEP, observeListMore } from './list-window.js';

function detectType(sample) {
  if (sample == null) return null;
  if (typeof sample === 'number') return 'number';
  if (typeof sample === 'boolean') return 'number';
  if (sample instanceof Date) return 'date';
  if (typeof sample === 'string') {
    // ISO-8601-Heuristik: 2026-..., mit T oder Leerzeichen
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(sample)) return 'date';
    return 'string';
  }
  return 'string';
}

function coerce(value, type) {
  if (type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === 'date') {
    if (value == null) return null;
    const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(t) ? t : null;
  }
  return value == null ? '' : String(value);
}

// Pure-Funktion fuer Unit-Tests. Kein this, kein Alpine.
export function sortRows(rows, key, dir, typeHint) {
  if (!Array.isArray(rows) || !key) return rows.slice();
  const sample = rows.find((r) => r != null && r[key] != null)?.[key];
  const type = typeHint || detectType(sample) || 'string';
  const sign = dir === 'desc' ? -1 : 1;
  const out = rows.slice();
  out.sort((a, b) => {
    const av = coerce(a == null ? undefined : a[key], type);
    const bv = coerce(b == null ? undefined : b[key], type);
    // null sinkt immer ans Ende, unabhaengig von dir
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (type === 'string') return sign * compareText(av, bv);
    if (av < bv) return -1 * sign;
    if (av > bv) return 1 * sign;
    return 0;
  });
  return out;
}

function loadPersisted(persistKey) {
  if (!persistKey) return null;
  const obj = lsGetJSON(`sortableTable.${persistKey}`);
  if (obj && typeof obj.key === 'string' && (obj.dir === 'asc' || obj.dir === 'desc')) return obj;
  return null;
}

function savePersisted(persistKey, state) {
  if (!persistKey) return;
  lsSetJSON(`sortableTable.${persistKey}`, state);
}

// Fenstergrösse nach `n` sichtbaren Zeilen; pure, für Unit-Tests.
export function windowRows(rows, size) {
  return rows.length > size ? rows.slice(0, size) : rows;
}

// Spaltenzahl aus der Kopfzeile (inkl. colspan) — für die Fusszeile.
function headColumnCount(table) {
  const row = table.tHead?.rows?.[0];
  if (!row) return 1;
  let n = 0;
  for (const c of row.cells) n += c.colSpan || 1;
  return Math.max(1, n);
}

export function registerSortableTable() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('sortableTable', (cfg = {}) => {
    const persisted = loadPersisted(cfg.persistKey);
    // Nicht-reaktiv: ein Getter, der reaktiven State schreibt, weckte jeden Leser erneut.
    let sortCache = null;   // { raw, key, dir, val }
    let footCleanup = null;
    return {
      sortKey: persisted?.key ?? (cfg.defaultKey || null),
      sortDir: persisted?.dir ?? (cfg.defaultDir === 'desc' ? 'desc' : 'asc'),
      _rowsFn: typeof cfg.rows === 'function' ? cfg.rows : () => [],
      _types: cfg.types || {},
      _persistKey: cfg.persistKey || null,
      _windowed: cfg.window !== false,
      windowSize: LIST_WINDOW_STEP,

      init() {
        if (!this._windowed) return;
        const table = this.$el;
        if (!(table instanceof HTMLTableElement)) return;
        const foot = document.createElement('tfoot');
        foot.className = 'sortable-table-more';
        const td = document.createElement('td');
        td.colSpan = headColumnCount(table);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-compact list-window-more';
        btn.addEventListener('click', () => this.sortedMore());
        td.appendChild(btn);
        foot.appendChild(document.createElement('tr')).appendChild(td);
        table.appendChild(foot);
        const update = () => {
          const rest = this.sortedRest;
          foot.hidden = rest === 0;
          if (rest) btn.textContent = tRaw('common.showMore', { n: rest });
        };
        update();
        this.$watch(() => `${this.sortedRest}|${window.Alpine.store('shell')?.uiLocale || ''}`, update);
        const stopObserve = observeListMore(btn, () => { if (this.sortedRest) this.sortedMore(); });
        footCleanup = () => { stopObserve(); foot.remove(); };
      },

      destroy() {
        footCleanup?.();
        footCleanup = null;
      },

      // Ganze Liste, sortiert. Cache je Quelle + Sortierung: `sorted` und
      // `sortedRest` lesen beide pro Render, sortiert wird einmal pro Änderung.
      get sortedAll() {
        const raw0 = this._rowsFn() || [];
        const raw = Array.isArray(raw0) ? raw0 : [];
        const c = sortCache;
        if (c && c.raw === raw && c.key === this.sortKey && c.dir === this.sortDir) return c.val;
        const val = this.sortKey ? sortRows(raw, this.sortKey, this.sortDir, this._types[this.sortKey]) : raw;
        sortCache = { raw, key: this.sortKey, dir: this.sortDir, val };
        return val;
      },

      // Was die Tabelle rendert: das Fenster aus `sortedAll`.
      get sorted() {
        const all = this.sortedAll;
        return this._windowed ? windowRows(all, this.windowSize) : all;
      },

      get sortedRest() {
        return this._windowed ? Math.max(0, this.sortedAll.length - this.windowSize) : 0;
      },

      sortedMore() {
        this.windowSize += LIST_WINDOW_STEP;
      },

      sortBy(key) {
        if (!key) return;
        if (this.sortKey === key) {
          this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          this.sortKey = key;
          this.sortDir = 'asc';
        }
        if (this._persistKey) savePersisted(this._persistKey, { key: this.sortKey, dir: this.sortDir });
      },

      sortClass(key) {
        if (!key) return '';
        if (this.sortKey !== key) return 'sortable-th';
        return this.sortDir === 'asc' ? 'sortable-th sortable-th--asc' : 'sortable-th sortable-th--desc';
      },

      ariaSort(key) {
        if (this.sortKey !== key) return 'none';
        return this.sortDir === 'asc' ? 'ascending' : 'descending';
      },

      // Spread pro sortierbarer <th>: Optik, ARIA und Maus-/Tastatur-Bedienung.
      sortTh(key) {
        return {
          tabindex: 0,
          [':class']: () => this.sortClass(key),
          [':aria-sort']: () => this.ariaSort(key),
          ['@click']: () => this.sortBy(key),
          ['@keydown.enter.prevent']: () => this.sortBy(key),
          ['@keydown.space.prevent']: () => this.sortBy(key),
        };
      },
    };
  });
}
