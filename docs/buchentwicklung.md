# Buchentwicklung (Zeitliniendiagramm)

Karte `bookStatsCard` ([book-stats-card.js](../public/js/cards/book-stats-card.js), Methoden [book/bookstats.js](../public/js/book/bookstats.js), Rechenkern [book/bookstats-avg.js](../public/js/book/bookstats-avg.js), Metrik-Katalog [book/bookstats-metrics.js](../public/js/book/bookstats-metrics.js), Template [bookstats.html](../public/partials/bookstats.html)). Zeigt den Verlauf eines Buchs über die Zeit; „Meine Statistik" ([my-stats.md](my-stats.md)) ist das buchübergreifende Gegenstück.

## Quellen

| Metriken | Quelle | Zeitachse |
|---|---|---|
| Umfang, Satzlänge, LIX/Flesch, Abschn./Kap., Wortschatz | `book_stats_history` (`GET /history/book-stats/:id`) — eine Zeile je Buch und Tag aus `syncBook` ([routes/sync.js](../routes/sync.js)), nächtlich und manuell — der Nachtlauf um 00:05 ([lib/cron.js](../lib/cron.js)) schreibt den **Vortag**, die Zeile eines Tags ist also der Stand an seinem Ende; ein manueller Sync schreibt heute; LIX/Flesch seitengewichtet nach Prosa-Wörtern ([stil-heatmap.md](stil-heatmap.md)) | Snapshot-Tage |
| Schreib-, Lektorats-, Diktatzeit | `writing_time`/`lektorat_time`/`stt_time` (`GET /history/*-time/:id`), je User | nur aktive Tage |
| Bearbeitungsstand | `GET /redaktion/:id/history` | nur Tage mit Stufenwechsel |
| Zeichen pro Schreibstunde | Snapshot-Zuwachs (ohne Import) ÷ Schreibzeit **aller** User desselben Tags (`tempoRows`, `book_daily` aus `GET /history/writing-time/:id` — der Zuwachs ist buchweit, also auch der Nenner) | Tage mit Schreibzeit |

- **Satzlänge** = Σ Wörter in Sätzen / Σ Sätze aus dem Stil-Index — dieselbe Zerlegung wie Stil-Karte und Autorenprofil ([stil-heatmap.md](stil-heatmap.md#satzerkennung)).
- **Wortformen** = `book_lexicon.types` des Wortschatz-Scans, in die Tageszeile gestempelt ([wortschatz.md](wortschatz.md)). Keine eigene Zählung im Sync.
- **Teil-Sync schreibt keinen Snapshot:** fehlt eine noch existierende Seite (Ladefehler), bleibt der alte Tagesstand; die Antwort trägt `snapshot: false` + `missing_pages`, die Karte sagt das.
- **Importe zählen nicht als geschrieben:** `imported_chars`/`imported_words` sind kumulativ ([my-stats.md](my-stats.md#importe)). Δ Zeichen/Δ Wörter, die Plakette „Δ Wörter", der Ø-Zuwachs der Bestände (`computeAvgSummary` `offsets`) und das Tempo rechnen den Import-Zuwachs heraus; die Kurve selbst zeigt den echten Umfang und markiert Import-Tage mit einem Dreieck (Tooltip: Umfang des Imports). Dieselbe Regel gilt in der Buch-Übersicht (`today-ring.js#writtenChars`: Tagesbilanz, 7-Tage-Kachel, Streak, Sparkline, Ziel-Prognose).
- **Normseite** = 1500 Zeichen, eine Konstante je Seite (Browser `utils/format.js#CHARS_PER_NORMSEITE`, Server [lib/normseite.js](../lib/normseite.js)), gegated durch [normseite-single-value.test.mjs](../tests/unit/normseite-single-value.test.mjs).

## Drei Metrik-Arten

`metricKind` ordnet jede Metrik ein (Drift-Guard im Test): **stock** (Bestand — Ø-Zuwachs, Trendgerade), **flow** (Tagesmenge — Balken, Ø pro Kalendertag, Σ, Ø je aktivem Tag ≠ 0), **rate** (Verhältnis — Ø-Niveau; mit Gewichten gewogen, Zeichen/Stunde = Σ Zeichen / Σ Stunden).

## Kalenderachse und Verdichtung

- Δ-Werte entstehen **vor** dem Zeitraum-Filter (sonst fehlt der erste sichtbare Tag).
- `selectWindow` schneidet den Zeitraum zu („7 T" = heute und die sechs Tage davor) und legt über `fillCalendar` jeden Tag an — die Achse ist ein Kalender, Tage ohne Schreiben sind sichtbar, nicht zusammengeschoben:
  - **flow:** vom Stichtag (bei „Alles" vom ersten Wert) bis zum Achsen-Ende, fehlende Tage = 0. Der Ø teilt damit durch die Tage des Zeitraums, nicht durch die Tage mit Daten.
  - **stock:** der letzte Stand **vor** dem Stichtag steht als Anker am Stichtag. Seltene Bestands-Quellen (Bearbeitungsstand, kumulierte Zeiten) laufen ausserdem bis heute weiter; tägliche Snapshots enden am jüngsten Snapshot.
  - **rate:** nur die Werte im Zeitraum; Lücken bleiben leer (die Linie überbrückt).
  - **Achsen-Ende:** heute für live erfasste Quellen (Schreib-/Lektorats-/Diktatzeit, Bearbeitungsstand), sonst gestern bzw. der heutige Snapshot, falls ein manueller Sync ihn schon geschrieben hat.
  - Kein Wert im Zeitraum → Leerhinweis statt leerem Chart (`bookStatsMetricEmpty`).
- Die Metrik-Auswahl ist nach Umfang · Qualität · Aufwand gruppiert und zeigt nur Metriken mit Daten (`bookStatsMetricOptions`); die gewählte bleibt immer drin.
- `bucketFor(range, spanDays)`: 7/30/90 T tageweise; „1 J" wochenweise (ab 4 Monaten Spanne); „Alles" nach Spanne — bis 120 Tage Tage, bis 400 Wochen, darüber Monate. `bucketSeries`: flow = Summe, stock = letzter Wert, rate = Mittel (gewogen).
- Ø-Linie und Tagesziel-Linie (nur Δ Zeichen, `daily_goal_chars`; 0 = keine Linie) werden je Eimer mit dessen Kalendertagen multipliziert — Rand-Eimer sind kürzer. Der gleitende Ø erscheint nur in der Tagesansicht. Bezugslinien zeigen im Tooltip eine Nachkommastelle, Prozent-Metriken (lexikalische Dichte, Einmalwort-Anteil) tragen „%" an Achse und Tooltip.

## Kennzahlen-Gruppen

`bookStatsBadgeGroups()` liefert Umfang · Qualität · Aufwand; Zahlen über `formatNumber` (Locale-Region des Users), nie über eine feste Locale.
