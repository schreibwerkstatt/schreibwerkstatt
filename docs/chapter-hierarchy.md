# Kapitel-Hierarchie

Kapitel können in Kapitel verschachtelt werden (max 3 Ebenen). SSoT der Verschachtelung lebt in `book_order.order_json` (Tree) **und** materialisiert in `chapters.parent_chapter_id` (FK, ON DELETE SET NULL). Tiefe wird nicht persistiert — sie wird bei Bedarf aus der Parent-Kette berechnet.

Kapitel tragen **keinen Text** (`chapters` hat nur Name, Position, Parent) — geschrieben wird ausschliesslich in Seiten (`pages`, im UI «Abschnitt»). Ein Abschnitt kann ohne Kapitel auf oberster Ebene stehen, ein Kapitel ohne Abschnitt ist leer.

## Harte Grenzen

- **`MAX_CHAPTER_DEPTH = 3`** — Konstante in [db/book-order.js](../db/book-order.js) (Backend-SSoT) + gespiegelt als Frontend-Konstante in [public/js/book-organizer/view.js](../public/js/book-organizer/view.js).
  - **Why:** PDF-Renderer mapped 1→h1, 2→h2, 3→h3; tiefer wäre ohne neue Heading-Stufen unsauber. UX bei tieferer Verschachtelung wird unübersichtlich. Beispiele wie Bibel-Bücher (Buch → Teil → Kapitel) decken 3 Ebenen ab.
- **Validator wirft** `MAX_DEPTH` bei Versuch tieferer Verschachtelung — gilt für PUT auf `/content/books/:id/order` und für DnD-Drop-Targets.
- **Zyklen-Schutz** kommt strukturell durch JSON-Tree-Form (kein Kapitel kann sich selbst enthalten); Organizer-DnD prüft zusätzlich `_descendantIdsOf` vor Drop.

## Schema

```sql
chapters.parent_chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL
CREATE INDEX idx_chapters_parent ON chapters(parent_chapter_id);
```

- Migration **135** ([db/migrations.js](../db/migrations.js)). FK-Recreate nicht nötig — `ALTER TABLE ADD COLUMN` mit FK ist erlaubt für nullable Spalten ohne DEFAULT.
- `ON DELETE SET NULL` (statt CASCADE): **Why** — konsistent mit `pages.chapter_id`. Löscht ein User das Eltern-Kapitel, fällt sein Inhalt nicht mit (User-Daten-Schutz). Wohin er wandert, entscheidet die Facade, nicht der FK: `deleteChapter` ([lib/content-store/index.js](../lib/content-store/index.js)) setzt die Kinder in order_json an die Stelle des Kapitels (`spliceChapterOut`, [tree.js](../lib/content-store/tree.js)) — Unterkapitel rücken eine Ebene hoch in seine Lücke, seine Abschnitte gehen ans Ende der Abschnitte des Elternkapitels bzw. zu den kapitellosen Abschnitten. Seitenleiste und Organizer bieten Löschen trotzdem nur für leere Kapitel an.

## SSoT: `book_order.order_json`

Kapitel-Knoten enthalten Abschnitte und Unterkapitel, bis MAX_CHAPTER_DEPTH. Die Reihenfolge ist **kanonisch**: in jeder Geschwisterliste stehen die Abschnitte vor den Kapiteln — kapitellose Abschnitte am Buchanfang, die eigenen Abschnitte eines Kapitels vor seinen Unterkapiteln:

```json
[
  { "type": "page", "id": 103 },
  { "type": "chapter", "id": 42, "children": [
      { "type": "page", "id": 101 },
      { "type": "chapter", "id": 50, "children": [
          { "type": "page", "id": 200 }
      ]}
  ]}
]
```

`canonicalizeTree` ([db/book-order.js](../db/book-order.js)) normalisiert jeden Schreibweg darauf (`putOrder`, `reconcile`, Auto-Init) — ein verschränkt gespeicherter Tree wird beim nächsten `ensureTree` umsortiert. **Why:** Seitenleiste und Buchorganizer können nur «Abschnitte, dann Unterkapitel» darstellen; jede andere Reihenfolge im Tree hiess, dass Buch-Chat, Lektorat-Serie und Fassungs-Export eine andere Lesereihenfolge sahen als Seitenleiste, Bucheditor und Live-Export. Damit ist die Lesereihenfolge eines Abschnitts auch in SQL eindeutig: `ORDER BY COALESCE(c.position, -1), p.position` (`globalPageOrderSql()`, mit `LEFT JOIN chapters c`). Buchweite Abfragen sortieren nie nach `p.position` allein — das zählt pro Kapitel und verzahnt die Kapitel (Quellen-Nummern, Abbildungs-/Tabellen-Nummern, Buch-Chat-Listen).

`materializeTree` ([db/book-order.js](../db/book-order.js)) setzt in einer Transaction:
- `chapters.parent_chapter_id` (NULL für top-level, sonst FK auf Eltern-Kapitel)
- `chapters.position` (0-basiert, **lückenlos in Depth-First-Tree-Reihenfolge** — globaler Sort-Hint für `listChapters`)
- `pages.chapter_id` (NULL für top-level, sonst FK auf **direkt** enclosing Kapitel)
- `pages.position` (0-basiert, lückenlos **pro Bucket**: Eltern-Kapitel oder Top-Level)

`reconcile` (Lese-Pfad nach externen CRUD-Inserts) ist rekursiv: verwaiste Sub-Kapitel werden anhand `parent_chapter_id` unter ihren Parent gehängt, sofern die **echte Tiefe des Parents im Tree** + 1 ≤ MAX (fehlende Eltern zuerst). Sonst Fallback auf top-level — eine vierte Ebene im Tree liesse jedes spätere `putOrder` mit `MAX_DEPTH` scheitern.

**Strukturversion:** `book_order.updated_at` ist die Version der Gliederung. Sie rückt bei jeder Strukturänderung vor — `putOrder`, `reconcile` (auch ohne neuen `updated_by`), Kapitel anlegen/umbenennen/ausschliessen/löschen, Abschnitt anlegen/löschen (`touchOrder` bzw. `_syncOrder` in der Facade, die zusätzlich `emitBookChange` feuert). Ausgeliefert als `order_updated_at` im Tree-Response und `structure_at` in `/changes`; `PUT …/order` mit `expected_updated_at` antwortet bei Abweichung `409 ORDER_CONFLICT` (`OrderConflictError`) statt einen fremden Umbau still zu überschreiben.

## Backend-Helper

In [db/book-order.js](../db/book-order.js):

```js
getDescendantChapterIds(chapterId, { includeSelf = false })
```
Rekursive CTE auf `parent_chapter_id`. Liefert alle Nachfahren. Genutzt von:
- **Kapitel-Review** ([routes/jobs/kapitel.js](../routes/jobs/kapitel.js)) bei `include_subchapters: true` — lädt Seiten aller Sub-Kapitel rekursiv.
- **`chapterSubtreeFilter(column, chapterId)`** → `{ sql, params }` (`column IN (…)`): «Kapitel» heisst in jedem Filter der ganze Teilbaum. Konsumenten: die `chapter_id`-Filter der Buch-Chat-Werkzeuge ([db/book-chat/](../db/book-chat/): Textsuche, Dialoge, Lektorat-Befunde, Stil, Wiederholungen, Orte, Songs, Szenen; Kontinuität im Handler). Ein Teil, der nur Unterkapitel trägt, wäre sonst leer.

Weiter: `chapterDepth(chapterId)` (Tiefe aus der Parent-Kette; `POST /content/chapters` lehnt einen Parent auf Ebene 3 mit `400 CHAPTER_MAX_DEPTH` ab, die Facade wirft dasselbe), `canonicalizeTree`, `globalPageOrderSql`, `touchOrder`.

In [lib/content-store/index.js](../lib/content-store/index.js):

- **`bookTree(bookId, ctx)`** — Output: `{ chapters: [top-level], topPages: [] }`. Jedes Kapitel hat `{ ...meta, pages: [], subchapters: [] }` (rekursiv selbe Shape). Direkt verbrauchbar für nested UI.
- **`flattenTree(tree)`** ([tree.js](../lib/content-store/tree.js)) — Lesereihenfolge `[{ page, chapterId, chapterName, depth }]`: kapitellose Abschnitte zuerst, dann die Kapitel depth-first. `chapterName` ist das direkt umschliessende Kapitel. Genutzt von [routes/book-editor.js](../routes/book-editor.js) für flache Page-Liste. Der Bucheditor bekommt die Elternkette zusätzlich als `chapters: [{ id, name, parentId }]` und setzt daraus je beginnendem Vorfahr einen Kapitel-Header mit Tiefe ([manuscript-stream.js](../public/js/manuscript-stream.js)#`fromPages`; `fromGroups` für den Share-Reader genauso aus `parent_chapter_id`).
- **`bookOutline(bookId)`** ([lib/content-store/outline.js](../lib/content-store/outline.js)) — Kapitel und Abschnitte als eine Knotenliste in Lesereihenfolge direkt aus dem (kanonischen) Tree. Kapitel `{ type:'chapter', id, name, depth, parent_id, path, chapter_ids }`, Abschnitt `{ type:'page', id, name, chapter_id, depth, path, chapter_ids }` (`depth` 0 = ohne Kapitel). Dazu `chapterPages(outline, id, { includeSubchapters })` und `formatChapterPath(path)`. Ist der Tree ungültig, baut es ungespeichert aus den Positionen. Genutzt vom Buch-Chat (Werkzeuge + klassischer Prompt, [chat-tools.md](chat-tools.md)).
- **`walkAllChapters(tree, cb)`** — Iterator über alle Kapitel-Ebenen.

In [lib/content-store/backends/localdb.js](../lib/content-store/backends/localdb.js): das Kapitel-Shape (`_chapterRow`) führt `parent_chapter_id` — Pflicht, damit `coalesce.js`/Export-Builder die Tiefe berechnen können.

## Frontend: Buchorganizer

[public/js/book-organizer/](../public/js/book-organizer/) — alle Slices nested-aware.

- **`workTree`-Shape** ([persist.js](../public/js/book-organizer/persist.js)): rekursiv, `{ id, name, depth, parent_id, pages, subchapters }`. Snapshot via `_snapshotFromNav` rekonstruiert das Nesting aus `nav.tree` — der ist flach, enthält aber alle Kapitel jeder Tiefe mit `depth` + `parent_id` (kein eigener Tree-Fetch nötig). `depth` wird aus dem rekonstruierten Nesting neu abgeleitet.
- **3-Level-Render** ([public/partials/buchorganizer.html](../public/partials/buchorganizer.html)): Unrolled (Alpine kennt keine Template-Rekursion), aber der Zeileninhalt ist SSoT im Fragment-Include [organizer-chapter-body.html](../public/partials/organizer-chapter-body.html). **Alle Tiefen nutzen denselben x-for-Alias `ch`** (Level 2/3: `ch in (ch.subchapters || [])`, Alpine shadowed im Kind-Scope) — nur dadurch ist das Fragment tiefenunabhängig. Gegated: [tests/e2e/organizer-hierarchy.spec.js](../tests/e2e/organizer-hierarchy.spec.js).
- **DnD** ([dnd.js](../public/js/book-organizer/dnd.js)): Alle Chapter-Listen teilen Gruppe `chapters`. `_validateChapterMove` (Sortable.onMove) blockt:
  - Drop in eigenen Subtree (via `_descendantIdsOf`)
  - Tiefe-Überschreitung (`targetDepth + subtreeDepth - 1 > MAX_CHAPTER_DEPTH`, Konstante aus [constants.js](../public/js/book-organizer/constants.js))
- **Tab / Shift+Tab** ([view.js](../public/js/book-organizer/view.js#onChapterTab)): Im Kapitel-Input ruft `onChapterTab` → `demoteChapter` / `promoteChapter`. preventDefault nur wenn Aktion möglich, sonst native Tab-Navigation.
- **`promoteChapter` / `demoteChapter`** ([dnd.js](../public/js/book-organizer/dnd.js)): mutieren workTree (raus aus aktueller parentList, in neuer einfügen), `_setSubtreeDepth` rekursiv für Subtree (Tiefe + `parent_id`), dann `_persistOrder({ mirror: 'chapters' })` + `_reattachSortables()`.
- **Persist-Strategie** — `_persistOrder({ mirror })` mit vier Modi (`'chapters'`/`'pages'`/`'both'`/`'reload'`, Tabelle in [buchorganizer.md](buchorganizer.md#mirror-modi)). Der Mirror ist tiefen-vollständig: `_mirrorChapterOrderInRoot` schreibt `priority`/`depth`/`parent_id`/`hasChildren` aller Kapitel, ordnet `nav.tree` depth-first (`_reorderNavTree`) und klappt in der Sidebar die neue Eltern-Kette eines umgehängten Kapitels auf; `_mirrorPageMembershipInRoot` sammelt Seiten rekursiv. Deshalb laufen **auch Cross-Level-Moves, neue Sub-Kapitel und Seiten in Sub-Kapiteln über den granularen Mirror** (kein Sidebar-Flicker); `'reload'` ist nur Rückfall (Papierkorb-Restore, Parent während des Namensdialogs verschwunden).
- **Kanonische Reihenfolge** — innerhalb eines Kapitels stehen seine eigenen Abschnitte **vor** seinen Unterkapiteln, kapitellose Abschnitte vor allen Kapiteln. Der Server erzwingt das beim Materialisieren ([db/book-order.js](../db/book-order.js)); `_buildTreeFromWorkstate` schreibt den Order-PUT schon in dieser Reihenfolge, Sidebar und Organizer zeigen sie so.
- **Strukturstand** — der Order-PUT trägt `expected_updated_at` (Stand aus `order_updated_at` des Tree-Loads bzw. `updated_at` des letzten PUT, [tree/catchup.js](../public/js/book/tree/catchup.js)#`_structureVersionForWrite`). Hat ein anderer Tab/ein anderes Gerät die Struktur inzwischen umgebaut, antwortet der Server `409 ORDER_CONFLICT`: der Organizer meldet das (`bookOrganizer.orderConflict`), verwirft die History und lädt Baum + Workstate frisch, statt den fremden Umbau zu überschreiben.
- **`canPromoteChapter` / `canDemoteChapter`** — Demote braucht Vor-Geschwister + `newDepth + movingSubtreeDepth - 1 ≤ MAX_CHAPTER_DEPTH`.

## Frontend: Sidebar-Tree

[public/js/book/tree.js](../public/js/book/tree.js) — flach mit Depth-Annotation:

- `loadPages` walkt nested `tree.chapters` rekursiv → `this.tree` als flacher depth-first Array. Jedes Item: `{ ..., depth, parent_id, hasChildren }`.
- `hasChildren` (true wenn das Kapitel Sub-Kapitel hat) erlaubt Chevron + Collapse auch für Kapitel ohne eigene Seiten.
- `filteredTree` ([public/js/app.js](../public/js/app.js)): zwei-Pass-Filter. Pass 1 matcht Abschnittsnamen **und Kapitelnamen** — trifft der Kapitelname, gehört das ganze Kapitel samt Unterbaum zum Ergebnis. Pass 2 fügt Vorfahren matchender Sub-Kapitel hinzu (mit leerer Page-Liste), damit Deep-Treffer Kontext zeigen. Die Treffer sind **Kopien** mit gefilterten `pages`: Kennzahlen am Kapitelkopf rechnen darum nie an der Kopie — der Bearbeitungsstand (`chapterEditStatus`) immer am echten Baum-Item über den ganzen Unterbaum, das Abschnitts-Tag (`_chapterPageCount`) als Treffer im Unterbaum (`subtreeHitCounts`), ohne Filter als `pageTotal`.
- Einrückung: `sidebar.html` bindet `--depth` an jedes `.tree-chapter`; [tree-history.css](../public/css/page/tree-history.css) rückt um `(depth − 1) × --tree-indent-step` ein, eine Stufe = die Einrückung der Abschnitte eines Kapitels (`.tree-chapter-pages`). Ein Unterkapitel-Kopf steht so auf der Höhe der Abschnitte seines Elternkapitels, seine Abschnitte und die dritte Ebene je eine Stufe tiefer; die Klassen `.tree-chapter--depth-2/3` tragen nur Abstände und die abgestufte Schrift.
- **Struktur-Sync über Tabs/Geräte**: `/changes` meldet `structure_at`; weicht er vom Stand des Baums ab (`_structureDrifted`), zieht der leise Nachzug den Baum nach ([tree/catchup.js](../public/js/book/tree/catchup.js)) — Aufklapp-Zustand und offene Seite bleiben. Eigene Struktur-Writes melden sich über `EVT.STRUCTURE_WRITTEN` ([repo/content.js](../public/js/repo/content.js)); je gemeldetem Stand höchstens ein Nachzug.
- **Unterkapitel anlegen** im Kontextmenü eines Kapitels bis Tiefe 2 (`pagetreeCtxNewSubchapter` → `createChapter({ parentChapterId })`): letztes Kind, Eltern-Kette aufgeklappt.
- **Aufklapp-Zustand und Rendern** ([tree/open-state.js](../public/js/book/tree/open-state.js)): pro (User, Buch) in `localStorage`. Ohne gespeicherten Zustand starten Kapitel offen, ab `TREE_COLLAPSE_MIN_PAGES` (200) Abschnitten im Buch zugeklappt ([tree/build.js](../public/js/book/tree/build.js)); das Kapitel der geöffneten Seite deckt `_revealPageInTree` auf. Abschnittszeilen zugeklappter Kapitel werden **nicht gerendert** (`_chapterPagesShown` leert die `x-for`-Quelle, nicht nur `x-show`), und im Kalendermodus (Tagebuch) gibt es den Baum gar nicht (`x-if`). Wer Zeilen im DOM sucht, findet also nur sichtbare. **Why:** ein Tagebuch mit 2500 Abschnitten baute sonst beim Öffnen ~45 000 versteckte Knoten mit ~500 MB Heap und 2,5 s Main-Thread-Blockade auf.
- Sub-Chapter-Stats: `_refreshChapterStats` aggregiert rekursiv pro Subtree (children-Map via `parent_id`), inkl. Chapter-Name-Beitrag.
- **Ein-Abschnitt-Kapitel als eine Zeile** ([tree/stats.js](../public/js/book/tree/stats.js)#`_isSingleSectionChapter`: genau ein Abschnitt, keine Sub-Kapitel; bei aktiver Suche zählt `pageTotal`, nicht die gefilterte Trefferliste): kein Kapitelkopf, die Abschnittszeile trägt Kapitelname, Kapitel-Plaketten (Ideen, Recherche, Ausgeschlossen) und — bei abweichendem Abschnittsnamen — diesen als Untertitel. Ein Klick öffnet den Abschnitt. Tastatur-Baum: die Zeile steht auf der Ebene des Kapitels (`aria-level`, `data-tree-parent` = Parent-Kapitel). Das Kontextmenü vereint Abschnitts- und Kapitel-Einträge (`target.single` + `chapterId`; Umbenennen/Teilen/Exportieren/Neuer Abschnitt/Ausschliessen wirken aufs Kapitel, Löschen auf den Abschnitt). **Why:** Romane aus einem Abschnitt pro Kapitel zeigten jedes Kapitel doppelt und brauchten zwei Klicks bis zum Text.
- **Namens-Zwilling:** Hat ein Kapitel genau einen Abschnitt, der gleich heisst (`sameStructureTitle`, [public/js/structure-title.js](../public/js/structure-title.js) — Browser-Zwilling von [lib/export-builders/shared.js](../lib/export-builders/shared.js), gegated in [tests/unit/structure-title.test.mjs](../tests/unit/structure-title.test.mjs)), zieht Umbenennen in Sidebar/Editorkopf den anderen Namen mit (`renameChapterById` ↔ `renamePageById`). Sonst liefen die Namen auseinander, und Export, Bucheditor und Share-Reader zeigten ab dann zwei Überschriften. Der Buchorganizer zeigt beide Namen explizit und benennt nicht mit.
- **Neues Kapitel mit erstem Abschnitt:** besteht jedes Blatt-Kapitel mit Text aus genau einem Abschnitt (`_bookUsesSingleSectionChapters`), legt `createChapter` den gleichnamigen ersten Abschnitt gleich mit an und öffnet ihn (`_createFirstSection` in [tree-context-menu.js](../public/js/book/tree-context-menu.js)). Bücher mit Mehr-Abschnitt-Kapiteln bekommen weiterhin ein leeres Kapitel.
- **Kapitelbewertung** ist für jedes Buch mit mindestens einem Kapitel mit Text verfügbar (`_bookQualifiesForChapterReview` in [kapitel-review.js](../public/js/book/kapitel-review.js): ein Abschnitt mit Text — oder noch unbekanntem Umfang — in irgendeinem Kapitel; ein Teil aus lauter leeren Unterkapiteln zählt nicht), auch wenn alle Kapitel aus einem Abschnitt bestehen — Bewertung und Abschnitts-Lektorat sind verschiedene Linsen. Erreichbar über Kapitelkopf, Kontextmenü „Kapitel bewerten", Palette und Kapitel-Verweise.

## Kapitel-Review

[routes/jobs/kapitel.js](../routes/jobs/kapitel.js):

- POST-Body: `include_subchapters: boolean`.
- Bei `true`: `getDescendantChapterIds(chapterIdInt, { includeSelf: true })` → Set aller relevanten Kapitel-IDs → Pages-Filter via `chapterIds.has(p.chapter_id)`.
- Cache-Key (`pagesSig`) enthält `chaptersSig` (sortierte ID-Liste) + `optionsSig` (mit `includeSubchapters`-Flag). Cache-Miss bei:
  - Sub-Kapitel-Drift (neues Sub-Kapitel, verschoben, gelöscht)
  - Mode-Switch (User toggelt Checkbox)
  - Direkter Page-Change
- `CACHE_REV` im `optionsSig` zählt hoch, wenn sich Prompt-Aufbau oder Ergebnis-Form des Jobs ändern — der Wortlaut der Prompt-Builder fliesst nicht in `PROMPTS_VERSION`.
- Lädt eine Seite nicht, bricht der Lauf ab: eine Bewertung über ein lückenhaftes Kapitel landete sonst unter der Signatur des vollständigen im Cache.
- Das Ergebnis trägt `includeSubchapters` und `pageCount` (Seiten mit Text). Ein Cache-Treffer schreibt nur dann einen Verlaufseintrag, wenn er sich vom jüngsten unterscheidet ([db/chapter-reviews.js](../db/chapter-reviews.js)).
- Dedup pro Kapitel: läuft schon ein Lauf mit anderem Umfang, antwortet der POST `409 CHAPTER_REVIEW_OTHER_SCOPE_RUNNING` statt den fremden Lauf zurückzugeben.
- Position im Prompt („Kapitel X von Y", Vorgänger/Nachfolger) zählt alle Kapitel des Baums depth-first, Sub-Kapitel und leere eingeschlossen — dieselbe Zählung wie die Positions-Kachel der Karte (`kdPosition`). Bei `true` ist der Nachfolger das erste Kapitel hinter dem Teilbaum.
- Multi-Pass: die Teil-Analysen bekommen `teil: { nr, von }`, damit das Modell den Schnitt nicht als fehlenden Anfang/Schluss wertet. Die Teile schneidet `splitGroupsIntoChunks` an Abschnittsgrenzen; ein einzelner Abschnitt über `perChunk` wird an Absatz-/Satzgrenzen in Teile mit gleichem Titel zerlegt (Regeln: [komplett.md](komplett.md#single-pass-vs-multi-pass)) — so bleibt auch ein Kapitel aus einem einzigen langen Abschnitt auf Providern mit kleinem Kontextfenster bewertbar.

Frontend [public/js/cards/kapitel-review-card.js](../public/js/cards/kapitel-review-card.js):

- `_includeSubchaptersByChapter`-Map mit Auto-Default: `true` wenn `kapitelReviewHasSubchapters(chapterId)`.
- UI-Toggle ([public/partials/kapitelreview.html](../public/partials/kapitelreview.html)) erscheint nur wenn Kapitel Sub-Kapitel hat. Liegt im gewählten Umfang keine Seite, ist der Bewerten-Knopf gesperrt.
- Helper `_kapitelReviewDescendantIds` traversiert root.tree-parent_id-Kette (Frontend-Mirror der CTE); Kennzahlen und „Zuletzt bearbeitet" folgen demselben Umfang.
- Die aktuelle Bewertung ist der jüngste Verlaufseintrag (`kapitelReviewLatest`) und steht auch nach Reload oben; der Verlauf darunter listet nur die älteren. Läufe tragen ein Umfangs-Kennzeichen, die Notenänderung vergleicht nur Läufe mit gleichem Umfang und Modell.

## PDF-Export

[lib/pdf-export-defaults.js](../lib/pdf-export-defaults.js):

- **`chapter.numberingMode: 'nested' | 'flat'`** — Default `'nested'` (1, 1.1, 1.1.1). `'flat'` zählt durchlaufend (1, 2, 3).
- **`chapter.breakBeforeSubchapter: boolean`** — Default `true`. Sub-Kapitel beginnen wie Top-Kapitel auf einer neuen Seite; `false` laesst sie inline. **Why Default `true`:** die ERSTE Seite eines Sub-Kapitels folgt seiner Ueberschrift — inline stuende sie unter dem Text der vorigen Seite, und die Zusage „jede Seite beginnt neu" (`pageBreakBetweenPages`) waere in einer Hierarchie gebrochen.
- **`toc.depth: [1, 2, 3]`** — zaehlt **Kapitelebenen**, nicht Einrueckungsstufen.
- **`toc.includePages: boolean`** — Default `true`, eigene Achse fuer die **Seiten**-Eintraege. **Why getrennt:** eine Seite in einem Sub-Sub-Kapitel liegt auf Einrueckungsebene 4 und faellt sonst durch jede erlaubte Kapiteltiefe. Praedikat als SSoT: `tocEntryVisible` in [lib/pdf-render/pages.js](../lib/pdf-render/pages.js); eine Seite ist zusaetzlich an die Sichtbarkeit **ihres** Kapitels gebunden.
- **`font.heading.sizes.h1`..`h6`** — EINE absteigende Kette: `h1`–`h3` Kapitelebenen, `h4` **Seitentitel**, `h5`/`h6` die Ueberschriften, die der **Autor im Seitentext** setzt. Die Reihenfolge muss absteigend bleiben (`h1 > h2 > h3 > h4 > h5 > h6 >= body`), gegated in [tests/unit/pdf-export-defaults.test.js](../tests/unit/pdf-export-defaults.test.js).
- **Autoren-Ueberschriften sind kontextabhaengig skaliert** (`subHeadings` in [lib/pdf-render/blocks.js](../lib/pdf-render/blocks.js), pro Item gesetzt in [body.js](../lib/pdf-render/body.js)): mit gezeichnetem Seitentitel → h5/h6; ohne (flatten, kapitellose Seite) → h1/h2/h3, weil sie dann die oberste Marke im Fluss sind. Word-Pendant: Heading 5/6 statt 2/3 — dort zusaetzlich noetig, weil Heading 2/3 im `\o "1-4"`-Bereich des TOC-Felds liegen und im Verzeichnis ueber ihrer eigenen Seite stuenden.

[lib/pdf-render/layout.js](../lib/pdf-render/layout.js#_chapterLabelNested): Roman/Word-Numbering nur für Top-Level; Sub-Ebenen sind immer arabisch (Lesbarkeit). Beispiel `nested`+`roman`: `IV.2.1`.

**Ein Kapitel ist sein ganzer Teilbaum.** [lib/load-contents.js](../lib/load-contents.js)#`_groupByChapter` setzt vor die erste Gruppe eines Unterkapitels für jeden Vorfahren ohne eigenen Abschnitt eine reine Überschriften-Gruppe `{ chapterId, chapter, pages: [] }` (z. B. «Teil I», dessen Text erst in «Kapitel 1» steht); der Fassungs-Adapter [lib/snapshot-export.js](../lib/snapshot-export.js) tut dasselbe. Dadurch trägt jeder Ausgabeweg die Überschrift, die Tiefe der Unterkapitel folgt der vollen Elternkette, Nummern laufen verschachtelt (`1` → `1.1`), `unnumberedChapterIds`/`skipPageCounterChapterIds` des Vorfahren vererben sich, und Querverweise auf ihn sind auflösbar. Jeder Builder rendert für eine solche Gruppe nur die Überschrift (PDF: Kapitelblock ohne Items, Keep-with-next nimmt den Platz für den Folgetitel mit; EPUB: eigene Datei mit Überschrift, Top-Kapitel öffnet in der NavMap den Ast seiner Unterkapitel). Kapitel, deren ganzer Teilbaum keinen Text hat, bleiben weg. Kapitel-Scope (`includeSubchapters`, Default `true`; Schnell-Export `/export/chapter/…` immer mit Teilbaum): Menge aus `chapterScopeIds` — Kapitel + Nachfahren, ausgeschlossene Unterkapitel samt ihren Nachfahren raus, die gewählte Wurzel bleibt; Vorfahren oberhalb der Wurzel erscheinen nicht, die exportierte Einheit beginnt auf Ebene 1.

[lib/pdf-render/coalesce.js](../lib/pdf-render/coalesce.js): jedes Block-Element trägt `depth`, berechnet via `_depthByChapterId` aus `parent_chapter_id`-Kette. Bei `pageStructure: 'nested'` (Default) wird **jede** Seite ein eigenes Item mit `heading` — kein `pages.length > 1`-Vorbehalt, sonst fiele genau das einseitige Sub-Kapitel aus der Gliederung. Traegt die erste Seite den Namen ihres Kapitels, entfaellt ihre Ueberschrift (`sameStructureTitle`, SSoT mit dem Word-Export).

[lib/pdf-render/index.js](../lib/pdf-render/index.js):

- **TOC-Plan**: `tocCounters[3]`; bei depth d → `counters[d-1]++`, tiefere reset; Label via `_chapterLabelNested`; TOC-Level = `depth - 1`. Seiten-Eintraege kommen mit `isPage: true` + `parentLevel` dazu (Level = `depth`).
- **Body-Loop** ([lib/pdf-render/body.js](../lib/pdf-render/body.js)): depth → Heading-Größe (h1/h2/h3), Align (depth=1 nach `titleStyle`, tiefer nach `subTitleAlign`), `spaceBeforeMm`-Faktor (1.0 / 0.4 / 0.2), Break-Verhalten (depth>1 nur bei `breakBeforeSubchapter`), DropCap nur depth=1, Linie depth=1 bei `titleRule`/`left-rule`, tiefer bei `subTitleRule`. Seitentitel = h4, `pageTitleAlign`, `pageTitleRule`. Linienart und Kapitelnummer: [publikation-export.md](publikation-export.md#überschriften-gestaltung-pdf--epub). PDF-Lesezeichen sind ein echter Baum (`outlineStack`: Kapitel der Tiefe d haengt an `stack[d-1]`, die Seite an `stack[depth]`) — die Leiste spiegelt damit dieselbe Gliederung wie das Verzeichnis.

## Andere Export-Builder

[lib/export-builders/shared.js](../lib/export-builders/shared.js) exportiert `chapterDepth(chapter, byId, max=3)` + `buildChaptersById(groups)` + `isDescendantChapter` als gemeinsame Helper. `buildChaptersById` ist vollständig, weil die Überschriften-Gruppen (siehe [PDF-Export](#pdf-export)) jeden Vorfahren in `groups` bringen.

- **HTML/MD**: Kapitel-Heading via depth+1 (Top = h2 / `##`, depth 2 = h3 / `###`, depth 3 = h4 / `####`); Page-Heading eine Stufe tiefer, gecapped bei 6.
- **DOCX** ([lib/export-builders/docx.js](../lib/export-builders/docx.js)): depth → Word-Heading 1..3, **Seitentitel auf Heading 4** (`PAGE_HEADING_LEVEL`); Umbruch vor Kapiteln via `chapter.pageBreakBefore` (+ `breakBeforeSubchapter` fuer depth>1) und vor Seiten via `chapter.pageBreakBetweenPages` — immer am Ueberschriften-Absatz selbst, nie als vorangestellter Leerabsatz. `toc.includePages` wie im PDF; das Word-TOC-**Feld** kann nur einen zusammenhaengenden `\o "1-N"`-Bereich, exakt schneiden kann nur `mode: 'static'`.
- **EPUB**: NavMap-NCX hat 2 Ebenen — depth-1 wird auf `__level: min(1, depth-1)` gemapped (Sub-Sub-Kapitel kollabiert in Outline auf Level 1, Content vollständig erhalten); ein Top-Kapitel, dem ein Unterkapitel folgt, ist Ast (`__hasChildren`). Die Überschrift im Inhalt folgt dagegen der echten Tiefe: h1/h2/h3.
- **TXT**: unverändert (Plain-Text ohne Heading-Markup).

## Andere `chapter_id`-Konsumenten

Alle referenzieren das **direkt** enclosing Kapitel (`pages.chapter_id`). Sub-Kapitel sind selbst Kapitel — Konsumenten funktionieren transparent ohne Code-Änderung:

- `figure_appearances`, `location_chapters`, `song_chapters`, `figure_events`, `figure_scenes`
- `continuity_issue_chapters`, `zeitstrahl_event_chapters`
- `ideen` (XOR mit `page_id`)
- `page_checks`, `chapter_reviews`, `chapter_extract_cache`, `chapter_macro_review_cache`
- FTS5 `search_index` — Kapitel-Entities (Name + Description) werden mit eigener `entity_id` indexiert, durchsuchbar
- Komplettanalyse Phase 3b (kapitelübergreifende Beziehungen) — iteriert alle Kapitel, Sub-Kapitel automatisch enthalten
- Finetune-Export — sample-generation behandelt Sub-Kapitel wie reguläre Kapitel

Falls eine Aggregation auf **Top-Level-Kapitel rollupen** soll (z.B. „Häufigkeit pro Hauptteil"), via `getDescendantChapterIds` + SUM. Aktuell nicht im UI exponiert.

## Kapitel und Abschnitte per ID, nie per Name

Kapitelnamen sind **nicht eindeutig**: gleichnamige Unterkapitel («Einleitung» in Teil I und Teil II) sind zwei Kapitel, gleichnamige Abschnitte zwei Abschnitte, und ein Abschnitt darf wie ein Kapitel heissen («Der Vater» als Abschnitt im Kapitel «Der Unauffällige»). Wer über den Namen filtert, gruppiert oder zurückübersetzt, legt Verschiedenes zusammen oder rät. Darum gilt überall: **der Bezug ist die ID, der Name nur das Label.** **Why:** die Kontinuitäts-Karte bot als Kapitel-Filter nur ein Kapitel an, dessen Name zufällig einem Abschnitt glich — die Befunde der übrigen Kapitel waren nicht filterbar, und die zwei angebotenen gehörten in Wahrheit in ein anderes Kapitel.

**Frontend — Katalog-Filter** (Figuren inkl. Graph und Präsenz, Schauplätze, Szenen, Ereignisse, Musik, Weltfakten, Kontinuität, Plot):

- Filterfelder heissen `kapitelId` / `seiteId` (bzw. `…KapitelId`) und halten die ID. Optionen sind `{ value: id, label }` aus `$app._kapitelOptionen(ids)` / `$app._seitenOptionen(ids)` ([app-ui.js](../public/js/app/app-ui.js)) — Buchreihenfolge über `_chapterIdOrderMap`, Label über `_chapterLabelMap` (beide in [tree/build.js](../public/js/book/tree/build.js)#`_rebuildTreeOrderMaps`). Gleichnamige Kapitel bekommen das Elternkapitel davor («Teil II › Einleitung», [chapter-filter.js](../public/js/chapter-filter.js)#`buildKapitelLabels`).
- Jeder Eintrag trägt seine IDs: `kapitel[].chapter_id` (Figuren, Orte, Songs), `chapter_ids`/`page_ids` (Ereignisse, Weltfakten via `listWorldFacts({ withChapterIds })`, Kontinuität), `seiten[].chapter_id/page_id` (Figuren), `chapter_id`/`page_id` (Szenen, Beats; Beats erben die des Strangs). Fehlt eine ID, fehlt sie im Server-Payload — nachliefern, nicht über den Namen auflösen.
- **Wirksam ist nur ein angebotener Wert:** jeder Filter läuft durch `activeFilterId(value, options)`. Ein gespeicherter Wert, den die Optionen nicht (mehr) anbieten — Kapitel gelöscht, Katalog neu analysiert, altes Namensformat aus dem localStorage —, filtert nicht. Ohne diese Regel zeigt die Combobox «Alle Kapitel», während die Liste leer bleibt.
- Einsprünge setzen IDs: `openFigurMitKapitel(figId, chapterId)`, `openOrtMitKapitel`, `openEreignisseMitKapitel`, Kapitel-Referenz im Figur-Detail, Präsenz-Zellen (`openChapterById`).
- **Kontinuität:** das Kapitel eines Befunds kommt aus seinen verankerten Abschnitten (`page_a_id`/`page_b_id` → Kapitel des Abschnitts). Sind alle vorhandenen Stellen verankert, zählen nur die Anker; sonst kommen `chapter_ids` bzw. ein **eindeutiger** KI-Kapitelname dazu. Server ([db/continuity.js](../db/continuity.js)#`_resolveRefs`) und Karte ([kontinuitaet.js](../public/js/book/kontinuitaet.js)#`_kontinuitaetChapterResolver`) folgen derselben Regel.

**Server — KI-Namen auflösen:**

- Name → `chapter_id` nur über [write-helpers.js](../db/write-helpers.js)#`chapterNameMap` (bzw. `chapterIdsByName`): ein Name, den zwei Kapitel tragen, **fehlt** in der Map. Ein Eintrag ohne Kapitel ist sichtbar unzugeordnet, ein geratenes Kapitel still falsch.
- Der Komplett-Loader ([loader.js](../routes/jobs/shared/loader.js)#`loadOrderedBookContents`) zeigt der KI Kapitelpfade («Teil › Kapitel»), die buchweit eindeutig sind: gleichnamige Geschwister bekommen ab dem zweiten eine Ordnungszahl («Einleitung (2)»). `chNameToId` löst jeden Pfad auf, den Rohnamen nur, wenn er eindeutig ist. Bücher ohne Namensdoppel sehen unveränderte Pfade (Prompt-Cache bleibt).

Gegated durch [tests/unit/chapter-filter-ids.test.mjs](../tests/unit/chapter-filter-ids.test.mjs) (jede `catalogFilter('chapter'|'page')`-Combobox bindet ein `…Id`-Feld, kein Filter-Scope führt `kapitel`/`seite`, keine eigene Name→ID-Map über `chapter_name`), dazu [chapter-name-map.test.js](../tests/unit/chapter-name-map.test.js) und je Karte ein Fall mit gleichnamigen Kapiteln.

## Folder-Import nutzt Hierarchie

[routes/jobs/folder-import.js](../routes/jobs/folder-import.js) erzeugt Jahr-Kapitel (top-level) + Monat-Sub-Kapitel (`parent_chapter_id = Jahr-ID`). Siehe [docs/folder-import.md](folder-import.md).

## Pflicht-Invarianten

1. **PUT auf `/content/books/:id/order`** ist einzige Stelle, die die Gliederung umbaut (`chapters.parent_chapter_id`, `pages.chapter_id`, beide `position`). CRUD-Routen (`POST /chapters`) akzeptieren `parent_chapter_id` nur beim Anlegen; Re-Parent läuft ausschliesslich über order_json. `PUT /content/pages/:id` und `PUT /content/chapters/:id` verwerfen `chapter_id`/`position` (die Facade streicht sie in `savePage`/`updateChapter`) — ein Spalten-Write am Tree vorbei liesse order_json und Spalten auseinanderlaufen. Einzige weitere Schreiber: `deleteChapter` (Kinder an Ort und Stelle), `splitPage`, `movePage` (Buchwechsel), Importe/Restore — alle über `putOrder`/`ensureTree`. Ein neues Kapitel landet per reconcile am Ende seines Parents — `position` im POST-Body wirkt auf die Lese-Reihenfolge nicht, sobald eine order_json-Row existiert. Wer an einer bestimmten Stelle einfügen will, schickt `after_chapter_id`: die Facade ([lib/content-store/index.js](../lib/content-store/index.js)#`createChapter`) übernimmt den Parent des Ankers und hängt das Kapitel in order_json direkt dahinter (Konsumenten: Sidebar-Kontextmenü, Kapitelbewertung).
2. **`MAX_CHAPTER_DEPTH = 3`** ist gespiegelte Konstante. Bei Bumpen: beide Stellen ändern + PDF-Renderer (h1/h2/h3-Mapping) erweitern + Frontend-Indent-CSS-Stufen ergänzen.
3. **`chapters.position`** ist depth-first global lückenlos. Wer sortiert nach `position` über `listChapters`, bekommt depth-first Tree-Reihenfolge automatisch.
4. **`pages.position`** ist per-Bucket lückenlos. Buchweite Lesereihenfolge nur über `globalPageOrderSql()` (Kapitel-Position, dann Abschnitts-Position) — korrekt, weil der Tree kanonisch ist. SSoT bleibt order_json.
5. **`mapChapter` muss `parent_chapter_id` exposeen** — alle Export-Builder + PDF-Renderer berechnen Tiefe daraus. Drop = stille Flach-Darstellung.
6. **DnD-Validierung** prüft Self-Cycle + Max-Depth bevor Drop akzeptiert wird (`onMove`). Server-Validator ist letzte Verteidigungslinie; UI-Validation gibt visuelles Feedback (Cursor + ggf. Drop-Verbot-Indicator).

## Tests

- [tests/integration/book-order.test.js](../tests/integration/book-order.test.js)
  - Validator: akzeptiert depth ≤ 3, wirft `MAX_DEPTH` bei 4
  - bookTree: `subchapters[]` nested-Output
  - `flattenTree`: depth-first Page-Liste + chapterName-Mapping
  - `getDescendantChapterIds`: rekursive CTE
  - Kanonische Reihenfolge (putOrder + Normalisierung eines alten Trees), SQL-Lesereihenfolge, `reconcile` ohne vierte Ebene, `createChapter` → `CHAPTER_MAX_DEPTH`, `deleteChapter` an Ort und Stelle, `savePage` ohne Struktur-Write, `OrderConflictError`, Strukturversion bei Umbenennen
- [tests/integration/book-structure-api.test.js](../tests/integration/book-structure-api.test.js)
  - `order_updated_at`/`structure_at`, `409 ORDER_CONFLICT`, `400 CHAPTER_MAX_DEPTH`, Chat-Filter = Teilbaum, Quellen-Fundstellen in Lesereihenfolge, Faktencheck-Kapitel per ID
- [tests/unit/chapter-subtree-export.test.mjs](../tests/unit/chapter-subtree-export.test.mjs)
  - Kapitel ohne eigenen Abschnitt: Überschriften-Gruppe (Live + Fassung), Tiefe 2/3, Nummern `1.1`/`1.1.1`, Vererbung `unnumbered`
  - Kapitel-Scope = Teilbaum (`chapterScopeIds`), Probeseiten, HTML/MD/DOCX/EPUB/PDF
- [tests/unit/pdf-export-defaults.test.js](../tests/unit/pdf-export-defaults.test.js)
  - `numberingMode` Default `nested`, akzeptiert `flat`, verwirft Bogus
  - `breakBeforeSubchapter` Default true, akzeptiert false
  - `toc.depth: 3` akzeptiert
