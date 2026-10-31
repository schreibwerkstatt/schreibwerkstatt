// Ereignis bearbeiten — gespreadet in ../ereignisse-card.js. Muster:
// book/figuren-pflege.js (Steckbrief).
//
// Ereignis-granular über PATCH /figures/zeitstrahl/:book_id/:event_id
// (db/zeitstrahl-patch.js). Der Server setzt dabei `manually_edited` — die
// Komplettanalyse ersetzt die Zeile danach nicht mehr und legt auch kein
// KI-Doppel daneben (Abzeichen «Manuell bearbeitet» in der Liste). Bearbeitbar
// sind nur Ereignisse mit `id`, also Zeilen des konsolidierten Zeitstrahls; der
// Figuren-Fallback eines unkonsolidierten Buchs steht in keiner Zeile.
//
// Kein `get x()` in diesem gespreadeten Modul (Spread-Getter-Falle).
import { SUBTYP_ICON } from './subtyp.js';

const _t = (key, params) => window.__app?.t?.(key, params) ?? key;

// Bearbeitbare Felder in Formular-Reihenfolge. Längen deckungsgleich mit
// db/zeitstrahl-patch.js#TEXT_FIELDS. `spell`: LanguageTool auf Prosa
// (public/CLAUDE.md); das Datum ist keine Prosa. `area`: mehrzeilig.
export const EVENT_EDIT_FIELDS = [
  { key: 'ereignis', max: 1000, spell: true },
  { key: 'datum_label', max: 100, hint: true },
  { key: 'typ', options: 'typ' },
  { key: 'subtyp', options: 'subtyp' },
  { key: 'bedeutung', max: 2000, spell: true, area: true },
];

const EVENT_TYPEN = ['persoenlich', 'extern'];

const _norm = (v) => (v == null ? '' : String(v).trim());

// Anzeigewert eines Felds am Ereignis (das Datum steht als Label im Formular).
function _current(ev, key) {
  if (key === 'datum_label') return ev?.datum_label || ev?.datum || '';
  return ev?.[key];
}

/** Pure: geänderte Felder zwischen Ereignis und Entwurf ({ key: wert|null }). */
export function eventEditDiff(ev, draft) {
  const out = {};
  for (const d of EVENT_EDIT_FIELDS) {
    const next = _norm(draft?.[d.key]);
    if (next !== _norm(_current(ev, d.key))) out[d.key] = next || null;
  }
  return out;
}

export const ereignisEditMethods = {
  eventEditFields() { return EVENT_EDIT_FIELDS; },

  // Optionen der Schlüssel-Felder (Combobox). Wert = Persistenz-Key.
  eventEditOptions(kind) {
    if (kind === 'typ') return EVENT_TYPEN.map(k => ({ value: k, label: _t('events.edit.typ.' + k) }));
    return Object.keys(SUBTYP_ICON).map(k => ({ value: k, label: _t('events.subtyp.' + k) }));
  },

  startEventEdit(ev) {
    if (ev?.id == null) return;
    this.eventEditId = ev.id;
    this.eventEditDraft = Object.fromEntries(EVENT_EDIT_FIELDS.map(d => [d.key, _current(ev, d.key) ?? '']));
    this.eventEditError = '';
    this.eventEditMessage = '';
  },

  cancelEventEdit() {
    this.eventEditId = null;
    this.eventEditDraft = {};
    this.eventEditError = '';
  },

  // Klick daneben (Inline-Edit, public/CLAUDE.md «Edit-Formulare»): nur wenn noch
  // dasselbe Ereignis offen ist und kein Request läuft; ein leerer Pflichttext
  // verwirft den Entwurf statt einen Fehler zu zeigen.
  commitEventEdit(ev) {
    if (this.eventEditId !== ev?.id || this.eventEditBusy) return;
    if (!_norm(this.eventEditDraft?.ereignis)) { this.cancelEventEdit(); return; }
    this.saveEventEdit(ev);
  },

  async saveEventEdit(ev) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.eventEditBusy || this.eventEditId !== ev?.id) return;
    const fields = eventEditDiff(ev, this.eventEditDraft);
    if (!Object.keys(fields).length) { this.cancelEventEdit(); return; }
    if ('ereignis' in fields && !fields.ereignis) { this.eventEditError = _t('events.edit.textRequired'); return; }
    this.eventEditBusy = true;
    this.eventEditError = '';
    try {
      const r = await fetch(`/figures/zeitstrahl/${encodeURIComponent(bookId)}/${encodeURIComponent(ev.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(window.__app.tError(data));
      if (String(Alpine.store('nav').selectedBookId) !== String(bookId)) return;
      // Nur schliessen, was noch offen ist: ein Klick auf «Bearbeiten» einer
      // anderen Zeile hat während des Requests schon deren Formular geöffnet.
      if (this.eventEditId === ev.id) this.cancelEventEdit();
      this.eventEditMessage = _t('events.edit.saved');
      await window.__app._reloadZeitstrahl();
    } catch (e) {
      console.error('[saveEventEdit]', e);
      this.eventEditError = e.message || _t('events.edit.saveError');
    } finally {
      this.eventEditBusy = false;
    }
  },
};
