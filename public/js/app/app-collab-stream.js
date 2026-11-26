// Collab über den Event-Stream: der Buch-Kanal (public/js/event-stream.js,
// Server routes/events/book-channel.js) stösst an, die bestehenden Reads in
// app-collab.js holen die Daten. Der Stream trägt keine Change-Rows — Self-
// Filter, Geräte-Label und ACL bleiben in /changes und /presence.
//
// Reaktionen:
//   changed   voller Poll läuft → sofort ein Tick (Toast, Baum-Marker,
//             Konflikt-Banner); sonst Baum-Drift-Probe ohne Dedup
//   presence  Geräte-Ping (Zähler → Voll-Poll an/aus) + Presence-Read
//   reconnect alles einmal nachholen, Edit-Presence neu melden (die Rows können
//             während der Lücke abgelaufen sein)
//   gone      Geräte-Ping — seine 403 löst `_handleBookAccessLost` aus
//   meta      Bereiche ausserhalb des Manuskripts geändert (Ideen, Bearbeitungs-
//             stand, Recherche, Plot, Share-Links, Kommentare, Katalog …; Server
//             lib/live-writes.js): Zähler im Baum/Abschnittskopf neu, sichtbare
//             Karten dieses Bereichs still abgleichen (`card:refresh` mit
//             `source: 'wake'`), Kommentar-Leisten neu (SHARE_COMMENTS_CHANGED).
//             Nach einem Reconnect und — ohne offenen Stream — bei Tab-Rückkehr
//             für alle Bereiche.
//
// Tab-Kanal (tab-bus.js): Server-Anstoss und /changes filtern das eigene Gerät
// heraus, also auch die anderen Tabs desselben Browsers. Deren Manuskript-
// Writes kommen per BroadcastChannel und laufen durch denselben Pfad wie ein
// fremder Write (`_applyCollabChanges`, Gerät „anderer Tab"); Meta-Writes
// trennt der Server selbst per Tab-ID.
//
// Die Timer in app-collab.js laufen weiter. Bei offenem Buch-Stream überspringt
// jeder seine Ticks bis zum Sicherheitsabstand in STREAM_SAFETY_MS: der Stream
// liefert die Änderungen, und sein Server-Heartbeat hält die eigenen
// Presence-Rows frisch. Ohne Stream (Proxy, Reconnect, alter Browser) tickt
// alles im normalen Takt.

import { setEventStreamBook, bookStreamOpen, onBookStream } from '../event-stream.js';
import { onTabEvent } from '../tab-bus.js';
import { EVT } from '../events.js';
import { EXCLUSIVE_CARDS } from '../cards/feature-registry.js';

// Bereich (Server lib/live-writes.js#LIVE_KINDS) → sichtbare Karten, die still
// nachladen. Bereiche mit Plaketten im Baum/Abschnittskopf stehen in
// KIND_BADGES. Neuer Bereich: Server-Zeile + hier eine Zeile (+ ggf. Nachlader).
export const KIND_CARDS = {
  ideen: ['ideenBoard'],
  redaktion: ['bookOrganizer', 'bookOverview'],
  recherche: ['recherche'],
  plot: ['plot'],
  shareLinks: ['shareLinks'],
  comments: ['shareLinks'],
  figuren: ['figures', 'figurWerkstatt'],
  orte: ['orte'],
  motiv: ['motiv'],
  songs: ['songs'],
  weltfakten: ['weltfakten'],
  quellen: ['sources'],
  fassungen: ['snapshots'],
  chat: [],
};
const ALL_KINDS = Object.keys(KIND_CARDS);
// Zähler je Bereich: gezielte Nachlader am Root (app-view/badges.js,
// tree/edit-status.js). Jeder lädt nur seine Maps und behält bei einem
// Netzfehler den alten Stand.
const KIND_BADGES = {
  ideen: ['refreshIdeenCounts', '_loadCurrentPageBadges'],
  recherche: ['refreshRechercheCounts'],
  plot: ['refreshPlotBeatCounts'],
  shareLinks: ['refreshShareLinkCounts'],
  comments: ['refreshShareCommentCounts'],
  redaktion: ['refreshPageStatus'],
  chat: ['_loadCurrentPageBadges'],
};
// Voll-Abgleich (alle Bereiche) nach Reconnect/Tab-Rückkehr höchstens so oft —
// eine flatternde Verbindung meldet sonst bei jedem Wiederverbinden alles neu.
const RESYNC_MIN_MS = 30_000;
let lastResync = 0;
// Meldungen kurz sammeln: eine Board-Aktion schreibt oft mehrfach hintereinander.
const META_DEBOUNCE_MS = 300;
// Modul-Zustand statt Store: ein Root je Seite, und nichts davon ist Anzeige.
let metaPending = new Set();
let metaTimer = null;

// Sichtbare Karten, die einer der Bereiche betrifft (pure, Node-testbar).
export function cardsForKinds(kinds, isVisible) {
  const keys = new Set();
  for (const k of kinds) for (const key of KIND_CARDS[k] || []) keys.add(key);
  return EXCLUSIVE_CARDS.filter((c) => keys.has(c.key) && isVisible(c));
}

// Abstand, nach dem ein Timer trotz offenem Stream wieder selbst tickt.
//   poll      fängt ab, was kein Anstoss meldet: stumm abgelaufene fremde
//             Presence (Tab-Crash ohne DELETE)
//   ping      Geräte-Zähler nach stummem Wegfall eines Zweitgeräts
//   presence  eigener Edit-Heartbeat — deutlich unter dem 90-s-Stale-Fenster
//             bräuchte es ihn nur, wenn der Server-Heartbeat ausfiele
const STREAM_SAFETY_MS = { poll: 30_000, ping: 120_000, presence: 60_000 };

export const appCollabStreamMethods = {
  _attachCollabStream(bookId) {
    if (!this.$store.collab._streamOff) {
      this.$store.collab._streamOff = onBookStream((ev) => this._onCollabStreamEvent(ev));
      onTabEvent((ev) => this._onTabEvent(ev));
      // Ohne offenen Stream gibt es keine Meta-Anstösse: die Rückkehr in den
      // Tab holt den Stand nach (einmal registriert, wie das Abo).
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        const id = this.$store.nav.selectedBookId;
        if (id && !bookStreamOpen(id)) this._resyncBookMeta();
      });
    }
    setEventStreamBook(bookId || null);
  },

  _detachCollabStream() {
    setEventStreamBook(null);
  },

  // Zeitstempel eines gesendeten Ticks; `_collabStreamCovers` rechnet damit.
  _markCollabSent(kind) {
    this.$store.collab._lastSent[kind] = Date.now();
  },

  // true = der Timer-Tick darf ausfallen, weil der Stream das Buch abdeckt und
  // der letzte eigene Tick jünger als der Sicherheitsabstand ist.
  _collabStreamCovers(bookId, kind) {
    if (!bookStreamOpen(bookId)) return false;
    return Date.now() - (this.$store.collab._lastSent[kind] || 0) < STREAM_SAFETY_MS[kind];
  },

  // Meta-Bereiche geändert: sammeln, dann einmal nachladen.
  _onBookMetaChanged(kinds) {
    for (const k of kinds || []) metaPending.add(k);
    if (metaTimer) return;
    metaTimer = setTimeout(() => {
      metaTimer = null;
      const pending = [...metaPending];
      metaPending = new Set();
      this._applyBookMeta(pending);
    }, META_DEBOUNCE_MS);
  },

  // Alle Bereiche nachholen (Reconnect, Tab-Rückkehr ohne Stream), gedrosselt.
  _resyncBookMeta() {
    const now = Date.now();
    if (now - lastResync < RESYNC_MIN_MS) return;
    lastResync = now;
    this._onBookMetaChanged(ALL_KINDS);
  },

  _loadCurrentPageBadges() {
    if (this.currentPage?.id) return this._loadPageBadgeCounts?.(this.currentPage.id);
  },

  _applyBookMeta(kinds) {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || !kinds.length) return;
    const loaders = new Set();
    for (const k of kinds) for (const m of KIND_BADGES[k] || []) loaders.add(m);
    for (const m of loaders) this[m]?.();
    if (kinds.includes('comments')) window.dispatchEvent(new CustomEvent(EVT.SHARE_COMMENTS_CHANGED));
    for (const c of cardsForKinds(kinds, (card) => !!this[card.flag])) {
      window.dispatchEvent(new CustomEvent(EVT.CARD_REFRESH, { detail: { name: c.refreshName || c.key, source: 'wake' } }));
    }
    window.dispatchEvent(new CustomEvent(EVT.BOOK_META_CHANGED, { detail: { bookId, kinds } }));
  },

  // Anderer Tab dieses Browsers hat das Manuskript geschrieben (tab-bus.js).
  _onTabEvent(ev) {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || !ev || Number(ev.bookId) !== Number(bookId)) return;
    if (ev.type === 'structure') { this._checkTreeDrift(bookId, { force: true }); return; }
    if (ev.type !== 'page-saved' || !ev.pageId) return;
    this._applyCollabChanges([{
      page_id: Number(ev.pageId),
      page_name: ev.pageName || null,
      kind: 'update',
      is_self: true,
      device_label: this.t('collab.device.otherTab'),
    }]);
  },

  _onCollabStreamEvent(ev) {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || !ev) return;
    const fullPoll = !!this.$store.collab._collabPollTimer;
    if (ev.gone) { this._sendBookDevicePing(bookId); return; }
    if (ev.reconnect) this._resyncBookMeta();
    else if (Array.isArray(ev.meta) && ev.meta.length) this._onBookMetaChanged(ev.meta);
    if (ev.reconnect) {
      const pid = this.$store.collab._presencePingPageId;
      if (pid) this._sendPresencePing(pid);
      this._sendBookDevicePing(bookId);
      if (fullPoll) this._collabPollOnce(bookId);
      else this._checkTreeDrift(bookId, { force: true });
      return;
    }
    // Reiner Meta-Anstoss betrifft das Manuskript nicht.
    if (!ev.changed && !ev.presence) return;
    if (ev.presence) this._sendBookDevicePing(bookId);
    if (fullPoll) this._collabPollOnce(bookId);
    else if (ev.changed) this._checkTreeDrift(bookId, { force: true });
  },
};
