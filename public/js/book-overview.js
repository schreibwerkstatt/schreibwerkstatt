// Buch-Übersicht: Default-Landing beim Öffnen eines Buchs.
// Aggregiert ohne neuen KI-Job aus zwei Quellen:
//   /overview/:book_id                 → ALLE Tile-Daten in einer Antwort (routes/overview.js:
//                                        Lektorat-Abdeckung + offene Fehler, Bewertungen,
//                                        Lektoratszeit, Recent, Figuren/Szenen/Schauplätze,
//                                        Songs, Plot, Motive, Wortschatz, Ideen, Buch-Chat,
//                                        Rückblick-Coverage nur für Tagebücher). Jeder Teil
//                                        trägt `data`, `forbidden` oder `error` —
//                                        Zuordnung zu Banner/still: load.js#OVERVIEW_PARTS.
//     (Figuren/Schauplätze/Szenen: liegt der Katalog des offenen Buchs schon im
//     catalog-Store, lässt `?skip=` sie aus; der Refresh fragt immer neu)
//   app-view/bookscope.js#loadDailyProgress → Snapshot-Verlauf + Buch-Einstellungen
//                                        (geteilt mit dem Header-Donut)
//   /history/stats-stale/:book_id      → Server-Urteil Stats-Staleness (Auto-Sync)
//   /history/book-stats, /history/coverage, /history/page-stats → Refresh nach Auto-Sync
//   $store.badges.editStatus           → Bearbeitungsstand (lädt der Seitenbaum, kein eigener Fetch)
//
// Reaktivität / Memoization:
// Aggregat-Methoden cachen ihr Ergebnis in `_memos` via `_memo(key, deps, fn)`:
// Cache-Hit nur wenn alle deps-Refs identisch zur letzten Compute. `loadBookOverview`
// und `resetBookOverview` weisen neue Arrays zu → Cache-Miss → Recompute. Die
// Methoden touchen weiterhin `this.overviewXxx`, damit Alpine die Reaktivität
// auch beim Cache-Hit korrekt trackt.
//
// Visualisierungen sind reines Inline-SVG (kein Chart.js): Overview soll
// instant beim Buchwechsel sichtbar sein, ohne Lazy-Lib-Load.
//
// Fehler vs. Recht: ein Teil mit `forbidden` (Betrachter ohne editor-Recht auf
// Figuren, Szenen, Schauplätze, Songs) ist kein Ladefehler — das Tile bleibt aus,
// der Fehler-Banner nicht (`overviewForbidden` statt `overviewLoadErrors`).
//
// Facade: spreadet alle Sub-Module in `bookOverviewMethods`. Sub-Methoden
// nutzen `this._memo` aus `load.js` (gemeinsamer Memo-Speicher pro Card).
// Reine Compute-Kerne ohne Alpine-Bindung liegen daneben und werden von den
// Fachmodulen importiert statt gespreadet: `presence.js` (Matrix-Mechanik der
// drei Präsenz-Tiles), `diverging.js` (Median-Balken der Kapitel-Tiles),
// `ranking.js` (Top-Listen-Auswahl), `iso-day.js` (Kalendertag-Arithmetik).
import { loadMethods } from './book-overview/load.js';
import { presenceMethods } from './book-overview/presence.js';
import { statsMethods } from './book-overview/stats.js';
import { coverageMethods } from './book-overview/coverage.js';
import { reviewMethods } from './book-overview/review.js';
import { figurenMethods } from './book-overview/figuren.js';
import { szenenMethods } from './book-overview/szenen.js';
import { orteMethods } from './book-overview/orte.js';
import { songsMethods as overviewSongsMethods } from './book-overview/songs.js';
import { kapitelMethods } from './book-overview/kapitel.js';
import { recentMethods } from './book-overview/recent.js';
import { formatMethods } from './book-overview/format.js';
import { diaryMethods } from './book-overview/diary.js';
import { projectionMethods } from './book-overview/projection.js';
import { plotMethods } from './book-overview/plot.js';
import { ideenMethods } from './book-overview/ideen.js';
import { motivMethods } from './book-overview/motiv.js';
import { wortschatzMethods } from './book-overview/wortschatz.js';
import { editStatusMethods } from './book-overview/edit-status.js';
import { nextStepsMethods } from './book-overview/next-steps.js';

export const bookOverviewMethods = {
  ...loadMethods,
  ...presenceMethods,
  ...statsMethods,
  ...projectionMethods,
  ...diaryMethods,
  ...coverageMethods,
  ...reviewMethods,
  ...figurenMethods,
  ...szenenMethods,
  ...orteMethods,
  ...overviewSongsMethods,
  ...kapitelMethods,
  ...recentMethods,
  ...formatMethods,
  ...plotMethods,
  ...ideenMethods,
  ...motivMethods,
  ...wortschatzMethods,
  ...editStatusMethods,
  ...nextStepsMethods,
};
