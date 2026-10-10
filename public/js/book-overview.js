// Buch-Übersicht: Default-Landing beim Öffnen eines Buchs.
// Aggregiert ohne neuen KI-Job aus existierenden Endpoints:
//   /history/book-stats/:book_id       → Snapshot-Verlauf (Sparkline + Last-Snapshot)
//   /history/coverage/:book_id         → Lektorat-Abdeckung
//   /history/fehler-heatmap/:book_id   → Top-Fehlertypen (mode=open)
//   /history/review/:book_id           → letzte + vorletzte Bewertung (Trend)
//   /history/lektorat-time/:book_id    → Lektoratszeit pro Kapitel
//   /history/rueckblick-coverage/:id   → Rückblick-Heatmap (nur buchtyp 'tagebuch')
//   /history/stats-stale/:book_id      → Server-Urteil Stats-Staleness (Auto-Sync)
//   /history/page-stats/:book_id       → tokEsts-Refresh nach Auto-Sync
//   /usage/page/recent                 → zuletzt geöffnete Abschnitte (mit Puffer, siehe load.js)
//   /figures/:book_id, /figures/scenes/:book_id → Figuren/Szenen + Präsenz-Matrix
//   /locations/:book_id                → Schauplätze + Präsenz-Matrix
//     (Figuren/Schauplätze: liegt der Katalog des offenen Buchs schon im
//     catalog-Store, wird er wiederverwendet; der Refresh fragt immer neu)
//   /songs/:book_id                    → Soundtrack-Tile
//   /booksettings/:book_id             → Buchtyp, is_finished, Schreibziel/Deadline
//   /plot?book_id, /motifs?book_id     → optionale Planungswerkzeuge (Tile aus, wenn leer)
//   /lexicon/:book_id                  → Wortschatz-Tile (MTLD/MATTR + Peer-Median)
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
// Fehler vs. Recht: ein 403 (Betrachter ohne editor-Recht auf Figuren, Szenen,
// Schauplätze, Songs) ist kein Ladefehler — das Tile bleibt aus, der
// Fehler-Banner nicht (`overviewForbidden` statt `overviewLoadErrors`).
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
};
