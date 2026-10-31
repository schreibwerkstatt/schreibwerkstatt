# Alters-Analyse der Figuren (Reiter „Alter" der Figuren-Karte)

Beantwortet **„wie alt ist diese Figur im Buch"** — als Tabelle über alle Figuren,
filterbar nach Figurentyp und Kapitel (Figuren mit Auftritt im Kapitel; die Alterswerte bleiben die des ganzen Buchs), mit Belegstelle im Manuskript.

## Warum neben der Komplettanalyse

Die Komplettanalyse extrahiert `figures.geburtstag` und die datierten Ereignisse als
Nebenprodukt eines teuren Gesamtlaufs. Wer danach weiterschreibt, hat ein Alter auf
dem Stand von damals — **und sieht das nicht**. Dieser Job ist klein genug für einen
Knopfdruck und liest den heutigen Text. Ausserdem reiht ihn die Komplettanalyse nach
dem Katalog als eigenen Job ein (Schritt `figurAlter` im Lauf-Umfang, Default an,
[docs/komplett.md](komplett.md#katalog-und-prüfung-sind-zwei-jobs)) — dann **ohne**
`force`: hat sich weder Text noch Figurenstamm geändert, greift der Delta-Skip und der
Lauf kostet keinen Call. Umgekehrt weist `POST /jobs/figur-alter` einen Start ab, solange
eine Komplettanalyse läuft (`409 KOMPLETT_ANALYSIS_RUNNING`, die Karte zeigt die
Meldung): sie schreibt Figurenstamm und Zeitstrahl gerade neu.

## Drei Schichten, in dieser Reihenfolge

| # | Wer | Was | Wo |
|---|-----|-----|----|
| 1 | deterministisch | **Kandidatensätze**: Muster (Ziffer, Zahlwort, Ordinal-Geburtstag, Geburtsjahr in beiden Leserichtungen, englische Formen) + Figurenname im Satzfenster, inkl. Pronomen-Anschluss aus dem Vorsatz | [lib/figure-age/patterns.js](../lib/figure-age/patterns.js), [scan.js](../lib/figure-age/scan.js) |
| 1b | deterministisch | **semantische Nachlese** (`semanticQuery`) für Figuren, bei denen die Muster wenig finden — „wie alt ist X" trifft ein Embedding-Index besser als eine Wortsuche. Die Passage (bis ~1500 Zeichen) wird per `passageStellen` auf den **Satz mit der Angabe** zugeschnitten, nicht auf ihren Anfang; die Figur muss in der Passage genannt sein. Non-fatal ohne Index | [routes/jobs/figur-alter.js](../routes/jobs/figur-alter.js) |
| 2 | Modell | **was behaupten diese Sätze** — ein Call pro Figuren-Bündel. Nur das Modell sieht, dass „an ihrem sechzehnten Geburtstag" ein Alter nennt und „1912 kehrte sie zurück" nur ein Bezugsjahr | [prompts/figur-alter.js](../public/js/prompts/figur-alter.js) |
| 3 | deterministisch | **Zitat nachschlagen, Zahl prüfen, Spanne bilden, Widerspruch melden** | [lib/figure-age/consolidate.js](../lib/figure-age/consolidate.js) |

**Das Modell rechnet nicht und rät nicht.** Sein Schema kennt kein Feld für ein
geschätztes Alter: ein Sprachmodell schätzt das Alter jeder Figur, nach der man
fragt, und in einer Tabelle sieht die Schätzung aus wie ein Befund. Gefragt ist nur,
was im vorgelegten Satz **steht** — samt wörtlichem Zitat.

## Zwei Prüfungen, ohne die das Feature nichts wert wäre

1. **Zitat-Prüfung.** Das Zitat muss in einer der **vorgelegten** Stellen dieser Figur
   stehen (normalisierter Vergleich). Gleiche Haltung wie bei den Belegzitaten der
   Bewertung ([lib/quote-verify.js](../lib/quote-verify.js)), hier nur mit engerem
   Heuhaufen.
2. **Zahl-Prüfung.** Der gemeldete Wert muss im Zitat vorkommen — als Ziffer **oder**
   als Zahlwort (`numbersIn`). Ohne diese Prüfung wandern gerechnete und geratene
   Werte als „belegt" in die Tabelle.

Davor fallen Zitate unter acht Zeichen (ein blosses „zwölf" steht in jeder Stelle) und
unplausible Werte (`isPlausibleWert`: Alter 0–130, Geburts-/Todesjahr 1000–2999 — ein
„Geburtsjahr 12" ergäbe sonst ein gerechnetes Alter von 1900 Jahren). Der unbestimmte
Artikel („ein", „eine", „einen" …) zählt in `numbersIn` nicht als Eins, ein Ordinalwort
nur vor „Geburtstag"/„Lebensjahr" („erst" ist sonst eine Eins, das Verb „achten" eine Acht).

**Bezugsjahr nur aus der Stelle.** Das `bezugsjahr` eines Funds bleibt nur stehen, wenn
die Jahreszahl in der vorgelegten Stelle steht (und 1000–2999 ist); sonst fällt das
Jahr weg, der Fund bleibt. Ein aus dem Kontext erschlossenes Jahr wäre eine Rechnung des
Modells — und die Rechnungsprüfung meldete daraus einen Widerspruch, den es im Text
nicht gibt. Die Spanne der erzählten Zeit steht im Prompt nur zur Orientierung.

Die Verwerfungs-Zähler stehen im Job-Ergebnis (`verworfen.zitat` / `.zahl` / `.wert` /
`.figur` / `.bezugsjahr`) und im Log — ein stiller Filter liest sich wie „mehr gab es nicht". `.wert`
zählt auch eine ungültige `art` und einen fehlenden Zahlenwert; `.zitat` nur Zitate, die
zu kurz sind oder in keiner vorgelegten Stelle stehen; `.figur` auch Funde zu einem Namen,
den zwei Figuren tragen (Vollname wie Kurzname) — zugeordnet wird nur Eindeutiges.

**Sprungziel.** Das Modell nennt zu jedem Fund die Nummer der Stelle (`stelle`, „2.3"
wie im Prompt). Steht dasselbe Zitat in mehreren vorgelegten Stellen, bestimmt sie die
Seite; ohne passende Nummer gilt die erste Fundstelle.

## Satzfenster

`splitSentences` schneidet **nicht** an einem Punkt hinter einer ein- bis dreistelligen
Zahl vor einem Wort („am 3. Mai 1850", „zum 40. Geburtstag") und nicht hinter Abkürzungen
und Initialen („geb. 1850", „Dr. Berg") — genau dort stehen Geburts- und Altersangaben.
Ein Datum in Ziffern („12.03.1950", „12. 3. 1950") trennt ebenfalls keinen Satz — sonst
stünde „geboren" ohne seine Jahreszahl und der Name ohne beides da. Eine Jahreszahl am
Satzende bleibt eine Grenze. Ordinal-Geburtstage werden als ganzes
Wort zerlegt („dritten", „ersten", „zwanzigsten", „einundzwanzigsten").

**Absatzgrenzen sind Satzgrenzen.** Der Job baut den Seitentext mit `htmlToTextForPrompt`
(Blockgrenzen als Umbruch, rohe Umbrüche im Quell-HTML vorher eingeebnet), nicht mit dem
einzeiligen `htmlToText` — sonst klebte eine Überschrift „Anna" oder eine Dialogzeile
ohne Schlusspunkt am nächsten Absatz und wurde zur direkten Nennung.

**Der Grobfilter** (`COARSE_RE`, [patterns.js](../lib/figure-age/patterns.js)) vor den
Mustern muss jede Form durchlassen, an der ein Muster greift — auch das blosse Zahlwort
(„Sie war damals zwölf", „im Alter von vierzig"). Er liegt darum neben den Mustern, nicht
im Scan. Das Kopula-Muster kennt `war/ist/wird/werde/…` mit bis zu zwei Zeitadverbien,
Ziffer und Zahlwort, Deutsch und Englisch, und lässt Mengen („12 Minuten", „12.30 Uhr")
und Jahreszahlen liegen. Englisches „am" gilt nur als „I am"/„I'm" — allein griffe es in
jedem deutschen Datum („am 12. Mai").

**Fenster um die Angabe.** Ein Kandidatensatz geht mit höchstens 320 Zeichen an das
Modell, geschnitten um die (erste harte) Angabe, nicht ab dem Satzanfang: ein langer
Vorsatz („Figur steht im Satz davor") verdrängte die Zahl sonst, und die Zitat-Prüfung
verwürfe ein korrektes Zitat (`clipSatz`, [scan.js](../lib/figure-age/scan.js)). Die
nächste Nennung der Figur kommt mit, wenn sie ins Fenster passt; geschnitten wird an
Wortgrenzen ohne Auslassungszeichen.

**Nachrichtenverläufe** ([nachrichtenverlauf.md](nachrichtenverlauf.md)) laufen nicht durch
das Satzfenster: Chat-Zeilen tragen selten Satzzeichen und klebten sonst an Absenderzeile,
Nachbarnachricht und Erzählsatz — „bin jetzt 18 jahre alt" vor „Anna legte das Handy weg."
wurde zur direkten Angabe über Anna. Der Job liest das Seiten-HTML (`loadPageContents`
mit `keepHtml`); der Erzähltext läuft **ohne** Verlauf durch `scanPage` (auch als Live-Text
der semantischen Nachlese), jede Nachricht einzeln durch `scanMsgUtterances`
([scan.js](../lib/figure-age/scan.js)): eine im Text genannte Figur ist direkt gemeint, der
Absender aus der geltenden Namenszeile seiner Seite ([html-text.js](../lib/html-text.js)#`msgUtterances`)
indirekt; der Satz trägt ihn als „Name: …" voran. Nachrichten ohne Namenszeile ihrer Seite —
meist die ausgehenden — ergeben nur mit Figur im Text etwas — kein Rückgriff auf den Satz
davor, denn wem das Telefon gehört, steht nur in einer Namenszeile.

## Bündel und Abbruch

Ein Bündel hat zwei Deckel ([shared/bundles.js](../routes/jobs/shared/bundles.js)#`bundleBlocks`):
die Eingabe (Zeichen der Stellen) und die geschätzte Antwort (Tokens je Figur und Stelle,
höchstens 60 % des Output-Caps) — ohne den zweiten passte ein ganzes Buch in ein Bündel,
und jeder Lauf zahlte einen abgerissenen Call. Gleiches Muster im Schulweg-Vorschlag.
Reisst ein Bündel trotzdem am Output-Cap (`aiTruncated`), wird es halbiert und erneut gestellt;
erst eine einzelne Figur, die allein nicht passt, beendet den Lauf mit Fehler. Ein
**Abbruch wirft** an jeder Schleife und unmittelbar vor dem Schreiben — der Lauf endet
`cancelled`, und der vorige Index bleibt stehen (ein Teilstand darf den Full-Replace nie
auslösen).

## Der gerechnete Wert hängt am Ankerjahr der Figur

`gerechnet` = `jahr_im_roman − geburtsjahr`, wobei `jahr_im_roman` das **jüngste
datierte Ereignis dieser Figur** ist ([lib/figure-years.js](../lib/figure-years.js)) —
nicht das Ende des Buchs. Eine Figur, die 1987 aus der Geschichte verschwindet,
während das Buch bis 2003 läuft, ist fünf und nicht einundzwanzig.
Ein Ereignis im Geburtsjahr oder davor ist **kein** Ankerjahr: ist die eigene Geburt
(oft nur aus „Jahrgang 1960") das jüngste datierte Ereignis, gälte die Figur sonst
als null Jahre alt. Sie zählt dann als undatiert und fällt aufs Buchende zurück.

Gerechnet wird mit dem Geburtsjahr **dieser Zeile** (Steckbrief › Text › Zeitstrahl-
Geburtsereignis), nicht mit dem fertigen `alter_im_roman`: das stützt sich auf das
Geburtsjahr des Zeitstrahls, und stünde in der Zeile eines aus dem Text, passten
Geburtsjahr und gerechnetes Alter nicht zusammen. Bei gleichem Geburtsjahr ist es
dieselbe Zahl wie im Figuren-Katalog. Ein **Todesjahr** aus dem Text deckelt das
Ankerjahr — eine Figur, an die 1990 noch erinnert wird, die aber 1950 starb, wird
nicht älter als bei ihrem Tod.

Die buchweite Jahresspanne (`bookYearSpan`) ist deshalb **nur Rahmen für den
Prompt** und geht nicht in die Verdichtung ein.

**Text gegen Rechnung** (`widerspruch.typ = 'rechnung'`): `gerechnet` gilt am Ankerjahr,
dem spätesten Punkt der Figur — eine Angabe aus Kapitel 1 ist damit nicht vergleichbar.
Nennt ein Beleg sein Bezugsjahr, wird dort gerechnet (`wert` gegen `bezugsjahr −
geburtsjahr`); ohne Bezugsjahr bleibt nur die Richtung: ist `gerechnet` kleiner als das
höchste Textalter, stimmt etwas nicht. Höher ist der Normalfall.

**Welches Text-Geburtsjahr zählt:** der erste als sicher gemeldete Fund, sonst der erste.

## Datenmodell (abgeleiteter Index, Full-Replace pro Lauf)

Ein Lauf ersetzt nur die Zeilen der **eigenen** Figuren (`figures.user_email`) — Figuren und Lauf-Kopf sind pro (Buch, User), ein buchweites Löschen räumte in einem geteilten Buch die Tabelle der anderen Mitarbeitenden ab.

- `figure_ages` — **eine Zeile pro Figur**: Altersspanne, Bezugsjahre, Geburtsjahr +
  dessen Quelle, `gerechnet`, Konfidenz, `widerspruch_json`.
- `figure_age_belege` — die Fundstellen: `art`/`wert`/`zitat`/`page_id` (Sprungziel).
- `figure_age_scans` — Lauf-Kopf pro Buch + User: „Stand vom", `content_sig` für den
  Delta-Skip, `embed_used`.

Schreibpfad ausschliesslich [db/figure-ages.js](../db/figure-ages.js)#`replaceFigureAges`
(eine Transaktion). Kein Delta: eine Figur, deren Altersangabe im Text gestrichen
wurde, müsste sonst aktiv gelöscht werden — und genau das vergisst man.

## Pflicht-Invarianten

- **`figures` wird nie geschrieben.** `geburtstag` gehört dem Autor. Weicht der
  Textfund davon ab, ist das ein **Befund** (`widerspruch.typ = 'geburtsjahr'`) und
  keine Korrektur. Beim Anzeigen gewinnt der Steckbrief.
- **Zwei Alters-Spalten bleiben zwei Spalten.** „Alter" = wörtliche Angabe (mit
  Beleg), „gerechnet" = Rekonstruktion aus Geburtsjahr + erzählter Zeit. Eine einzige
  Spalte müsste sich für eine Quelle entscheiden und würde den Widerspruch
  verschweigen — der Widerspruch ist der Mehrwert.
- **Die Tabelle funktioniert ohne Lauf.** Ohne Alters-Index zeigt sie, was Steckbrief
  und Zeitstrahl hergeben (`alter_im_roman` aus [lib/figure-years.js](../lib/figure-years.js)),
  plus den Hinweis, dass noch nichts analysiert wurde. Der Knopf ergänzt, er schaltet
  nicht frei.
- **Ein Alter ist eine Spanne.** Angezeigt wird `12–19`, nicht `12`: die Figur ist im
  Buch nicht zwölf, sie wird zwischen zwölf und neunzehn. Darum verteilt
  `selectCandidates` die Stellen über den Buchbogen (erste und letzte immer) statt die
  ersten N zu nehmen — sonst steht dort das Alter aus Kapitel 1.
- **Konfidenz in drei Stufen, nicht als Kommazahl** — und als **Ton der einen
  Herkunfts-Plakette**, nicht als zweite Plakette daneben: „aus dem Text" +
  „gerechnet" nebeneinander lesen sich wie zwei widersprüchliche Quellenangaben.
  Das Wort steht im Tooltip. Eine Zahl wie `0.75` behauptet ohnehin eine Präzision,
  die eine Heuristik nicht hat.
- **Ohne Alter kein Bezugsjahr.** `jahr_im_roman` fällt für eine undatierte Figur
  auf das späteste Jahr des Buchs zurück; neben „unbekannt" wäre diese Jahreszahl
  eine Scheinantwort.
- **Zwei verschiedene Geburtsjahre im Text sind ein Befund** (`widerspruch.typ =
  'geburtsjahrText'`), genau wie die Abweichung vom Steckbrief. Gezählt wird das erste.
  Ohne Steckbrief-Eintrag gilt dasselbe für Text gegen Geburtsereignis im Zeitstrahl
  (`'geburtsjahrZeitstrahl'`); der Text gewinnt.
- **Ohne Lauf dieselbe Herkunft wie nach dem Lauf.** Ein Alter, das der Katalog aus dem
  Steckbrief-Geburtsjahr rechnet, heisst schon vor der Analyse „aus Geburtsjahr" (Ton
  mittel), nur eines aus dem Zeitstrahl-Geburtsereignis „aus Zeitstrahl" — sonst
  wechselte dieselbe Zahl mit dem ersten Lauf Plakette und Ton.
- **Ein Geburts-Event gehört nicht jeder verknüpften Figur.** «Geburt von Manuel»
  verknüpft auch Eltern und Grosseltern. Zugeordnet wird es nur der einen Figur ohne
  früheres datiertes Ereignis, bei Gleichstand der im Ereignistext genannten; sonst
  niemandem ([lib/figure-years.js](../lib/figure-years.js)#`birthYearsFromEvents`).
  Ein falsches Geburtsjahr macht die Mutter in Katalog und Plot-Zeitmessung zum Kind.
- **„Alter sinkt im Buchverlauf" ist ein Hinweis, kein Fehler.** Rückblenden sind
  legitim. Das Badge heisst darum `prüfen`, nicht „falsch", und die Konfidenz sinkt
  dadurch nicht — alle anderen Widersprüche ziehen sie eine Stufe herunter.
- **Bezugsjahr beim Textalter nur aus den Stellen.** Nennt keine Stelle ein Jahr, bleibt
  die Spalte leer; das Ankerjahr neben einer Spanne aus dem ganzen Buch läse sich, als
  gelte sie in diesem einen Jahr. Beim gerechneten Alter ist das (ggf. vom Todesjahr
  gedeckelte) Ankerjahr der Bezugspunkt.
- **Eine Indexzeile mischt nicht mit dem Katalog.** Hat die Figur eine Zeile, kommen
  Geburtsjahr und gerechneter Wert nur aus ihr, auch wenn einer davon leer ist — sonst
  stünden ein Textgeburtsjahr und ein Alter aus einem anderen Geburtsjahr nebeneinander.
- **Nur die Zeitlinien-Achse ist gegated.** Der gerechnete Wert setzt
  `book_settings.zeitlinie_real` voraus (gleiche Regel wie `alter_im_roman`); eine
  wörtliche Angabe („war zwölf") gilt immer — auch in Büchern ohne Kalender-Zeitlinie.
- **`AGE_ANALYSIS_VERSION`** ([lib/figure-age.js](../lib/figure-age.js)) gehört in die
  `content_sig`. Wer Muster, Verdichtung oder Prompt ändert, erhöht sie — sonst
  überspringt der Delta-Skip den nächsten Lauf.
- **Der Figurenstamm und die Zeitlinie gehören in die `content_sig`.** Eine neu
  angelegte Figur ändert das Ergebnis, ohne dass eine Seite angefasst wurde; ebenso
  `zeitlinie_real` und je Figur Ankerjahr + Geburtsjahr aus `computeFigureYears`, an
  denen `gerechnet` hängt.
- **Ob ein fertiger Index existiert, gehört in die `content_sig`** (`indexReady(bookId)`):
  die semantische Nachlese liefert erst mit Index Stellen — ohne ihn bliebe ein Lauf
  von vor dem Erstindex „unverändert". Nur der Bool, nicht der Zeitstempel: den setzt
  jeder nächtliche Index-Lauf neu, die Signatur bräche sonst täglich.
- **Semantische Stellen tragen ihre echte Position** (`offset` = Lage der
  Live-Passage auf der Seite + Satz-Offset darin), damit `selectCandidates` sie
  neben den Musterfunden in Leserichtung ordnet.

## Wege

- Karte: Reiter „Alter" in der Figuren-Karte
  ([partials/figuren-alter.html](../public/partials/figuren-alter.html),
  [js/book/figuren-alter.js](../public/js/book/figuren-alter.js), Methods gespreadet in
  `figurenCard`).
- Lesen: `GET /figures/:book_id/alter` ([routes/figures-alter.js](../routes/figures-alter.js), ab `viewer`).
  Zeilen sind nach `figures.fig_id` geschlüsselt — die Kennung, die der Katalog als
  `id` nach vorne gibt.
  `scan.veraltet` nennt, warum der Lauf nicht mehr zum Buch passt (`version` —
  ältere `AGE_ANALYSIS_VERSION`, `text` — Abschnitt nach dem Lauf gespeichert,
  `figuren` — Figurenstamm danach geändert, etwa durch die Komplettanalyse); die
  Karte zeigt dazu einen Hinweis über der Tabelle. Der Index baut sich nur auf
  Knopfdruck neu — ohne Hinweis läse sich ein alter Lauf wie ein aktueller. Bewusst
  grob gegen `scanned_at` statt der exakten `content_sig`: die bräuchte den Volltext
  aller Abschnitte im Leseweg.
- Analysieren: `POST /jobs/figur-alter` (ab `editor`, nur ein ausdrückliches
  `force: true` überspringt den Delta-Skip — der Knopf der Karte setzt es, manuell
  ausgelöst heisst „ich will jetzt eine Zahl sehen"; ohne Angabe gilt der Delta-Skip).
- Tests: [tests/unit/figure-age.test.js](../tests/unit/figure-age.test.js) +
  [figure-age-befunde.test.js](../tests/unit/figure-age-befunde.test.js) (reine
  Schichten), [tests/integration/figur-alter.test.js](../tests/integration/figur-alter.test.js)
  (Naht der drei Schichten mit Mock-AI, inkl. der beiden Prüfungen),
  [tests/e2e-app/figuren-alter.spec.js](../tests/e2e-app/figuren-alter.spec.js)
  (Reiter in der echten App).

## Zwei Layout-Fallen, die hier schon zugeschnappt sind

- **`display:flex` gehört nie auf ein `<td>`.** Eine Zelle mit `display:flex` ist
  kein `table-cell` mehr, der Browser wickelt sie in eine anonyme Zelle — die Spalte
  verrutscht gegen ihren Kopf. Der Flex-Kontext gehört auf einen inneren Span
  (gebraucht wird er nur, damit `.figur-typ-dot` als inline-Span seine 8×8 bekommt).
- **Der Chevron-Platz bleibt immer reserviert** (`visibility: hidden`, nicht
  `x-show`), sonst beginnen Punkt und Name in Zeilen ohne Belege weiter links und
  die Namensspalte franst aus.
