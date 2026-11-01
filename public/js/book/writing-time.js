// Schreibzeit-Tracking: summiert die Sekunden, während editMode, focusActive oder
// bookEditorWriting (Bucheditor mit aktiviertem Abschnitt) aktiv sind, der Tab
// sichtbar ist UND der User innerhalb von IDLE_MS eine bewusste Eingabe (Taste,
// Klick, Scroll) gemacht hat. Im Bucheditor zählt Scrollen nicht als Eingabe:
// dort ist der ganze Manuskript-Stream offen, und Durchscrollen ist Lesen. Timer-Lifecycle, Clamp,
// Tab-Lease und Senden kommen aus [heartbeat-tracker.js](heartbeat-tracker.js);
// hier stehen nur die Unterschiede dieses Zählers.
//
// Idle-Cutoff (IDLE_MS): ein offen gelassener Editor ohne Eingabe akkumuliert
// nach Ablauf der Schwelle keine Zeit mehr — sonst zählt blosses Offenhalten als
// Schreibzeit. Editor öffnen / Tab wieder sichtbar machen gilt als Aktivität.
//
// `this` zeigt auf die Alpine-Komponente (via spread in app.js).

import { makeHeartbeatTracker } from './heartbeat-tracker.js';

const IDLE_MS = 180000; // 3 min ohne bewusste Eingabe → Editor gilt als untätig
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'wheel', 'input'];

// Nur der Bucheditor ist aktiv (kein Notebook-/Focus-Editor daneben).
const bookEditorOnly = (ctx) => ctx.bookEditorWriting && !ctx.editMode && !ctx.focusActive;

export const writingTimeMethods = {
  // Bucheditor offen + Abschnitt aktiviert; gesetzt von bookEditorCard (Root-State).
  bookEditorWriting: false,
  _writingLastActivity: null,
  _writingLastInput: null,

  ...makeHeartbeatTracker({
    name: 'writing',
    url: '/history/writing-time',
    methods: {
      active: '_writingTimeActive',
      setup: '_setupWritingTime',
      start: '_startWritingHeartbeat',
      stop: '_stopWritingHeartbeat',
      flush: '_flushWritingTime',
    },
    spec: {
      isActive: (ctx) => (ctx.editMode || ctx.focusActive || ctx.bookEditorWriting)
        && ctx.$store.nav.selectedBookId
        && document.visibilityState === 'visible',

      watch: [
        { get: 'editMode' },
        { get: 'focusActive' },
        { get: 'bookEditorWriting' },
        { get: (ctx) => ctx.$store.nav.selectedBookId, restart: true },
      ],

      // Editor öffnen / Tab-Rückkehr zählt als Aktivität.
      onStart: (ctx) => { ctx._writingLastActivity = ctx._writingLastInput = Date.now(); },

      extraSetup: (ctx, signal) => {
        const onActivity = (ev) => {
          const now = Date.now();
          ctx._writingLastActivity = now;
          if (ev.type !== 'wheel') ctx._writingLastInput = now;
        };
        for (const ev of ACTIVITY_EVENTS) {
          document.addEventListener(ev, onActivity, { signal, passive: true, capture: true });
        }
      },

      // Letzte bewusste Eingabe liegt länger als IDLE_MS zurück → Editor offen,
      // aber untätig. Intervall verfällt, statt Zeit zu buchen.
      skipTick: (ctx, now) => {
        const last = bookEditorOnly(ctx) ? ctx._writingLastInput : ctx._writingLastActivity;
        return last == null || now - last > IDLE_MS;
      },

      payload: (ctx, seconds) => {
        if (seconds <= 0) return null;
        const bookId = ctx.$store.nav.selectedBookId;
        return bookId ? { book_id: Number(bookId), seconds } : null;
      },
    },
  }),
};
