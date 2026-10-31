// Schlagworte in der Quellen-Karte: Liste der Bibliothek laden, im Formular
// setzen, Tabelle und Picker danach filtern. Wird in Alpine.data('sourcesCard')
// gespreadet (public/js/cards/sources-card.js).
//
// Ein Schlagwort gehoert dem Bibliothekseintrag, nicht dem Buch — es gilt in
// allen Arbeiten der Quelle, setzen kann es nur der Besitzer (Server-Schranke
// in routes/sources.js#PUT /:id). Die Vorschlagsliste kommt darum aus der
// eigenen Bibliothek (GET /sources/tags), nicht aus der Buchliste.

import { fetchJson } from '../utils.js';
import { normalizeTagList, hasAnyTag, MAX_TAGS } from './fields.js';
import { compareText } from '../i18n.js';

export const sourcesTagMethods = {
  /** Schlagworte der eigenen Bibliothek ([{ tag, count }]). Fehler bleiben
   *  still: ohne Liste fehlen nur die Vorschlaege, Tippen geht weiter. */
  async loadSourceTags() {
    try {
      const rows = await fetchJson('/sources/tags');
      this.srcPoolTags = Array.isArray(rows) ? rows : [];
    } catch (e) {
      this.srcPoolTags = [];
      console.error('[sources] Schlagworte laden fehlgeschlagen:', e);
    }
  },

  /** Combobox-Optionen fuer die Filter: Bibliothek plus alles, was an den
   *  gerade geladenen Zeilen haengt (Quellen eines Co-Autors tragen dessen
   *  Schlagworte, die GET /sources/tags nicht kennt). */
  srcTagOptions() {
    const seen = new Map();
    for (const t of this.srcPoolTags || []) seen.set(t.tag.toLowerCase(), t.tag);
    for (const s of this.sources || []) {
      for (const t of s.tags || []) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    }
    return [...seen.values()]
      .sort(compareText)
      .map(t => ({ value: t, label: t }));
  },

  /** Filter-Praedikat der Tabelle/des Pickers: ein gewaehltes Schlagwort. */
  srcMatchesTag(s, tag) {
    return hasAnyTag(s, tag ? [tag] : []);
  },

  // ── Formular ───────────────────────────────────────────────────────────────

  /** Eingabe ins Draft uebernehmen. Komma trennt, damit „zhaw, cas" in einem
   *  Zug zwei Schlagworte ergibt. */
  addSrcDraftTag(raw = this.srcTagInput) {
    const parts = String(raw || '').split(',');
    this.srcDraft.tags = normalizeTagList([...(this.srcDraft.tags || []), ...parts]);
    this.srcTagInput = '';
  },

  removeSrcDraftTag(tag) {
    this.srcDraft.tags = (this.srcDraft.tags || []).filter(t => t !== tag);
  },

  /** Vorschlaege unter dem Eingabefeld: Schlagworte der Bibliothek, die am
   *  Draft noch fehlen, gefiltert nach der laufenden Eingabe. */
  srcTagSuggestions() {
    const have = new Set((this.srcDraft.tags || []).map(t => t.toLowerCase()));
    if (have.size >= MAX_TAGS) return [];
    const q = String(this.srcTagInput || '').trim().toLowerCase();
    return (this.srcPoolTags || [])
      .map(t => t.tag)
      .filter(t => !have.has(t.toLowerCase()) && (!q || t.toLowerCase().includes(q)))
      .slice(0, 12);
  },

  onSrcTagKeydown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      this.addSrcDraftTag();
    } else if (e.key === 'Backspace' && !this.srcTagInput && this.srcDraft.tags?.length) {
      this.srcDraft.tags = this.srcDraft.tags.slice(0, -1);
    }
  },
};
