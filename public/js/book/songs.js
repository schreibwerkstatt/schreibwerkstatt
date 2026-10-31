// Musik-Methoden am Root-Spread (von app-view, toggleSongsCard gerufen).

import { fetchJson } from '../utils.js';
import { loadToken } from '../cards/book-guard.js';

export const songsMethods = {
  // Buchwechsel-/Doppel-Load-Guard: verspätete Antwort des vorigen Buchs (oder
  // eines älteren Loads) darf den Katalog nicht überschreiben.
  async loadSongs(bookId) {
    const isCurrent = loadToken(this, '_songsLoadSeq', bookId);
    try {
      const data = await fetchJson('/songs/' + bookId);
      if (!isCurrent()) return;
      this.$store.catalog.songs = data?.songs || [];
      this.$store.catalogUi.songsUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadSongs]', e);
    }
  },

  songsKapitelOptionen() {
    return this._kapitelOptionen((this.$store.catalog.songs || []).flatMap(s => (s.kapitel || []).map(k => k.chapter_id)));
  },

  songsGenreListe() {
    const seen = new Set();
    for (const s of this.$store.catalog.songs) {
      if (s.genre) seen.add(s.genre);
    }
    return [...seen].sort();
  },

  songsKontextTypListe() {
    const seen = new Set();
    for (const s of this.$store.catalog.songs) {
      if (s.kontext_typ) seen.add(s.kontext_typ);
    }
    return [...seen].sort();
  },

  openSongById(id) {
    if (!this.$store.catalog.songs.some(s => s.id === id)) return;
    if (typeof this.toggleSongsCard === 'function' && !this.showSongsCard) this.toggleSongsCard();
    // Alle Filter leeren, ohne die Schlüssel hier ein zweites Mal aufzuzählen
    // (SSoT: FILTER_SCOPES in app-view/_shared.js, alle Defaults '').
    // In-Place wie applyFilterScope: Bindings auf das Objekt bleiben gültig.
    const f = this.$store.catalogUi.songsFilters;
    for (const k of Object.keys(f)) f[k] = '';
    this.$store.catalogUi.selectedSongId = id;
    setTimeout(() => {
      const el = document.querySelector(`[data-song-id="${id}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  },
};
