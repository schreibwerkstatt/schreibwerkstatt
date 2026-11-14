// Pflege-Formular der Schauplatz-Karte: anlegen, Stammdaten korrigieren, Elternort
// setzen; dazu Zeilen-Mechanik (Titel öffnet das Bearbeiten, Chevron/Zeilenkörper
// klappen auf) und Aktionsmenü. Zusammenführen läuft über den geteilten Merge-Picker
// (entity-merge-picker.js) aus dem Menü. In Alpine.data('orteCard')
// gespreadet; die Server-Calls liegen am Root (book/orte.js), hier nur Formular-
// State und Optionslisten. Geschickt werden nur geänderte Felder; der Server schützt
// genau diese (`manual_fields`) — die nächste Komplettanalyse überschreibt sie nicht.

import { ORT_TYPEN, ortTypLabel } from './ort-typen.js';
import { countryOptions } from '../country-codes.js';
import { compareText } from '../i18n.js';
import { isRowBodyClick, isFloatingLayerClick } from '../row-click.js';

const EMPTY_DRAFT = { name: '', typ: '', beschreibung: '', stimmung: '', land: '', parent: '' };

// Geschlossenes Formular. `ortEdit` ist nie null: Alpine wertet die Ausdrücke eines
// `x-if`-Blocks beim Schliessen noch einmal aus, bevor es ihn entfernt —
// `ortEdit.draft.name` auf null würfe dann in jedem Feld.
export function closedOrtEdit() {
  return { mode: null, id: null, draft: { ...EMPTY_DRAFT }, orig: { ...EMPTY_DRAFT }, busy: false, error: '' };
}

export const orteEditMethods = {
  ortTypLabel(typ) { return ortTypLabel(typ, (k, p) => window.__app.t(k, p)); },

  ortTypOptions() {
    return ORT_TYPEN.map(v => ({ value: v, label: this.ortTypLabel(v) }));
  },

  ortLandOptions() {
    return countryOptions(this._geoLang || 'de');
  },

  // Elternort-Kandidaten: alle aktiven Orte ausser dem Ort selbst und seinen
  // Nachfahren (sonst entstünde ein Zyklus; der Server prüft das zusätzlich).
  ortParentOptions(selfId) {
    const orte = Alpine.store('catalog').orte;
    const blocked = new Set();
    if (selfId) {
      blocked.add(selfId);
      let grew = true;
      while (grew) {
        grew = false;
        for (const o of orte) {
          if (o.parent && blocked.has(o.parent) && !blocked.has(o.id)) { blocked.add(o.id); grew = true; }
        }
      }
    }
    return orte.filter(o => !o.stale && !blocked.has(o.id))
      .map(o => ({ value: o.id, label: o.name }))
      .sort((a, b) => compareText(a.label, b.label));
  },

  ortChildren(o) {
    return Alpine.store('catalog').orte.filter(c => c.parent === o.id);
  },

  startOrtCreate() {
    this.ortEdit = { mode: 'new', id: null, draft: { ...EMPTY_DRAFT }, orig: { ...EMPTY_DRAFT }, busy: false, error: '' };
    if (this.viewMode === 'map') this.viewMode = 'list';
    this.$nextTick(() => this.$refs.ortEditName?.focus());
  },

  // Titel-Klick (DESIGN.md «Listen-Anriss»): Zeile aufklappen und direkt ins
  // Bearbeiten. Ein offenes Formular eines anderen Orts wird vorher gespeichert.
  async openOrtEdit(o) {
    if (this.isEditingOrt(o.id)) return;
    if (!await this._commitOtherOrtEdit(o)) return;
    if (this.ortEdit.mode === 'new') return;
    Alpine.store('catalogUi').selectedOrtId = o.id;
    this.startOrtEdit(o);
  },

  async ortToggleOpen(o) {
    if (this.isEditingOrt(o.id)) return;
    if (!await this._commitOtherOrtEdit(o)) return;
    const ui = Alpine.store('catalogUi');
    ui.selectedOrtId = ui.selectedOrtId === o.id ? null : o.id;
  },

  ortRowBodyClick(o, ev) {
    if (isRowBodyClick(ev)) this.ortToggleOpen(o);
  },

  // false = Speichern gescheitert, das offene Formular bleibt stehen.
  async _commitOtherOrtEdit(o) {
    const ed = this.ortEdit;
    if (ed.mode !== 'edit' || ed.id === o.id) return true;
    await this.commitOrtEdit();
    return this.ortEdit.mode !== 'edit';
  },

  // Klick daneben (Inline-Edit, public/CLAUDE.md «Edit-Formulare») — nur im
  // Bearbeiten einer Zeile, nicht bei der Neuanlage: kein Request läuft, leerer
  // Name verwirft. Klicks in schwebende Ebenen (Rechtschreib-Popover, Dialog,
  // Menü) zählen nicht.
  async commitOrtEdit(ev) {
    if (ev && isFloatingLayerClick(ev)) return;
    const ed = this.ortEdit;
    if (ed.mode !== 'edit' || ed.busy) return;
    if (!ed.draft.name.trim()) { this.cancelOrtEdit(); return; }
    await this.saveOrtEdit();
  },

  // Aktionsmenü einer Schauplatz-Zeile (action-menu.js); Ziel = loc_id.
  ortOpenMenu(ev, o) {
    if (this.isEditingOrt(o.id)) return;
    this.openActionMenu(ev, 'ort:' + o.id, o.id);
  },
  ortMenuOrt() {
    return Alpine.store('catalog').orte.find(o => o.id === this.actionMenuTarget) || null;
  },

  startOrtEdit(o) {
    const draft = {
      name: o.name || '', typ: o.typ || '', beschreibung: o.beschreibung || '',
      stimmung: o.stimmung || '', land: o.land || '', parent: o.parent || '',
    };
    this.ortEdit = { mode: 'edit', id: o.id, busy: false, error: '', draft, orig: { ...draft } };
  },

  cancelOrtEdit() { this.ortEdit = closedOrtEdit(); },

  isEditingOrt(id) { return this.ortEdit?.mode === 'edit' && this.ortEdit.id === id; },

  async saveOrtEdit() {
    const ed = this.ortEdit;
    if (!ed.mode || ed.busy) return;
    const d = ed.draft;
    if (!d.name.trim()) { ed.error = window.__app.t('orte.edit.error.NAME_REQUIRED'); return; }
    const all = {
      name: d.name, typ: d.typ || null, beschreibung: d.beschreibung, stimmung: d.stimmung,
      land: d.land || null, parent: d.parent || null,
    };
    // Bearbeiten: nur Felder, die sich gegenüber dem Formularstart geändert haben —
    // ein mitgeschicktes, unverändertes Feld würde sonst als «vom Autor korrigiert»
    // gegen die Analyse geschützt. Anlegen schickt alles.
    const fields = ed.mode === 'new' ? all : Object.fromEntries(
      Object.entries(all).filter(([k]) => String(d[k] ?? '').trim() !== String(ed.orig[k] ?? '').trim()));
    if (ed.mode === 'edit' && !Object.keys(fields).length) { this.ortEdit = closedOrtEdit(); return; }
    ed.busy = true;
    ed.error = '';
    try {
      const app = window.__app;
      if (ed.mode === 'new') {
        const id = await app.createOrt(fields);
        Alpine.store('catalogUi').selectedOrtId = id;
      } else {
        await app.updateOrt(ed.id, fields);
      }
      this.ortEdit = closedOrtEdit();
    } catch (e) {
      ed.error = window.__app.ortEditErrorText(e);
      ed.busy = false;
    }
  },

  // Geschützte Felder als lesbare Liste fürs Detail («Name, Beschreibung»).
  ortManualFieldsLabel(o) {
    return (o.manual_fields || []).map(f => window.__app.t('orte.col.' + f)).join(', ');
  },

  async restoreOrtAnalysis(o) {
    try {
      await window.__app.restoreOrtAnalysis(o);
    } catch (e) {
      console.error('[restoreOrtAnalysis]', e);
      await window.__app.appAlert({ message: window.__app.ortEditErrorText(e) });
    }
  },
};
