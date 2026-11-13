// Pflege-Formular der Schauplatz-Karte: anlegen, Stammdaten korrigieren, Elternort
// setzen, mit einem anderen Ort zusammenführen. In Alpine.data('orteCard')
// gespreadet; die Server-Calls liegen am Root (book/orte.js), hier nur Formular-
// State und Optionslisten. Geschickt werden nur geänderte Felder; der Server schützt
// genau diese (`manual_fields`) — die nächste Komplettanalyse überschreibt sie nicht.

import { ORT_TYPEN, ortTypLabel } from './ort-typen.js';
import { countryOptions } from '../country-codes.js';
import { compareText, tFetchError } from '../i18n.js';
import { entityMergeTargetOptions } from './entity-merge-picker.js';

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

  // Ziele: nur aktive Orte (ein verwaistes Ziel sperrt auch der Server, TARGET_STALE).
  ortMergeOptions(o) {
    return entityMergeTargetOptions('ort', o.id, Alpine.store('catalog'));
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

  // Aktueller Ort (Quelle) geht im gewählten Ziel auf.
  async mergeOrtInto(o) {
    const target = this.ortMergeTarget;
    if (!target) return;
    try {
      if (await window.__app.mergeOrt(o.id, target)) this.ortMergeTarget = '';
    } catch (e) {
      console.error('[mergeOrtInto]', e);
      // Server-Meldung (z.B. TARGET_STALE), Netzfehler usw.
      await window.__app.appAlert({ message: tFetchError(e) });
    }
  },
};
