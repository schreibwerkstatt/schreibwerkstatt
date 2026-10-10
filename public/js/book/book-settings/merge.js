// Verwaiste Katalog-Einträge zusammenführen (Figuren · Szenen · Schauplätze).
// Panel in der Danger-Zone der Bucheinstellungen, Partial
// public/partials/book-settings-merge.html. State im bookSettingsCard.
//
// Warum das Feature existiert: der Reconcile der Komplettanalyse löscht nicht mehr
// gefundene Einträge nicht, sondern markiert sie «nicht mehr im Text» (stale). Dafür
// gab es bisher nur «löschen» — und damit den Verlust aller Verknüpfungen, die am
// verwaisten Eintrag hingen (Plot-Beats, Recherche-Links, manuell editierte
// Ereignisse). Hier wählt der Autor Quelle + Ziel; der Server hängt alle Referenzen
// um und löscht die Quelle (Merge-Kern db/entity-merge.js).
//
// Grenze, die das Panel auch sichtbar sagt (merge.hint): nur Figuren bekommen einen
// dauerhaften Alias (figure_aliases). Bei Schauplätzen und Szenen legt die nächste
// Komplettanalyse für einen Namen, der noch im Buchtext steht, wieder einen Eintrag
// an — die umgehängten Referenzen bleiben beim Ziel.
//
// Buchwechsel während eines Requests: die Kandidaten tragen das Buch, zu dem sie
// gehören (`mergeCandidatesBookId`); eine Antwort, die nach dem Wechsel eintrifft,
// wird verworfen statt in die Listen des neuen Buchs geschrieben.

import { fetchJson } from './_shared.js';
import { figurMergeMessage } from '../figur-merge.js';

// Pro Gattung: Endpunkt-Basis, Listen-Feld der GET-Antwort, Namensfeld und die
// Body-Schlüssel des POST. Die `id` ist bei Figuren/Schauplätzen die öffentliche
// TEXT-Kennung (fig_id/loc_id), bei Szenen die INTEGER-PK — jeweils genau so, wie
// der zugehörige GET sie ausliefert.
const MERGE_KIND_CFG = {
  figur: { list: 'figuren', nameKey: 'name',  url: (b) => `/figures/${b}`,        body: (s, t) => ({ source: s, target: t }) },
  szene: { list: 'szenen',  nameKey: 'titel', url: (b) => `/figures/scenes/${b}`, body: (s, t) => ({ source_id: Number(s), target_id: Number(t) }) },
  ort:   { list: 'orte',    nameKey: 'name',  url: (b) => `/locations/${b}`,      body: (s, t) => ({ source: s, target: t }) },
};

export const MERGE_KINDS = Object.keys(MERGE_KIND_CFG);

export const mergeMethods = {
  // Gattungs-Reihenfolge des Panels. Getter statt Literal im Template, damit die
  // Liste nur an einer Stelle steht (Schlüssel = i18n-Suffix + MERGE_KIND_CFG-Key).
  get mergeKinds() { return MERGE_KINDS; },

  // Kandidatenlisten laden (verwaiste zuerst, dann alphabetisch). Bewusst in
  // karten-lokalen State statt in Alpine.store('catalog'): die drei Entitäten-Karten
  // sind zu den Bucheinstellungen exklusiv und laden beim Öffnen selbst.
  async loadMergeCandidates() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    const isCurrent = () => String(Alpine.store('nav').selectedBookId) === String(bookId);
    this.mergeLoading = true;
    this.mergeError = '';
    try {
      const results = await Promise.all(
        MERGE_KINDS.map(k => fetchJson(MERGE_KIND_CFG[k].url(bookId)).catch(() => null)),
      );
      // Buch inzwischen gewechselt: der book:changed-Reset hat den State schon
      // geleert — die Listen des alten Buchs nicht hineinschreiben.
      if (!isCurrent()) return;
      MERGE_KINDS.forEach((kind, i) => {
        const cfg = MERGE_KIND_CFG[kind];
        const rows = results[i]?.[cfg.list] || [];
        this.mergeLists[kind] = rows
          .map(r => ({ id: String(r.id), name: r[cfg.nameKey] || '', stale: !!r.stale }))
          .sort((a, b) => (b.stale - a.stale) || a.name.localeCompare(b.name));
      });
      this.mergeCandidatesBookId = String(bookId);
    } catch (e) {
      console.error('[loadMergeCandidates]', e);
      if (isCurrent()) this.mergeError = window.__app.t('merge.loadError');
    } finally {
      if (isCurrent()) this.mergeLoading = false;
    }
  },

  // Kandidaten erst laden, wenn der Gefahrenzone-Tab wirklich offen ist — die
  // Bucheinstellungen sollen nicht bei jedem Öffnen drei Katalog-Requests feuern.
  // Aus dem `x-effect` der Sektion gerufen (Argument = aktiver Tab).
  onMergeSectionVisible(tab) {
    if (tab !== 'danger') return;
    // Guard + Fetch bewusst NACH dem Effect-Lauf (queueMicrotask): würden
    // `mergeCandidatesBookId`/`mergeLoading` synchron im x-effect gelesen, wären sie
    // dessen Abhängigkeiten — und `loadMergeCandidates` schreibt genau sie, der
    // Effect würde sich also selbst nachtriggern. So hängt er nur am aktiven Tab.
    queueMicrotask(() => {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId || this.mergeCandidatesBookId === String(bookId) || this.mergeLoading) return;
      this.loadMergeCandidates();
    });
  },

  _mergeEntry(kind, id) {
    return (this.mergeLists[kind] || []).find(e => e.id === String(id)) || null;
  },

  mergeReady(kind) {
    const sel = this.mergeSel[kind];
    return !!(sel?.source && sel?.target && sel.source !== sel.target && !this.mergeBusy);
  },

  async mergeEntity(kind) {
    const cfg = MERGE_KIND_CFG[kind];
    const bookId = Alpine.store('nav').selectedBookId;
    const sel = this.mergeSel[kind];
    if (!cfg || !bookId || !this.mergeReady(kind)) return;
    const src = this._mergeEntry(kind, sel.source);
    const tgt = this._mergeEntry(kind, sel.target);
    if (!src || !tgt) return;

    if (!await window.__app.appConfirm({
      message: window.__app.t('merge.confirm', { source: src.name, target: tgt.name }),
      confirmLabel: window.__app.t('merge.button'),
      danger: true,
    })) return;

    const isCurrent = () => String(Alpine.store('nav').selectedBookId) === String(bookId);
    this.mergeBusy = true;
    this.mergeError = '';
    this.mergeMessage = '';
    try {
      const r = await fetch(`${cfg.url(bookId)}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg.body(sel.source, sel.target)),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(window.__app.tError(data));
      // Buch gewechselt, während der Merge lief: er ist geschehen, aber Meldung,
      // Auswahl und Kandidaten gehören dem alten Buch — der Reset hat sie geleert.
      if (!isCurrent()) return;

      // `moved` zählt die umgehängten Zeilen pro Brücke — für den User genügt die Summe.
      const moved = Object.values(data?.moved || {}).reduce((a, n) => a + (Number(n) || 0), 0);
      this.mergeMessage = kind === 'figur'
        ? figurMergeMessage(data, src, tgt)
        : window.__app.t('merge.done', { source: src.name, target: tgt.name, n: moved });
      this.mergeSel[kind] = { source: '', target: '' };
      // Offene/zwischengespeicherte Kataloge nachziehen, damit die gelöschte Quelle
      // aus den Entitäten-Karten verschwindet (gleiches Vorgehen wie beim
      // stale-Bulk-Cleanup in admin.js).
      window.__app.loadFiguren?.(bookId);
      window.__app.loadOrte?.(bookId);
      window.__app.loadSzenen?.(bookId);
      await this.loadMergeCandidates();
      if (this._mergeMsgTimer) clearTimeout(this._mergeMsgTimer);
      this._mergeMsgTimer = setTimeout(() => { this.mergeMessage = ''; this._mergeMsgTimer = null; }, 8000);
    } catch (e) {
      if (isCurrent()) this.mergeError = e.message;
    } finally {
      if (isCurrent()) this.mergeBusy = false;
    }
  },
};
