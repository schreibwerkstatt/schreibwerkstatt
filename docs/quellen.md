# Quellen & Quellenverzeichnis

Wissenschaftliches Belegen: eine **Quellen-Bibliothek pro User**, pro Buch daraus ausgewählte Quellen, Quellenangaben im Seitentext, und daraus ein Verzeichnis in jedem Ausgabeweg. Rein rückwärtsgewandt — nie generativ im Buchtext.

Die harten Regeln stehen in [CLAUDE.md](../CLAUDE.md) („Editor-Blockstruktur → Quellen-Chips"); hier stehen die Details.

## Datenmodell

| Tabelle | Rolle |
|---|---|
| `sources` | die Bibliothek. **Pool pro User** (`owner_email`), nicht pro Buch — dieselbe Literatur trägt mehrere Arbeiten. Feldschnitt CSL-JSON-nah (`csl_type`, `authors`/`editors` als JSON `[{family,given}\|{literal}]`, `container_title`, `doi`, `isbn`, …). `citekey` ist **pro Bibliothek** eindeutig, nicht pro Buch. |
| `book_source_links` | M:N-Brücke Buch ↔ Quelle. Zuordnen ist eine Buch-Operation, Anlegen eine Bibliotheks-Operation. |
| `source_tags` | Schlagworte am Bibliothekseintrag (`PRIMARY KEY (source_id, tag COLLATE NOCASE)`). Gelten in **allen** Büchern der Quelle, setzen nur der Besitzer (wie jedes Pool-Feld über `PUT /sources/:id`, Full-Replace über `tags: string[]`). **Kein Tag-Stamm:** die Schlagwort-Liste eines Users ist die DISTINCT-Menge über seine Quellen — kein verwaister Tag, keine zweite Besitz-Spalte. Kommen mit jeder Quellenzeile (`tags`), die Liste der Bibliothek über `GET /sources/tags`. |
| `source_citations` | abgeleiteter Fund-Index („welche Quelle wird auf welcher Seite belegt"), zusätzlich `quote_chars` + `paraphrase_count` für die Zitat-Anteil-Kennzahl. |
| `source_detect_runs` | Historie der Quellen-Erkennung (Job `source-detect`) pro Buch + User. `result_json` = `{ vorschlaege[] }`, `found_count`/`verified_count` denormalisiert fürs Listen-Rendering. Sentinel-freier Scope: `scope` (`book`/`chapter`) + nullbares `scope_chapter_id`. **Ohne Bibliotheks-Status am Fund** — der altert und wird bei jedem Lesen neu gerechnet. Aufbewahrung: die letzten `DETECT_RUN_KEEP` Läufe. |

**Wahrheit ist der Marker im Seiten-HTML.** `source_citations` ist reine Ableitung und wird pro Seiten-Write per Full-Replace neu geschrieben ([lib/cite-index.js](../lib/cite-index.js) am Content-Store-Chokepoint, Muster `page_figure_mentions`). Nie inkrementell fortschreiben.

**DB-Schicht: [db/sources.js](../db/sources.js) ist eine Facade** über [db/sources/](../db/sources/) — Themen, die nur die Tabelle teilen und je eigene Regeln haben:

| Modul | Inhalt |
|---|---|
| `shared.js` | Feld-Inventar (`TEXT_FIELDS`), Personen-Normalisierung, die beiden Kennzahl-SQL-Fragmente, Zeilen-Mapper. Speist INSERT, UPDATE, Spaltenliste **und** Normalisierung — laufen die auseinander, verliert ein Schreibpfad still ein Feld. |
| `pool.js` | die Bibliothek: CRUD plus die drei Dublettenfragen (Import über Zitierschlüssel bzw. Titel+Jahr, Erfassen über die normalisierte URL, Recherche-Übernahme als reines Log-Signal). |
| `links.js` | die Brücke. `unlinkSource` ≠ `deleteSource` — siehe oben. |
| `citations.js` | der Fund-Index und die Zitat-Kennzahlen. |
| `detect-runs.js` | Historie der Quellen-Erkennung. |
| `tags.js` | Schlagworte: Full-Replace je Quelle (`setSourceTags`, läuft in der Transaktion von `createSource`/`updateSource`) und die Liste der Bibliothek (`listPoolTags`). Normalisierung (`normalizeTags`) in `shared.js`, Spiegel fürs Formular in `public/js/sources/fields.js`. |
| `doc.js` | PDF-Anhang; die **einzigen** Zugänge zu `doc`/`doc_text` (die Spaltenliste in `shared.js` führt sie bewusst nicht). |

Konsumenten importieren die Facade oder `db/schema.js`, nie ein Submodul. **Neue Funktion ⇒ Export in beiden** (`db/sources.js` spreadet die Submodule, `db/schema.js` listet die Namen einzeln auf) — sonst ist sie über `require('../db/schema')` nicht sichtbar, und genau darüber gehen die Routen.

**Buch-Guard beim Indizieren:** eine Quelle erzeugt nur eine Fundstelle, wenn sie dem Buch der Seite **zugeordnet** ist (`INSERT … FROM book_source_links l JOIN pages p … WHERE l.book_id = p.book_id`). Fängt zwei Fälle: Seite in ein anderes Buch verschoben, und Quelle aus dem Buch entfernt während der Marker im Text stehen bleibt.

## Markup

SSoT [public/js/sources/cite-html.js](../public/js/sources/cite-html.js) — nie von Hand schreiben.

```html
<span class="cite" data-src="7" data-loc="44">(Müller, 2020, S. 44)</span>
<span class="cite" data-src="7" data-mode="paraphrase">(vgl. Müller, 2020)</span>
<blockquote data-src="7"> … wörtliches Blockzitat … </blockquote>
```

**Drei Zitat-Kategorien, zwei Attribute.** Kurzzitat (wörtlich, in Anführungszeichen im laufenden Text), Blockzitat (wörtlich, ab ~3 Zeilen eingerückt + kleiner + **ohne** Anführungszeichen) und Paraphrase („vgl."). Getragen von `data-mode` am Chip (**nur `paraphrase` wird persistiert**, Abwesenheit = `quote`, damit Alt-Inhalte ohne Migration gültig bleiben und kein „vgl." in bestehende Angaben leckt) und `data-src` am `<blockquote>` (dieser Absatz ist wörtlich aus Quelle N; treibt Zitat-Typografie **und** die Kennzahl „Zitat-Anteil").

Bewusst **kein** `data-loc` am blockquote — die Stellenangabe gehört zum sichtbaren Kurzbeleg, und der steht als Chip am Ende des Blocks.

**Fundstellen-Zählung:** der Chip zählt; ein belegtes Blockzitat **ohne** eigenen Chip zählt selbst als Fundstelle (sonst gäbe es keine), mit Chip nur einmal. Ein belegtes Blockzitat in einem belegten Blockzitat wird nicht doppelt geführt. Renderer erfahren es über `block.cited` aus dem [html-walker](../lib/pdf-render/html-walker.js); Zitat-Satz ist **aufrecht** (PDF kleiner via `CITED_QUOTE_SIZE_SCALE`, DOCX ohne Kursive) — das stilistische Zitat/Motto bleibt das blockquote **ohne** Zeiger.

`data-src` am blockquote überlebt bewusst den WordPress-Push ([lib/wp-html.js](../lib/wp-html.js)), weil der Blog-Sync zurückliest (LWW-Pull) und das Blockzitat sonst beim nächsten Pull seine Quelle verliert.

## Chip-Text ist ein Cache

`data-src` ist die Wahrheit. Jeder Ausgabeweg setzt den Text beim Rendern frisch ([lib/bibliography.js](../lib/bibliography.js)#`resolveCitesInHtml`, im Anmerkungsmodus [lib/endnotes.js](../lib/endnotes.js)) — im Export steht damit immer die aktuelle Form. **In der App bleibt der gespeicherte Text stehen:** nach einem Stilwechsel oder einer Quellenkorrektur zeigt der Editor bis zum nächsten Einfügen die alte Form. Bewusst so — es gibt keinen Pass, der Seiten hinter dem Rücken des Autors umschreibt.

**`contenteditable` steht nie in der Persistenz.** Der Editor setzt es beim Mount, [lib/html-clean.js](../lib/html-clean.js)#`stripEditorUiArtefacts` strippt es beim Save, und die Dirty-Vergleichsform ([editor/shared/html-clean.js](../public/js/editor/shared/html-clean.js)#`stripLektoratMarks`) ignoriert es. Ohne **beides** gilt jede Seite mit Quellenangabe beim Öffnen als geändert und wird ungefragt gespeichert.

Das Markup-Modul ist DOM-agnostisch, damit Browser und Server (linkedom) dieselbe Parse-Logik nutzen statt zweier driftender Kopien. Der Server lädt es — wie alle geteilten Browser-Module — über [lib/esm-bridge.js](../lib/esm-bridge.js) (`citeHtml()`, `sourceFormat()`, `sourceSearch()`); dort steht der Pfad einmal und das dynamic `import()` ist pro Modul memoisiert. **Keine eigene `pathToFileURL`-Kette in einem neuen Konsumenten** — das Muster lag in acht Modulen einzeln herum. Ausgenommen bleibt [lib/prompts-loader.js](../lib/prompts-loader.js): der braucht **zwei isolierte Instanzen** pro Provider-Klasse und darf die Bridge nicht mitbenutzen.

## Suchen und Benennen

[public/js/sources/search.js](../public/js/sources/search.js) beantwortet die zwei Fragen, die jede Oberfläche mit einer Quellenliste stellt: `sourceHaystack`/`filterSources` („passt die Zeile zum Suchbegriff") und `sourceLine`/`primaryPersonLabel`/`personLabel` („wie heisst sie in einer Zeile"). Pur, DOM-frei, vom Server über die Bridge erreichbar.

**Welche Felder eine Quelle auffindbar machen, ist eine fachliche Entscheidung** und steht darum an genau einer Stelle: Titel, übergeordnetes Werk, Verlag, **Ort**, Jahr, Zitierschlüssel und alle Personen — Notiz und Abstract bewusst nicht (sie machen die Suche unscharf). Konsumenten: Quellen-Karte (Tabelle + Bibliotheks-Picker) und der Beleg-Picker des Notebook-Editors.

**Serverseitig gibt es keinen Freitextfilter.** `GET /sources` und `GET /sources/pool` kennen nur den Typ-Filter; alle Konsumenten laden die Liste ohnehin vollständig (eine persönliche Bibliothek liegt im zwei- bis dreistelligen Bereich) und sieben clientseitig über dieses Modul.

## Drei Schutzschichten

Quellenangaben dürfen von den Text-Prüfern nicht angefasst werden:

- **LanguageTool** — geschützte Offset-Bereiche statt Text-Schnitt. Siehe [docs/languagetool.md](languagetool.md).
- **TTS** — Sprechtext und Highlight teilen einen Offsetraum. Siehe [docs/tts.md](tts.md).
- **Lektorat-Prompts** — `_buildBelegBlock` in [prompts/blocks.js](../public/js/prompts/blocks.js), eingehängt nur bei `hatBelege`; das Flag gehört in **beide** Pässe und in die Lektorat-Cache-Signatur.

Dazu die **Paste-Allowlist** ([utils/html.js](../public/js/utils/html.js)): `SPAN` ist ausschliesslich als Chip erlaubt, alles andere wird unwrapped — sonst zerfällt ein kopierter Satz zu reinem Text und verliert den Zeiger.

**Zwei bewusste Selektor-KOPIEN** (nicht konsolidieren): `TTS_SKIP_SEL` in [tts-segment.js](../public/js/tts-segment.js) — das Modul gehört zum schlanken Share-Reader-Modulgraph und darf keine App-Bundle-Kanten ziehen — und `CITE_SKIP_SEL` in [editor-spellcheck/mapping.js](../public/js/cards/editor-spellcheck/mapping.js). Beide gegen `CITE_SEL` gegated.

## Einstellungen (pro Buch, nicht pro Exportprofil)

In `book_settings`, weil der Zitierstil für **alle** Ausgabewege gleichzeitig gilt: `citation_style` (`apa7`/`chicago-ad`/`numeric`), `bibliography_enabled`, `bibliography_title` (leer = Sprach-Default), `bibliography_scope` (`cited`/`all`), `bibliography_in_blog`, `citation_notes` (`inline`/`endnotes`). Oberfläche: BookSettings-Tab „Quellen" ([book-settings-sources.html](../public/partials/book-settings-sources.html), [book-settings/citation.js](../public/js/book/book-settings/citation.js)).

## Formatierung

[public/js/sources/format.js](../public/js/sources/format.js) — pures ESM, vom Server per dynamic `import()` geladen (Muster `prompts.js`). Drei Stile, Run-Modell (`[{text, italic?}]`) als gemeinsame Basis für Klartext, HTML und die PDF/DOCX-Walker. Sprach-Bausteine („Hrsg.", „o. J.", „S.") als lang-Map im Modul, **nicht** in `i18n/*.json`: sie folgen der Sprache des **Buchs**, nicht der UI-Locale, und im Render-Pfad gibt es keinen `t()`-Kontext.

Zwei Disambiguierungen: `assignNumbers` (numerischer Stil, Nummern folgen der **gerenderten Einheit**) und `assignYearSuffixes` („2020a"/„2020b", Bezugsmenge ist das **Buch**, damit derselbe Buchstabe im Kapitel- und im Buch-PDF dasselbe Werk meint).

**Erscheinungsdatum und Zeitungsartikel.** `sources.issued_date` hält das genaue Datum ISO-partiell (`YYYY`/`YYYY-MM`/`YYYY-MM-DD`); Eingaben wie „12.3.2024", „12. März 2024" oder das RIS-Format „2024/03/12/" normalisiert [sources/issued-date.js](../public/js/sources/issued-date.js) (Formular, Vorschau, Formatierer) bzw. dessen CJS-Spiegel [lib/issued-date.js](../lib/issued-date.js) (Schreibpfad, Import, Crossref) — gleich gehalten durch [issued-date-drift](../tests/unit/issued-date-drift.test.mjs). **Datum führt, Jahr folgt:** ist ein Datum gesetzt, schreibt der Schreibpfad dessen Jahr nach `year` — sonst stünde im Kurzbeleg ein anderes Jahr als im Eintrag; `year` bleibt die Spalte für Sortierung, Kurzbeleg und Jahres-Buchstaben. Ein unlesbares Datum ist an der Route `400 INVALID_VALUE`, beim Import fällt es still weg. **Gesetzt wird das volle Datum nur bei `newspaper` und `website`** (APA „(2024, 12. März)", Chicago „*NZZ*, 12. März 2024", numerisch „In: *NZZ*, 12. März 2024, S. 5"). **Why ein eigener Typ `newspaper`** statt `article` mit Datum: beim Fachaufsatz nennen alle drei Stile nur das Jahr, und Zotero-/EndNote-Exporte liefern für jeden Aufsatz ein Datum mit — hinge die Formatierung am blossen Vorhandensein des Datums, stünde nach einem RIS-Import bei jedem Fachaufsatz Tag und Monat. Austausch: RIS `NEWS`/`MGZN` + `DA`, biblatex `@article` + `entrysubtype = {newspaper}` + `date`, CSL-JSON `article-newspaper`; Crossref-Treffer bringen ihr Datum mit. Die Register-Suche (`searchWork`) steigt bei `newspaper` sofort aus — kein Register führt Zeitungsartikel.

## Verzeichnis und Anmerkungsapparat

[lib/bibliography.js](../lib/bibliography.js)#`buildBibliography({ bookId, pageIds, … })`. Zwei harte Regeln:

1. **Das Verzeichnis wird nie in `pages.content` persistiert** — Render-Artefakt, jedes Mal neu.
2. **Entweder Kurzbeleg oder Notenziffer, nie beides.** Die Weiche steht in [export-builders/shared.js](../lib/export-builders/shared.js)#`prepareCitations`; ein zweiter Pass würde das Ergebnis des ersten überschreiben. **Jeder** Ausgabeweg geht durch diese Weiche — auch DOCX (sonst ignoriert Word als einziger Weg die Buch-Einstellung).

Einheit = das Gerenderte: Buch-Export → Buch, Blog-Push → die Seite (ein Post). Bei Kapitel-/Seiten-Export werden die Chips aufgelöst, aber **kein** Verzeichnis angehängt — ein Kapitel ist keine Publikation mit eigenem Apparat.

Angebunden: Custom-PDF ([pdf-render/index.js](../lib/pdf-render/index.js), Font-Rolle `bibliography`), Custom-DOCX (benannte Styles `Bibliography` + `Endnotes`, hängender Einzug), EPUB/HTML/MD/TXT/Substack, WordPress + HubSpot.

**Blog-Sync-Invariante:** der Push umschliesst das Verzeichnis mit `BIBLIOGRAPHY_MARKER_CLASS`, und `wpToAppHtml` entfernt es beim Pull wieder. Ohne das wandert es beim Pull in den Seitentext und der nächste Push hängt ein zweites an — es akkumuliert. Details in [docs/blog-sync.md](blog-sync.md). Ein Chip, der ohne `data-src` zurückkommt (WordPress-KSES bei fehlendem `unfiltered_html`), wird zu reinem Text degradiert und gezählt (`stats.citesDegraded`) — nie auf eine Quelle geraten.

**Verzeichnis-Export aus der Quellen-Karte** (Panel „Exportieren", [sources/export-panel.js](../public/js/sources/export-panel.js), Formatierung pure in [sources/export.js](../public/js/sources/export.js)): ein Verzeichnis **ohne Buchtext** — für Kurslisten, Moodle, Zotero. Läuft komplett im Browser, es gibt keinen Export-Endpunkt. Auswahl: gewählte Bücher (Vereinigung der `GET /sources?book_id=`-Listen, Buch-ACL ab `viewer`) oder ohne Buch die ganze eigene Bibliothek (`GET /sources/pool`); danach Schlagworte (eines genügt), Archiv und „nur belegte" (buch-skopiert, darum nur mit Buchauswahl). Formate: Literaturliste, Markdown, Linksammlung (nur mit DOI/URL) im gewählten Stil — `format.js` bleibt die SSoT des Eintragstexts; hat eine Quelle DOI **und** eine abweichende URL, hängt der Export die URL hinter die DOI an (das Buch-Verzeichnis nennt nach Zitierregel nur die DOI) — sowie BibTeX/RIS/CSL-JSON. **Die Austauschformate spiegeln die Feldzuordnung von [lib/bib-parse.js](../lib/bib-parse.js):** ein Export muss durch den eigenen Import wieder dieselbe Quelle ergeben (gegated in [sources-export](../tests/unit/sources-export.test.mjs)); ändert sich dort ein Mapping, zieht der Export mit. Der numerische Stil nummeriert hier alphabetisch — ohne Buchtext gibt es keine Zitierreihenfolge. „Kopieren" legt Klartext **und** HTML in die Zwischenablage (`copyRich` in [copy-button.js](../public/js/copy-button.js)), damit ein Rich-Text-Editor Aufzählung, Kursiv und Links übernimmt.

**Fassungs-Export** liest die Fundstellen aus dem eingefrorenen HTML der Fassung, nicht aus `source_citations`: der Index beschreibt den heutigen Stand. Die Quellen-Stammdaten bleiben live (eine korrigierte ISBN soll auch dort stimmen).

## Routen

```
GET    /sources?book_id=          Quellen eines Buchs (buch-skopierte Kennzahlen)
GET    /sources/pool              die Bibliothek des Users (exclude_book für den Picker)
GET    /sources/tags              Schlagworte der eigenen Bibliothek [{ tag, count }]
GET    /sources/stats             Zitat-Anteil + Deckung pro Buch
GET    /sources/citations?book_id= Fund-Index des Buchs (für die Karten-Anzeige)
GET    /sources/:id               Einzel-Quelle (Owner ODER Viewer auf einem verknüpften Buch)
GET    /sources/:id/citations     Fundstellen; OHNE book_id buchübergreifend → nur Besitzer
GET    /sources/:id/books         welche Arbeiten nutzen sie → nur Besitzer
POST   /sources                   anlegen (+ optional gleich zuordnen)
PUT    /sources/:id               ändern (PATCH-artig)
POST   /sources/:id/link          zuordnen: Editor des Buchs UND Besitzer der Quelle
DELETE /sources/:id/link          aus dem Buch nehmen (Editor); Pool-Eintrag bleibt
DELETE /sources/:id               aus der Bibliothek löschen (Besitzer)
POST   /sources/import            BibTeX/RIS (lib/bib-parse.js)
GET    /sources/lookup?doi=|isbn= Crossref/OpenLibrary-Proxy, liefert einen Entwurf
POST   /sources/from-research      Recherche-Fundstück → Quelle (`url_id` wählt einen seiner Links)
GET    /sources/by-url?url=&book_id= „liegt das schon in meiner Bibliothek?" (nur eigener Pool)
POST   /sources/:id/doc           PDF anhängen (Besitzer); identischer Re-Upload ist ein No-Op
GET    /sources/:id/doc           Original ausliefern (Besitzer ODER Viewer auf verknüpftem Buch)
DELETE /sources/:id/doc           PDF + Volltext + Index-Chunks entfernen (Besitzer)

POST   /capture                   Erfassen aus dem Browser: Fundstück und/oder Quelle in EINER
                                  Transaktion (routes/capture.js, siehe docs/clients.md)

POST   /jobs/source-embed-index        Bibliothek des Users neu indizieren (kein Per-Quelle-Scope)

POST   /jobs/source-detect             Erkennung starten (ganzes Buch oder ein Kapitel)
GET    /jobs/source-detect/runs        Lauf-Historie des Buchs (eigene Läufe, ohne Fundliste)
GET    /jobs/source-detect/runs/:id    Lauf öffnen — Bibliotheks-Status frisch gerechnet
DELETE /jobs/source-detect/runs/:id    Lauf verwerfen

POST   /jobs/source-pdf-draft?book_id=&name=  Quelle aus PDF: Entwurf bestimmen (Body: rohes PDF)
```

**Sichtbarkeits-Regel:** buchübergreifende Antworten (`/:id/citations` ohne `book_id`, `/:id/books`) sind **nur** für den Besitzer. Wer nur auf einem gemeinsamen Buch Viewer ist, könnte sonst aus einer geteilten Quelle die Seiten- und Kapitelnamen der übrigen Arbeiten ableiten.

## Oberfläche

- Karte `sourcesCard` ([cards/sources-card.js](../public/js/cards/sources-card.js), Methoden [sources/manage.js](../public/js/sources/manage.js) + [sources/detect.js](../public/js/sources/detect.js) + [sources/tags.js](../public/js/sources/tags.js) (Schlagworte: Formular, Tabellen- und Picker-Filter) + [sources/export-panel.js](../public/js/sources/export-panel.js), Partials [sources.html](../public/partials/sources.html) + [sources-form.html](../public/partials/sources-form.html) + [sources-picker.html](../public/partials/sources-picker.html) + [sources-detect.html](../public/partials/sources-detect.html) + [sources-export.html](../public/partials/sources-export.html)). Das Export-Panel rendert per `x-if` nur offen: seine Comboboxen (Zitierstil, Format) sollen nicht dauerhaft neben denen der Buch-Einstellungen im DOM hängen.
- **Quellen-Erkennung** (Job `source-detect`, [routes/jobs/source-detect.js](../routes/jobs/source-detect.js)): findet im Buchtext lose erwähnte Werke und schlägt sie zur Aufnahme vor. Zwei Schichten — das Modell extrahiert nur, was im Text steht ([prompts/sources.js](../public/js/prompts/sources.js), Schema ohne `doi`/`isbn`/`publisher`/`place`), die kanonischen Felder holt der Register-Lookup ([lib/source-lookup.js](../lib/source-lookup.js)#`searchWork`). Kein Registertreffer heisst **unbestätigt**, nicht verworfen. **Setzt nie einen Quellen-Marker** — der Fund trägt seine Fundstelle (Seite + wörtlicher Satz, deterministisch rückgesucht) nur als Sprungziel. Übernehmen läuft über `POST /sources` + `:id/link`, kein zweiter Schreibpfad; liegt das Werk schon im Pool, wird nur zugeordnet statt dupliziert. Läufe sind historisiert und überleben den Reload, ein laufender Job wird nach F5 wieder aufgenommen (`lektorat_source_detect_job_<bookId>`).
- **Übernahme aus dem Recherche-Board** ([sources/from-research.js](../public/js/sources/from-research.js), in die Karte `rechercheCard` gespreadet, Markup [recherche-item-urls.html](../public/partials/recherche-item-urls.html)): jede **Link-Zeile** eines Fundstücks trägt ihre eigene Aktion und schickt ihre `url_id` mit. **Why:** ein Fundstück sammelt beliebig viele URLs, und welche davon der Nachweis ist, weiss nur der Autor — ein Button pro Fundstück müsste raten (und nähme immer die erste). Das Ergebnis ist ein **Entwurf** (`csl_type` aus dem Vorhandensein einer URL, Abrufdatum = heute, Titel aus dem Fundstück und nur ersatzweise aus der Link-Bezeichnung); Autor/Jahr schärft der User in der Quellen-Karte nach. Das Fundstück bleibt unangetastet, ein `url_id` fremder Herkunft ist ein `404` und **kein** stiller Rückfall auf die erste URL. Bewusst nicht idempotent und ohne „schon übernommen"-Markierung: derselbe Link darf zwei Nachweise tragen, und ohne persistierte Verknüpfung Fund-URL ↔ Quelle wäre jede solche Anzeige geraten. Zweiter Einstieg: „Als Quelle übernehmen" an einem **Recherche-Chat-Vorschlag** ([research-chat-proposals.js](../public/js/chat/research-chat-proposals.js)#`proposalToSource`) speichert den Vorschlag zuerst als Fundstück (bzw. nimmt den schon vorhandenen Eintrag) und ruft dann dieselbe Route ohne `url_id` (erster Link).
- **Erfassen aus dem Browser** — der einzige Weg in die Bibliothek, der **ausserhalb der App** beginnt: die Chrome-Erweiterung `schreibwerkstatt-browser-extension` legt die gerade offene Seite über `POST /capture` ([routes/capture.js](../routes/capture.js)) als Fundstück und/oder Quelle ab, beides in **einer** Transaktion. Die Bibliotheks-Regel „eine Quelle pro Dokument, buchübergreifend" gilt dort wie überall: eine bekannte URL wird wiederverwendet und nur noch dem Buch zugeordnet (`source_created`/`source_linked` sagen es einzeln), erkannt über den URL-Vergleich aus [lib/url-normalize.js](../lib/url-normalize.js) — dieselbe Frage vorab beantwortet `GET /sources/by-url`. Der Entwurf trägt bewusst **keinen `citekey`**: den Zitierschlüssel vergibt der Autor, nicht die Erweiterung. Die Metadaten liest der Client aus dem DOM (auch hinter Login und Paywall) — **kein Endpunkt ruft eine fremde URL ab**, es gibt hier also keine SSRF-Fläche; kanonische Angaben holt weiterhin `GET /sources/lookup?doi=`. Token-Scope, Idempotenz-Regeln und der Grund für den Sammel-Endpunkt: [docs/clients.md](clients.md).
- Einfügen im **Notebook-Editor**: [toolbar/cite.js](../public/js/editor/notebook/toolbar/cite.js). Inline am Caret über die Range-API — **nicht** `execCommand('insertHTML')`: Chromium schleust den Fragment-String durch seinen Editing-Sanitizer, verwirft `class`/`data-*` und backt die CSS-Werte als Inline-`style` ein.
- **Nachschlagen in der Leseansicht des Notebook-Editors**: Klick auf einen Chip öffnet ein read-only Popover (voller Verzeichniseintrag im Stil des Buchs, Stellenangabe, „vgl."-Marke, Belegzahl, DOI/URL, Weg ins Quellenverzeichnis). Anzeigemodell pure in [sources/cite-popover.js](../public/js/sources/cite-popover.js), Host + Klick-Pfad in [cards/editor-entities-card.js](../public/js/cards/editor-entities-card.js) (`kind: 'source'` im geteilten `.entity-popover` — dieselbe Positionierung, Scroll-Nachführung und Close-Logik wie die Figuren-/Orte-Popover), Markup in [editor-entities-panel.html](../public/partials/editor-entities-panel.html). Bewusst **nicht** an `entities_enabled` gebunden: das Flag schaltet die Figuren-/Orte-Hervorhebung, ein Quellennachweis steht unabhängig davon im Text. Der **Edit-Modus** gehört dagegen dem Picker (Chip-Klick = Beleg ändern), darum grenzt der Lese-Pfad über `editMode` ab. Die Quellenliste teilen beide über einen Fetch pro Buch ([sources/source-cache.js](../public/js/sources/source-cache.js), invalidiert über `sources:changed`/`book:changed`).
- Zeigt der Chip auf eine Quelle, die dem Buch nicht (mehr) zugeordnet ist (Seite kopiert, Quelle entfernt), sagt das Popover das — es geht nie leer auf, und es bietet dann keinen Weg ins Verzeichnis an. Ein Ladefehler ist davon getrennt: sonst behauptet ein 500er, die Quelle sei entfernt worden.
- Focus-Editor und Bucheditor stellen Chips dar und zerstören sie nicht, bringen aber weder Einfüge- noch Nachschlage-Pfad mit.
- CSS: `span.cite` in [components/manuscript-content.css](../public/css/components/manuscript-content.css) (SSoT für alle drei Oberflächen inkl. Share-Reader), Picker in [editor/notebook/edit-toolbar.css](../public/css/editor/notebook/edit-toolbar.css), Karte in [entities/sources.css](../public/css/entities/sources.css).

## PDF-Anhang an der Quelle

Optional hängt an jeder Quelle ihr Original-PDF (`sources.doc`, BLOB) plus der extrahierte Plain-Text (`sources.doc_text`). Zweck ist die **semantische Bibliothekssuche**: „Wo habe ich etwas über X gelesen" über die eigenen Werke, unabhängig vom Buch. Rein rückwärtsgewandt — nie generativ im Buchtext.

- **Geteilter Stack mit dem Recherche-Board.** Dasselbe PDF-Anhängen gibt es am Recherche-Fundstück ([docs/recherche-chat.md](recherche-chat.md)); alles Mechanische liegt darum einmal in [lib/pdf-attachment.js](../lib/pdf-attachment.js) (Upload-Limit als `express.raw`-Body, Namens-Bereinigung, Extraktion, Fehler-Mapping, Auslieferungs-Header) und im Frontend in [public/js/upload-pdf.js](../public/js/upload-pdf.js). Beide Router bringen nur ihr eigenes ACL- und Persistenz-Modell mit — Buch-ACL dort, Pool-Besitz hier. **Nomenklatur `doc` auf allen Schichten** (Route, Spalten, Frontend-State), damit die zwei Oberflächen dieselbe Sache gleich nennen.
- **Upload-Limit ist eine Zahl.** SSoT `MAX_INPUT_BYTES` in [lib/pdf-extract.js](../lib/pdf-extract.js); der `express.raw`-Limit-String und die Browser-Vorprüfung (`/config` → `pdfUpload.maxBytes`) leiten sich daraus ab. Keine zweite Konstante daneben.
- **Der Volltext ist gedeckelt** (`MAX_TEXT_CHARS`). `doc_chars` hält die tatsächliche Länge; erreicht sie den Deckel, zeigt das Formular es an. **Why:** ohne dieses Signal hält der Autor ein halb indiziertes 800-Seiten-Werk für vollständig durchsuchbar.
- **Identischer Re-Upload ist ein No-Op.** `doc_content_hash` (sha256 des Originals) entscheidet: gleicher Hash ⇒ weder Extraktion noch Index-Job, nur die Antwort. Sonst kostet ein versehentliches zweites Hochladen einen kompletten Embedding-Lauf.
- **Kein BLOB auf dem Listenweg.** Die Quellen-SELECTs führen eine explizite Spaltenliste; `doc` und `doc_text` verlassen die Tabelle ausschliesslich über `getSourceDocBlob`/`getSourceDocText`. Der Download prüft die ACL auf der **Meta-Zeile** und lädt das Original erst danach — ein 403 soll keine 25 MB durch den Prozess ziehen. Ausgeliefert wird `inline` mit `X-Content-Type-Options: nosniff`.
- **Index-Job** `source-embed-index` ([routes/jobs/source-embed-index.js](../routes/jobs/source-embed-index.js)) läuft **immer über die ganze Bibliothek eines Users**, nie über eine einzelne Quelle: der Delta-Cache (Chunk-Hash) macht den Ein-PDF-Fall gleich billig, und ein zweiter Scope wäre ein zweiter Pfad, der driftet. Dedup-Key ist die E-Mail; ein laufender Job nimmt frisch hochgeladene PDFs im selben Lauf mit, darum gibt der Upload dessen `index_job_id` zurück und die Karte pollt ihn. Chunks liegen user-skopiert in `source_semantic_chunks` ([db/source-semantic-chunks.js](../db/source-semantic-chunks.js), Pendant zu `semantic_chunks`, aber ohne `book_id`). Am Ende jedes Laufs räumt `clearForeignModels` die Chunks eines früher aktiven Embedding-Modells — `pruneMissing` ist modell-skopiert und sähe sie nie.
- **Stale heisst „seit dem Index angefasst", pro Quelle.** `doc_indexed_at IS NULL OR doc_indexed_at < updated_at`. `setSourceDoc` nullt den Stempel, `markSourceIndexed` fasst `updated_at` nicht an. **Why:** ein Vergleich gegen einen benutzerweiten `MAX(created_at)` der Chunks kann nicht funktionieren — die zwei Stempel kommen aus verschiedenen Uhren (JS-`Date` im Job vs. `strftime` beim Insert), und jede Quelle gälte dauerhaft als veraltet.
- **Bibliothekssuche** `GET /search/sources-semantic` (user-skopiert, kein `book_id`, keine FTS-Hybridfusion — Quellen liegen nicht im buch-skopierten `search_index`). Score-Floor und Cross-Encoder-Reranking teilt sie sich mit dem Buchpfad über `_rerankCandidates` in [lib/semantic-retrieval.js](../lib/semantic-retrieval.js). Der Snippet geht **roh** raus und wird im `x-text`-Sink escapt — anders als bei `/search/semantic`, dessen `<mark>`-Highlight über `x-html` läuft.
- Oberfläche: [sources/doc.js](../public/js/sources/doc.js) (in `sourcesCard` gespreadet), Formular-Block in [sources-form.html](../public/partials/sources-form.html), Suche in [sources-lib-search.html](../public/partials/sources-lib-search.html).

## Quelle aus PDF

Der umgekehrte Weg zum Anhang: der Autor wählt zuerst das PDF („Aus PDF" in der Toolbar), und die Quelle entsteht daraus. Job `source-pdf-draft` ([routes/jobs/source-pdf-draft.js](../routes/jobs/source-pdf-draft.js)), Kennungssuche pure in [lib/source-pdf-ident.js](../lib/source-pdf-ident.js), Oberfläche [sources/pdf-draft.js](../public/js/sources/pdf-draft.js) + Fragment [sources-pdf-draft.html](../public/partials/sources-pdf-draft.html).

- **Drei Stufen, die billigste und sicherste zuerst:** DOI aus Info-Dictionary/XMP ([pdf-extract.js](../lib/pdf-extract.js)#`readPdfMeta`) und Textkopf → Crossref; ISBN (mit Prüfziffer) aus dem Textanfang → OpenLibrary; erst dann liest das Modell die Titelseite und `searchWork` sucht das Werk. Das Modell bekommt dasselbe kennungsfreie Schema wie die Quellen-Erkennung — dieselbe Zwei-Schichten-Regel wie unten.
- **Eine Kennung zählt nur, wenn der Registertitel im PDF steht** (`titleInText`, Textanfang). **Why:** Titelseiten nennen fremde Kennungen — den DOI eines Begleitartikels, die ISBN der Vorauflage oder des E-Books. Ohne diese Schranke trüge der erste gefundene DOI fremde Metadaten mit Registeranschein in die Bibliothek. Gesucht wird darum auch nur am Anfang (DOI 8 000, ISBN 20 000 Zeichen): dahinter beginnt das Literaturverzeichnis, das fast nur fremde Kennungen enthält.
- **Entwurf, kein Schreibzugriff.** Das Ergebnis öffnet das Anlage-Formular; erst „Speichern" legt über `POST /sources` an und hängt das PDF über `POST /sources/:id/doc` an — dieselben Endpunkte wie von Hand, kein zweiter Schreibpfad. Scheitert der Anhang, bleibt die Quelle stehen und die Karte meldet es. Das `File` liegt bis dahin in einer Modul-Variable, **nicht** im Alpine-State (Proxy bricht `arrayBuffer()`, s. [upload-pdf.js](../public/js/upload-pdf.js)); darum gibt es auch keinen Reconnect nach Reload — ohne Datei gäbe es nichts anzuhängen.
- **Dubletten:** der Job vergleicht den Entwurf mit dem eigenen Pool (DOI, ISBN, dann Titel + Jahr) und meldet `existing_source_id`/`existing_linked`/`existing_has_doc`. Das Formular bietet dann „Vorhandene Quelle verwenden" an: zuordnen, PDF anhängen, falls sie noch keines hat, und zum Prüfen öffnen — keine zweite Quelle für dasselbe Werk.
- **Zeitungs- und Webartikel:** das Modell liest zusätzlich das gedruckte Erscheinungsdatum (`datum`, Text wie auf der Seite, keine Kennung) und unterscheidet `zeitungsartikel` von `aufsatz`; bei `newspaper` entfällt die Register-Suche (`register_skipped`, eigene Meldung statt „unbestätigt"). Hat keine Stufe eine Adresse geliefert, nimmt der Job die Adresse aus Kopf-/Fusszeile eines Browser-Drucks ([source-pdf-ident.js](../lib/source-pdf-ident.js)#`findPrintedUrl`: eine URL, die mehrfach vorkommt, oder die einzige am Textrand — ein Link aus dem Fliesstext ist nicht die Adresse des Dokuments). Abrufdatum ist dann das **Erstellungsdatum des PDFs** (`CreationDate` = Drucktag), fehlt es, bleibt das Feld leer statt „heute" zu behaupten.
- Der Upload wird **in der Route** ausgelesen (`readDocUpload`), damit „kein PDF", „zu gross" und „unlesbar" als sofortiger 4xx mit denselben `error_code`s ankommen wie beim Anhängen. Dedup über den Inhalts-Hash: dasselbe PDF zweimal gewählt ⇒ derselbe Lauf.

## Belegvorschlag (vom Befund zur Quelle)

Die Gegenrichtung zur Bibliothekssuche: dort fragt der Suchende „wo habe ich etwas über X gelesen", hier fragt der **Buchtext** „womit kann ich genau diesen Satz stützen". Route [routes/sources-evidence.js](../routes/sources-evidence.js), Oberfläche im Lektorat-Findings-Panel ([public/js/editor/lektorat-evidence.js](../public/js/editor/lektorat-evidence.js)), Mechanik der Wolke: [docs/semantic-search.md](semantic-search.md#zwei-fragen-jenseits-der-trefferliste).

- **Auslöser ist ein `unbelegt`-Befund** des wissenschaftlichen Lektorat-Profils — sein Span ist ein ganzer Satz und damit eine fertige semantische Anfrage gegen `source_semantic_chunks`. Bewusst **nicht** `zuschreibung`: im journalistischen Profil ist der Beleg die im Satz genannte Person oder Stelle, nicht der Kurzbeleg.
- **`GET /sources/evidence?book_id=&q=`** liefert je Treffer den vollständigen Quellen-Datensatz (das Frontend baut daraus den Kurzbeleg ohne zweiten Roundtrip) **plus `linked`**. Letzteres ist keine Zierde: ein `data-src`-Marker erzeugt nur eine Fundstelle, wenn die Quelle dem Buch zugeordnet ist (`replacePageCitations`) — ein Vorschlag aus einer anderen Arbeit muss also erst durch `POST /:id/link`, und zwar **vor** dem Einfügen.
- **`paraphrase`, nicht `quote`.** Eine unbelegte Behauptung steht in eigenen Worten; sie wird sinngemäss gestützt („vgl."), nicht wörtlich zitiert.
- **Keine Stellenangabe.** Ein Embedding-Chunk trägt keine Seitenzahl (`source_semantic_chunks` hat keine Spalte dafür). Sie zu raten wäre eine erfundene Belegstelle — der Autor trägt sie über den Chip-Klick nach (`openCiteForChip` kann genau das).
- **Der Satz bleibt unangetastet.** Eingefügt wird über `insertAfterInHtml` ([public/js/utils/html-find.js](../public/js/utils/html-find.js)), das an einer Position **spleisst statt zu ersetzen**: `replaceInHtml` setzt nur maskierten Klartext ein (ein Chip-Markup käme als Text an) und blockiert jeden Treffer, der eine bestehende Quellenangabe umschliesst. Mehrdeutigkeit (`countInHtml > 1`) ist ein Abbruch — ein Beleg am falschen Satz ist schlimmer als kein Beleg.
- **Schreibweg ist der Server-Apply des Lektorats** (frisch laden → spleissen → `savePage` mit `expectedUpdatedAt`, Revisions-Quelle `lektorat-apply`), nicht der DOM-Weg des Beleg-Pickers: bei sichtbaren Befunden ist der Editor per Invariante nie im Bearbeiten-Modus.

## Tests

[cite-html](../tests/unit/cite-html.test.mjs) (Markup, Offsets, Zitat-Kategorien) · [cite-index](../tests/unit/cite-index.test.js) (Fund-Index am Chokepoint) · [cite-popover](../tests/unit/cite-popover.test.mjs) (Anzeigemodell des Lese-Popovers, verwaister Zeiger, DOI/URL-Schranke) · [cite-guard-drift](../tests/unit/cite-guard-drift.test.mjs) (die drei Schutzschichten + Selektor-Kopien) · [sources-format](../tests/unit/sources-format.test.mjs) (Stile, Jahres-Buchstaben) · [sources-db](../tests/unit/sources-db.test.js) (Pool/Brücke/CASCADE) · [source-doc-db](../tests/unit/source-doc-db.test.js) (PDF-Metadaten, kein BLOB in Listen, Stale-Heuristik, Modellwechsel-Cleanup) · [pdf-attachment](../tests/unit/pdf-attachment.test.js) (geteilter Anhang-Stack: Fehler-Codes, Hash, nosniff) · [bibliography](../tests/unit/bibliography.test.mjs) + [export-builders/bibliography](../tests/unit/export-builders/bibliography.test.mjs) · [endnotes](../tests/unit/endnotes.test.mjs) · [sources-export](../tests/unit/sources-export.test.mjs) (Lesefassungen, Linksammlung, Rundlauf BibTeX/RIS durch den Import) · [bib-parse](../tests/unit/bib-parse.test.mjs) + [source-lookup](../tests/unit/source-lookup.test.mjs) + [source-lookup-search](../tests/unit/source-lookup-search.test.mjs) (Annahmeregel der bibliografischen Suche) + [source-detect-prompt](../tests/unit/source-detect-prompt.test.mjs) (Schema ohne Metadaten-Felder) + [source-detect](../tests/integration/source-detect.test.js) (Job-Kette) · [source-pdf-ident](../tests/unit/source-pdf-ident.test.mjs) (DOI-/ISBN-Kandidaten, Prüfziffer, Titel-Schranke, PDF-Metadaten) + [source-pdf-draft](../tests/integration/source-pdf-draft.test.js) (Stufenfolge, fremder DOI verworfen, Dubletten) + App-E2E [sources-pdf-draft](../tests/e2e-app/sources-pdf-draft.spec.js) (Entwurf → Speichern mit Anhang, vorhandene Quelle verwenden, Zeitungsartikel mit Datum) · [sources-newspaper](../tests/unit/sources-newspaper.test.mjs) (Datum in den drei Stilen, Fachaufsatz bleibt beim Jahr) + [issued-date-drift](../tests/unit/issued-date-drift.test.mjs) + [sources-issued-date](../tests/integration/sources-issued-date.test.js) (Schreibpfad: ISO, Jahr folgt, 400) · [wp-html](../tests/unit/wp-html.test.mjs) + [hubspot-html](../tests/unit/hubspot-html.test.mjs) (Round-Trip + Akkumulation) · [sources-import](../tests/integration/sources-import.test.js) (Endpunkte + Sichtbarkeit) · App-E2E: [notebook-cite](../tests/e2e-app/notebook-cite.spec.js), [sources-card](../tests/e2e-app/sources-card.spec.js), [sources-export](../tests/e2e-app/sources-export.spec.js) (Schlagworte setzen/filtern, Export-Auswahl → Format → Download), [reference-sources-tab](../tests/e2e-app/reference-sources-tab.spec.js), [recherche-to-source](../tests/e2e-app/recherche-to-source.spec.js) (Übernahme je Link-Zeile — der Button lebt in einem `x-for`-Fragment, das der Smoke bei leerem Board nie auswertet). · [cite-insert-after](../tests/unit/cite-insert-after.test.mjs) (Belegvorschlag: `insertAfterInHtml` verliert nichts — Inline-Auszeichnung, bestehende Quellenangabe, Absatzgrenze, abschliessende Auszeichnung; plus der Mehrdeutigkeits-Guard davor)

## Vier Regeln, die keine Schicht verwischen darf

- **Quellen sind eine persönliche Bibliothek, kein Buch-Inhalt** — die Quelle lebt im User-Pool `sources` (`owner_email`) und ist über die M:N-Brücke `book_source_links` beliebig vielen Büchern zugeordnet. **Why:** eine Literaturbibliothek ist personen-, nicht werkgebunden — wer mehrere Arbeiten mit überlappender Literatur schreibt, erfasst dieselbe Quelle sonst mehrfach und pflegt sie mehrfach. Daraus folgen vier Regeln, die keine Schicht verwischen darf:
  - **Zwei Achsen im Zugriff:** Ändern/Löschen im Pool kann **nur der Besitzer** (`403 NOT_SOURCE_OWNER`) — die Quelle liegt in seinen anderen Arbeiten mit drin. Lesen (ab `viewer` — auch ein Lektor muss den Quellen-Marker auflösen können) und **Zu-/Entordnen** (ab `editor`) hängen an der **Buch-ACL**: das ist eine Aussage über das Buch, nicht über eine fremde Bibliothek. Frontend spiegelt das über `srcIsOwner(s)`, autoritativ ist [routes/sources.js](../routes/sources.js).
  - **`unlinkSource` ≠ `deleteSource`:** Entfernen löst nur die Brücke zu **einem** Buch (plus dessen Fundstellen); Löschen räumt den Pool-Eintrag und trifft damit **alle** Bücher. Beide Wege müssen in jeder Oberfläche unterscheidbar bleiben.
  - **Kennzahlen sind buch-skopiert, sobald ein Buch im Spiel ist** (`listSources(bookId)`, `getSource(id, bookId)`) — dieselbe Quelle ist in Arbeit A zwanzigmal und in Arbeit B gar nicht belegt. Nur die Pool-Sicht (`listPoolSources`, `getSource(id)`) summiert über alle Bücher und liefert `book_count`. `citekey` ist **UNIQUE pro Bibliothek**, nicht pro Buch.
  - **Die Quellen-Erkennung schlägt vor, sie recherchiert nicht und sie schreibt nicht** (Job `source-detect`, [routes/jobs/source-detect.js](../routes/jobs/source-detect.js), Panel in der Quellen-Karte). Zwei Schichten, deren Trennung die Existenzberechtigung des Features ist: das Modell **extrahiert** nur, was im Text steht (Titel, genannte Person, genanntes Jahr) — sein Schema ([prompts/sources.js](../public/js/prompts/sources.js)) kennt darum bewusst **kein** `doi`/`isbn`/`publisher`/`place`, denn danach gefragt erfindet ein Sprachmodell die Angabe —, und die kanonischen Felder holt der deterministische Register-Lookup ([lib/source-lookup.js](../lib/source-lookup.js)#`searchWork`, Crossref/OpenLibrary). Kein Registertreffer heisst **unbestätigt**, nicht verworfen. Die Annahmeregel (`acceptMatch`) ist bewusst streng und dumm: ein danebengegriffener Treffer trägt fremde Metadaten mit dem Anschein von Registerdaten in die Bibliothek, ein verpasster kostet nur einen Handgriff. **Kein Chip:** der Job fasst den Buchtext nicht an — wo belegt wird, entscheidet allein der Autor im Editor; der Fund trägt stattdessen seine Fundstelle (Seite + wörtlicher Satz, deterministisch rückgesucht) als Sprungziel. Ergebnis ist transient und wird erst mit dem Übernehmen zur Quelle (bestehendes `POST /sources` + `:id/link`, kein zweiter Schreibpfad).
  - **Der Buch-Guard des Fund-Index läuft über die Brücke** ([db/sources.js](../db/sources.js)#`replacePageCitations`): ein `data-src`-Marker erzeugt nur dann eine Fundstelle, wenn die Quelle dem Buch der Seite zugeordnet ist. Fängt „Seite in ein anderes Buch kopiert" und „Quelle aus dem Buch entfernt, Marker steht noch im Text" ab.
