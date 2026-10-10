# Ideen: Stufen, Board und Verknüpfungen

Ideen sind in diesem Haus zweierlei: eine **mögliche Fortsetzung** („hier könnte
die Schwester auftauchen") und eine **Pendenz** an einer Stelle im Text („Beleg
nachtragen, Zeitangabe prüfen"). Beides hängt an **höchstens einem** Anker — einer
Seite **oder** einem Kapitel; ohne Anker gehört die Idee nur dem Buch
(CHECK `page_id IS NULL OR chapter_id IS NULL` in `ideen`).

**Buch-Ideen** sind Einfälle, die noch keinen Ort im Text haben. Sie entstehen
ausschliesslich im Board (die Ideen-Karte ist an Seite bzw. Kapitel gebunden),
stehen dort in der Buch-Bahn ganz oben und werden vom Autor später einer Seite
oder einem Kapitel übergeben — per „Zuordnen" auf der Karte oder per Drag
(siehe „Ein Drag" in § 2). Kein `kind`-Diskriminator
daneben: die zwei nullbaren FKs beschreiben den Anker vollständig. Ein
Seiten-Umzug in ein anderes Buch ([localdb.js](../lib/content-store/backends/localdb.js)#`movePage`)
macht die Ideen der Seite zu Buch-Ideen des Quellbuchs, statt sie mitzunehmen.

Abschnitts- und Buch-Chat können eine Idee an einem Abschnitt oder Kapitel **vorschlagen**
(bemerkter Widerspruch, Fehler, offener Punkt); angelegt wird sie erst, wenn der
User sie dort erfasst — über dieselbe Route wie die Ideen-Karte
([chats.md](chats.md#ideen-vorschläge-abschnitts--und-buch-chat)).

Zwei Oberflächen, dieselben Zeilen:

| | Ideen-Karte | Ideen-Board |
|---|---|---|
| Frage | Was ist an **dieser** Stelle offen? | Was ist im **ganzen Buch** offen, und wie weit? |
| Ort | neben dem Editor bzw. neben der Kapitelbewertung | eigene Hauptkarte (exklusiv) |
| Scope | eine Seite ODER ein Kapitel | ein Buch |
| Code | [cards/ideen-card.js](../public/js/cards/ideen-card.js), [book/ideen.js](../public/js/book/ideen.js) | [cards/ideen-board-card.js](../public/js/cards/ideen-board-card.js), [book/ideen-board/](../public/js/book/ideen-board/) |
| Partial | [ideen.html](../public/partials/ideen.html) | [ideen-board.html](../public/partials/ideen-board.html) |
| Route | `GET /ideen?page_id=` / `?chapter_id=` | `GET /ideen/board?book_id=` |

Geteilt: die Stufen-SSoT ([ideen-shared.js](../public/js/book/ideen-shared.js) /
[lib/ideen-status.js](../lib/ideen-status.js)), die Verknüpfungs-Methoden
([ideen-links.js](../public/js/book/ideen-links.js)) und das Chip-Markup
([ideen-link-chips.html](../public/partials/ideen-link-chips.html)).

**User-privat.** `ideen.user_email` ist Sichtbarkeits-Scope, nicht Attribution —
auf einem geteilten Buch sieht jeder sein eigenes Brett. Das ist der Unterschied
zu `research_items`, die buchweit geteilt sind, und er wird an genau einer Stelle
durchgesetzt: **jede** Lesung in [db/ideen.js](../db/ideen.js) trägt `user_email`.

---

## 1 · Die Stufen-Achse

`ideen.status`: **offen → in_arbeit → erledigt**, daneben **verworfen**.
SSoT [lib/ideen-status.js](../lib/ideen-status.js), Frontend-Spiegel
[ideen-shared.js](../public/js/book/ideen-shared.js), Drift gegated in
[tests/unit/ideen-status.test.mjs](../tests/unit/ideen-status.test.mjs).

**Eine Spalte, ein CHECK.** Es gibt kein `erledigt`-Flag daneben: zwei Wahrheiten
über dieselbe Frage lösen sich nicht auf (`erledigt = 1` neben
`status = 'verworfen'`), und der nächste Schreibpfad setzt garantiert nur eine
von beiden. `status_at` hält fest, wann die Stufe zuletzt wechselte — ein
Content-Update bewegt ihn nicht.

**„Offen" heisst `offen` ODER `in_arbeit`** — SQL-Fragment `openStatusSql(alias)`,
damit die Zählpfade nicht jeder für sich eine `IN`-Liste schreiben. Daran hängen
drei Dinge, und in allen dreien ist `verworfen` **nicht** offen:

* die Sidebar-Plakette und `GET /ideen/counts`,
* der Ideen-Block im **Abschnitts-Chat** ([jobs/shared/queries.js](../routes/jobs/shared/queries.js)#`getOpenIdeen`),
* das Buch-Chat-Werkzeug `list_ideen` (`offen_only`).

**Why beim Chat:** eine verworfene Idee als Absicht des Autors vorzulegen ist die
schlechtere Halluzinationsquelle von beiden — das Modell schlägt dann genau das
vor, wogegen er sich entschieden hat. Darum nennt die Werkzeug-Beschreibung die
Stufe ausdrücklich.

**`verworfen` ist eine Stufe, kein Löschen** (dieselbe Regel wie bei
`research_items.status`). Eine gelöschte Idee verschweigt, dass man sie hatte und
gegen sie entschieden hat; genau das will man beim nächsten Durchgang nicht noch
einmal denken müssen. Der Board-Filter blendet sie aus, statt sie aus der Welt zu
nehmen — und sagt dabei, wie viele er ausblendet.

**Ein unbekannter Wert zählt als `offen`**, nicht als Fehler (`normalizeIdeeStatus`
/ `ideeStatus`): eine Zeile mit kaputtem Status ist eine ungeklärte Pendenz, keine
erledigte, und sie darf nicht aus dem Board fallen. Gleiche Regel wie `itemStatus`
im Recherche-Board.

**Ein Status-Key ist eine Persistenz-Konstante** (Spaltenwert + CHECK + i18n-Key
`ideen.status.<key>`): ergänzen ja, umbenennen nein.

**Abgeschlossen wandert nicht mehr.** Der Move (Idee auf eine andere Seite bzw.
ein anderes Kapitel) ist nur offen/in Arbeit erlaubt (`400 IDEE_CLOSED`): eine
abgeschlossene Idee ist die Spur einer Entscheidung an **dieser** Stelle;
anderswo hingehängt wäre sie eine Aussage über eine Stelle, an der sie nie stand.
Der Move bleibt ausserdem **within-kind** (Seiten-Idee nur auf eine Seite);
einzige Ausnahme ist die Buch-Idee, die auf Seite **oder** Kapitel darf — das ist
ihr Zweck. Zurück ins Buch geht keine Idee: wer sie vom Ort lösen will, legt sie
neu an.

### Stufen pro Buch

Nicht jedes Buch braucht vier Stufen. `book_settings.ideen_stages` hält die
**aktiven** Stufen als Komma-Text in kanonischer Reihenfolge; **`offen` und
`erledigt` sind immer aktiv** (ohne Anfang keine Pendenz, ohne Ende kein Abhaken),
`in_arbeit` und `verworfen` schaltet das Buch zu. `NULL` heisst „nie eingestellt"
und liest sich als alle vier: ein bestehendes Buch sieht sein Board unverändert.
Normalisiert wird an **einer** Stelle, `normalizeIdeeStages` in
[lib/ideen-status.js](../lib/ideen-status.js) (Spiegel in
[ideen-shared.js](../public/js/book/ideen-shared.js), gegated in
[tests/unit/ideen-stages.test.mjs](../tests/unit/ideen-stages.test.mjs)).

**Buchweit, nicht user-privat.** Die Ideen gehören dem User, die Stufen dem Buch:
schaltet ein Editor `verworfen` ab, gilt das auch für das Brett seiner
Mitarbeiter. Darum sagt es der Hinweis neben dem Schalter.

**Abschalten heisst „nicht mehr anbieten", nicht „ausblenden".** Eine Idee, die
schon in einer abgeschalteten Stufe steht, behält ihren Status — die Einstellung
schreibt keine einzige Idee um. Daraus folgt:

* das Board zeigt die Spalte weiter, solange sie Ideen trägt (`boardColumns` in
  [ideen-board/model.js](../public/js/book/ideen-board/model.js)), gestrichelt
  markiert; sie geht, wenn sie leer ist — sonst verschwände eine Pendenz still,
  sobald ihr Buch die Stufe abschaltet;
* Drag, Stufen-Knöpfe und das Menü der Ideen-Karte bieten nur **aktive** Ziele
  an; herausziehen geht immer;
* der Server lehnt einen **Wechsel** in eine abgeschaltete Stufe ab
  (`400 IDEE_STATUS_INACTIVE`); derselbe Status noch einmal ist kein Wechsel,
  damit ein PATCH, der ihn mitschickt, nicht scheitert.

Eingestellt wird im Board selbst (Schalter „Spalten" im Kopf), weil man dort
sieht, was die Einstellung bewirkt. Die Einstellung reist im Bundle mit
(`SETTINGS_KEYS` in [lib/book-bundle.js](../lib/book-bundle.js)) — `.swbook` und
Fassungs-Restore.

---

## 2 · Das Board

Ein Raster: **Zeilen sind die Anker im Buch** (Bahnen — Kapitel bzw. Seite),
**Spalten die Stufen**. Pure Rechnung in
[ideen-board/model.js](../public/js/book/ideen-board/model.js), gegated in
[tests/unit/ideen-board.test.mjs](../tests/unit/ideen-board.test.mjs).

**Die Reihenfolge der Bahnen kommt aus dem Baum**, nicht aus der Ideen-Abfrage:
`$store.nav.tree` ist die SSoT der Buch-Reihenfolge (`book_order`-Overlay), ein
`ORDER BY position` im Ideen-SQL wäre eine zweite, stillschweigend abweichende
Sortierung. Pro Kapitel entsteht zuerst die Kapitel-Bahn, danach die Bahnen seiner
Seiten; eine Solo-Seite bekommt nur ihre Abschnitts-Bahn (eine Kapitel-Bahn dafür wäre
eine Bahn für ein Kapitel, das es nicht gibt). Der Baum ist flach und depth-first;
die Gliederung trägt jede Kapitel-Bahn als `parentId` mit. **Die Hierarchie zeigt der
Einzug** (`ideen-board-row--depth-N`: Kapitel nach ihrer Tiefe, ein Abschnitt eine
Stufe unter seinem Kapitel) — eine Abschnitts-Bahn wiederholt den Kapitelnamen
nicht, ihre Kapitelzeile steht immer darüber. Vor allen steht die Buch-Bahn
(`LANE_BOOK`, [ideen-shared.js](../public/js/book/ideen-shared.js)) für Ideen
ohne Anker; sie ist nicht anspringbar und fällt aus jedem Kapitel-Filter. Das
Anlegen-Feld hat sie vorgewählt, damit ein Einfall ohne Ortswahl festgehalten
ist. Der Baum kann sich unter dem
offenen Board ändern — darum zieht ein `$watch` die Bahnen nach.

**Nur belegte Bahnen erscheinen.** Ein Board mit einer leeren Zeile je Seite des
Buches wäre unlesbar. **Ausnahme ist die Kapitel-Bahn:** sie bleibt auch ohne
eigene Ideen stehen, sobald ihr **Teilbaum** welche trägt (eigene Abschnitte,
Unterkapitel, deren Abschnitte) — sie ist die Gruppen-Überschrift und der Griff,
an dem das Kapitel zuklappt. Ohne sie wäre
genau das Kapitel nicht klappbar, dessen Pendenzen alle auf Seiten hängen, also
fast jedes.

**Klappen ist Ansicht, nicht Filter.** Zwei unabhängige Achsen, beide als Liste
von Bahn-Keys:

| | was sie faltet | Griff |
|---|---|---|
| `collapsedLanes` | die **Karten** einer Bahn | Chevron vor dem Bahntitel |
| `collapsedChapters` | den **Teilbaum** eines Kapitels (Unterkapitel + Abschnitts-Bahnen), in dessen Zeile; *n* zählt die belegten Abschnitte des ganzen Teilbaums | „*n* Abschnitte" unter dem Kapiteltitel |

Sie sind getrennt, weil sie Verschiedenes beantworten („zeig das Kapitel ohne
seine Seiten" vs. „zeig die Bahn ohne ihre Notizen"). Beide liegen **pro Buch im
localStorage**, im selben Filter-Scope `ideenBoard` wie die Filterleiste
([cards/ideen-board-card.js](../public/js/cards/ideen-board-card.js),
[filter-persist.js](../public/js/filter-persist.js)) — ein eigener Scope wäre ein
zweiter Schlüssel für dieselbe Frage „wie sieht dieses Board für mich aus". Die
Listen werden immer **neu geschrieben**, nie mutiert: der Board-Memo vergleicht
seine Deps per Identität, und die Scope-Defaults sind ein geteiltes Objekt.

Die Klappung bewegt die **Filterzahlen nicht** (`visible`/`hiddenByFilter` werden
gezählt, bevor gefaltet wird) — sonst behauptete die Filterleiste, sie verstecke
etwas, das sie nicht meint. Was die Klappung verbirgt, steht stattdessen je Zeile
und Stufe als `+n` in der Zelle: dieselbe Überlegung wie beim Ausblend-Zähler.

**Nichts verschwindet still.** Eine Idee, deren Bahn der Baum (noch) nicht kennt —
Seite gerade angelegt, Baum noch nicht nachgezogen — landet in der Sammelbahn
`LANE_UNKNOWN` am Ende, statt aus dem Board zu fallen. Das Board ist eine
Pendenzenliste; eine verschwundene Pendenz ist von einer erledigten nicht zu
unterscheiden.

**Der Kapitel-Filter misst die BAHN, nicht den Anker.** Dafür liefert der Server
`lane_chapter_id` mit (für eine Seiten-Idee das Kapitel **ihrer Seite**). Nach
`chapter_id` gefiltert fände „Kapitel 3" nur die Ideen, die direkt am Kapitel
hängen — also die wenigsten. Der Filter erfasst den **Teilbaum** (Unterkapitel
über die `parentId`-Kette), und wählbar ist jedes Kapitel, dessen Teilbaum Ideen
trägt.

**Zwei Haken für die zwei Schlussstufen.** `erledigt` und `verworfen` sind
getrennt ausblendbar, beide per Default aus: das Board ist eine Pendenzenliste,
und beide Stufen sollen beim Öffnen nicht mitarbeiten. Getrennt, weil sie
Verschiedenes beantworten — „fertig" und „dagegen entschieden"; wer den Stand
eines Kapitels prüft, will das Erledigte sehen, ohne das Verworfene
zurückzuholen. Ausgeblendet wird nur die Karte, nie die Spalte samt Zähler.

**Der Filter blendet aus und sagt es.** `hiddenByFilter` steht als Zahl in der
Filterleiste; ohne sie ist eine versteckte Pendenz von einer verlorenen nicht zu
unterscheiden. Die **Spalten-Zähler messen dagegen den ganzen Bestand** — sonst
zeigte die Spalte „verworfen" beim Ausblenden eine `0` und damit das Gegenteil
der Wahrheit. Aus demselben Grund filtert `GET /ideen/board` **serverseitig
nicht**: Bahnen, Spalten und Zähler rendern dieselbe Liste desselben Requests
(gleiche Regel wie die zwei Ansichten des Recherche-Boards).

**Die Kapitel-Optionen des Filters hängen nicht am Status-Filter** — sonst
verschwände die eigene Auswahl unter der Hand, sobald man `verworfen` ausblendet.

**Ein Drag einer verankerten Idee trägt genau eine Aussage: den neuen Status.**
Ihre Bahn bleibt, wie sie ist — sie IST der Anker im Buch, und den verschiebt man
nicht per Kanban-Zug quer durchs Manuskript (dafür gibt es „Verschieben" auf der
Ideen-Karte). Technisch: SortableJS-Gruppe **pro Bahn** (`idee-lane-<key>`). Der
DOM-Move wird immer zurückgenommen (`revertSortable`) — Alpine besitzt den DOM;
aus ihm wird vorher nur abgelesen, wohin die Karte fiel.

**Ausnahme: die offene Buch-Idee wird per Drag zugeordnet.** Sie hat noch keinen
Anker, und ihn zu bekommen ist ihr Zweck. Zwei Ziele, ein Schreibpfad mit dem
Picker (`_assignIdee` in [actions.js](../public/js/book/ideen-board/actions.js),
ein PATCH):

* **eine Kapitel-/Abschnitts-Bahn des Boards** — setzt den Anker und, wenn es
  eine andere ist, die Stufe der Zielspalte. Angenommen werden nur `offen` und
  `in_arbeit` (`_canDropAssign`): eine Idee, die beim Zuordnen gleich
  abgeschlossen würde, hätte an ihrem Anker nie offen gestanden.
* **ein Eintrag im Inhaltsverzeichnis der Sidebar** — das Board zeigt nur
  belegte Bahnen, ein Kapitel oder Abschnitt ohne Ideen ist dort kein Ziel; die
  Sidebar führt jeden Anker. Sortable kennt den Baum nicht (der Drop dort ist ein
  Spill), darum merkt [tree-drop.js](../public/js/book/ideen-board/tree-drop.js)
  während des Zugs den Baumeintrag unter dem Zeiger und markiert ihn
  (`.tree-drop-target`). Die Stufe bleibt.

**Die Reihenfolge der Karten wählt jede Spalte für sich**
([model.js](../public/js/book/ideen-board/model.js)#`columnSortOf`/`nextColumnSort`).
Im Spaltenkopf steht ein Segment-Umschalter **Datum** / **A–Z** (dem Text, Ideen
haben keinen eigenen Titel); ein zweiter Klick aufs aktive Kriterium kehrt die
Richtung um, Gleichstand fällt auf die `id`. Daneben holt der Reset-Knopf die
**ursprüngliche Position** der Spalte zurück. Gehalten wird das als Map
`columnSort` (Stufe → `{ by, dir }`) im Filter-Scope `ideenBoard`; der Reset
**entfernt** den Eintrag, statt `manual` hineinzuschreiben — „nie umsortiert"
und „zurückgesetzt" sind derselbe Zustand, und ein kaputter Wert aus dem
localStorage fällt ebenfalls dorthin. Pro Spalte, weil die Stufen Verschiedenes
fragen: offene Pendenzen ordnet man von Hand, das Erledigte liest man nach
Datum. Die Reihenfolge der Server-Abfrage zählt dafür nicht — sortiert wird im
Modell.

**Die ursprüngliche Position ist die eine Sortierung, die eine Position ist** —
`ideen.sort_order`, in der DB statt im localStorage, weil sie Inhalt ist und
nicht Ansicht: wer seine Pendenzen geordnet hat, will die Ordnung auf jedem
Gerät, und eine Ansichts-Sortierung darf sie nie überschreiben (darum kann der
Reset sie zurückholen). Nur in einer Spalte, die so steht, zieht man
**innerhalb** der Spalte (Sortable-Option `sort` je Zelle nach ihrer Spalte,
umgeschaltet an den bestehenden Instanzen); in einer sortierten ordnete das
Kriterium die Karte sofort wieder um. Ein Drop schreibt die **ganze Zelle**
(Bahn × Stufe) als 1..n (`PUT /ideen/order`, ganz oder gar nicht); ein Zug in
eine andere Spalte setzt zuerst den Status und nummeriert dann die Zielzelle —
sofern die **Zielspalte** in ihrer ursprünglichen Position steht. Die Zelle umfasst den ganzen
Bestand, auch was der Textfilter gerade ausblendet — die gezogene Idee wird nur
vor ihren sichtbaren Nachfolger gesetzt (`cellOrderAfterDrop`), eine
ausgeblendete verliert so nie ihren Platz. `0` heisst „nie einsortiert": eine
neue Idee steht oben in ihrer Zelle, unter mehreren davon die neueste zuerst.
Die ursprüngliche Position hat keine Richtung; der Reset-Knopf erscheint nur,
solange die Spalte sortiert ist.
Der tastaturerreichbare Weg sind die Stufen-Knöpfe auf der Karte — **derselbe
Schreibpfad** (`setIdeeStatus`), drei Oberflächen (Board-Drag, Board-Knöpfe,
Menü der Ideen-Karte).

**Layout:** ein CSS-Grid, kein Flex-Spalten-Board wie bei der Recherche. Karten
derselben Bahn müssen über alle Spalten hinweg auf einer Linie liegen, sonst ist
die Zeile als Zusammenhang nicht mehr lesbar. Auf schmalem Container scrollt die
Fläche horizontal, statt die Zeilen-Achse aufzugeben — untereinander gestapelt
wäre genau die Aussage des Boards weg, und dann wäre die Ideen-Karte das bessere
Werkzeug.

**Vollbild:** Knopf im Kartenkopf schaltet die ganze Karte ins Native-Vollbild
(`.fullscreen-shell`, [fullscreen.js](../public/js/fullscreen.js), wie Plot und
Recherche). Das Raster braucht dafür keine eigene Regel — die Spaltenbreite hängt
am Container `.ideen-board-wrap`, nicht am Viewport. Was sonst unter `<body>`
hängt, läge im Vollbild hinter dem `::backdrop` und wird darum zur Anzeigezeit
umgehängt: der Drag-Ghost (`onStart`) und der Verknüpfungs-Picker
(`mountInTopLayer` in `openLinkPicker`). Der Drop aufs Inhaltsverzeichnis entfällt
im Vollbild — der Baum ist dann nicht zu sehen; „Zuordnen" auf der Karte bleibt.

---

## 3 · Verknüpfungen (beidseitig)

`idea_links` — Brücke von einer Idee zu einem **Recherche-Fundstück**, einem
**Plot-Beat**, einem **Handlungsstrang** (`thread`), einem **Motiv** oder einer
**Werkstatt-Figur** (`draft`). SSoT der Ziel-Arten: `IDEA_LINK_KINDS` in
[lib/ideen-status.js](../lib/ideen-status.js) (Frontend-Spiegel in
[ideen-shared.js](../public/js/book/ideen-shared.js), Drift + DB-CHECK gegated in
[tests/unit/ideen-status.test.mjs](../tests/unit/ideen-status.test.mjs)). Form ist der Zwilling von
`research_item_links`: sentinel-frei, genau eine `*_id` passend zum
`target_kind`, alle anderen NULL, partielle UNIQUE-Indexe je Ziel-Art.

**Warum eine eigene Tabelle** statt `research_item_links.target_kind` um `'idea'`
zu erweitern: die Idee besitzt ihre Verknüpfungen. Sonst läge ein Drittel davon
(Recherche) in einer fremden Tabelle und der Rest (Beat, Motiv, …) hier — und
die Frage „woran hängt diese Pendenz" hätte zwei Lesepfade.

**Warum nur diese Ziele:** alle sind **planende** Kataloge desselben Buches. Eine
Pendenz hängt an einem Fundstück, einem Handlungspunkt, einem Strang, einem Motiv
oder einer Werkstatt-Figur — nicht an einer Textstelle, denn ihre Stelle im Buch
**ist** ja schon ihr Anker. Katalog-Figur, Ort und Szene sind bewusst **keine**
Ziele: sie werden aus dem Text extrahiert, nicht geplant, und eine Pendenz „im
Text" hat mit Seite/Kapitel schon ihren Ort.

**Ein Ziel bleibt im Buch.** Der FK allein liesse eine Idee aus Buch A auf ein
Motiv aus Buch B zeigen; die Buch-Prüfung liegt in
[db/ideen.js](../db/ideen.js)#`addIdeaLink` (sie muss die Ziel-Tabelle kennen und
gehört darum nicht in den Handler).

**Labels kommen per JOIN zur Lesezeit**, nie als Snapshot-Spalte: ein umbenanntes
Motiv heisst sofort überall neu.

### Die Gegenrichtung

Die Ideen-Plaketten **an** einem Fundstück / Beat / Strang / Motiv / einer
Werkstatt-Figur laufen über **einen**
Endpunkt — `GET /ideen/links?book_id=&target_kind=` — und ein geteiltes Modul
([ideen-backlinks.js](../public/js/book/ideen-backlinks.js) +
[ideen-backlinks.html](../public/partials/ideen-backlinks.html)).

**Why ein Endpunkt statt drei erweiterter Payloads:** so bleibt die Skopierung an
**einer** Stelle richtig. Hängte man die Anrisse an die `research_items`-Zeile,
müsste jeder ihrer Schreibpfade (`/capture`, Media-Upload, Scrape, Interview,
PATCH …) die E-Mail des Betrachters mitführen — und der erste, der es vergisst,
zeigt dem Mitarbeiter die privaten Pendenzen des Autors. `/research`, `/plot` und
`/motifs` bleiben unverändert.

**Read-only auf der Gegenseite.** Kuratiert wird die Kante ausschliesslich auf der
Ideen-Seite; die Plakette zeigt und springt. Gleiche Bauart wie die Motiv-Badges
auf der Beat-Karte, die in der Motiv-Werkstatt kuratiert werden.

**Non-fatal.** Schlägt die Nebenlesung fehl, steht die Karte ohne Ideen-Chips da —
ein Motiv-Katalog, der wegen einer fehlenden Beigabe gar nicht erscheint, wäre der
schlechtere Tausch.

**Der Host nennt das Ziel `ideaOwnerId`** (per `x-data` auf einem Wrapper über dem
Include), weil die Karten ihre Entität verschieden benennen. Hält eine Karte zwei
Ziel-Arten (Plot-Karte: Beats in `ideaBacklinks`, Stränge in
`threadIdeaBacklinks`), nennt der Wrapper zusätzlich `ideaSource`.

**`.swbook` trägt die Kanten NICHT mit** ([db/book-migration-data.js](../db/book-migration-data.js)):
keiner der Zielkataloge steht im Bundle. Eine mitgenommene Kante hätte auf
der Zielinstanz kein Gegenüber — oder, schlimmer, träfe eine gleich nummerierte
fremde Zeile. Alt-Bundles mit `erledigt`/`erledigt_at` werden weiter gelesen,
geschrieben wird nur die aktuelle Form.

---

### Ideen als KI-Kontext und in anderen Ansichten

Die Ideen sind dem Autor **bekannt** — ein KI-Befund, der eine offene Pendenz nur
wiederholt, ist Rauschen, und eine verworfene Idee erneut vorzuschlagen ignoriert
seine Entscheidung. Darum lesen die planenden KI-Funktionen sie mit:

- **Plot-Konsistenz, Plot-Brainstorm, Plot-Chat** — Ideen an Beats und Strängen
  stehen direkt am Beat bzw. Strang im Prompt: offene/in Arbeit als „bekannt,
  nicht als neuen Befund melden", verworfene als „nicht erneut vorschlagen";
  erledigte fallen raus. Daten: [lib/idea-context.js](../lib/idea-context.js)#`ideaNotesByTarget`,
  Textform (SSoT): [prompts/plot/lines.js](../public/js/prompts/plot/lines.js)#`_ideenMarker`
  (Facade `ideenMarker`, auch vom Plot-Chat über `getPrompts`).
- **Kapitelbewertung** — die offenen Ideen des Kapitels und seiner Seiten als
  eigener Block („wiederhole sie nicht als Empfehlung, bestätigen/präzisieren
  ist erlaubt, kein Einfluss auf die Note"), `loadChapterIdeenContext`
  ([review-context.js](../routes/jobs/review-context.js)). Steht in der
  `optionsSig` nur, wenn vorhanden; der Kapitel-Cache ist pro User.
- **Buch-Chat** — `list_ideen` liefert pro Idee `verknuepft` (Ziele aus `idea_links`).
- **Ideen-Chat** — Panel im Board selbst: prüft offene Pendenzen gegen den Text (Beleg-Pflicht für «erledigt»), sucht Buch-Ideen einen Ort, führt Dubletten zusammen. Schreibt nicht, jeder Vorschlag läuft beim Übernehmen über die Routen unten. Details: [ideen-chat.md](ideen-chat.md).
- **Buchübersicht** — Kachel „Ideen" ([book-overview/ideen.js](../public/js/book-overview/ideen.js)):
  offene Pendenzen, Verteilung auf die Stufen, Buch-Ideen ohne Ort, offene mit
  Verknüpfung. Quelle `GET /ideen/board`; Viewer (403) sehen sie nicht.
- **Bucheditor** — Zähler der offenen Ideen an Kapitel- und Seitenkopf (aus dem
  Badges-Store, derselbe Sprung wie in der Sidebar).

## 4 · Routen

| Route | Zweck |
|---|---|
| `GET /ideen?page_id=` / `?chapter_id=` | Ideen eines Ankers (offen zuerst) |
| `GET /ideen/counts?book_id=&kind=` | Map Anker → Zahl **offener** Ideen (Sidebar-Plakette) |
| `GET /ideen/board?book_id=` | alle Ideen des Buchs + aktive Stufen — Datenquelle des Boards |
| `GET /ideen/stages?book_id=` · `PUT /ideen/stages` | aktive Stufen des Buchs lesen / setzen (buchweit) |
| `GET /ideen/link-targets?book_id=` | verknüpfbare Ziele (Recherche / Beat / Motiv) |
| `GET /ideen/links?book_id=&target_kind=` | Gegenrichtung: Map Ziel-ID → Ideen-Anrisse |
| `POST /ideen` | anlegen (XOR `page_id`/`chapter_id`) |
| `PATCH /ideen/:id` | `content`, `status`, Move |
| `PUT /ideen/order` | manuelle Reihenfolge einer Board-Zelle (`ids` → `sort_order` 1..n) |
| `POST /ideen/:id/links` · `DELETE /ideen/:id/links/:linkId` | Kante setzen / lösen |
| `PATCH /ideen/chat-proposal` | Status eines Ideen-Chat-Vorschlags (übernommen / verworfen / wieder offen), [ideen-chat.md](ideen-chat.md) |
| `DELETE /ideen/:id` | löschen |

Alle ab Rolle `editor` auf dem Buch, alle Ideen-Routen zusätzlich auf den
eigenen `user_email`-Bestand beschränkt (`/stages` nicht — die Stufen gehören dem
Buch). Fehlerformen: `INVALID_SCOPE`, `BOOK_MISMATCH`,
`KIND_MISMATCH`, `IDEE_CLOSED`, `INVALID_STATUS`, `IDEE_STATUS_INACTIVE`, `INVALID_LINK_KIND`,
`LINK_TARGET_NOT_FOUND`, `ORDER_REQ`, `ORDER_MISMATCH`, `CONTENT_REQUIRED` / `CONTENT_TOO_LONG` (4000 Zeichen).

---

## 5 · Pflicht-Invarianten

1. **Eine Spalte für den Stand.** Kein zweites Ja/Nein neben `status`.
2. **`verworfen` ist nie „offen".** Weder Plakette noch Zähler noch Chat-Kontext.
3. **Verworfen wird nicht gelöscht.** Ausblenden ja, wegräumen nein.
4. **Jede Lesung trägt `user_email`** — besonders die Rückwärts-Lesung.
5. **Ein Ziel bleibt im Buch** (`addIdeaLink` prüft, der FK reicht nicht).
6. **Keine Idee verschwindet still** aus dem Board (Sammelbahn, ausgewiesene
   Ausblend-Zahl, `+n` je eingeklappter Zelle).
7. **Die Bahnen-Reihenfolge kommt aus dem Baum**, nie aus einer zweiten Sortierung.
8. **Spalten-Zähler messen den Gesamtbestand**, nicht die gefilterte Sicht.
9. **Ein Drag setzt den Status, nie die Bahn** — einzige Ausnahme ist die offene
   Buch-Idee, deren Drag in eine Kapitel-/Abschnitts-Bahn oder aufs
   Inhaltsverzeichnis sie zuordnet. Eine verankerte Idee wechselt nie per Drag
   die Zeile.
10. **Klappen ist Ansicht, kein Filter** — es bewegt weder `visible` noch
    `hiddenByFilter`, und ein zugeklapptes Kapitel behält seine Zeile (sonst wäre
    der Griff zum Aufklappen mit weg).
11. **Ein Status-Key ist eine Persistenz-Konstante.** Ergänzen ja, umbenennen nein —
    mit Eintrag in beide Locales (`ideen.status.<key>`), sonst rendert eine
    Alt-Zeile ihren rohen Key.
12. **`offen` und `erledigt` sind nie abschaltbar**, und eine abgeschaltete Stufe
    schreibt keine Idee um — ihre Spalte bleibt, solange sie belegt ist.
