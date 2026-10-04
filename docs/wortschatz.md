# Wortschatz-Analyse (quantitative Stilistik pro Buch)

Längenrobuste Kennzahlen über den gesamten Buchtext, dazu zwei Ranglisten:
Lieblingswörter und wiederkehrende Wendungen. Rein rückwärtsgewandt — der Job
liest den Text und schreibt nie hinein. **Kein `callAI`**: alles ist Arithmetik
über der Token-Sequenz.

## Warum das nicht `unique_words` ist

`book_stats_history.unique_words` ([routes/sync.js](../routes/sync.js)) ist die
Grösse eines `Set` aller Wortformen — ein reiner Type-Count. Er wächst monoton mit
der Textlänge und ist darum weder zwischen Büchern noch über die Zeit vergleichbar:
er misst überwiegend Buchlänge. Dasselbe gilt für die klassische Type-Token-Rate.
Die Masse hier sind alle gegen genau diesen Effekt gebaut.

`unique_words` bleibt bestehen (Historie, Charts) und heisst im UI „Wortformen
kumuliert", nicht „Wortschatz".

## Die zentrale Invariante: buchweiter Pass, kein Seiten-Aggregat

MATTR, MTLD und Heaps β sind **Fenster- bzw. Präfix-Masse über die Token-Sequenz**.
Ein 1000-Token-Fenster liegt regelmässig quer über eine Seitengrenze; keines dieser
Masse ist aus Pro-Seiten-Zahlen rekonstruierbar. Darum liest der Job die Seiten in
**Leserichtung** (`bookTree` + `flattenTree`, also `book_order`) und baut eine
durchgehende Sequenz — er summiert nicht `page_stats` auf.

Wer diese Kennzahlen in die Stil-Heatmap ([lib/stil-heatmap.js](../lib/stil-heatmap.js))
einbauen will, kann das **nicht**: die aggregiert pro Seite aus `page_stats`.
Kapitelwerte brauchen einen eigenen Pass pro Kapitel (Phase 2).

## Kennzahlen

| Kennzahl | Bedeutung | Richtung |
|---|---|---|
| **MATTR** (Fenster 1000, Schritt 1) | Mittel der TTR über ein gleitendes Fenster | höher = reicher |
| **MTLD** (bidirektional, Schwelle 0,72) | mittlere Sequenzlänge, über der die TTR die Schwelle hält | höher = reicher |
| **Hapax-Quote** | Anteil der Types, die genau einmal vorkommen | höher = reicher |
| **Yule's K** | Konzentration auf wenige Wörter (frequenzverteilungsbasiert) | **niedriger** = reicher |
| **Heaps β** | Wachstumsexponent des Wortschatzes (V = K·N^β) | ~0,5 normal, gegen 0 = gesättigt |
| **Lexikalische Dichte** | Inhaltswörter / Gesamttoken (Ure/Halliday) | kontextabhängig |

Quellen (das UI zeigt sie als Tooltip am Label, die Erklärung als Notiz darunter):
MATTR — Covington & McFall (2010), *Journal of Quantitative Linguistics* 17(2);
MTLD — McCarthy & Jarvis (2010), *Behavior Research Methods* 42(2);
Yule's K — Yule (1944), *The Statistical Study of Literary Vocabulary*;
Heaps β — Herdan (1960) / Heaps (1978); lexikalische Dichte — Ure (1971), Halliday (1985).
Die Formeln in [lib/lexicon/measures.js](../lib/lexicon/measures.js) folgen den
Originaldefinitionen; Abweichungen von publizierten Werten kommen aus der
Tokenisierung (Wortformen statt Lemmata, siehe unten), nicht aus der Formel.

**Ehrliche Nullwerte statt Scheingenauigkeit.** MTLD ist unter 100 Token `NULL`,
Heaps β unter 200 Token. Ist der Text kürzer als das MATTR-Fenster, liefert MATTR
die einfache TTR — und `book_lexicon.mattr_window` hält fest, wie gross das Fenster
tatsächlich war. Die Karte muss diesen Fall **sichtbar machen** (Warnzeile), sonst
hält der Autor einen nicht vergleichbaren Wert für vergleichbar.

**Einordnung statt nackter Zahl.** `loadPeerStats` liefert den Median jeder Kennzahl
über die übrigen Bücher desselben Besitzers. „MTLD 78" sagt niemandem etwas, „78,
dein Median ist 71" schon. Der MATTR-Median zählt nur Bücher mit vollem Fenster.

## Sprache

Die Analyse rechnet mit der Buchsprache (`book_settings.language`, `de`/`en`; ohne
eigene Zeile der Default des **Besitzers**, `db/lexicon.js#bookLanguage`). Sie
entscheidet drei Dinge:

- **Funktionswörter** (`lib/lexicon/function-words.js#stopwordsFor`): Deutsch =
  [lib/stopwords-de.js](../lib/stopwords-de.js) + `FUNCTION_WORDS_DE`, Englisch =
  [lib/stopwords-en.js](../lib/stopwords-en.js) +
  [lib/lexicon/function-words-en.js](../lib/lexicon/function-words-en.js) (inkl.
  Kontraktionen wie „don't" — der Tokenizer hält sie als ein Token). Davon hängen
  lexikalische Dichte und alle drei Wortlisten ab; MATTR, MTLD, Hapax-Quote, Yule's
  K und Heaps β sind listenfrei.
- **Referenzkorpus** (Keyness, auffällige Wörter, `novel` der Einmalwörter) und
- **Vergleichs-Mediane**: nur Bücher **derselben Sprache**. Gegen ein deutsches
  Korpus wäre in einem englischen Buch fast jedes Wort „auffällig", und Englisch hat
  systematisch andere Diversitätswerte (weniger Flexion).

`book_lexicon.language` hält die Sprache **des gespeicherten Scans**, nicht die
aktuelle Einstellung — die Referenz muss wissen, womit eine Frequenztabelle gezählt
wurde. Die Sprache geht in `input_sig`; nach einer Umstellung meldet
`GET /lexicon/:book_id` `stale`, bis neu gescannt ist. Dieselbe Sprache wählt im
Sync die Stoppwörter der seitenlokalen Wiederholungs-Metrik
([lib/page-index.js](../lib/page-index.js)#computeStyleStats).

## Tokenisierung

SSoT: [lib/lexicon/tokenize.js](../lib/lexicon/tokenize.js).

- Token = Buchstabenfolge (`\p{L}` plus Kombinationszeichen `\p{M}`), innere
  Apostrophe erlaubt („geht's" bleibt **ein** Token). Einzelbuchstaben und Zahlen
  fallen weg — Zahlen sind kein Wortschatz.
- **Vor dem Match:** NFC-Normalisierung (ein zerlegt importiertes „é" ist sonst ein
  abgeschnittenes Wort) und Entfernen unsichtbarer Zeichen (weiches Trennzeichen,
  Zero-Width-Zeichen, BOM) — sie stehen mitten in Wörtern aus Word-/WordPress-
  Importen und würden sie teilen.
- **Apostroph-Faltung:** `’` und `ʼ` → `'`. Dieselbe Begründung wie ß → ss.
- **Benannte HTML-Entities** dekodiert [lib/html-text.js](../lib/html-text.js) über die
  vollständige Tabelle [lib/html-entities.js](../lib/html-entities.js) (Spiegel im
  Frontend, Parity gegated) — sonst wird `f&uuml;r` zu „uuml".
- **`tokens` ist bewusst kleiner als `page_stats.words`.** Dort zählt jede
  whitespace-getrennte Einheit. Kein Drift, sondern zwei verschiedene Grössen.
- **ß → ss.** Die App läuft auf Schweizer Schreibnorm (`baseRules` in
  `prompt-config.json`), importiertes Material bringt beide Formen mit; ohne Faltung
  sind „Strasse"/„Straße" zwei Types und jedes Diversitätsmass ist verzerrt. In der
  Schweizer Norm sind die gefalteten Paare ohnehin Homographen.
- **Keine Lemmatisierung** (Phase 1). „geht"/„ging" sind zwei Types, die Werte sind
  im Deutschen systematisch nach oben verzerrt. Die Verzerrung ist über Kapitel und
  über die Zeit konstant, Vergleiche *innerhalb* der App bleiben also gültig; der
  absolute Wert ist nicht sprachübergreifend interpretierbar. UI-Label darum
  **„Wortformen"**, nicht „Wortschatz"/„Lemmata". `book_lexicon.lemma_types` liegt
  nullable bereit.
- **Segmente** (`tokenizeSegments`) begrenzen n-Gramme auf Satz/Block. Der
  Orchestrator schneidet zusätzlich an den **HTML-Blockgrenzen** — ohne das klebt
  eine Überschrift ohne Satzzeichen am Folgeabsatz und erzeugt eine Phantom-Wendung
  über die Grenze hinweg. Eigene Implementierung statt `_sentenceRanges` aus
  [lib/page-index.js](../lib/page-index.js): die liefert Zeichen-Ranges für die
  Beispielsatz-Suche und verwirft unpunktierte Enden.

## Ranglisten

`lexicon_terms` hält **drei Sorten Zeile**, getrennt über `kind` — gemeinsam ist
ihnen die Form (Wort, Zahl, Streuung, Sprungziel) und der Filter: Inhaltswörter ab
4 Zeichen, ohne Funktionswörter und ohne Eigennamen — die häufigste Figur führte
sonst jede Liste an und ist kein Stilbefund. Für die lexikalische Dichte zählt ein
Eigenname dagegen **mit**: dort ist er ein Inhaltswort.

- **Funktionswörter:** Basisliste [lib/stopwords-de.js](../lib/stopwords-de.js) **plus**
  die volle Liste [lib/lexicon/function-words.js](../lib/lexicon/function-words.js)
  (alle flektierten Pronomen/Determinative, Präpositionen, Konjunktionen, Hilfs- und
  Modalverben inkl. Konjunktiv, Partikeln). Die Basisliste bleibt knapp, weil sie
  auch die seitenlokale Wiederholungs-Metrik speist; für die Dichte (Ure/Halliday)
  zählt jedes fehlende Funktionswort als Inhaltswort und hebt den Wert systematisch.
- **Eigennamen** ([lib/lexicon/names.js](../lib/lexicon/names.js)): Zerlegung wie
  `tokenizeNamesForStopwords`, danach dieselbe Normalisierung wie der Text, dazu die
  **Genitivform** („Annas") und Apostroph-Namen als ein Token („o'brien").

**`kind='freq'` — Lieblingswörter** (Top 200 nach Häufigkeit, ab 3 Vorkommen).
Jede Zeile trägt `chapter_spread` (in wie vielen Kapiteln) — der eigentliche
Mehrwert gegenüber der seitenlokalen Wiederholungs-Metrik in `page_stats`:
„40× im Buch, alle in Kapitel 3" ist ein anderer Befund als „40× gleichmässig".

**`kind='key'` — auffällige Wörter** (Top 100 nach Keyness, zusätzlich zu den 200).
Die Häufigkeit verfehlt genau die Wörter, die dieses Buch von den übrigen
unterscheiden: ein Wort, das hier zwölfmal steht und sonst nie, ist nicht häufig,
sondern eigen — es fällt durch jeden Häufigkeitsdeckel. Die zweite Achse kommt
**dazu**, sie verdrängt keinen Häufigkeitsplatz.

Ausgewählt wird mit der **vorsichtigen** Keyness (`refUpper`, siehe unten),
angezeigt die schlichte. Der Unterschied ist die Existenzberechtigung der Achse:
sobald die Keyness über die Auswahl entscheidet, greift sie ohne diese Schranke
bevorzugt Terme, deren Wert allein aus der Kappung der Referenztabelle stammt.

**`kind='hapax'` — Einmalwörter** (genau ein Vorkommen im ganzen Buch, Top 300).
Der Deckel ist unvermeidlich: rund die Hälfte aller Types kommt genau einmal vor.
Weil alle dieselbe Häufigkeit haben, muss die Rangfolge von woanders kommen —
`_selectHapax` sortiert (1) Wörter, die in den übrigen Büchern des Autors **nicht**
vorkommen, nach vorn („einmal hier UND sonst nie" ist die Frage, nicht „einmal
hier"), dann (2) nach Länge, dann alphabetisch. Deterministisch, sonst zeigt
derselbe Text nach jedem Scan eine andere Liste.

`book_lexicon.hapax_listed` hält fest, wie viele Einmalwörter die Filter insgesamt
passiert haben — die Karte stellt „300 von 4812" darüber. Ohne diese Zahl liest
sich der Ausschnitt als Vollständigkeit. **Nicht** dasselbe wie `hapax`: dort
zählen Stoppwörter, Eigennamen und kurze Wörter mit.

**Wendungen** (`lexicon_ngrams`, Top 60 **pro Länge** n=2…5, ab 3 Vorkommen).
Stoppwörter werden hier **nicht** gefiltert — „mit einem Ruck" besteht zu zwei
Dritteln aus Funktionswörtern. Gegen die Flut aus blossen Funktionswort-Ketten
wirkt nicht ein Filter, sondern **log-Dice**: häufige Bestandteile drücken den Wert.

Der Deckel wirkt pro Länge, sonst verdrängen die zwangsläufig häufigeren kurzen
Wendungen die langen.

### Apriori-Beschneidung

Ein n-Gramm kann die Mindesthäufigkeit nur erreichen, wenn **Präfix und Suffix** der
Länge n−1 sie erreichen. Ohne diese Beschneidung müsste man für n≤5 rund 4·N
Kandidaten halten (bei 600k Token ≈ 2,4 Mio Einträge). Nebeneffekt, der gebraucht
wird: weil auch das Suffix überlebt hat, ist dessen Häufigkeit bekannt — genau der
Nenner von log-Dice.

`logDice(f, head, tail) = 14 + log2(2f / (head + tail))`, zerlegt in erstes Token |
Rest. Für n=2 ist das exakt das klassische log-Dice; für n>2 eine Verallgemeinerung
über dieselbe Formel statt eines zweiten Masses.

## Keyness

`keyness` ist Log-Likelihood (G²) gegen ein Referenzkorpus, **vorzeichenbehaftet**:
positiv = in diesem Buch überrepräsentiert, negativ = auffällig gemieden. Ohne
Vorzeichen wäre „benutzt du auffällig oft" nicht von „vermeidest du auffällig" zu
unterscheiden — beides ist G² > 0.

Referenzkorpus in Phase 1 sind **die übrigen Bücher desselben Autors**. Kein
externes Frequenzkorpus: keine Lizenzfrage, und die Frage „was benutze ich *hier*
auffällig und sonst nicht" ist für den Schreibenden die interessantere.

Damit das ohne O(n²)-Neutokenisierung pro Nacht geht, hält jedes Buch seine
Häufigkeitstabelle in `book_lexicon.freq_json`; die Referenz ist die Summe über
die anderen Bücher.

**Gekappt wird über eine Mindesthäufigkeit (3), nicht über einen Rang.** Bei einem
Rangdeckel liegt die Kappungsgrenze irgendwo im zweistelligen Bereich, und ein Wort,
das die Referenz deshalb nicht kennt, sieht aus wie ein Wort, das es dort nie gibt.
Als Anzeigespalte war das eine hinnehmbare Ungenauigkeit; als Auswahlkriterium wäre
es ein systematischer Fehler. Bei 3 bleibt die Abweichung auf zwei Vorkommen
begrenzt. Ein Rangdeckel steht nur noch als Notbremse dahinter.

**`refUpper` macht den Restfehler unschädlich, wo er zählt.** Fehlt ein Term in der
Tabelle eines Referenzbuchs, kommt er dort bis zu `bookMin` Mal vor (seltenster
aufgenommener Term dieses Buchs). `loadReferenceCorpus` liefert `upper(term)` =
gezählte Häufigkeit **plus die Summe** dieser Schranken über alle Bücher, in denen
der Term fehlt — ein Maximum über die Bücher wäre keine Schranke (zehn Bücher mit je
zwei Vorkommen sind zwanzig, nicht drei). `keynessFor({ refUpper })` rechnet damit
eine **untere Schranke** der Auffälligkeit; nur die entscheidet über die Auswahl.
Greift die Notbremse, steigt `bookMin` des Buchs und die Auswahl wird von allein
vorsichtiger.

**Nur Tabellen der aktuellen `LEXICON_VERSION` und derselben Sprache** (siehe
„Sprache") gehen in Referenz und Vergleichs-
Mediane ein: eine ältere Tabelle wurde anders tokenisiert und passt Wort für Wort
nicht. Nach einer Versionserhöhung füllt sich die Referenz mit dem Nacht-Lauf wieder.

**Sichtbar nur für den Besitzer.** Keyness, die Zeilensorte `key`, das
Einmalwort-Merkmal `novel` und die Vergleichs-Mediane sind aus den **übrigen**,
womöglich privaten Büchern des Besitzers abgeleitet. `GET /lexicon/:book_id` liefert
sie nur an `owner`; ein Lektor mit Leserecht auf dieses Buch sieht die Kennzahlen
und Listen dieses Buchs, aber keine Rückschlüsse auf die anderen (`isOwner` im
Payload, Hinweiszeile in der Karte).

Nur ein Buch im Bestand ⇒ keine Referenz ⇒ Spalte bleibt leer und die Karte blendet
sie aus. Das ist der korrekte Zustand, kein Fehler.

## Datenmodell (Migration 261, `kind` + `hapax_listed` in 262, Ausbau in 308, `language` in 317)

Alle Tabellen sind **abgeleitet** und werden pro Scan als Ganzes ersetzt
(`replaceBookLexicon`, eine Transaktion). Kein Delta: die Ranglisten sind gedeckelt
— ein Term, der aus den Top 200 fällt, müsste beim Delta-Schreiben aktiv gelöscht
werden, und genau das vergisst man. Ein Full-Replace kann diesen Zustand nicht
erzeugen.

| Tabelle | Form |
|---|---|
| `book_lexicon` | 1:1 zum Buch (`book_id` PK, CASCADE) — Kennzahlen + `content_sig` + `freq_json` |
| `lexicon_terms` | Wortlisten, `kind` CHECK `freq`\|`key`\|`hapax`, `UNIQUE(book_id, term)`, `first_page_id` → `pages` **SET NULL** |
| `lexicon_ngrams` | Top-Wendungen, `UNIQUE(book_id, phrase)`, `first_page_id` **SET NULL** |
| `chapter_lexicon` | Kapitel-Band, `chapter_id` PK → `chapters` CASCADE, `position` = Buchreihenfolge |
| `figure_idiolect` | Idiolekt, `figure_id` PK → `figures` CASCADE, `terms_json` |

`lexicon_terms.novel`/`sort_rank` halten Auswahlmerkmal und Rang der Einmalwörter —
die Karte zeigt die Reihenfolge, nach der ausgewählt wurde, statt sie in SQL
nachzubauen (SQLite sortiert binär, die Auswahl mit `localeCompare`). Kapitel und
Figuren, die zwischen Analyse und Schreiben gelöscht wurden, fallen beim Schreiben
weg (Existenz-Check wie `_safePageId`).

`first_page_id` ist ein Sprungziel, kein Inhalt — darum SET NULL: verschwindet die
Seite, bleibt die Zahl bis zum nächsten Scan gültig. Der Schreibpfad prüft
zusätzlich, ob die Seite noch existiert (`_safePageId`): der Scan läuft über
Minuten, und ein FK-Verstoss würde die ganze Transaktion verwerfen — also die
komplette Analyse. Ein fehlendes Sprungziel kostet nur einen Klick.

Buch-skopiert, **nicht** user-skopiert: der Wortschatz ist eine Eigenschaft des
Textes, nicht des Betrachters. Zugriffsschutz über die Buch-ACL.

## Job + Cron

`POST /jobs/lexicon-scan` ([routes/jobs/lexicon-scan.js](../routes/jobs/lexicon-scan.js)),
Job-Typ `lexicon-scan`, Label `job.label.lexiconScan`. In der Job-Queue, obwohl es
kein `callAI` gibt — der Lauf kann Minuten dauern und muss abbrechbar sein (Muster
wie `motif-scan`/`beat-anchor`).

**Delta-Skip über die Eingangs-Signatur.** Zwei Signaturen:

- `content_sig` = SHA-1 über `LEXICON_VERSION` + alle `page_id:updated_at` **in
  Leserichtung** (Umsortierung verschiebt die MATTR-Fenster). Der reine Textstand.
- `input_sig` = SHA-1 über `content_sig` + Namensliste + Figuren + Fingerabdruck der
  Referenz (`book_id:content_sig` der übrigen Bücher, `referenceFingerprint`).
  **Nur sie entscheidet über den Skip.** Ohne Namen bliebe eine neu angelegte Figur
  in den Lieblingswörtern, bis jemand eine Seite ändert; ohne Referenz bliebe ein
  Buch, das in einer frischen Installation vor allen anderen gescannt wurde, für
  immer ohne Keyness.
- Der Fingerabdruck nimmt bewusst die **Text**-Signatur der anderen Bücher, nicht
  deren `input_sig`: sonst hinge jedes Buch an den Referenzen der anderen, und zwei
  Bücher desselben Autors würden sich gegenseitig jede Nacht neu anstossen.

**Der manuelle Knopf setzt `force`**, sonst quittiert er mit „unverändert" und der
Autor sieht nichts passieren.

**Tagesverlauf:** `book_stats_history` trägt `mattr`/`mtld`/`lex_density`/
`hapax_ratio`. Der Sync stempelt seine Tageszeile mit dem Stand des letzten Scans
(`stampLexiconHistory`), der Scan überschreibt sie danach mit dem frischen Stand.
MATTR nur mit vollem Fenster — der Sprung von TTR zu MATTR sähe im Verlauf sonst wie
eine Stiländerung aus. Die Buchstatistik bietet die vier Werte als Kurven an.

**Cron:** hinter `syncAllBooks()` im 23:00-Block, **nicht** in der
`reindexAllBooks`-Kette — der Scan liest reinen Seitentext, keine Vektoren.

**Laufzeit** (gemessen, 900 Seiten / 2,6 Mio Zeichen HTML / 607k Token): ~1,4 s,
~100–130 MB Heap-Spitze. Der Speicher-Höhepunkt ist die unbeschnittene Bigramm-Map;
Level 3+ bleiben durch Apriori klein. Zwischen den Phasen gibt der Job per
`setImmediate` an den Event-Loop zurück (`onYield`) und prüft dort das Abort-Signal.

## Frontend

Karte `wortschatz` — [public/js/cards/wortschatz-card.js](../public/js/cards/wortschatz-card.js),
Methods [public/js/book/wortschatz.js](../public/js/book/wortschatz.js), Partial
[public/partials/wortschatz.html](../public/partials/wortschatz.html), CSS
[public/css/analysis/wortschatz.css](../public/css/analysis/wortschatz.css),
Route `#book/:id/wortschatz`, Lesepfad `GET /lexicon/:book_id`.

Das Kennzahlen-Grid **wiederverwendet** `.overview-grid`/`.overview-tile` aus
`book-overview/`; alle drei Ranglisten sind `sortableTable`.

**Zweiter Leser: Wortschatz-Tile der Buch-Übersicht**
([book-overview/wortschatz.js](../public/js/book-overview/wortschatz.js),
[bookoverview-wortschatz.html](../public/partials/bookoverview-wortschatz.html)).
Liest dieselbe Antwort von `GET /lexicon/:book_id` und zeigt MTLD (ersatzweise
MATTR) mit dem Peer-Median. Dieselben Regeln wie die Karte: `null` ist „–", nie 0;
MATTR ohne volles Fenster bekommt keine Peer-Zeile; `peers: null` heisst „kein
Vergleich". Ohne Scan (`stats: null`) ein Hinweis-Tile. Klick öffnet die Karte nur
ab `editor` (Rolle der Karte) — die Übersicht sieht schon ein `viewer`.

Die Ranglisten liegen als Fragmente daneben (`wortschatz-terms.html`,
`-phrases.html`, `-hapax.html`) und kommen über den **String-Include**
(`<!-- @include … -->`) herein, nicht über den DOM-Placeholder: der Einhängepunkt
steckt in einem `<template x-if>`, und `querySelector` steigt nicht in
Template-Content ab. Reiter `terms` | `phrases` | `hapax` | `cloud` | `chapters` | `figures`.

### Vierter Reiter: Wortwolke

[public/js/book/wortschatz-cloud.js](../public/js/book/wortschatz-cloud.js),
Fragment [wortschatz-cloud.html](../public/partials/wortschatz-cloud.html),
Layout via d3-cloud (lazy, `loadWordCloud()` in
[lazy-libs.js](../public/js/lazy-libs.js)).

Die Wolke fügt **keine eigene Auswahl** hinzu: sie zeichnet dieselben
`lexicon_terms`-Zeilen wie die Tabellen, nur nach Gewicht skaliert. Zwei Modi,
weil die Wortliste zwei Auswahlachsen hat:

- **Häufigkeit** — Grösse ∝ `count`.
- **Auffälligkeit** — Grösse ∝ |`keyness`|; das Vorzeichen geht in die Farbe
  (kursiv/grau = auffällig **gemieden**). Ohne Referenzkorpus ist der Modus
  gesperrt statt leer, mit Begründung im Tooltip.

Drei Entscheidungen, die den Unterschied machen:

- **Wurzelskala statt linear.** Die Häufigkeitsverteilung eines Buchs ist
  zipfverteilt; linear skaliert erdrückt das häufigste Wort alle anderen.
- **Deterministisch.** d3-cloud würfelt per Default (`Math.random`) — dieselbe
  Analyse ergäbe bei jedem Öffnen ein anderes Bild, und zwei Scans wären nicht
  vergleichbar. Darum fixer `random()` und indexbasierte Rotation.
- **Der Deckel wird ausgewiesen.** d3-cloud lässt Wörter weg, für die kein Platz
  war; die Zahl steht unter der Wolke. Dieselbe Regel wie bei `hapax_listed` —
  ein stillschweigend gekürzter Ausschnitt liest sich als Vollständigkeit.

Klick auf ein Wort springt zu `first_page_id`, wie in den Tabellen.

Die Einmalwort-Zeilen bekommen im Frontend die Wortlänge als eigenes Feld (`len`)
— die einzige Zahl, nach der sich diese Liste sortieren lässt, die Häufigkeit ist
per Definition überall 1. Der Getter ist memoisiert (Vergleich auf die Array-
Referenz), sonst baut er bei jedem Render ein neues Array und `sortableTable`
sortiert jedes Mal neu.

**Die Analyse-Version kommt vom Server** (`thresholds.version` + `stale`-Flag), das
Frontend hält **keine Kopie**. Dieselbe Regel gilt in der Stil-Karte: dort liefert
`/history/style-stats` das `needsSync`-Flag mit, gerechnet gegen
`lib/page-index.js#METRICS_VERSION` — die Karte kennt die Zahl nicht und kann
darum nicht gegen sie driften.

## Kapitel-Band (Reiter „Kapitel")

[lib/lexicon/chapters.js](../lib/lexicon/chapters.js). Dieselben Diversitätsmasse
pro Kapitel — eigener Pass über die Token-Sequenz jedes Kapitels (Seiten in
Leserichtung aneinandergehängt), kein Aggregat über Seitenwerte. Seiten ohne Kapitel
zählen nur buchweit.

**Burrows's Delta gegen das Durchschnittskapitel:** Merkmale sind die 150 häufigsten
Wortformen des Buchs, **mit** Funktionswörtern (sie tragen die Stilsignatur und sind
thematisch neutral). Relative Häufigkeiten je Kapitel werden über die Kapitel
z-standardisiert; Delta = Mittel der |z|. Gerechnet nur für Kapitel ab
`DELTA_MIN_TOKENS` (1500) und erst ab `DELTA_MIN_CHAPTERS` (3) solchen Kapiteln —
darunter ist eine relative Häufigkeit Rauschen bzw. jedes Kapitel gleich weit von der
Mitte. `delta_top` hält die stärksten Merkmale mit Vorzeichen; die Karte zeigt sie als
„öfter: … · seltener: …". Ohne Begründung wäre die Zahl eine Behauptung.

Hervorgehoben wird **relativ** (Delta > Mittel + 1 Standardabweichung der Kapitel),
weil Delta keinen festen Normalbereich hat.

## Figuren-Idiolekt (Reiter „Figuren")

[lib/lexicon/idiolect.js](../lib/lexicon/idiolect.js). Wortschatz der wörtlichen Rede
je Figur. Dialog-Erkennung und Namensmuster kommen **injiziert** aus
[lib/page-index.js](../lib/page-index.js) (`findDialogRanges`,
`buildFigureNamePatterns`) — dieselbe Regel wie Stil-Metriken und
Figuren-Erwähnungen, ohne dass das pure Modul die DB lädt.

**Erkannte Rede:** «…», »…«, „…“, “…”, "…", ‹…›, ‚…‘, Gedankenstrich am
Zeilenanfang, „sagte: …" — und britisch ‘…’. Weil ’ zugleich Apostroph ist (don’t,
James’, ’tis), öffnet ‘ nur nach Leerraum, Zeilenanfang oder öffnendem Zeichen, und
ein ’ schliesst nur, wenn kein Buchstabe folgt; bevorzugt der erste Schliesser mit
Satzzeichen davor, damit „‘It’s James’ hat, isn’t it?’" nicht nach „James’" endet.
Gerade einfache '…' bleiben aussen vor — dort ist jeder zweite Treffer ein Apostroph.

**Sprecherzuordnung vorsichtig:** ein Absatz wird einer Figur nur zugeordnet, wenn
in seinem **Erzähltext** (alles ausserhalb der Rede) genau **eine** Figur genannt ist.
Ein Name in der Rede („»Anna, komm!«") ist kein Sprecher. Lieber weniger Rede als
falsch zugeordnete — ein falscher Satz macht aus zwei Stimmen eine. Folge: Ich-Erzähler
und Wechselrede ohne Inquit-Formel bleiben unzugeordnet. Der zugeordnete Anteil steht
als `book_lexicon.idiolect_coverage` über der Tabelle.

Gleichnamige Figuren (Kopien desselben Stammeintrags unter verschiedenen Konten)
bilden eine Gruppe und bekommen dieselbe Zeile; der Lesepfad zeigt die Figuren des
Betrachters, ersatzweise die des Besitzers. Eine Figur braucht mindestens
`IDIOLECT_MIN_TOKENS` (150) zugeordnete Wörter. **Typische Wörter** = Keyness der Rede
einer Figur gegen die Rede **aller anderen** Figuren (nicht gegen das Buch).

## Pflicht-Invarianten

1. **`LEXICON_VERSION` erhöhen**, wenn sich Tokenisierung, Masse oder Auswahlregeln
   ändern — sonst bleiben alte Werte stehen (die Version steckt im `content_sig`).
2. **Kein Frontend-Spiegel der Version.** Sie wird im Payload mitgeliefert.
3. **Nie inkrementell schreiben.** Full-Replace in einer Transaktion.
4. **`NULL` nicht zu 0 machen.** Nicht messbar ≠ null gemessen; die Karte zeigt „–".
5. **`mattr_window` mit ausliefern und auswerten.** Ohne den Hinweis sieht ein
   nicht längenrobuster Wert aus wie ein robuster.
6. **Eigennamen aus der Wortliste, aber in die Dichte.** Zwei verschiedene Fragen.
7. **n-Gramme überspannen keine Segment-/Blockgrenze.**
8. **Der Job schreibt nie in `pages`.** Rein ableitend.
9. **Auswahl nach Keyness nur mit `refUpper`.** Die Schranke summiert pro Buch, in
   dem der Term fehlt; ohne sie wählt die Liste bevorzugt Terme, deren Auffälligkeit
   nur aus der Kappung der Referenz stammt.
10. **Gedeckelte Liste zeigt ihren Deckel.** Einmalwörter kommen mit
    `hapax_listed`, der Idiolekt mit `idiolect_coverage`; ein Ausschnitt ohne diese
    Zahl liest sich als Vollständigkeit.
11. **`kind` ist der Diskriminator, kein Sentinel.** Ein Einmalwort ist nicht „ein
    Lieblingswort mit `count = 1`" — die drei Sorten haben verschiedene
    Auswahlregeln und verschiedene Reiter.
12. **Skip nur über `input_sig`.** Alles, wovon das Ergebnis abhängt (Text, Namen,
    Sprache, Referenz-Textstände), gehört hinein; der Referenz-Fingerabdruck nimmt die
    `content_sig` der anderen Bücher, nie deren `input_sig`.
13. **Was aus anderen Büchern stammt, sieht nur der Besitzer** (Keyness, `key`,
    `novel`, Mediane).
14. **Referenz und Mediane nur gleicher Sprache.** Gefiltert über
    `book_lexicon.language` (Sprache des Scans), nie über die aktuelle Einstellung.

## Später (nicht gebaut)

- Frequenzband-Abdeckung (Lexical Frequency Profile) + Keyness gegen ein externes
  Referenzkorpus — braucht eine Frequenzliste als Asset (Lizenz klären).
- Lemmatisierung; erst damit wird „Wortschatz" statt „Wortformen" korrekt. Braucht
  ein Lemma-Lexikon als Asset (Lizenz klären).
