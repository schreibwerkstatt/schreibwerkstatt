# Meine Statistik

Karte `myStatsCard` ([public/js/cards/my-stats-card.js](../public/js/cards/my-stats-card.js), Partials `public/partials/my-stats*.html`): Schreib-Kennzahlen über **alle eigenen Bücher** (`role='owner'`, ohne Bücher mit `book_settings.exclude_from_stats`). User-gebunden, nicht buch-gebunden.

Rechnung: pure Funktionen in [cards/my-stats-compute.js](../public/js/cards/my-stats-compute.js) (Facade über `my-stats-compute/`: `series`, `volume`, `rhythm`, `readability`, `goals`) und [cards/my-stats-trends.js](../public/js/cards/my-stats-trends.js); Tests: [tests/unit/my-stats-compute.test.mjs](../tests/unit/my-stats-compute.test.mjs).

## Datenquellen

| Quelle | Inhalt | Frische |
|---|---|---|
| `GET /me/profile-stats` ([routes/usersettings/profile-stats.js](../routes/usersettings/profile-stats.js)) | Live-Bestand aus `page_stats` (Summe + `books_detail` je Buch inkl. `created_at` und Ziel-Feldern), Schreib-/Lektoratszeit gesamt, heutige Schreibsekunden, Stunden-Histogramm (`writing_hour`), Lektorat-Befund (`page_checks`) | live |
| `GET /me/profile-stats-history` | `history` = `book_stats_history`-Snapshots je (Buch, Tag); `writing`/`lektorat`/`sessions` = Tagesreihen aus `writing_time`/`lektorat_time`/`writing_session` | Snapshots: nächtlicher Sync ([lib/cron.js](../lib/cron.js) → `syncAllBooks`); Zeitreihen: live (Heartbeat) |

Buchnamen kommen aus der Root-Buchliste (`Alpine.store('nav').books`), nicht aus den Routen.

## Aufbewahrung der Snapshots

`book_stats_history` wird von [lib/cache-cleanup.js](../lib/cache-cleanup.js) (Policy `thin-monthly`) **ausgedünnt, nicht gelöscht**: die jüngsten 365 Tage bleiben tagesgenau, ältere Zeilen nur als letzter Snapshot je Buch und Kalendermonat. Damit hat jedes Zeitfenster eine Basis vor seinem Beginn — mindestens den Monatsend-Stand.

## Zeitfenster

Presets 30 T / 90 T / 1 J = genau 30 / 90 / 365 Kalendertage **inklusive heute**; „Alle" = kein Filter. Freies Von/Bis hat Vorrang; ein vertauschtes Von/Bis wird getauscht ([series.js](../public/js/cards/my-stats-compute/series.js)#`resolveWindow`). Alle Tagesgrenzen rechnen im App-Datum (`app.timezone`), per ISO-Tagesarithmetik — nie mit Uhrzeiten der Browser-Zeitzone.

Jede Kachel trägt ein Geltungs-Tag (`myStatsScope`):

| Tag | Kacheln |
|---|---|
| **im Zeitraum** (ohne Filter: „gesamt") | Umfang-Hero, Schreibrhythmus-Kennzahlen, Wochentage, Sessions, Vorperioden-Vergleich, Aufwand, Schreibzeit pro Buch, Entwicklungs-Chart |
| **letzte 52 Wochen** | Streak-Heatmap (Raster aus der ungefilterten Reihe) |
| **aktuell** | Bücher/Kapitel/Wortformen im Hero, Lesbarkeit, Lektorat, Umfang nach Kategorie, Bücher & Ziele |
| **gesamt** | Meilensteine, Tageszeit-Muster, Tagesziel |

## Umfang im Zeitraum

Netto-Bestandsdifferenz je Buch, summiert ([volume.js](../public/js/cards/my-stats-compute/volume.js)#`computeVolumeDelta`):

- **Endstand:** reicht das Fenster bis heute, der Live-Stand aus `books_detail` (der heutige Nacht-Snapshot existiert noch nicht); sonst der jüngste Snapshot ≤ Fensterende.
- **Basis:** jüngster Snapshot ≤ Fensterbeginn − 1. Fehlt er, ist das Buch im Fenster neu (voller Zuwachs zählt) — oder seine Historie reicht nicht zurück: Anlagedatum vor dem Fenster (`created_at`; ohne Anlagedatum: das Buch beginnt mit der ältesten Historie überhaupt, und die liegt an der 365-Tage-Grenze). Dann ist der erste Snapshot im Fenster die Basis, und die Karte zeigt den Hinweis „Näherungswert".
- **Netto:** Importe, Löschungen und Beiträge von Co-Autor:innen zählen mit; ein negativer Wert trägt das Tag „netto".

Dieselbe Regel gilt für den Vorperioden-Vergleich und das Wochen-Delta („diese Woche"); das Schreibtempo (Z/h) teilt den Umfang durch die Schreibzeit desselben Fensters.

## Schreibrhythmus

- **Aktive Tage, aktuelle und längste Serie** zählen Tage mit Schreibsekunden > 0 im Fenster ([rhythm.js](../public/js/cards/my-stats-compute/rhythm.js)#`computeStreakStats`). Eine Serie reisst an jedem Kalendertag ohne Treffer; ein heute noch leerer Tag bricht die aktuelle Serie nicht. Der Meilenstein „Schreibtage" nutzt dieselbe Tageszählung über alle Daten.
- **Tagesziel** (Minuten/Tag, Profil): erreicht, wenn Sekunden ≥ Ziel·60 — in der Ziel-Serie wie in der Heatmap-Färbung (Modus „Ziel"). Heute zählt der Live-Wert `today_writing_seconds`.
- **Meilenstein „Bücher"** zählt nur Bücher mit Inhalt.

## Entwicklungs-Chart

- **Inhalts-Metriken** (Zeichen, Normseiten, Wörter, Wortformen, Abschnitte, Kapitel): Linie über die Snapshot-Tage, Y-Achse ab 0; je Bucket der jüngste Stand. Jüngste Tage mit weniger Büchern als der Vortag (Teil-Sync) werden abgeschnitten.
- **Zeit-Metriken** (Schreib-/Lektoratszeit): Balken auf lückenloser Kalenderachse (Tage ohne Wert = 0), Einheit je Granularität (min/Tag, min/Woche, min/Monat); kumuliert als Linie. Pro Buch: gestapelte Balken. Mit Tagesziel zeigt Schreibzeit/Tag eine Ziellinie.
- **Leerzustand:** ohne Snapshot-Historie „füllt sich nachts", sonst „Keine Daten im Zeitraum".

## Lesbarkeit & Wortformen

Wert = zeichengewichteter Schnitt (Lesbarkeit) bzw. Summe (Wortformen) über den letzten Snapshot je Buch. Der Trendpfeil vergleicht mit dem Stand vor 30 Tagen, **nur über Bücher, die zu beiden Zeitpunkten existierten**. Wortformen werden je Buch gezählt und addiert — dasselbe Wort in zwei Büchern zählt zweimal (darum nicht „Wortschatz", siehe [wortschatz.md](wortschatz.md)).

## Bücher & Ziele / Prognose

[goals.js](../public/js/cards/my-stats-compute/goals.js)#`computeBookGoals`:

- **Heute** = Live-Stand minus letzter Snapshot vor heute (≥ 0; ohne Vortags-Snapshot 0).
- **Tempo** (`recentDailyChars`) = Zeichen-Zuwachs pro Kalendertag zwischen jüngstem Snapshot und dem Snapshot von vor 30 Tagen; ein jüngeres Buch nimmt seinen ältesten Snapshot (kürzeres Fenster, `paceDays`). Angezeigt als „⌀ n Z/Tag, letzte d Tage".
- **Prognose** = heute + Restumfang / Tempo (bis ~14 Jahre, sonst „kein Tempo"). Mit Frist zusätzlich „im Plan"/„hinter der Frist" als Text und das nötige Tempo bis zur Frist.
- **Gesamt-Prognose** ([my-stats-trends.js](../public/js/cards/my-stats-trends.js)#`computeOverallForecast`): Summe der Restumfänge / Summe der Tempi aller Bücher mit offenem Ziel.

## Lektorat-Befund

Server-seitig: jüngster `page_checks`-Lauf je Abschnitt; Trend gegen den Stand bis einschliesslich heute − 30 Tage (Schwelle ±0,2 Fundstellen/Abschnitt).
