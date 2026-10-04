// Alpine.data('ideenBoardCard') — Ideen-Board: alle Notizen und Pendenzen eines
// Buches auf einem Brett.
//
// Verhaeltnis zur Ideen-Karte (`ideenCard`): dieselben Zeilen, zwei Fragen. Die
// Ideen-Karte steht neben dem Editor und beantwortet „was ist an DIESER Stelle
// offen"; das Board steht fuer sich und beantwortet „was ist im ganzen Buch
// offen und wie weit ist es". Darum ist es eine eigene Hauptkarte (exklusiv,
// Buch-skopiert) und nicht ein zweiter Modus der Ideen-Karte, die parallel zum
// Editor lebt.
//
// User-privat wie die Ideen selbst: `ideen.user_email` ist Sichtbarkeits-Scope,
// nicht Attribution — auf einem geteilten Buch sieht jeder sein eigenes Brett.

import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync, toggleWrapFullscreen } from '../fullscreen.js';
import { ideenBoardMethods } from '../book/ideen-board.js';
import { buildLaneOrder } from '../book/ideen-board/model.js';
import { LANE_BOOK, IDEE_STATUSES } from '../book/ideen-shared.js';
import { ideenChatMethods, ideenChatState } from '../chat/ideen-chat.js';

// Filterleiste pro Buch im localStorage. `showVerworfen` steht bewusst per
// Default auf false: das Board ist eine Pendenzenliste, und was man verworfen
// hat, soll beim Oeffnen nicht mitarbeiten. Die Spalte bleibt sichtbar (mit
// ihrem Zaehler), nur ihre Karten sind eingeklappt — verworfen ist eine Stufe,
// kein Loeschen.
//
// Im selben Scope liegt die KLAPPUNG (`collapsedLanes`, `collapsedChapters` —
// je eine Liste von Bahn-Keys): sie ist wie der Filter eine Sicht auf dasselbe
// Buch und soll den Kartenwechsel ueberleben — wer ein Buch mit dreissig
// Kapiteln einmal zusammengeklappt hat, will das nicht bei jedem Oeffnen
// wiederholen. Ein eigener Scope waere ein zweiter Schluessel fuer dieselbe
// Frage „wie sieht dieses Board fuer mich aus".
const IDEEN_BOARD_FILTER_SCOPES = [
  {
    scope: 'ideenBoard',
    defaults: { filterChapterId: '', showErledigt: false, showVerworfen: false, query: '', collapsedLanes: [], collapsedChapters: [], columnSort: {} },
  },
];

export function registerIdeenBoardCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('ideenBoardCard', () => ({
    ideen: [],
    laneOrder: [],
    // Aktive Stufen des Buches (book_settings.ideen_stages, kommt mit
    // /ideen/board). Default alle — so sieht ein Buch ohne Einstellung aus.
    stages: [...IDEE_STATUSES],
    // Schalter-Leiste „Spalten" unter dem Kopf.
    stagesOpen: false,
    // Native-Fullscreen-Status (gespiegelt vom fullscreenchange-Listener) —
    // mehr Platz fuers Raster; die Spalten wachsen ueber den Container mit.
    ideenBoardFullscreen: false,

    // Filterleiste + Klappung (Besitz: IDEEN_BOARD_FILTER_SCOPES).
    filterChapterId: '',
    showErledigt: false,
    showVerworfen: false,
    query: '',
    // Reihenfolge der Karten pro Spalte: Map Stufe → { by, dir }
    // (columnSortOf/nextColumnSort in ideen-board/model.js). Ohne Eintrag die
    // urspruengliche, per Drag gespeicherte Position (ideen.sort_order). Immer
    // als NEUES Objekt schreiben — der Default oben ist geteilt.
    columnSort: {},
    // Bahn-Keys. Immer als NEUE Liste schreiben (toggleLaneFold/toggleChapterFold
    // in ideen-board/actions.js) — die Defaults oben sind ein geteiltes Objekt,
    // und der Board-Memo vergleicht seine Deps per Identitaet.
    collapsedLanes: [],
    collapsedChapters: [],

    newContent: '',
    newLaneKey: LANE_BOOK,
    // Zuordnen einer Buch-Idee (ohne Anker) zu Kapitel/Seite.
    assigningId: null,
    assignLaneKey: '',
    editingId: null,
    editingDraft: '',

    // Verknuepfungs-Picker (ideen-links.js).
    linkTargets: {},
    _linkTargetsBookId: null,
    linkPickerIdeeId: null,
    linkPickerKind: 'research',
    linkPickerTargetId: '',
    // Popover-Geometrie des Pickers (nach <body> teleportiert, am Trigger
    // verankert — public/js/popover-anchor.js).
    linkPickerPos: { top: 0, left: 0 },
    _linkTriggerRect: null,
    _linkPickerCloseHandler: null,

    loading: false,
    busy: false,
    errorMessage: '',

    // SortableJS-Instanzen der Status-Zellen (eine je Bahn × Spalte).
    _boardSortables: [],
    // Speicher des EINEN Memo-Helfers der Karte (_memo in ideen-board/actions.js).
    _memos: {},
    _lifecycle: null,

    // Ideen-Chat: Panel neben dem Board (chat/ideen-chat.js). Vorschläge des Chats
    // laufen beim Übernehmen über dieselben /ideen-Routen wie die Board-Bearbeitung.
    ...ideenChatState(),

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'ideenBoard',
        showFlag: 'showIdeenBoardCard',
        filterScopes: IDEEN_BOARD_FILTER_SCOPES,
        resetState: { editingId: null, linkPickerIdeeId: null, assigningId: null, stagesOpen: false, busy: false },
        load: async () => { await this.loadBoard(); },
        onBookChanged: () => { this.resetBoard(); this.resetIdeenChat(); this.ideenChatOpen = false; },
        onViewReset: () => { this.resetBoard(); this.resetIdeenChat(); this.ideenChatOpen = false; },
      });

      // Native Fullscreen-API: Status spiegeln (Toggle-Button + Esc-Exit).
      attachFullscreenSync({
        resolveWrap: () => this.$root,
        signal: this._lifecycle.signal,
        onChange: (active) => { this.ideenBoardFullscreen = active; },
      });

      // Der Baum traegt die Bahnen-REIHENFOLGE (SSoT book_order). Er wird
      // asynchron geladen und kann sich unter dem offenen Board aendern (neue
      // Seite, Umsortieren, Collab-Nachzug) — ohne diesen Watcher stuenden die
      // betroffenen Ideen in der Sammelbahn, bis jemand die Karte neu oeffnet.
      this.$watch(() => this.$store.nav.tree, (tree) => {
        if (!window.__app?.showIdeenBoardCard) return;
        this.laneOrder = buildLaneOrder(tree);
        this._memos = {};
      });

      // Bahnen kommen und gehen mit dem Filter; die Drop-Zonen haengen an den
      // gerenderten Zellen und muessen darum neu angebunden werden, sobald eine
      // Bahn dazukommt oder verschwindet (anders als im Recherche-Board mit
      // seinen vier festen Spalten).
      //
      // Beobachtet wird die BAHNEN-SIGNATUR, nicht die Filterfelder: `x-for` mit
      // `:key` behaelt die Zellen einer bleibenden Bahn als dieselben DOM-Knoten,
      // ihre Sortable-Instanzen sind also weiter gueltig. An `query` gehaengt
      // wuerde dagegen jeder Tastendruck alle Instanzen wegwerfen und neu bauen.
      this.$watch(
        () => this.lanes().map(l => l.lane.key).join('|'),
        () => this._ensureBoardSortables(),
      );

      // Ziehen INNERHALB einer Spalte gibt es nur, solange sie in ihrer
      // urspruenglichen Position steht; die Option wird an den bestehenden
      // Instanzen umgeschaltet.
      this.$watch(() => this.columnSort, () => this._applyManualSortOption());
    },

    destroy() {
      this.resetIdeenChat();
      this._lifecycle?.destroy();
      this._destroyBoardSortables();
      this._detachLinkPickerListeners?.();
    },

    // Ganze Karte ins Native-Vollbild. Was sonst nach <body> haengt (Drag-
    // Ghost, Verknuepfungs-Picker), wird zur Anzeigezeit ins Vollbild-Element
    // umgehaengt — siehe actions.js#_initBoardSortables, ideen-links.js.
    async toggleIdeenBoardFullscreen() {
      try {
        await toggleWrapFullscreen(this.$root);
      } catch {
        this.errorMessage = window.__app.t('ideenBoard.error.fullscreen');
      }
    },

    ...ideenBoardMethods,
    ...ideenChatMethods,
  }));
}
