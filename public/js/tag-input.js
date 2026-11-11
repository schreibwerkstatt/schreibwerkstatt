// Schlagwort-Eingabe (selbst-rendernd) — EIN Kern fuer jedes Formular, das
// freie Schlagworte an einem Objekt setzt (Quellen, Recherche-Fundstuecke).
// Gesetzte Schlagworte stehen als entfernbare Chips ueber dem Feld, darunter
// Vorschlaege aus dem Pool des Objekts (Bibliothek bzw. Buch), gefiltert nach
// der laufenden Eingabe. Optik: components/tag-input.css. DESIGN.md
// „Schlagwort-Eingabe".
//
// Verwendung (Wrapper leer lassen, nur Attribute — analog combobox):
//
//   <div x-data="tagInput({ max: 20, maxLen: 40, placeholder: $app.t('…'), label: $app.t('…') })"
//        x-modelable="tags" x-model="draft.tags"
//        x-effect="pool = tagPool.map(r => r.tag)"></div>
//
// - `tags`: Array von Strings (das Draft-Feld der Karte), normalisiert wie der
//   Server ablegt (getrimmt, ohne Dubletten unabhaengig von Gross-/Klein-
//   schreibung, gedeckelt auf `max` Stueck zu `maxLen` Zeichen).
// - `pool`: Vorschlagsliste (Strings). Die Karte liefert sie per `x-effect`.
// - Enter oder Komma uebernimmt, Backspace im leeren Feld nimmt das letzte
//   Schlagwort weg. Noch nicht uebernommener Text geht beim Verlassen des Felds
//   und bei Cmd/Ctrl+S mit — sonst verwuerfe Speichern ein getipptes, aber nicht
//   bestaetigtes Schlagwort still.

import { isSaveShortcut, isImeComposing } from './utils/keys.js';

/** Schlagwort-Liste normalisieren: getrimmt, Innen-Whitespace einfach, ohne
 *  Dubletten (Gross-/Kleinschreibung egal, erste Form gewinnt), gedeckelt. */
export function normalizeTags(list, { max = 20, maxLen = 40 } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const tag = raw.replace(/\s+/g, ' ').trim().slice(0, maxLen).trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/** Vorschlaege: Pool-Eintraege, die noch fehlen und zur Eingabe passen. */
export function tagSuggestions(pool, tags, query, { max = 20, limit = 12 } = {}) {
  const have = new Set((tags || []).map(t => String(t).toLowerCase()));
  if (have.size >= max) return [];
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  const seen = new Set();
  for (const t of pool || []) {
    const key = String(t).toLowerCase();
    if (!t || have.has(key) || seen.has(key) || (q && !key.includes(q))) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

const TEMPLATE = [
  '<div class="tag-input-chips" x-show="tags.length">',
  '  <template x-for="t in tags" :key="t">',
  '    <span class="tag-input-chip">',
  '      <span x-text="t"></span>',
  '      <button type="button" class="tag-input-chip-remove" @click="remove(t)"',
  '              :aria-label="$app.t(\'common.remove\') + \': \' + t">',
  '        <svg class="icon" aria-hidden="true"><use href="/icons.svg#x"/></svg>',
  '      </button>',
  '    </span>',
  '  </template>',
  '</div>',
  '<input type="text" class="card-form-input tag-input-field" x-model="input"',
  '       :maxlength="_maxLen" :placeholder="_placeholder" :aria-label="_label"',
  '       @keydown="onKeydown($event)" @blur="onBlur($event)">',
  '<div class="tag-input-suggest" x-show="suggestions().length" x-cloak>',
  '  <template x-for="t in suggestions()" :key="t">',
  '    <button type="button" class="tag-input-suggestion" @click="add(t)" x-text="\'+ \' + t"></button>',
  '  </template>',
  '</div>',
].join('\n');

export function tagInputData(cfg = {}) {
  return {
    tags: [],
    pool: [],
    input: '',
    _max: cfg.max ?? 20,
    _maxLen: cfg.maxLen ?? 40,
    _placeholder: cfg.placeholder ?? '',
    _label: cfg.label ?? cfg.placeholder ?? '',

    /** Eingabe (oder einen Vorschlag) uebernehmen. Komma trennt, damit
     *  „zhaw, cas" in einem Zug zwei Schlagworte ergibt. */
    add(raw = this.input) {
      const parts = String(raw || '').split(',');
      const next = normalizeTags([...(this.tags || []), ...parts], { max: this._max, maxLen: this._maxLen });
      if (next.length !== (this.tags || []).length) this.tags = next;
      // Auch ein gewaehlter Vorschlag verbraucht die Eingabe: sie war sein Filter.
      this.input = '';
    },
    remove(tag) {
      this.tags = (this.tags || []).filter(t => t !== tag);
    },
    suggestions() {
      return tagSuggestions(this.pool, this.tags, this.input, { max: this._max });
    },
    onKeydown(e) {
      if (isSaveShortcut(e)) { this.add(); return; } // Formular speichert danach selbst
      if (isImeComposing(e)) return;
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        // Enter mit leerem Feld gehoert dem Formular nicht: nichts uebernehmen,
        // aber auch nicht absenden (das Feld ist kein Titel).
        this.add();
      } else if (e.key === 'Backspace' && !this.input && this.tags?.length) {
        this.tags = this.tags.slice(0, -1);
      }
    },
    // Fokus wandert auf einen Vorschlag/Chip desselben Bausteins: dort nicht
    // vorab den Teiltext uebernehmen („zh" + Klick auf „zhaw" ergaebe beides).
    onBlur(e) {
      if (e.relatedTarget && this.$el.contains(e.relatedTarget)) return;
      if (this.input.trim()) this.add();
    },

    init() {
      this.$el.classList.add('tag-input');
      this.$el.setAttribute('role', 'group');
      this.$el.innerHTML = TEMPLATE;
      // Analog combobox/radioGroup: frisch gesetztes Markup explizit
      // initialisieren, falls der Baustein in einem spaet hydratisierten
      // Subtree liegt.
      window.Alpine.initTree(this.$el);
    },
  };
}

export function registerTagInput() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('tagInput', (cfg = {}) => tagInputData(cfg));
}
