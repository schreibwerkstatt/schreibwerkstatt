// Schauplatz-Methoden am Root-Spread (von app-view, Szenen-Trigger, toggleOrteCard
// und der Schauplatz-Karte gerufen). Pflege-Endpunkte: docs/schauplaetze.md.

import { fetchJson } from '../utils.js';

// Server-`error_code` der Pflege-Routen → i18n-Key; Unbekanntes fällt auf den
// generischen Speicherfehler.
const EDIT_ERRORS = new Set(['NAME_REQUIRED', 'FIELD_TOO_LONG', 'INVALID_LAND', 'PARENT_NOT_FOUND', 'PARENT_CYCLE', 'NOT_FOUND', 'NOT_DELETABLE']);

async function _send(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(json?.error_code || `HTTP ${r.status}`);
    err.code = json?.error_code || null;
    throw err;
  }
  return json;
}

export const orteMethods = {
  async loadOrte(bookId) {
    try {
      const data = await fetchJson('/locations/' + bookId);
      this.$store.catalog.orte = data?.orte || [];
      this.$store.catalogUi.orteUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadOrte]', e);
    }
  },

  // Fehlertext für die Pflege-Formulare der Schauplatz-Karte.
  ortEditErrorText(e) {
    return EDIT_ERRORS.has(e?.code) ? this.t('orte.edit.error.' + e.code) : this.t('orte.edit.error.save');
  },

  // Neu anlegen. fields: { name, typ, beschreibung, stimmung, land, parent }.
  // Liefert die neue loc_id; wirft bei Fehler (Caller zeigt ortEditErrorText).
  async createOrt(fields) {
    const bookId = this.$store.nav.selectedBookId;
    const res = await _send('POST', '/locations/' + bookId, fields);
    await this.loadOrte(bookId);
    return res.id;
  },

  // Stammdaten korrigieren (Teilmenge der Felder). Wirft bei Fehler.
  async updateOrt(locId, fields) {
    const bookId = this.$store.nav.selectedBookId;
    await _send('PATCH', `/locations/${bookId}/${encodeURIComponent(locId)}`, fields);
    await this.loadOrte(bookId);
  },

  // Quelle in Ziel verschmelzen (Kapitel, Figuren, Szenen, Plot-Beats, Recherche-
  // Links und Unterorte wandern mit). Szenen neu laden — ihre ort_ids zeigen danach
  // aufs Ziel.
  async mergeOrt(sourceId, targetId) {
    const bookId = this.$store.nav.selectedBookId;
    const src = this.$store.catalog.orte.find(o => o.id === sourceId);
    const tgt = this.$store.catalog.orte.find(o => o.id === targetId);
    if (!src || !tgt) return false;
    if (!await this.appConfirm({
      message: this.t('orte.merge.confirm', { source: src.name, target: tgt.name }),
      confirmLabel: this.t('orte.merge.action'),
    })) return false;
    await _send('POST', `/locations/${bookId}/merge`, { source: sourceId, target: targetId });
    await Promise.all([this.loadOrte(bookId), this.loadSzenen(bookId)]);
    this.$store.catalogUi.selectedOrtId = targetId;
    return true;
  },

  // Endgültig löschen — nur verwaiste («nicht mehr im Text») und selbst angelegte
  // Orte; ein aktiver Analyse-Ort käme mit dem nächsten Lauf ohnehin zurück.
  async deleteOrt(o) {
    if (!o || (!o.stale && !o.manually_created)) return;
    if (!await this.appConfirm({
      message: this.t(o.stale ? 'orte.confirmDeleteStale' : 'orte.confirmDeleteManual', { name: o.name }),
      confirmLabel: this.t('common.delete'), danger: true,
    })) return;
    try {
      await _send('DELETE', `/locations/${this.$store.nav.selectedBookId}/${encodeURIComponent(o.id)}`);
      // Kinder hängen danach an der Wurzel (SET NULL) — neu laden statt lokal filtern.
      await this.loadOrte(this.$store.nav.selectedBookId);
    } catch (e) {
      console.error('[deleteOrt]', e);
    }
  },

  // Nur Koordinaten patchen (Marker-Drag, Undo/Redo, Georef löschen) — race-frei
  // gegenüber anderen Edits. patches: [{id,lat,lng}].
  // Liefert true/false; Caller spiegeln optimistisch und rollen bei false zurück.
  async patchOrtCoords(patches) {
    if (!Array.isArray(patches) || !patches.length) return true;
    try {
      const r = await fetch('/locations/' + this.$store.nav.selectedBookId + '/coords', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patches }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return true;
    } catch (e) {
      console.error('[patchOrtCoords]', e);
      return false;
    }
  },
};
