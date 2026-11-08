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
// Grenze, die das Panel auch sichtbar sagt (merge.hint): Figuren und Schauplätze
// bekommen einen dauerhaften Alias (figure_aliases/location_aliases). Bei Szenen legt
// die nächste Komplettanalyse für einen Titel, der noch im Buchtext steht, wieder
// einen Eintrag an — die umgehängten Referenzen bleiben beim Ziel. Ein verwaister
// Schauplatz taugt nicht als Ziel (Server: TARGET_STALE), die Ziel-Liste blendet ihn aus.
//
// Buchwechsel während eines Requests: die Kandidaten tragen das Buch, zu dem sie
// gehören (`mergeCandidatesBookId`); eine Antwort, die nach dem Wechsel eintrifft,
// wird verworfen statt in die Listen des neuen Buchs geschrieben.

import { fetchJson } from './_shared.js';
import { MERGE_KIND_CFG, MERGE_KINDS, confirmEntityMerge, postEntityMerge, entityMergeMessage, reloadCatalogsAfterMerge } from '../entity-merge.js';
import { compareText } from '../../i18n.js';

export const mergeMethods = {
  // Gattungs-Reihenfolge des Panels. Getter statt Literal im Template, damit die
  // Liste nur an einer Stelle steht (Schlüssel = i18n-Suffix + MERGE_KIND_CFG-Key).
  get mergeKinds() { return MERGE_KINDS; },

  // Kandidatenlisten laden (verwaiste zuerst, dann alphabetisch). Bewusst in
  // karten-lokalen State statt in Alpine.store('catalog'): die drei Entitäten-Karten
  // sind zu den Bucheinstellungen exklusiv und laden beim Öffnen selbst.
  async loadMergeCandidates() {
    const bookId = this._selectedBookId();
    if (!bookId) return;
    this.mergeLoading = true;
    this.mergeError = '';
    try {
      const results = await Promise.all(
        MERGE_KINDS.map(k => fetchJson(MERGE_KIND_CFG[k].url(bookId)).catch(() => null)),
      );
      // Buch inzwischen gewechselt: der book:changed-Reset hat den State schon
      // geleert — die Listen des alten Buchs nicht hineinschreiben.
      if (!this._isSelectedBook(bookId)) return;
      MERGE_KINDS.forEach((kind, i) => {
        const cfg = MERGE_KIND_CFG[kind];
        const rows = results[i]?.[cfg.list] || [];
        this.mergeLists[kind] = rows
          .map(r => ({ id: String(r.id), name: r[cfg.nameKey] || '', stale: !!r.stale }))
          .sort((a, b) => (b.stale - a.stale) || compareText(a.name, b.name));
      });
      this.mergeCandidatesBookId = String(bookId);
    } catch (e) {
      console.error('[loadMergeCandidates]', e);
      if (this._isSelectedBook(bookId)) this.mergeError = window.__app.t('merge.loadError');
    } finally {
      if (this._isSelectedBook(bookId)) this.mergeLoading = false;
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
      const bookId = this._selectedBookId();
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
    const bookId = this._selectedBookId();
    const sel = this.mergeSel[kind];
    if (!cfg || !bookId || !this.mergeReady(kind)) return;
    const src = this._mergeEntry(kind, sel.source);
    const tgt = this._mergeEntry(kind, sel.target);
    if (!src || !tgt) return;

    if (!await confirmEntityMerge(src.name, tgt.name)) return;

    this.mergeBusy = kind; // Gattung, deren Knopf den Spinner zeigt; truthy sperrt alle
    this.mergeError = '';
    this.mergeMessage = '';
    try {
      const data = await postEntityMerge(kind, bookId, sel.source, sel.target);
      // Buch gewechselt, während der Merge lief: er ist geschehen, aber Meldung,
      // Auswahl und Kandidaten gehören dem alten Buch — der Reset hat sie geleert.
      if (!this._isSelectedBook(bookId)) return;
      this.mergeMessage = entityMergeMessage(kind, data, src, tgt);
      this.mergeSel[kind] = { source: '', target: '' };
      reloadCatalogsAfterMerge(bookId);
      await this.loadMergeCandidates();
      this._flash('mergeMessage', 8000, '');
    } catch (e) {
      if (this._isSelectedBook(bookId)) this.mergeError = e.message;
    } finally {
      if (this._isSelectedBook(bookId)) this.mergeBusy = false;
    }
  },
};
