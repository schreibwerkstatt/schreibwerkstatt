# Stil-Heatmap

Kapitel × Stil-Metrik, dazu Satzrhythmus-Band und Satzanfänge. Kein KI-Call: alle Werte
stammen aus `page_stats`, das [lib/page-index.js](../lib/page-index.js) beim Sync pro Seite
füllt (`METRICS_VERSION`).

| Teil | Ort |
|---|---|
| Lesepfad (Namens-JOIN, ohne `style_samples`) | [db/style-stats.js](../db/style-stats.js) |
| Verdichtung Kapitel-Raster, P90, Ich-Anteil | [lib/stil-heatmap.js](../lib/stil-heatmap.js) |
| Rhythmus-Band, Satzanfänge (Buch + pro Kapitel) | [lib/stil-rhythmus.js](../lib/stil-rhythmus.js) |
| Perzentil-Definition (Seite = Kapitel = Buch) | [lib/percentile.js](../lib/percentile.js) |
| Route | `GET /history/style-stats/:book_id`, Drilldown `GET /history/style-samples/:book_id` ([routes/history/stats.js](../routes/history/stats.js)) |
| Anzeige | [public/js/book/stil-heatmap.js](../public/js/book/stil-heatmap.js), [public/js/book/stil-rhythmus.js](../public/js/book/stil-rhythmus.js), [public/partials/stil-heatmap.html](../public/partials/stil-heatmap.html) |

## Pflicht-Invarianten

- **Gerechnet wird serverseitig.** Die Rohform (eine Zeile pro Seite mit bis zu 2000
  Satzlängen) ist um Grössenordnungen grösser als das Raster; der Client bekommt nur das
  Raster, die Band-Polygone und die Ranglisten.
- **Kein Metrik-Versions-Wissen im Frontend.** `needsSync` rechnet der Server gegen
  `METRICS_VERSION`.
- **Zeilen in Leserichtung.** `db/style-stats.js` sortiert nach `chapters.position` und
  `pages.position` (Kapitel ohne position hinten, Seiten ohne Kapitel am Ende), nie nach
  den IDs: die Reihenfolge der Seiten trägt zusammen mit `sentence_lens` den Rhythmus.
  Gegated: [tests/integration/heatmap-loaders.test.js](../tests/integration/heatmap-loaders.test.js).
- **`needsSync` hängt nur an `metrics_version`.** Ein fehlender LIX-Wert ist auf einer
  Seite ohne zählbaren Satz das Ergebnis, kein Rechenrückstand — als Auslöser rechnete die
  Karte sonst bei jedem Öffnen das ganze Buch neu.
- **Mindestmenge für die Farbskala:** Kapitel unter `HEATMAP_MIN_WORDS` färben nicht und
  bestimmen die Skala nicht mit (Regel wie bei der Fehler-Heatmap, [lektorat.md](lektorat.md#auswertung-fehler-heatmap--fehlerdichte-trend)).
- **Eine Perzentil-Definition.** Seiten-, Kapitel- und Buch-P90 sowie der P90 im
  Rhythmus-Band nutzen `percentileSorted` aus `lib/percentile.js` (Index
  `floor((n-1)·p)`, kein Interpolieren). Ein Kapitel aus einer Seite zeigt damit exakt den
  Seiten-P90.

## Satzerkennung

Eine Zerlegung (`sentenceRanges` in [lib/sentence-split.js](../lib/sentence-split.js)) für Satzlängen, Satzanfänge,
LIX/Flesch und die Drilldown-Beispiele. Kein Satzende ist ein Punkt nach Abkürzung
(`_ABBREVIATIONS`), Einzelbuchstabe oder Zahl („z. B.", „Dr.", „am 3. Mai") und ein
Terminator, nach dem es kleingeschrieben weitergeht (Dialog-Einschub «Komm!», rief er.;
Auslassung „…" mitten im Satz). Wörter sind Buchstabenfolgen aller Schriften (`\p{L}`).
Änderung an der Zerlegung ⇒ `METRICS_VERSION` erhöhen.

## Satz-P90 pro Kapitel und Buch

Exakt: die `sentence_lens`-Sequenzen aller Seiten werden gepoolt, das Perzentil wird über
den Pool genommen. Ein Mittel der Seiten-P90 wäre etwas anderes (9 Sätze à 5 Wörter + 1 Satz
à 40 haben P90 = 5, das Mittel der Seiten-P90 läge bei ~22).

**Fallback** nur für Seiten ohne Sequenz (`metrics_version < 7`, bis zum nächsten Sync):
deren gespeicherter Seiten-P90 geht wortgewichtet ein; hat ein Kapitel exakte und alte
Seiten, werden beide Teile nach Wortanteil gemischt. Das Feld `sentence_len_p90_exact` ist
dann `false`, die Zelle zeigt `≈`, die Legende erklärt es. Der Buch-P90 (`book`) folgt
derselben Regel.

**Grenze:** `sentence_lens` ist pro Seite auf `MAX_SENTENCE_LENS` (2000) gedeckelt — von
einer Seite mit mehr Sätzen geht nur der Anfang in den Pool ein.

## Satzanfänge

`openers` ist die buchweite Rangliste (Top 15), `chapterOpeners` die Rangliste je Kapitel
(Top 10, gleiche Form plus `key`/`name`). Die Karte wählt das Kapitel per Combobox; ohne
Auswahl gilt das Buch. Nachbar-Wiederholungen (`repeats`) zählt der Index pro Seite — ein
Paar über eine Seitengrenze zählt nirgends.

## Ich-Anteil (Erzähltext)

Spalte `first_person_share`: Anteil der Pronomen 1. Person (`ich` + `wir`) an allen Pronomen
1. und 3. Person (`er` + `sie_sg`), **nur `narr`** aus `page_stats.pronoun_counts` — direkte
Rede zählt nicht. Prozent mit einer Nachkommastelle; `null` (Anzeige „–") unter
`PERSPECTIVE_MIN_PRONOUNS` = 20 erzählenden Pronomen, damit kurze Kapitel nicht mit jedem
„mir" umkippen.

Bewusst **kein** Etikett „Perspektive": `sie` deckt Singular und Plural, `sein` auch das
Verb — beides schiebt Richtung 3. Person. Die Zahl taugt dafür, einen Wechsel zwischen Ich-
und Er/Sie-Erzählung **zwischen Kapiteln** zu sehen, nicht dafür, die Erzählperspektive
eines Kapitels zu bestimmen. Die Spalte ist richtungslos gefärbt (Primary-Skala).

## Querverweis Wortschatz

Die Wiederholungs-Spalte zählt innerhalb einzelner Seiten. Buchweite Lieblingswörter
stehen in der Wortschatz-Karte ([wortschatz.md](wortschatz.md)); der Link unter der Tabelle
und im Detail-Panel der Wiederholungs-Spalte öffnet sie über `toggleWortschatzCard`.
