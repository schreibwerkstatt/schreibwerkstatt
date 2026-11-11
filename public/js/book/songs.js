// Musik-Methoden am Root-Spread (von app-view, toggleSongsCard gerufen).

import { fetchJson } from '../utils.js';
import { loadToken } from '../cards/book-guard.js';
import { assignCatalogList } from '../cards/catalog-store.js';
import { compareText } from '../i18n.js';
import { scrollToWhenReady } from '../utils/scroll-when-ready.js';

// Reihenfolge der Figuren-Rollen in der Detailansicht (aktiv vor passiv);
// Werte = lib/song-fig-rollen.js (gegated in tests/unit/songs-prompt.test.mjs).
export const FIG_ROLLEN = ['spielt', 'singt', 'komponiert', 'hört', 'erwähnt'];

export const songsMethods = {
  // Buchwechsel-/Doppel-Load-Guard: verspätete Antwort des vorigen Buchs (oder
  // eines älteren Loads) darf den Katalog nicht überschreiben.
  async loadSongs(bookId) {
    const isCurrent = loadToken(this, '_songsLoadSeq', bookId);
    try {
      const data = await fetchJson('/songs/' + bookId);
      if (!isCurrent()) return;
      // Gleiche Antwort → keine neue Array-Identitaet (catalog-store.js).
      assignCatalogList('songs', bookId, data?.songs || []);
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
    return [...seen].sort(compareText);
  },

  // Schlüssel, sortiert nach ihrer Anzeige (die Combobox zeigt die Übersetzung).
  songsKontextTypListe() {
    const seen = new Set();
    for (const s of this.$store.catalog.songs) {
      if (s.kontext_typ) seen.add(s.kontext_typ);
    }
    const label = k => this.t('songs.kontextTyp.' + k, { _default: k });
    return [...seen].sort((a, b) => compareText(label(a), label(b)));
  },

  // Figuren eines Songs nach Rolle gruppiert für die Detailansicht: je Rolle eine
  // Zeile («Spielt: Anna, Ben»), Figuren ohne Rolle unter «Figuren» am Schluss.
  songFigurGruppen(s) {
    const byRolle = new Map();
    for (const f of (s?.figuren || [])) {
      const r = FIG_ROLLEN.includes(f.kontext_typ) ? f.kontext_typ : '';
      (byRolle.get(r) ?? byRolle.set(r, []).get(r)).push(f.fig_id);
    }
    return [...FIG_ROLLEN, ''].filter(r => byRolle.has(r)).map(r => ({
      rolle: r,
      label: r ? this.t('songs.figRolle.' + r) : this.t('songs.figuren'),
      figIds: byRolle.get(r),
    }));
  },

  // Sprung auf einen Song (Entitäts-Referenz, Deep-Link #…/song/<uid>) — Muster wie
  // app-navigation.js#openOrtById: Karte öffnen (lädt den Katalog, darum keine
  // Vorab-Prüfung gegen einen evtl. noch leeren Katalog), Filter leeren, Zeile wählen,
  // Scroll über scrollToWhenReady (wartet auf die stabile Position der Zeile).
  async openSongById(id) {
    this._beginNavigation();
    try {
      // Alle Filter leeren, ohne die Schlüssel hier ein zweites Mal aufzuzählen
      // (SSoT: FILTER_SCOPES in app-view/_shared.js, alle Defaults '').
      // In-Place wie applyFilterScope: Bindings auf das Objekt bleiben gültig.
      const f = this.$store.catalogUi.songsFilters;
      for (const k of Object.keys(f)) f[k] = '';
      if (!this.showSongsCard) await this.toggleSongsCard({ skipCardScroll: true });
      this.$store.catalogUi.selectedSongId = id;
      await this.$nextTick();
      scrollToWhenReady(() => document.querySelector(`[data-song-id="${CSS.escape(String(id))}"]`));
    } finally {
      this._endNavigation();
    }
  },
};
