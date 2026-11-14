// figurPflegeMethods — Katalog-Pflege in der Figurenkarte, gespreadet in
// cards/figuren-card.js:
//   * Steckbrief bearbeiten: figur-granular über PATCH /figures/:book_id/:fig_id
//     (db/figures/patch.js). Der Server setzt dabei `manually_edited` — die
//     Komplettanalyse überschreibt die gepflegten Felder danach nicht mehr
//     (Abzeichen «vom Autor gepflegt» in der Liste).
//   * Zeilen-Mechanik (Titel öffnet das Bearbeiten, Chevron/Zeilenkörper klappen
//     auf), Inline-Edit-Commit bei Klick daneben, Aktionsmenü und Sammel-Löschen
//     der verwaisten Figuren.
//   * «Zusammenführen mit …» (aktive und verwaiste Figuren) ist der geteilte
//     Merge-Picker aller Katalog-Listen (book/entity-merge-picker.js); hier nur
//     dessen Reset beim Buchwechsel.
//
// Kein `get x()` in diesem gespreadeten Modul (Spread-Getter-Falle).

const _t = (key, params) => window.__app?.t?.(key, params) ?? key;
import { sendJson } from '../utils/net.js';
import { tFetchError } from '../i18n.js';
import { FIGUR_TYPEN } from './figur-typen.js';
import { SCHICHT_LEVEL } from '../graph/constants.js';
import { isSelectedBook } from '../cards/book-guard.js';
import { isRowBodyClick, isFloatingLayerClick } from '../row-click.js';

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
  // Ja/Nein: die Ich-Erzählstimme (figures.ist_erzaehler) — die Alters-Analyse ordnet ihr
  // die Ich-Sätze der Erzählung zu.
  { key: 'ist_erzaehler', flag: true },
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
    if (d.flag) {
      if (!!draft?.[d.key] !== !!fig?.[d.key]) out[d.key] = !!draft?.[d.key];
      continue;
    }
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

  // Zeile (DESIGN.md «Listen-Anriss»): Titel-Klick öffnet das Bearbeiten, Chevron
  // und übriger Zeilenkörper klappen auf/zu. Eine Zeile im Bearbeiten-Modus klappt
  // nicht zu; ein offenes Formular einer anderen Figur wird vorher gespeichert.
  async openFigurEdit(f) {
    if (this.figurEditId === f.id) return;
    if (!await this._commitOtherFigurEdit(f)) return;
    Alpine.store('catalogUi').selectedFigurId = f.id;
    this.startFigurEdit(f);
  },

  async figurToggleOpen(f) {
    if (this.figurEditId === f.id) return;
    if (!await this._commitOtherFigurEdit(f)) return;
    const ui = Alpine.store('catalogUi');
    ui.selectedFigurId = ui.selectedFigurId === f.id ? null : f.id;
  },

  figurRowBodyClick(f, ev) {
    if (isRowBodyClick(ev)) this.figurToggleOpen(f);
  },

  // Offenes Formular einer ANDEREN Figur committen, bevor eine neue Zeile aufgeht —
  // nie still verwerfen. false = Speichern gescheitert (Formular bleibt offen).
  async _commitOtherFigurEdit(f) {
    const openId = this.figurEditId;
    if (openId == null || openId === f.id) return true;
    const prev = Alpine.store('catalog').figuren.find(x => x.id === openId);
    if (!prev) { this.cancelFigurEdit(); return true; }
    await this.commitFigurEdit(prev);
    return this.figurEditId !== openId;
  },

  // Klick daneben (Inline-Edit, public/CLAUDE.md «Edit-Formulare»): nur wenn noch
  // dieselbe Figur offen ist und kein Request läuft; ein leerer Name verwirft den
  // Entwurf. Klicks in schwebende Ebenen (Rechtschreib-Popover, Dialog) zählen nicht.
  async commitFigurEdit(f, ev) {
    if (ev && isFloatingLayerClick(ev)) return;
    if (this.figurEditId !== f?.id || this.figurEditBusy) return;
    if (!_norm(this.figurEditDraft?.name)) { this.cancelFigurEdit(); return; }
    await this.saveFigurEdit(f);
  },

  // Aktionsmenü einer Figurenzeile (action-menu.js); Ziel = fig_id. Im Formular
  // bleibt der native Rechtsklick des Textfelds.
  figurOpenMenu(ev, f) {
    if (this.figurEditId === f.id) return;
    this.openActionMenu(ev, 'figur:' + f.id, f.id);
  },
  figurMenuFigur() {
    return Alpine.store('catalog').figuren.find(f => f.id === this.actionMenuTarget) || null;
  },

  // Verwaiste Figuren («nicht mehr im Text»), Sammel-Löschen wie bei Schauplätzen/Szenen.
  figurStaleCount() {
    const figuren = Alpine.store('catalog').figuren;
    return this._memo('stale', [figuren], () => figuren.filter(f => f.stale).length);
  },

  async deleteAllStaleFiguren() {
    const n = this.figurStaleCount();
    const bookId = Alpine.store('nav').selectedBookId;
    if (!n || !bookId || this.figurStaleDeleting) return;
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.tn('figuren.confirmDeleteAllStale', n),
      confirmLabel: _t('common.delete'), danger: true,
    })) return;
    this.figurStaleDeleting = true;
    try {
      await sendJson(`/figures/${encodeURIComponent(bookId)}/stale`, 'DELETE');
      if (isSelectedBook(bookId)) await app.loadFiguren(bookId);
    } catch (e) {
      console.error('[deleteAllStaleFiguren]', e);
      if (isSelectedBook(bookId)) Alpine.store('catalogUi').figurenStatus = tFetchError(e) || _t('common.deleteFailed');
    } finally {
      this.figurStaleDeleting = false;
    }
  },

  startFigurEdit(f) {
    this.figurEditId = f.id;
    this.figurEditDraft = Object.fromEntries(FIGUR_EDIT_FIELDS.map(d => [d.key, d.flag ? !!f[d.key] : (f[d.key] ?? '')]));
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
      await sendJson(`/figures/${encodeURIComponent(bookId)}/${encodeURIComponent(f.id)}`, 'PATCH', { fields });
      if (!isSelectedBook(bookId)) return;
      this.cancelFigurEdit();
      this.figurPflegeMessage = _t('figuren.edit.saved', { name: fields.name || f.name });
      await window.__app.loadFiguren(bookId);
      // Die Geburt für die Schullaufbahn rechnet der Server — nach einem neuen
      // Geburtsdatum neu holen, sonst rechnet der Steckbrief mit dem alten.
      if ('geburtstag' in fields) this.loadFigurenSchulwege?.();
    } catch (e) {
      console.error('[saveFigurEdit]', e);
      this.figurEditError = tFetchError(e) || _t('figuren.edit.saveError');
    } finally {
      this.figurEditBusy = false;
    }
  },

  // Buchwechsel/View-Reset: Formular, Merge-Auswahl und Meldung gehören zum alten Buch.
  _resetFigurPflege() {
    this.cancelFigurEdit();
    this.figurEditBusy = false;
    this.figurStaleDeleting = false;
    this.closeActionMenu?.();
    this._resetMergePick();
    this.figurPflegeMessage = '';
  },
};
