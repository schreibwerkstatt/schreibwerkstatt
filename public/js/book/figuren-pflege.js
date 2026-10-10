// figurPflegeMethods — Katalog-Pflege in der Figurenkarte, gespreadet in
// cards/figuren-card.js:
//   * Steckbrief bearbeiten: figur-granular über PATCH /figures/:book_id/:fig_id
//     (db/figures/patch.js). Der Server setzt dabei `manually_edited` — die
//     Komplettanalyse überschreibt die gepflegten Felder danach nicht mehr
//     (Abzeichen «vom Autor gepflegt» in der Liste).
//   * Ausgemusterte Figur «zusammenführen mit…»: wählt eine aktive Ziel-Figur und
//     ruft den geteilten Merge-Weg (book/figur-merge.js).
//
// Kein `get x()` in diesem gespreadeten Modul (Spread-Getter-Falle).

// i18n über den Root (`window.__app.t`), nicht über i18n.js: das Modul hängt beim
// Import Listener an `window` und machte die Figurenkarte ohne Browser unladbar.
const _t = (key, params) => window.__app?.t?.(key, params) ?? key;
import { FIGUR_TYPEN } from './figur-typen.js';
import { SCHICHT_LEVEL } from '../graph/constants.js';
import { mergeFigurPair, figurMergeMessage } from './figur-merge.js';

// Präsenz-Stufen — Persistenz-Konstante, deckungsgleich mit dem Prompt-Enum
// (prompts/komplett/schemas.js) und den i18n-Keys figuren.praesenz.<key>.
const PRAESENZ_KEYS = ['zentral', 'regelmaessig', 'punktuell', 'randfigur'];

// Bearbeitbare Steckbrief-Felder in Formular-Reihenfolge. Teilmenge von
// db/figures/patch.js#PATCHABLE_FIELDS (gleiche Längen). `spell`: LanguageTool auf
// Prosafeldern (public/CLAUDE.md); Namen, Geschlecht und Datum sind keine Prosa.
// `area`: mehrzeilig.
export const FIGUR_EDIT_FIELDS = [
  { key: 'name', max: 200 },
  { key: 'kurzname', max: 200 },
  { key: 'typ', options: 'typ' },
  { key: 'geschlecht', max: 60 },
  { key: 'geburtstag', max: 100 },
  { key: 'beruf', max: 200, spell: true },
  { key: 'rolle', max: 400, spell: true },
  { key: 'praesenz', options: 'praesenz' },
  { key: 'sozialschicht', options: 'schicht' },
  { key: 'wohnadresse', max: 400, spell: true },
  { key: 'beschreibung', max: 4000, spell: true, area: true },
  { key: 'aeusseres', max: 4000, spell: true, area: true },
  { key: 'stimme', max: 4000, spell: true, area: true },
  { key: 'hintergrund', max: 4000, spell: true, area: true },
  { key: 'motivation', max: 4000, spell: true, area: true },
  { key: 'konflikt', max: 4000, spell: true, area: true },
  { key: 'entwicklung', max: 4000, spell: true, area: true },
];

const _norm = (v) => (v == null ? '' : String(v).trim());

/** Pure: geänderte Felder zwischen Figur und Formular-Entwurf ({ key: wert|null }). */
export function figurEditDiff(fig, draft) {
  const out = {};
  for (const d of FIGUR_EDIT_FIELDS) {
    const next = _norm(draft?.[d.key]);
    if (next !== _norm(fig?.[d.key])) out[d.key] = next || null;
  }
  return out;
}

export const figurPflegeMethods = {
  figurEditFields() { return FIGUR_EDIT_FIELDS; },

  // Optionen der Schlüssel-Felder (Combobox). Label aus i18n, Wert = Persistenz-Key.
  figurEditOptions(kind) {
    const keys = kind === 'typ' ? FIGUR_TYPEN
      : kind === 'praesenz' ? PRAESENZ_KEYS
      : Object.keys(SCHICHT_LEVEL);
    const prefix = kind === 'typ' ? 'figuren.type.' : kind === 'praesenz' ? 'figuren.praesenz.' : 'figuren.schicht.';
    return keys.map(k => ({ value: k, label: _t(prefix + k) }));
  },

  startFigurEdit(f) {
    this.figurEditId = f.id;
    this.figurEditDraft = Object.fromEntries(FIGUR_EDIT_FIELDS.map(d => [d.key, f[d.key] ?? '']));
    this.figurEditError = '';
  },

  cancelFigurEdit() {
    this.figurEditId = null;
    this.figurEditDraft = {};
    this.figurEditError = '';
  },

  async saveFigurEdit(f) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.figurEditBusy || this.figurEditId !== f.id) return;
    const fields = figurEditDiff(f, this.figurEditDraft);
    if (!Object.keys(fields).length) { this.cancelFigurEdit(); return; }
    if ('name' in fields && !fields.name) { this.figurEditError = _t('figuren.edit.nameRequired'); return; }
    this.figurEditBusy = true;
    this.figurEditError = '';
    try {
      const r = await fetch(`/figures/${encodeURIComponent(bookId)}/${encodeURIComponent(f.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(window.__app.tError(data));
      if (String(Alpine.store('nav').selectedBookId) !== String(bookId)) return;
      this.cancelFigurEdit();
      this.figurPflegeMessage = _t('figuren.edit.saved', { name: fields.name || f.name });
      await window.__app.loadFiguren(bookId);
    } catch (e) {
      console.error('[saveFigurEdit]', e);
      this.figurEditError = e.message || _t('figuren.edit.saveError');
    } finally {
      this.figurEditBusy = false;
    }
  },

  // ── Ausgemusterte Figur zusammenführen ──────────────────────────────────────
  toggleFigurMerge(f) {
    this.figurMergeSourceId = this.figurMergeSourceId === f.id ? null : f.id;
    this.figurMergeTargetId = '';
    this.figurMergeError = '';
  },

  async confirmFigurMerge(f) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.figurMergeBusy || !this.figurMergeTargetId) return;
    const target = (Alpine.store('catalog').figuren || []).find(x => x.id === this.figurMergeTargetId);
    if (!target) return;
    this.figurMergeBusy = true;
    this.figurMergeError = '';
    try {
      const data = await mergeFigurPair(bookId, { id: f.id, name: f.name }, { id: target.id, name: target.name });
      if (!data || String(Alpine.store('nav').selectedBookId) !== String(bookId)) return;
      this.figurMergeSourceId = null;
      this.figurMergeTargetId = '';
      this.figurPflegeMessage = figurMergeMessage(data, f, target);
    } catch (e) {
      console.error('[confirmFigurMerge]', e);
      this.figurMergeError = e.message;
    } finally {
      this.figurMergeBusy = false;
    }
  },

  // Buchwechsel/View-Reset: Formular, Merge-Auswahl und Meldung gehören zum alten Buch.
  _resetFigurPflege() {
    this.cancelFigurEdit();
    this.figurEditBusy = false;
    this.figurMergeSourceId = null;
    this.figurMergeTargetId = '';
    this.figurMergeBusy = false;
    this.figurMergeError = '';
    this.figurPflegeMessage = '';
  },
};
