# Lebenslauf der Figuren (Reiter „Lebenslauf" der Figuren-Karte)

Beantwortet **„wo stand die eine Figur, als die andere X erlebte"** — Lebensphasen
als Zeilen, die gewählten Figuren als Spalten, deren datierte Lebensereignisse in
den Zellen.

## Kein Job, kein Index, keine Route (für die Matrix)

Die Matrix ist **reine Anzeige** auf Daten, die schon da sind: `lebensereignisse`
(mit `datum`, `subtyp`, `kapitel`, `page_id`) und das Geburtsjahr stehen im
Figuren-Katalog, `GET /figures/:book_id`, befüllt von der Komplettanalyse. Ein
eigener Extraktionslauf würde dieselbe Biografie ein zweites Mal erheben — und
dann konkurrierend. Zwei Wahrheiten über dasselbe Leben sind schlechter als eine.

Die ganze Sachlogik liegt darum in einer reinen Schicht,
[public/js/book/figuren-lebenslauf.js](../public/js/book/figuren-lebenslauf.js);
die Alpine-Methoden daneben sind dünne Leser darauf.

## Die Zeilen-Achse ist das ALTER, nicht das Jahr

Das ist die Existenzberechtigung des Reiters und die Invariante, an der er steht
oder fällt. Zwei Figuren, ein Jahr auseinander geboren, gehen im selben
Lebensabschnitt zur Schule — aber in verschiedenen Kalenderjahren. Nach Jahren
sortiert stünden sie versetzt, und der Vergleich wäre zerschnitten. Die Zelle
zeigt trotzdem **Jahr und Alter** (`1997 · 12 J.`): das Jahr verankert im Buch,
das Alter erklärt die Zeile.

Der Zeitstrahl-Reiter der Ereignisse-Karte ist das Gegenstück — dort **ist** die
Kalenderachse die Frage. Beide nebeneinander, keiner ersetzt den anderen.

## Die Phasen-Schnitte liegen an den biografischen Nähten

`LEBENSPHASEN` (SSoT im Modul): Vorgeschichte · Geburt (0) · Frühe Kindheit (1–5)
· Schulkind (6–11) · Jugend (12–17) · Junges Erwachsenenalter (18–29) ·
Erwachsenenalter (30–49) · Reifes Alter (50–64) · Hohes Alter (65+), dazu die
Sammelzeile „Ohne Jahresangabe".

Die Grenzen liegen bewusst **nicht** auf runden Zehnern, sondern an Einschulung,
Übertritt in die Oberstufe, Volljährigkeit und Pensionierung. Die Naht ist der
Grund, warum zwei Figuren überhaupt in einer Zeile stehen; ein Band 10–19 legte
Primar- und Oberstufenzeit derselben Figur übereinander. Die Bänder sind
lückenlos und überschneidungsfrei — gegated.

## Pflicht-Invarianten

- **Ohne Geburtsjahr keine Spalte.** Ohne Bezugspunkt fiele jedes Ereignis in die
  Sammelzeile, und die Spalte täuschte eine Aussage vor, die sie nicht macht. Wie
  viele Figuren das betrifft, wird **ausgewiesen** (`ohneJahr`) — eine stumm
  gekürzte Liste liest sich als „mehr Figuren gibt es nicht".
- **Undatierte und vorgeburtliche Ereignisse bekommen eigene Zeilen**, statt
  weggelassen zu werden. „Steht nicht in der Matrix" hiesse sonst „gibt es
  nicht"; ein Ereignis vor der Geburt ist kein Rechenfehler, sondern
  Vorgeschichte.
- **Leere Phasen erscheinen nicht.** Eine Zwischenzeile ohne Ereignis ist kein
  Befund, nur Luft. Eine leere **Zelle** in einer sonst gefüllten Zeile bleibt
  dagegen sichtbar — dass hier nichts passierte, während die andere Figur etwas
  erlebte, ist genau die Aussage.
- **Das Geburtsjahr folgt derselben Vorrangordnung wie die Alters-Analyse**
  (`figurGeburtsjahr`): Alters-Index → Katalog (`geburtsjahr` aus dem
  konsolidierten Zeitstrahl) → Stammfeld `geburtstag`. Der Reiter zieht den Index
  beim Öffnen über `ensureFigurenAlter()` mit — **non-fatal**: ohne Lauf trägt der
  Katalog die Matrix allein. Er **schaltet nichts frei**, er verbessert nur.
- **`jahrAusDatum` ist wortgleich mit
  [lib/figure-years.js](../lib/figure-years.js)#`yearFromString`** (erste
  vierstellige Zahl). Eine grosszügigere Variante hier liesse Lebenslauf und
  Alters-Spalte an genau den Datumsangaben auseinanderlaufen, an denen sie sich
  unterscheiden.
- **Die Spaltenzahl ist gedeckelt** (`LEBENSLAUF_MAX_SPALTEN`), am Deckel wird
  **gesperrt statt ignoriert**, und der Deckel steht als Konstante im Modul — nie
  als zweite Zahl im Template.
- **Kein `sortableTable`.** Die Zeilen sind eine Ordnung (früh nach spät), keine
  Liste; eine umsortierte Biografie ist keine mehr. Dieselbe Ausnahme wie
  Präsenz-Matrix und Heatmaps.
- **`figures` wird nie geschrieben** — wie im Alters-Reiter. Der Lebenslauf ist
  eine Lesart, keine Quelle.

## Schullaufbahn

Beantwortet **„in welcher Klasse war Figur X im Jahr Y"** — im Code gerechnet,
nie vom Modell. Ein Sprachmodell rechnet Stichtag, Schuljahreswechsel und
Stufenübertritte zuverlässig falsch genug, dass die Antwort nicht mehr belegt ist.

**Zwei Ebenen:**

- **Buch:** `book_settings.schulsystem_json` (Bucheinstellungen › Reiter «Schule»,
  `PUT /booksettings/:book_id/schulsystem`, ab `editor`). Ein Schalter oben im Reiter
  entscheidet, ob das Buch überhaupt eine Schullaufbahn rechnet: aus = `null`
  (Standard; nur wenige Bücher brauchen das), an = Vorlage «CH allgemein (HarmoS)»
  als Ausgangspunkt. Eigene Schulwege der Figuren bleiben beim Ausschalten
  gespeichert. Gewählt wird dann eine Vorlage — «CH Solothurn (1990er)» oder
  «CH allgemein (HarmoS)» —, editierbar sind Einschulungsalter, Stichtag,
  Schuljahresbeginn, die Jahre je Stufe und der Standardweg. Stufen und benannte
  Wege kommen aus der Vorlage (`SCHUL_VORLAGEN`); gespeichert werden nur die
  editierbaren Werte, normalisiert. Unbekannte Vorlage → `400`. Wechselt der Autor
  zwischen zwei Vorlagen, fragt die Oberfläche vorher mit der Zahl der Figuren,
  deren eigener Weg-Key in der neuen Vorlage fehlt.
  Im selben Abschnitt und Schreibpfad (optionales Feld `handlungsjahr`; fehlt der
  Key, bleibt der Wert) steht das **Handlungsjahr** (`book_settings.handlungsjahr`):
  das Jahr, in dem die Handlung überwiegend spielt. Der Steckbrief zeigt damit die
  Klassenstufe «im Handlungsjahr».
  Buchtypen ohne Figuren-Biografien (`SCHULWEG_OHNE_BUCHTYPEN` in
  school-path.js: Sachbuch, Wissenschaft, Essay, Lyrik, Blog, Journalismus) haben
  keine Schullaufbahn: dort fehlen der Reiter «Schule» (samt Palette-Sprung), Steckbrief-Block und
  KI-Vorschlag, und die Schulweg-Routen, der Job und `get_figure_age` lesen über
  `lib/buchtyp.js#activeBookSchulsystem` kein System. Ein gespeichertes bleibt
  liegen und greift wieder, sobald der Buchtyp wechselt.
- **Figur:** `figure_school_paths` (eine Zeile pro `figures.id`): Weg-Key (leer =
  Standardweg des Buchs), Einschulungsjahr-Override, Repetitionen (`[{stufe, klasse}]`,
  höchstens vier; eine Repetition verlängert die Stufe um ein Jahr). Repetiert werden
  kann nur eine Klasse, die der wirksame Weg durchläuft (`repetitionsKlassen` — auf
  `bez_gym` gibt es keine 3. Bez); alles andere ist ein `400
  SCHULWEG_REPETITION_INVALID`, nichts fällt still heraus. Ein Weg-Key, den das
  System nicht (mehr) kennt (`wegGueltig`), rechnet mit dem Standardweg; Steckbrief
  und `get_figure_age` (`quelle: 'standard'`) sagen das. Gepflegt im Steckbrief
  (Fragment [figuren-detail-schulweg.html](../public/partials/figuren-detail-schulweg.html)),
  `PUT /figures/:book_id/schulwege/:fig_id` (ab `editor`), gelesen mit
  `GET /figures/:book_id/schulwege` (ab `viewer`, nur eigene Figuren). Gespeichert
  wird an `figures.id`, nach aussen geschlüsselt nach `fig_id` — die `fig_id` wird
  bei jeder Komplettanalyse neu nummeriert, die Zeile bleibt (Reconcile matcht in
  place). Figuren-Merge übernimmt den Schulweg der Quelle, wenn das Ziel keinen
  eigenen hat (`source IS NULL` — eine Zeile, die nur einen KI-Lauf trägt, zählt
  nicht). Der Job legt für Figuren ohne Ergebnis keine Zeile an, Verwerfen auch nicht.

**Die Rechnung hat genau einen Ort:**
[public/js/book/school-path.js](../public/js/book/school-path.js) (Browser-ESM, auf
dem Server über `lib/esm-bridge.js#schoolPath`). Konsumenten: Bucheinstellungen,
Steckbrief, Lebenslauf-Zellen, Schreibpfade der Routen, Job und `get_figure_age`.

**Die Geburt hat ebenfalls genau einen Ort:** `lib/figure-birth.js`
(`resolveBirthsForFigures`, Vorrang Steckbrief › Geburts-Ereignis › Alters-Index,
Monatsnamen inklusive). `GET …/schulwege` liefert sie je Figur als `geburten`;
Steckbrief und Lebenslauf rechnen damit und leiten nichts selbst her — sonst nennten
Lebenslauf und Buch-Chat für dieselbe Figur verschiedene Klassen. Nach einer
Geburtsdatums-Änderung im Steckbrief lädt die Karte die Schulwege neu.

- **Einschulung:** im Jahr, bis zu dessen Stichtag die Figur das Einschulungsalter
  erreicht (Stichtag 30. April: am 30.4. geboren → selbes Jahr, am 1.5. → ein Jahr
  später). Ohne Monat (bzw. ohne Tag im Stichtag-Monat) ist das nicht entscheidbar:
  dann **zwei** Kandidaten, das Ergebnis trägt `unsicher` + `alternative` — nie eine
  stillschweigend gewählte Variante. Ein Override ersetzt die Rechnung.
- **Schuljahr:** ab dem Monat des Schuljahresbeginns zählt das neue. Ein Jahr
  **ohne Monat** heisst Herbst (Schuljahr ab Sommer dieses Jahres);
  `schoolStagesForYear` liefert zusätzlich das Frühjahr, wenn es in einer anderen
  Klasse liegt — der Lebenslauf zeigt dann «6. Primar → 1. Bez».
- **Klassennummer** zählt je Stufe ab 1 («1. Bez»); `klasseStart` an der Stufe
  verschiebt den Anfang.
- **Übertritt vor dem Stufenende:** `bis` am Weg verlässt eine Stufe nach dieser
  Klasse (gedeckelt durch die eingestellten Jahre), z.B. `bez_gym` nach der 2. Bez.
- **Ohne Geburtsjahr** (und ohne Override) gibt es keine Stufe — wie beim Alter.
- **Vorlage-, Stufen- und Weg-Keys sind Persistenz-Konstanten** (stehen in
  `schulsystem_json` und `figure_school_paths.weg`): ergänzen ja, umbenennen nein.
  Labels sind i18n-Keys `schule.vorlage.*`, `schule.stufe.*`, `schule.klasse.*`
  (mit `{n}`), `schule.weg.*` in beiden Locales; Server-Texte für das Modell lösen
  sie über [lib/school-labels.js](../lib/school-labels.js) in der Buchsprache auf.

**Solothurn-Vorlage** (Stand vor der Sek-I-Reform 2011/12): Primar 6, Bez/Sek/
Oberschule je 3 Jahre; das Untergymnasium (3 Jahre) schliesst an die **5.** Primar
an, aus der Bez tritt man **nach der 2. Klasse** in die Maturitätsschule
(Obergymnasium, 4 Jahre) über — beide Wege enden nach 12 Schuljahren mit der Matur.
Vor 1998/99 war das Langzeitgymnasium ein 7-Jahre-Block ab der 5. Primar; gerechnet
ergibt das dieselben Jahre. Wege: Bez allein, Bez → Obergym (nach 2. bzw. 3. Bez),
Bez/Sek/Oberschule → Lehre, Kanti (Unter- → Obergym), Untergym → Lehre, dazu die
schultyp-neutrale Stufe «Oberstufe» (allein bzw. → Lehre) für Figuren, deren Schule
der Text offenlässt; Standardweg `oberstufe_lehre`. Quellen im Kommentar von `SCHUL_VORLAGEN`.

**KI-Vorschlag** (Job `schulweg-vorschlag`, `POST /jobs/schulweg-vorschlag`, ab
`editor`, Knopf im Lebenslauf-Reiter, ausserdem von der Komplettanalyse nach dem
Katalog eingereiht — Schritt `schulweg`, siehe «Komplettanalyse» unten;
[routes/jobs/schulweg-vorschlag.js](../routes/jobs/schulweg-vorschlag.js), Prompt
[prompts/schulweg.js](../public/js/prompts/schulweg.js)):

1. deterministisch: für Figuren, deren Stufe sich rechnen lässt (Geburt oder
   Einschulungs-Override), die Sätze, in denen die Figur zusammen mit einem
   Schulbegriff steht (`SCHOOL_RE`: Bez, Kanti, Gymnasium, Matura, Primar, Sek,
   Klasse, eingeschult, Lehre …). Steht im Satz keine Figur, zählt der Satz davor —
   nur wenn dort **genau eine** steht. Gekappt auf 320 Zeichen, höchstens acht je
   Figur: zuerst starke Begriffe (Schulart, Abschluss), mit schwachen (Klasse,
   Schule, Ausbildung) aufgefüllt, je über das Buch verteilt.
2. Modell: wählt **nur** aus den Weg-Keys dieses Buchs (Schema-Enum pro Call), mit
   wörtlichem Zitat und Stellennummer; Einschulungsjahr und Repetition nur, wenn
   ausdrücklich genannt. Dazu **Klassenangaben** (`jahr`, `monat?`, `stufe`,
   `klasse`, Zitat): nur wo Jahreszahl und Klasse in derselben Stelle stehen. Figuren
   mit Autor-Schulweg bekommen keinen Weg-Vorschlag, wohl aber Klassenangaben.
3. deterministisch: Zitat muss in der genannten (sonst einer) Stelle **dieser**
   Figur stehen und einen Schulbegriff enthalten, sonst verworfen; ein
   Einschulungsjahr bleibt nur, wenn die Jahreszahl im Zitat steht und höchstens
   zwei Jahre vom Einschulungsalter abweicht; eine Repetition nur mit
   Repetitionswort im Zitat und auf einer Klasse des vorgeschlagenen Wegs; eine
   Klassenangabe nur mit Jahreszahl **und** Klassennummer (Ziffer oder Ordinalwort)
   im Zitat. Ein Vorschlag, der dem schon übernommenen Stand entspricht, fällt weg
   (`schonUebernommen`). Verwerfungen stehen im Job-Ergebnis
   (`verworfen.weg/zitat/figur/klasse`), die Oberfläche meldet sie zusammen mit den
   Figuren ohne Geburtsjahr bzw. ohne Schul-Textstellen.

Der Job schreibt **ausschliesslich** `vorschlag_json` (Weg, Zitat, `page_id`,
Begründung) und `klassenangaben_json`. Jede gefragte Figur bekommt den Stand ihres
Laufs. Der Steckbrief zeigt den Vorschlag mit Beleg; **Übernehmen**
(`POST …/schulwege/:fig_id/uebernehmen`) prüft ihn erneut gegen das aktuelle
Schulsystem, fügt eine vorgeschlagene Repetition zu den bestehenden hinzu (die der
neue Weg nicht durchläuft, fallen weg und werden als `repetitionen_entfernt`
gemeldet) und setzt `source = 'ki'`; **Verwerfen** (`DELETE …/vorschlag`) leert ihn.

**Klassenangaben gegen die Rechnung:** ob eine Angabe stimmt, entscheidet
`pruefeKlassenangabe` beim **Lesen**, nicht der Job — ein später geänderter Weg
bewertet sie sofort neu. Ohne Monat zählen Frühjahr und Herbst des Jahres; eine
schultyp-neutrale Stufe (`vertritt`: «Oberstufe» für Bez/Sek/Oberschule)
widerspricht der konkreten nicht. Urteile: `stimmt`, `moeglich` (nur in der
Alternative einer unsicheren Einschulung), `widerspruch` (Befund für Text oder
Schulweg, mit der gerechneten Klasse daneben). Das Job-Ergebnis zählt die
Widersprüche des Stands beim Lauf.

**Anzeige:** mit Schulsystem zeigt jede datierte Zelle des Lebenslaufs zusätzlich
die Klassenstufe («1999 · 13 J. · 1. Bez»); der Monat kommt aus dem strukturierten
Ereignisdatum (`datum_month`). Über der Matrix beantwortet eine **Jahr-Abfrage**
«wer war im Jahr Y in welcher Klasse» für die gewählten Spalten (Stufe, «noch nicht
eingeschult» oder «Schule abgeschlossen»). Der Buch-Chat bekommt dieselbe Zahl über
`get_figure_age` ([chat-tools.md](chat-tools.md)).

Tests: [tests/unit/school-path.test.mjs](../tests/unit/school-path.test.mjs)
(Stichtag-Grenzfälle, Schuljahreswechsel, Repetition, Bez → Obergym, Untergym →
Obergym, Normalisierung, Repetition je Weg, `wegGueltig`, `pruefeKlassenangabe`),
[tests/integration/schulweg-routes.test.js](../tests/integration/schulweg-routes.test.js)
(ACL, Validierung, Geburt vom Server, Handlungsjahr, Übernehmen/Verwerfen, keine
Leerzeilen, CASCADE), [tests/unit/entity-merge.test.js](../tests/unit/entity-merge.test.js)
(Merge mit Schulweg),
[tests/integration/schulweg-vorschlag.test.js](../tests/integration/schulweg-vorschlag.test.js)
(Belegprüfung und Klassenangaben mit Mock-AI).

## Berufsweg und Hobbys

Beantwortet **„was tat Figur X im Jahr Y"**: Ausbildung, Stellen, Hobbys — mit
Zeitraum, gepflegt im Steckbrief, gelesen von Alterstabelle, Lebenslauf und
`get_figure_age`. Der Schulweg lässt sich rechnen, ein Berufsweg nicht: er kommt
aus dem Text oder vom Autor, darum Daten statt Regelwerk.

**Zwei Listen, eine Mechanik.** `figure_jobs` (Berufsweg: `art` =
`ausbildung`|`beruf`, `taetigkeit`, `arbeitgeber`, `ort`) und `figure_hobbies`
(`hobby`, `ort`), beide mit `von_jahr`/`von_monat`/`bis_jahr`/`bis_monat`,
`notiz` und Beleg (`zitat`, `page_id`, `begruendung`). Ein Schreib-/Lesepfad für
beide: [db/figure-stationen.js](../db/figure-stationen.js) (`kind` = `berufe` |
`hobbys` wählt Tabelle und Pflichtfeld). Gespeichert an `figures.id` (CASCADE),
nach aussen nach `fig_id` geschlüsselt — wie der Schulweg.

**Zeitraum beidseitig offen.** `bis` leer heisst „läuft noch oder Ende
unbekannt" — am Stichtag aktiv, sobald begonnen. Ohne Beginn ist der Start
unbekannt: aktiv bis zum Ende, markiert `unsicher` («(?)» in der Tabelle,
`beginn_unbekannt` im Chat). Ohne jede Jahresangabe ist die Station undatiert:
im Steckbrief ja, am Stichtag und im Lebenslauf nie. Ohne Monat auf einer Seite
zählt das ganze Jahr.

**Die Rechnung hat genau einen Ort:**
[public/js/book/figure-stationen.js](../public/js/book/figure-stationen.js)
(Browser-ESM, auf dem Server über `lib/esm-bridge.js#figureStationen`):
`stationAm`/`stationenAm` (am Stichtag), `normalizeStation` (Formular **und**
Route — derselbe 400 wie die Fehlermeldung am Feld), `stationenAlsEreignisse`
(Beginn/Ende als Lebenslauf-Einträge). Offene Vorschläge zählen nirgends mit.

**Zwei Schreiber, getrennte Zeilen** (`status`):
- Autor: `POST/PUT/DELETE /figures/:book_id/stationen/:kind/:fig_id[/:id]`
  ([routes/figures-stationen.js](../routes/figures-stationen.js), ab `editor`;
  Lesen `GET /figures/:book_id/stationen` ab `viewer`, nur eigene Figuren) legt
  Zeilen mit `status = 'aktiv'`, `source = 'autor'` an. Den Beleg setzt die Route
  nie.
- Job `stationen-vorschlag` (`POST /jobs/stationen-vorschlag`, ab `editor`,
  Knopf im Lebenslauf-Reiter; [routes/jobs/stationen-vorschlag.js](../routes/jobs/stationen-vorschlag.js),
  Prompt [prompts/stationen.js](../public/js/prompts/stationen.js)) schreibt
  **nur** Zeilen mit `status = 'vorschlag'` und ersetzt je gefragter Figur genau
  diese (`replaceVorschlaege`) — jede Figur bekommt den Stand dieses Laufs.
  **Übernehmen** (`…/:id/uebernehmen`) setzt `aktiv` + `source = 'ki'`, der Beleg
  bleibt; **Verwerfen** löscht die Zeile.

**Belegprüfung** — drei Schichten wie beim Schulweg, Stellen-Mechanik geteilt in
[routes/jobs/shared/figure-stellen.js](../routes/jobs/shared/figure-stellen.js):
1. deterministisch: Sätze mit Figur und Arbeits- (`BERUF_RE`) bzw.
   Freizeitbegriff (`HOBBY_RE`), je Thema eigene Auswahl (starke Begriffe zuerst,
   über das Buch verteilt) — sonst verdrängten Arbeitssätze die Hobbys.
2. Modell: Einträge mit wörtlichem Zitat und Stellennummer; was „schon erfasst"
   ist, steht im Prompt.
3. deterministisch: Zitat in einer Stelle **dieser** Figur, ein Wort der
   Tätigkeit bzw. des Hobbys im Zitat (Stammvergleich), sonst verworfen
   (`verworfen.zitat/feld/figur`). Ein Jahr bleibt nur, wenn es im Zitat steht
   und nicht vor der Geburt liegt, ein Monat nur, wenn er dort genannt ist; ein
   gestrichenes Jahr macht den Eintrag undatiert, verwirft ihn nicht
   (`verworfen.jahr`). Gleiche Tätigkeit + gleiches Beginnjahr wie eine aktive
   Zeile → `schonVorhanden`, kein Vorschlag.

**Lebenslauf:** Beginn und Ende jeder datierten aktiven Station stehen als
Einträge in der Zeile ihres Alters, mit eigenem Badge statt Subtyp. Eine Figur
mit Stationen, aber ohne Lebensereignisse taugt als Spalte.

**Komplettanalyse:** sie schreibt selbst keine Stationen, reiht aber nach dem
Katalog die beiden Vorschlags-Jobs ein (Umfangs-Schritte `schulweg` und `stationen`,
[pruef-jobs.js](../routes/jobs/komplett/pruef-jobs.js)) — den Schulweg nur, wenn das
Buch ein Schulsystem gespeichert hat. So eingereiht (`nachKatalog`) endet ein Lauf
ohne Figuren bzw. ohne aktives Schulsystem still mit `skipped` statt mit einer
Fehlermeldung. Beide schreiben weiterhin nur Vorschläge; einen Delta-Skip haben sie
nicht, jeder Lauf kostet seine (kleinen) Calls. Läuft eine Komplettanalyse, antworten
beide POST-Routen mit `409 KOMPLETT_ANALYSIS_RUNNING`. Berufliche Wendepunkte, die
sie als Lebensereignis findet, tragen die Subtypen `ausbildung`, `abschluss`,
`stellenantritt`, `berufswechsel`, `jobverlust`, `pensionierung` — datierte
Ereignisse im Zeitstrahl, keine Zeiträume. Das Feld `figures.beruf` bleibt die
Kurzangabe im Steckbrief.

**Mitreisen:** Figuren-Merge hängt alle Zeilen der Quelle ans Ziel
([db/entity-merge.js](../db/entity-merge.js)); `.swbook` trägt beide Tabellen im
Analyse-Block samt offener Vorschläge ([db/book-migration-data/figure-extras.js](../db/book-migration-data/figure-extras.js),
`page_id` umgeschlüsselt); Fassungen frieren sie über denselben Analyse-Block mit
ein. «Aus Vorband übernehmen» ([db/series-carryover.js](../db/series-carryover.js))
kopiert nur aktive Zeilen und ohne Beleg — Zitat und Abschnitt gehören zum Vorband,
die Biografie zur Figur.

Tests: [tests/unit/figure-stationen.test.mjs](../tests/unit/figure-stationen.test.mjs)
(Stichtag, Normalisierung, Lebenslauf-Einträge),
[tests/integration/stationen-routes.test.js](../tests/integration/stationen-routes.test.js)
(ACL, Validierung, Übernehmen/Verwerfen, Zeile nur an der eigenen Figur, CASCADE),
[tests/integration/stationen-vorschlag.test.js](../tests/integration/stationen-vorschlag.test.js)
(Belegprüfung mit Mock-AI, aktive Zeilen unberührt; mutationsgeprüft).

## Verhältnis zum Alters-Reiter

Geschwister, nicht Alternativen: die Alterstabelle ist **eine Zeile pro Figur**
(wie alt ist sie im Buch, mit Beleg), der Lebenslauf eine **Matrix** (wie
verlaufen mehrere Leben nebeneinander). Die beiden Formen lassen sich nicht in
eine Tabelle legen — darum zwei Reiter, die sich denselben Index und dieselbe
Geburtsjahr-Auflösung teilen.

## Wege

- Karte: Reiter „Lebenslauf" in der Figuren-Karte
  ([partials/figuren-lebenslauf.html](../public/partials/figuren-lebenslauf.html),
  [js/book/figuren-lebenslauf.js](../public/js/book/figuren-lebenslauf.js), Methods
  gespreadet in `figurenCard`).
- Lesen: keine eigene Route — `GET /figures/:book_id` (Katalog) plus optional
  `GET /figures/:book_id/alter` (Geburtsjahre aus dem Text) und
  `GET /figures/:book_id/stationen` (Berufsweg und Hobbys).
- Muster der Chip-Auswahl: DESIGN.md → „Auswahl-Chip-Reihe".
- Tests: [tests/unit/figuren-lebenslauf.test.mjs](../tests/unit/figuren-lebenslauf.test.mjs)
  (reine Schicht, Bandgrenzen, Lückenlosigkeit),
  [tests/e2e-app/figuren-lebenslauf.spec.js](../tests/e2e-app/figuren-lebenslauf.spec.js)
  (Reiter in der echten App; die Alters-Ausrichtung ist dort mutationsgeprüft).
