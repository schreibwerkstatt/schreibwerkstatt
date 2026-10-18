# Bucheditor

Eigenständiger Editor (kein Modus auf einer Einzelseite): rendert **alle Kapitel + Seiten eines Buchs in Lesereihenfolge** als durchgehenden Manuskript-Stream. Jede Seite ist ein separater `contenteditable`-Block mit eigenem Save-State. Klick aktiviert den Block, Verlassen flusht den Save. Schwesterdokus für die anderen beiden Editoren: [notebook-editor.md](notebook-editor.md) (Einzelseiten-Editor), [focus-editor.md](focus-editor.md) (Vollbild-Schreibmodus). Die drei Editoren sind unabhängige Features — bei Änderungswünschen muss der User immer nennen, welcher Editor gemeint ist (siehe Harte Regel in [CLAUDE.md](../CLAUDE.md)).

Code: [public/js/cards/book-editor-card.js](../public/js/cards/book-editor-card.js) (Alpine.data-Sub, Facade über [cards/book-editor/](../public/js/cards/book-editor/)), [public/partials/book-editor.html](../public/partials/book-editor.html), [public/css/editor/book/book-editor.css](../public/css/editor/book/book-editor.css). Server: [routes/book-editor.js](../routes/book-editor.js) (`/book-editor/:book_id/contents` — Server-Side-Aggregation, Batch-Loader; zweiter Konsument ist der Fassungen-Reader als Diff-Basis). Tests: siehe unten.

Trigger: Karten-Toggle aus Palette/Quick-Pills (`showBookEditorCard`, Feature-Key `bookEditor` in [feature-registry.js](../public/js/cards/feature-registry.js)). Cmd/Ctrl+F im sichtbaren Bucheditor öffnet die Find-Leiste **innerhalb** der Karte (Routing via `book-editor:open-find`-Event aus `editor-find-card`).

**Kommentar-Leiste:** Der Bucheditor zeigt verankerte Share-Link-Leser-Kommentare des ganzen Buchs als rechte Margin-Rail (dritte Layout-Spalte, `.book-editor-layout--comments`). Methoden in [public/js/editor/book-editor-comments.js](../public/js/editor/book-editor-comments.js) (in `bookEditorCard` gespreadet), Detail-Doku in [share-link.md](share-link.md#kommentar-leiste-im-bucheditor). Owner springt aus der „Geteilte Links"-Karte für Buch-/Kapitel-Shares hierher (`book-editor:goto-comment`).

## Abgrenzung gegen Notebook-Editor und Focus-Editor

| Eigenschaft | Bucheditor | Notebook-Editor | Focus-Editor |
|---|---|---|---|
| Scope | ganzes Buch (alle Pages sequenziell) | eine Seite | eine Seite (Modus auf Notebook) |
| State-Slot | Card-lokal (kein `editMode`) | `notebookState` ([app-state.js:113](../public/js/app/app-state.js#L113)) | `focusState` ([app-state.js:129](../public/js/app/app-state.js#L129)) |
| Aktivierung | Karten-Toggle (`showBookEditorCard`) | `startEdit()` (Edit-Button im Karten-Header) | `enterFocusMode()` (Hotkey Cmd+Shift+E) |
| Container | `[data-book-editor-page]` pro Block | `#editor-card .page-content-view--editing` | `.focus-editor.is-active .page-content-view--editing` |
| Body-Klasse | `.book-editor-page-body` | `.page-content-view` | `.focus-editor__content` |
| Paper-Tokens | `--color-book-editor-bg/-text` | `--color-page-view-bg/-text` | (eigene Paper-Tokens) |
| Save-Trigger | Block-Wechsel / Autosave / Cmd+S (Save-All) | Save-Button / Ctrl+S / Autosave | (vererbt Notebook-Save aus `focusMode ⇒ editMode`) |
| Concurrency | Save-Queue, eine Page parallel | eine Page | eine Page |
| Find/Replace | eigene Find-Bar (CSS Custom Highlight, Range-Replace) | — | — |
| Undo/Redo | eigener Verlauf **pro Seite** (`book-editor/history.js`) + Buttons im Kopf | eigener Verlauf pro Edit-Session | derselbe Verlauf wie Notebook |
| Toolbar / Bubble | nein | ja ([editorToolbarCard](../public/js/cards/editor-toolbar-card.js)) | nein (im Fokus deaktiviert) |
| Lektorat-Marks | nein (`stripLektoratMarks` entfernt sie defensiv) | ja (Findings im View, Apply via `saveCorrections`) | nein (im Fokus deaktiviert) |

**Keine Modus-Invariante** zwischen Bucheditor und den anderen — er kann nicht parallel zu Notebook/Focus offen sein (Exklusivität via `_closeOtherMainCards`, Eintrag in `EXCLUSIVE_CARDS` der feature-registry).

## Modul-Aufteilung

[book-editor-card.js](../public/js/cards/book-editor-card.js) ist die **Facade** (State, Lifecycle, Laden, Block-Interaktion) und spreadet die Fachteile:

| Modul | Inhalt |
|---|---|
| [book-editor/save.js](../public/js/cards/book-editor/save.js) | Save-Queue, `_saveBlock`, Save-All, Banner-Auflösung (Überschreiben/Übernehmen), `blockStatus`/`blockStatusLine` (+ pure `applySaveOutcome`) |
| [book-editor/conflict.js](../public/js/cards/book-editor/conflict.js) | Block-IDs (`_syncBlockIds`), Block-Level-Merge (`_mergeStaleBlock`, pure `planBlockMerge`) und Auflösungs-Modal ([book-editor-conflict.html](../public/partials/book-editor-conflict.html), Dialog-Inhalt geteilt: [conflict-blocks.html](../public/partials/conflict-blocks.html)) |
| [book-editor/find.js](../public/js/cards/book-editor/find.js) | Find/Replace über den Stream (Kern in [editor/shared/text-find.js](../public/js/editor/shared/text-find.js)) |
| [book-editor/outline.js](../public/js/cards/book-editor/outline.js) | Inhaltsverzeichnis + `IntersectionObserver` |
| [book-editor/history.js](../public/js/cards/book-editor/history.js) | Undo/Redo pro Seite über den geteilten Kern [editor/shared/edit-history.js](../public/js/editor/shared/edit-history.js); Buttons in [book-editor-history.html](../public/partials/book-editor-history.html) |
| [book-editor/head.js](../public/js/cards/book-editor/head.js) | Titel-Kopf je Beitrag (Dachzeile · Titel · Lead, nur publizistische Bücher): ein `GET /headline/:book_id` beim Laden, Speichern feldweise beim Verlassen über `PUT /headline/page/:id`; CSS [book-editor-head.css](../public/css/editor/book/book-editor-head.css) |
| [editor/book-editor-comments.js](../public/js/editor/book-editor-comments.js) | Kommentar-Leiste (Kern in `comment-rail-core/-layout`) |

Geteilt mit dem Notebook-Editor: [shared/text-find.js](../public/js/editor/shared/text-find.js) (Match-Suche + Highlight-Paar), [shared/autosave.js](../public/js/editor/shared/autosave.js) (`AUTOSAVE_IDLE_MS`/`AUTOSAVE_MAX_MS` + `createAutosaveTimers`), [shared/html-clean.js](../public/js/editor/shared/html-clean.js) (`stripLektoratMarks`), [shared/save-pipeline.js](../public/js/editor/shared/save-pipeline.js) (`isNoChange`), [shared/page-api.js](../public/js/editor/shared/page-api.js) (`savePage`).

## State (Card-lokal)

| Feld | Bedeutung |
|---|---|
| `blocks: Array` | Render-Liste, gebaut via `buildBlocksFromPages(pages)` aus Server-Response. `kind: 'chapter' \| 'page'`. Page-Block hält `html`/`originalHtml`/`originalUpdatedAt`/`dirty`/`saving`/`saveError`/`conflict`/`savedAt`/`_rev` |
| `activePageId` | Klick-aktivierter Block (nur dieser hat `contenteditable=true`) |
| `saveQueue: number[]` | FIFO, Concurrency 1 |
| `_queueRun` | Promise des laufenden Queue-Durchlaufs — Re-Entry-Guard **und** Await-Punkt für Save-All |
| `saveAllRunning` / `saveAllIds` | Save-All-Lauf + seine Page-IDs; `saveAllTotal`/`saveAllDone` sind daraus abgeleitete Getter |
| `dirtyCount` / `savingCount` | **Getter** über `blocks` (nicht handgepflegt) — Header-Badge und `beforeunload`-Schutz |
| `_autosave` / `_savedFlash` | `createAutosaveTimers` (Idle 60 s / Max 120 s pro pageId) bzw. `createTimerBag` (nullt `savedAt` nach 4 s) |
| `_loadToken` | Re-Entry-Guard: verwirft Responses überholter `_load`-Läufe |
| `_memos` | Memo-Cache (`_memo(key, deps, fn)`) für `outlineNodes` + Block-Index |
| `findOpen/Term/Replace/CaseSensitive/WholeWord/Matches/Index` | Find/Replace-State |
| `visiblePageId` / `collapsedChapters` / `outlineOpen` | Outline / TOC (Sticky-Sidebar) |
| `_outlineObserver` | `IntersectionObserver` für Active-Outline-Item |
| `_histories` / `_histTick` | Undo-Verläufe `Map<pageId, createEditHistory>` bzw. Reaktivitäts-Zähler für `bookEditorCanUndo/-Redo` (der Kern ist framework-frei). Verworfen bei `_load`, `_resetSession`, `destroy`; pro Seite bei „Server-Fassung übernehmen" |

Reset-Quelle: `sessionState()` ist **eine** Deklaration für Initial-State **und** `resetState` des Lifecycles ([card-lifecycle.js](../public/js/cards/card-lifecycle.js) akzeptiert dafür eine Factory) — `book:changed`/`view:reset` resetten den State und laden neu. Nicht im Reset: Präferenzen, die über den Buchwechsel gelten (`outlineOpen`, `findCaseSensitive`/`-WholeWord`, `bookEditorFullscreen`).

## Lifecycle

```
init ──setupCardLifecycle──▶ idle
       │
       └─ showBookEditorCard=true ──load(bookId)──▶ aktiv
                                                       │
                                                       ├─ activateBlock(p)  ── prev.dirty? → _enqueueSave(prev)
                                                       ├─ _onBlockInput     ── block.html = el.innerHTML; _markBlockDirty
                                                       ├─ Autosave Idle 60 s / Max 120 s ── _enqueueSave
                                                       ├─ Cmd/Ctrl+S        ── saveAllDirty
                                                       └─ Find/Replace       ── recompute → _doReplaceAt → dirty+queue
       book:changed / view:reset ──▶ reset → idle
       destroy ──▶ Timer/IO/Highlight-Cleanup
```

### Laden (`_load`)
0. `_loadToken` hochzählen. Buchwechsel und `showFlag`-Watch können beide laden; ohne Token gewinnt die langsamere Response und schreibt das Vorgänger-Buch in die Karte. Nach dem `await` (Erfolg **und** Fehlerpfad) gegen den Token prüfen und ggf. verwerfen.
1. `fetchJson('/book-editor/:book_id/contents')` — Server liefert alle Pages in Lesereihenfolge (Depth-First durch Kapitel-Hierarchie). Die Response trägt bewusst nur `pageId`/`pageName`/`pagePriority`/`chapterId`/`chapterName`/`html`/`updated_at` — jedes weitere Feld geht mal Seitenzahl über die Leitung.
2. `buildBlocksFromPages(pages)` produziert die Block-Liste mit Chapter-Markern an Kapitel-Grenzen. Die Struktur (Kapitel-Header + Seiten-Sequenz) kommt aus dem geteilten Stream-Modell [public/js/manuscript-stream.js](../public/js/manuscript-stream.js) (`fromPages`, geteilt mit Fassungen-Reader und Share-SSR); `buildBlocksFromPages` wrappt nur jeden Page-Entry mit dem Editor-State (dirty/saving/_rev/originalHtml). `stripFocusArtefacts` bleibt im Wrapper (browser-only).
3. `missing > 0` → Status-Toast (`bookEditor.missingPages`); Bucheditor bleibt lauffähig.
4. `$nextTick(_initOutlineObserver)` — IO an alle `.book-editor-page-card`-Targets.

### Klick-aktiviert-Block
- Default: alle Blöcke `contenteditable=false`. Klick speichert `_pendingMousedown` (Klick-Koordinaten + pageId), `activateBlock` setzt `activePageId` und im `$nextTick` Fokus + Caret (`_placeCaret` aus `caretRangeFromPoint`).
- **Caret-Fallback ist Pflicht:** trifft der Klick kein Textnode (Padding, Zeilenabstand, Rand) oder fehlt die API, setzt `_placeCaret` den Caret an den Anfang des ersten Kindblocks. Ohne ihn ist der Block fokussiert, aber jede Tastatureingabe verpufft — fehlerfrei und unsichtbar.
- Element-Lookups laufen über **`this.$root`**, nicht `this.$el`: in einer aus `@click` gerufenen Methode zeigt `$el` auf das auslösende Element (den Block-Body), nicht auf die Karten-Wurzel.
- Vorheriger aktiver Block wird vor dem Wechsel `_enqueueSave`'d, wenn dirty.
- **Nur mit Schreibrecht:** `activateBlock` und Replace greifen nur bei `app.canEdit()` (editor/owner, unbekannte Rolle = Legacy-Fallback). Lektor und Viewer lesen, suchen und kommentieren im Stream; die Ersetzen-Zeile der Find-Leiste ist ausgeblendet. Reine UX — der PUT prüft serverseitig `editor`.

### Render-Sync (`_mountBlockEl` / `_maybeRehydrate`)
- **`_mountBlockEl`** (x-init am Block-Container): einmaliger Initial-Write von `block.html` + `data-rev`.
- **`_maybeRehydrate`** (x-effect): schreibt `block.html` **nur dann** in den DOM, wenn `activePageId !== block.pageId` und sich `_rev` geändert hat. Schützt das Caret im aktiven Block vor externen Mutations-Rewrites (Find/Replace, Reload).
- Alle anderen `block.html`-Mutationen kommen aus `_onBlockInput` oder `_doReplaceAt`; sie inkrementieren `_rev` nicht (DOM ist bereits Quelle).

### Save-Queue (`_enqueueSave` → `_processQueue` → `_saveBlock`)

Code: [book-editor/save.js](../public/js/cards/book-editor/save.js).

- Pro Block: dirty/saving-Flags; Queue dedupliziert. `_processQueue()` liefert das Promise des laufenden Durchlaufs (`_queueRun`) — Re-Entry-Guard und Await-Punkt in einem.
- `_saveBlock`:
  1. Pending Autosave-Timer der Page clearen. **Offener Konflikt (`block.conflict`) → kein Save**: gespeichert wird erst nach einer Auflösung; ein Save daneben liefe in denselben Merge und setzte die Entscheidungen im Modal zurück.
  2. `_syncBlockIds(block)` — Block-IDs eindeutig und vollständig ([editor/shared/block-ids.js](../public/js/editor/shared/block-ids.js), dieselbe Regel wie im Notebook): Chromium klont `data-bid` beim Enter, zwei Absätze mit derselben ID verlöre der Merge still. Aktiver Block im Live-DOM (nur Attribute), inaktiver über einen losgelösten Container aus `block.html` (sein DOM trägt Diagramm-SVG und Badges).
  3. `stripLektoratMarks(html)` — der **geteilte** Save-Cleaner (Lektorat-/Chat-Marks, LanguageTool-UI, leere Trailing-Blöcke), identisch zum Notebook-/Focus-Pfad. Der Bucheditor rendert selbst keine Marks; der Cleaner ist defensiv gegen HTML aus History-/Chat-Apply.
  4. No-Change-Short-Circuit via `isNoChange(newHtml, originalHtml)` (Vergleichs-Normalform, nicht roher String-Vergleich) — dirty-Flag zurück, kein PUT.
  5. **Leer-Block-Schutz**: `htmlToText(newHtml).trim() === '' → bookEditor.emptyAbort`. Verhindert versehentliches Leerspeichern beim Verlassen.
  6. Pre-Conflict-Check: `checkPageConflict(pageId, originalUpdatedAt, { writer: 'book' })` aus [editor/shared/page-conflict.js](../public/js/editor/shared/page-conflict.js). Veralteter Stand → **Block-Merge** (unten).
  7. `savePage(pageId, { html, pageName, source: 'book', writer: 'book', expectedUpdatedAt })` aus [shared/page-api.js](../public/js/editor/shared/page-api.js); `snapshot = block.html` unmittelbar davor. Erfolg → `applySaveOutcome(block, { snapshot, savedHtml, savedUpdatedAt })`, `savedHtml` = Antwort des Servers (mit den dort vergebenen Block-IDs — der gemeinsame Vorfahr des nächsten Merges ist die Fassung, die ein anderes Gerät jetzt lädt).
  8. 409 PAGE_CONFLICT (Race nach Pre-Check) → Seite frisch lesen (`_loadRemoteForMerge`), **Block-Merge**, bei kollisionsfreiem Merge neuer PUT. Höchstens `MAX_MERGE_ROUNDS` Runden je Save, danach bleibt der Block dirty für den nächsten Autosave.
  - **Verlorene Save-Antwort ist kein Konflikt:** Pre-Check und PUT laufen mit dem Schreiber `book` ([repo/save-ids.js](../public/js/repo/save-ids.js)). Ging die Antwort eines gelandeten Saves verloren (Netzfehler → `saveError`, Basis-Stempel bleibt alt), erkennt `checkPageConflict(…, { writer: 'book' })` den Server-Stand an `last_save_id` als eigenen, und der Server nimmt den nächsten Save trotz altem Stempel an (`own_save_ids`). Beides nur, solange der Block noch auf der Basis steht, gegen die der verlorene Save ging (die Kennung trägt ihren Stempel). Ein fremder Write dazwischen setzt `last_save_id` neu bzw. auf `null` → Merge wie unten. Gegated: [tests/e2e-app/book-editor-lost-save-response.spec.js](../tests/e2e-app/book-editor-lost-save-response.spec.js).
  9. `app._syncPageStatsAfterSave?.(...)` — Page-Stats konsistent zum Notebook-/Focus-Save-Pfad (Frontend/Server-Parität, siehe Harte Regel „HTML→Text-Normalisierung" in CLAUDE.md).

### Block-Level-Merge bei Stale-Write ([book-editor/conflict.js](../public/js/cards/book-editor/conflict.js))

Dieselbe Regel wie im Notebook-Editor ([notebook-editor.md → Block-Level-Merge](notebook-editor.md#block-level-merge-bei-stale-write)), eigene Glue; Engine [editor/shared/block-merge.js](../public/js/editor/shared/block-merge.js), Flag `FEATURE_BLOCK_MERGE`. `base = block.originalHtml`, `local = block.html` (Live-Stand **nach** den Reads — der aktive Block bleibt während Pre-Check und PUT beschreibbar), `remote` = frischer Server-Stand. `planBlockMerge` (pure) liefert:

- **`clean`** → `_applyBlockHtml` schreibt den gemergten Stand in den Block (aktiv: DOM direkt, Caret bleibt in seinem Block über [shared/block-caret.js](../public/js/editor/shared/block-caret.js), neue Undo-Baseline — ein Undo dahinter nähme die Remote-Blöcke heraus; inaktiv: `_rev++` → Re-Hydrate), Basis = Server-Stand + Stempel, Block dirty, Toast `edit.conflict.merged.silent`; der Save läuft gegen den neuen Stempel weiter.
- **`collision`** → `block.conflict` (Banner, `mergeable: true`) + Auflösungs-Modal ([partials/book-editor-conflict.html](../public/partials/book-editor-conflict.html), per `@include` in die Karte, teleportiert in die Karten-Wurzel): je Stelle Meine/Andere/Beide, Bulk, Wort-Diff ([shared/conflict-diff.js](../public/js/editor/shared/conflict-diff.js), `x-text`), andere Version beim Urheber benannt (`conflictUiText` → [shared/conflict-text.js](../public/js/editor/shared/conflict-text.js)). Der Dialog-Inhalt ist mit dem Notebook-Modal geteilt ([partials/conflict-blocks.html](../public/partials/conflict-blocks.html)); die Karte liefert dafür eigenen State (`conflictResolution`) und die Schnittstelle `conflictUi*`. „Übernehmen" (`conflictUiSubmit`) → `buildResolvedHtml` wird der Block-Inhalt, Basis = Server-Stand, Save. **Abbrechen verwirft nichts**: Block und Banner bleiben, «Konflikt lösen …» (`reopenBookConflict`) liest frisch und mergt neu. Nur **ein** Modal: kollidiert beim Save-All ein zweiter Abschnitt, bekommt er nur das Banner.
- **`fallback`** (Flag aus, Basis ohne Block-IDs — Seite seit Einführung nie gespeichert) → Banner mit `resolveConflictOverwrite` (Remote-Stempel übernehmen, eigene Fassung speichern) und `resolveConflictTakeRemote`.
- `resolveConflictTakeRemote(block)` steht in jedem Banner (Remote-HTML übernehmen, dirty=false, `_rev++` → Re-Hydrate, offenes Modal der Seite zu). Ohne `remoteHtml` (409 und gescheiterter Read) liest sie die Seite frisch (`contentRepo.loadPage(id, { fresh: true })`), statt eine leere Seite zu übernehmen. Ist der Block aktiv, wird er vorher deaktiviert: `_maybeRehydrate` schreibt den aktiven Block nicht (Invariante 3), der User sähe sonst weiter die eigene Fassung und der nächste Tastendruck speicherte sie über die übernommene.

### Save-All (Cmd/Ctrl+S)
- Sammelt alle dirty Pages → in Queue → `await _processQueue()` (kein Polling).
- Fortschrittsanzeige: `saveAllDone / saveAllTotal`, beide abgeleitet aus `saveAllIds` + den Dirty-Flags.
- **Im Bucheditor löst Cmd/Ctrl+S keinen Einzel-Save aus** — Save-Trigger ist Block-Wechsel oder Autosave, Cmd/Ctrl+S ist explizit Save-All.

## Find/Replace (innerhalb der Karte)

- Trigger: Cmd/Ctrl+F → globales `editor-find-card` dispatcht `book-editor:open-find` → `openFind()`.
- Match-Pipeline:
  1. `_allBlockEls()` → alle `[data-book-editor-page]` (Lookup über `$root`, siehe „Klick-aktiviert-Block").
  2. Pro Block: `collectMatches(el, term, { caseSensitive, wholeWord })` aus [shared/text-find.js](../public/js/editor/shared/text-find.js) — `TreeWalker(SHOW_TEXT)` baut Node-Liste + concat-String, `indexOf`-Schleife sammelt Offsets, das Rückmapping liefert `{ startNode, startOffset, endNode, endOffset }`. Wortgrenze = `isWordChar` (Buchstaben/Ziffern inkl. `-`/`'`) plus `_`, **eine** Regel für Notebook- und Bucheditor.
  3. `findMatches` aggregiert über alle Blöcke und merkt sich pro Treffer `pageId` + `container`.
- Highlight: **CSS Custom Highlight API** über `createHighlightPair('book-editor-find-match', 'book-editor-find-current')`, kein DOM-Wrap. Browser ohne API → keine Highlights, Navigation bleibt funktional.
- Replace: `Range.deleteContents` + `createTextNode(replace)` + `range.insertNode`. Danach `block.html = cleanBlockHtml(container)`, dirty + autosave-schedule. Jeder Replace ist ein Undo-Schritt der betroffenen Seite (aktiv: Snapshot davor + danach; inaktiv: `_historyRecordInactive` aus `block.html`).
- Replace-All läuft rückwärts über die Match-Liste (sonst verschieben sich nachfolgende Offsets).
- Einzel-Replace prüft vorher `_matchStillValid` (Nodes noch im DOM, Range-Text = Suchbegriff). Hat der User seit der Suche im aktiven Block getippt, zeigen die gespeicherten Offsets auf anderen Text — dann wird neu gesucht und nicht ersetzt.

## Undo/Redo

Eigener Verlauf pro Seite, das native Browser-Undo wird **nie** bedient: `onBlockKeydown` fängt Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z und Ctrl+Y über `matchHistoryCommand` ab (`preventDefault`), `@beforeinput` leitet `historyUndo`/`historyRedo` aus Bearbeiten-Menü, Kontextmenü und iOS-Schütteln um. **Why:** Range-Replace landet nicht im Browser-Stack und entwertet ihn; Chromium/WebKit wenden ein überzähliges Strg+Z auf eine bereits verlassene Seite an, deren DOM Anzeige-Artefakte trägt; WebKit fasst lange Tipp-Strecken zu einem Schritt zusammen.

- Baseline bei der ersten Aktivierung einer Seite (`_historyOnActivate`, nach `clearRenderedDiagrams`/`clearCaptionNumbers`), bei späteren Aktivierungen ein Anschluss-Snapshot (Dedupe gegen die Spitze).
- Verlassen: `_historyOnDeactivate` löst den offenen 500-ms-Debounce ein, **bevor** `activePageId` wechselt.
- Tippen → `pushSoon` (in `_onBlockInput`); Paste/Cut → `pushNow` davor und danach.
- Restore mountet roh per `innerHTML` und dispatcht `input` → `_onBlockInput` setzt `block.html`, dirty, Autosave. Ein Undo ist eine normale Änderung und wird gespeichert. Danach Kommentar-Rail neu berechnen.
- Undo/Redo-Buttons und Tasten wirken nur auf die aktive Seite.

## Outline (Sticky-TOC)

- `outlineNodes` (memoized getter, deps `[blocks]`) gruppiert Pages nach Kapitel — Pages vor dem ersten Kapitel kommen in einen `solos`-Bucket. **Beide Knoten-Typen tragen dieselbe `pages`-Liste**, damit das Template einen einzigen Listen-Zweig hat (Solos haben `chapterId: null` und sind nie eingeklappt).
- `IntersectionObserver` mit `rootMargin: '-100px 0px -60% 0px'` + Threshold `[0]` markiert die Topmost-Page als `visiblePageId`. rAF-Throttle bündelt mehrere IO-Entries pro Scroll-Tick zu einem Update.
- `outlinePageStatus(block)` → `'saving' | 'error' | 'dirty' | 'saved' | ''`: leitet aus `blockStatus(block)` ab (faltet nur `conflict → error`), keine zweite Zustandsmaschine.
- Klapp-Marker ist das App-Pattern `.history-chevron` (Mask-Icon + `.open`-Rotation, siehe DESIGN.md), kein eigener Glyph/Pseudo-Chevron.
- `scrollToBlock(pageId)` — smooth-scroll aus Outline-Klick; setzt `visiblePageId` sofort optimistisch.
- `toggleChapterCollapse(chapterId)` — Map `collapsedChapters` togglet Sichtbarkeit der Pages unter einem Kapitel im Outline (Stream bleibt vollständig).
- `buildOutlineNodes(blocks)` ([book-editor/outline.js](../public/js/cards/book-editor/outline.js)) — Kapitel aus genau einem Abschnitt (`node.single`) erscheinen als **eine** Zeile (Kapitelname, Seiten-Optik mit Status-Punkt, Klick springt zum Abschnitt), ohne Kapitelzeile, Zähler und Collapse.
- Stream: heisst der erste Abschnitt eines Kapitels wie das Kapitel (`block.dupTitle`, `sameStructureTitle` aus [structure-title.js](../public/js/structure-title.js)), bleibt der Name in der Abschnitts-Caption leer — Status und Plaketten bleiben stehen.

## Pflicht-Invarianten

1. **Bucheditor ist **kein** Modus auf einer Seite.** `editMode`/`focusActive` werden **nie** vom Bucheditor gesetzt. Wer eine Cross-Editor-Funktion einbaut, prüft das per Feature-Flag explizit, statt am Modus-State zu hängen.
2. **`activeBlock` ist exklusiv.** Nur der Block mit `activePageId` ist `contenteditable=true`. Andere `contenteditable=false` — sonst Caret-Jumps + Multi-Block-Selections beim Drag.
3. **`_maybeRehydrate` darf nicht auf den aktiven Block schreiben.** DOM gehört dort dem User; ein Re-Render mit `block.html` würde Caret + Selektion killen.
4. **`_rev` nur bei externen Mutationen inkrementieren** (Conflict-Take-Remote, künftige Reload-Patches). Eigene Input-Events updaten `block.html`, aber **nicht** `_rev` — sonst Re-Hydrate-Schleife gegen den eigenen Tipp-Stream.
5. **`stripLektoratMarks` Pflicht vor jedem PUT** — der geteilte Save-Cleaner aus [shared/html-clean.js](../public/js/editor/shared/html-clean.js), keine editor-eigene Variante. Lektorat-/Chat-Marks und LanguageTool-UI haben im gespeicherten HTML nichts zu suchen; im Bucheditor ist der Cleaner defensiv (normalerweise no-op), aber eine schwächere Kopie driftet garantiert gegen den Notebook-Pfad.
6. **Pre-Conflict-Check mit `checkPageConflict` aus [editor/shared/page-conflict.js](../public/js/editor/shared/page-conflict.js)** — keine eigene Conflict-Logik. Stale-Write-Schutz ist app-weit eine Quelle. Die Pruefung liegt unter `shared/`, weil „hat jemand anderes seit meinem Snapshot geschrieben?" eine Eigenschaft der SEITE ist, nicht eines Editors; sie **nicht** wieder ueber die Root-Trampoline aus der Notebook-Karte holen — dann haenge der Stale-Schutz des Bucheditors daran, dass eine fremde Karte gemountet ist. Denselben Weg geht der Konflikt-Wortlaut (Geraet vs. User): [editor/shared/conflict-text.js](../public/js/editor/shared/conflict-text.js), Varianten `bookHint`/`bookBanner`/`bookStatus`. Ebenso der Merge: Engine, Block-IDs, Caret-Erhalt und Diff-Ansicht kommen aus `editor/shared/` (block-merge, block-ids, block-caret, conflict-diff); nur die Glue (welcher Block, welches Modal) liegt in [book-editor/conflict.js](../public/js/cards/book-editor/conflict.js).
7. **`htmlToText(...).trim() === ''` blockt den Save.** Leer-Block beim Verlassen darf die Seite nicht löschen; User sieht `bookEditor.emptyAbort`, Dirty-Flag bleibt.
8. **Save-Queue ist sequenziell.** Concurrency > 1 würde gegen das Stale-Schutz-Modell (`checkPageConflict` pro Save) laufen — der zweite Save weiss nicht, dass der erste das `updated_at` schon bewegt hat.
9. **Dirty-Flag überlebt den laufenden Save.** `applySaveOutcome` setzt `dirty` nur zurück, wenn `block.html` noch dem Snapshot vom Save-Start entspricht. Wer während des PUT weitertippt, würde sonst sein Dirty-Flag verlieren: der nachlaufende Autosave prallt an `_enqueueSave`s `!block.dirty` ab, der Block-Wechsel speichert ebenfalls nicht — die Zeichen sind still weg.
10. **`dirtyCount`/`savingCount` sind abgeleitete Getter**, keine handgepflegten Zähler. Inkrement/Dekrement über sechs Pfade driftet; `Math.max(0, …)`-Pflaster sind das Symptom, nicht die Lösung.
11. **`beforeunload`-Schutz nur bei `dirtyCount > 0 || savingCount > 0`.** Sonst Browser-Spam.
12. **Eigene Body-Tokens** (`--color-book-editor-bg/-text`) — kein Reuse der Notebook-Tokens (`--color-page-view-bg/-text`). Visuell entkoppelt vom Tagebuch-Sheet.
13. **Body-Styling ist eigenständig** — kein `--notebook-line`-Liniengitter, kein `repeating-linear-gradient` mit `--color-notebook-rule`. Bucheditor ist Manuskript-Stream, nicht Notebook-Sheet.
14. **Cross-Karten-Aufrufer respektieren** `window.__app` — der Bucheditor liest `app._syncPageStatsAfterSave`/`app.t`/`app.setStatus`. Diese Methoden gehören dem Root. Keine eigenen Duplikate. Was editor-agnostisch ist (Konflikt-Pruefung, Konflikt-Wortlaut, Autosave-Timing), wird dagegen aus `editor/shared/` **importiert** statt am Root abgegriffen.
15. **DOM-Lookups über `$root`, nie `$el`.** In einer aus einem Template-Handler gerufenen Methode ist `$el` das auslösende Element — ein Lookup findet dann nichts, ohne einen Fehler zu werfen (Block bekommt keinen Fokus, Find findet keine Blöcke).
16. **Undo-Snapshots nur vom aktiven Block oder aus `block.html`.** `getRoot` des Verlaufs liefert für inaktive Seiten `null`; nur `_historyRecordInactive` legt kurz einen losgelösten Container aus `block.html` vor. Inaktive Blöcke tragen Anzeige-Artefakte (Mermaid-SVG, Nummern-Badges), die ein Restore sonst ins Manuskript trüge. Aus demselben Grund übernimmt `_onBlockInput` nur Events des aktiven Blocks.
17. **Der Titel-Kopf steht ausserhalb von `.book-editor-page-body`** und trägt weder `data-book-editor-page` noch `data-bid`. Er ist Metadata (`page_headline`), kein Text: im Body landete er in `block.html`, im Dirty-Vergleich, im Undo-Verlauf und in Find/Replace — und über den Seiten-Save in `pages.content`, wo er als Prosa zählte. Sein Speicherweg bewegt `pages.updated_at` nicht, Save-Queue und Konflikt-Schutz sehen ihn nicht. Leere Felder stehen nur am aktiven Beitrag.

## Erweitern (Checkliste)

Neue Aktion / neuer Block-Typ / neuer Find-Modus:
1. Aktion am Block-Header (Save/Conflict-Buttons) → in [public/partials/book-editor.html](../public/partials/book-editor.html); Handler ins passende Submodul (Save-nah → [book-editor/save.js](../public/js/cards/book-editor/save.js)), sonst in die Facade. Keine Toolbar-Bubble — die gehört zum Notebook-Editor.
2. Neuer Block-Typ (z.B. Trennlinie zwischen Büchern): `buildBlocksFromPages` ergänzen + Unit-Test in [book-editor-blocks.test.mjs](../tests/unit/book-editor-blocks.test.mjs).
3. Find-Modus (Regex, Akzent-Faltung): `collectMatches` in [shared/text-find.js](../public/js/editor/shared/text-find.js) erweitern — **das trifft beide Editoren**, Notebook-Finder mitdenken und [text-find.test.mjs](../tests/unit/text-find.test.mjs) ergänzen. Highlight bleibt über `_refreshFindHighlights`.
4. Save-Pfad anfassen: Pflicht `stripLektoratMarks` + `isNoChange` + `checkPageConflict` (shared/page-conflict) + `savePage` (shared/page-api). Niemals direkt `fetch('/content/pages/...')`.
5. Neuer Block-Zustand: **nur** `blockStatus` erweitern — `blockStatusLine`, die CSS-Klasse am Block und `outlinePageStatus` hängen daran. Keine parallele Ableitung aufmachen.
6. CSS für neue Marker-Klasse: in [public/css/editor/book/book-editor.css](../public/css/editor/book/book-editor.css), Layer `components`. Karten-Akzent ist Sepia (`--card-accent`), Body-Tokens `--color-book-editor-bg/-text`.
7. CSS für **Inhalts**-Blöcke des Seiten-HTML (Listen, Checkbox-Listen, Bilder/Figuren, Tabellen, Trenner inkl. `hr.pagebreak`, Code, Gedichte, Callouts): **nicht** hier, sondern in der geteilten SSoT [public/css/components/manuscript-content.css](../public/css/components/manuscript-content.css). Der Bucheditor rendert dasselbe gespeicherte HTML wie Notebook-Leseansicht und Share-Reader — was nur hier landet, fehlt den beiden anderen. `book-editor.css` behält nur die Stream-Abweichungen (Überschriften-Gewicht/-Abstand, Zitat-Einzug, Absatzmodell).
7. CLAUDE.md „Vertiefende Dokus" zeigt auf diese Datei — bei strukturellen Änderungen (neuer Modus, neue Invariante) hier ergänzen.

## Tests

| Datei | Deckt ab |
|---|---|
| [tests/unit/book-editor-blocks.test.mjs](../tests/unit/book-editor-blocks.test.mjs) | `buildBlocksFromPages`: Chapter-Boundary-Marker, Solo-Pages vor erstem Kapitel, `originalHtml`/`originalUpdatedAt`-Initialisierung. Dazu `applySaveOutcome`: Dirty-Ausgang inkl. „während des Saves weitergetippt". `resolveConflictTakeRemote`: Frisch-Read im 409-Pfad, Deaktivierung des aktiven Blocks |
| [tests/unit/book-editor-merge.test.mjs](../tests/unit/book-editor-merge.test.mjs) | `planBlockMerge` (clean/collision/fallback) und die Block-Übergänge: still gemergt → Basis + Stempel = Server, Kollision → Modal-State, Auflösung „Beide“ → Save, ein zweites Modal ersetzt kein offenes |
| [tests/e2e-app/book-editor-merge.spec.js](../tests/e2e-app/book-editor-merge.spec.js) | **Gegen die echte App**: anderer Absatz remote → still gemergt, aktiver Block zeigt den Remote-Absatz; derselbe Absatz → Modal, „Beide behalten“; Abbrechen verwirft nichts, «Konflikt lösen …» öffnet neu |
| [tests/unit/text-find.test.mjs](../tests/unit/text-find.test.mjs) | Geteilter Find-Kern: Offset-Rückmapping über Node-Grenzen, Ganzwort-Regel, Case-Sensitivität, Grenz-Semantik am Node-Übergang |
| [tests/e2e-app/book-editor.spec.js](../tests/e2e-app/book-editor.spec.js) | **Verhalten gegen die echte App**: Klick aktiviert + fokussiert Block, Tippen → dirty, Save-All → persistiert (Reload-Probe), Caret-Fallback ohne `caretRangeFromPoint`, Find/Replace über den Stream, Outline-Collapse |
| [tests/e2e-app/book-editor-undo.spec.js](../tests/e2e-app/book-editor-undo.spec.js) | Undo/Redo pro Seite: Tippen + Strg+Z/Strg+Shift+Z, überzähliges Strg+Z nach Seitenwechsel lässt die verlassene Seite unberührt (kein Render-Artefakt in `block.html`), Replace als eigener Schritt |
| [tests/e2e-app/smoke.spec.js](../tests/e2e-app/smoke.spec.js) | Karte + alle drei Editoren öffnen ohne Konsolenfehler |
| [tests/unit/stale-write.test.mjs](../tests/unit/stale-write.test.mjs) | Pre-Save-Conflict-Check (geteilt mit Notebook-Card) — Bucheditor ruft denselben Helper |
| [tests/unit/page-stats-normalization.test.mjs](../tests/unit/page-stats-normalization.test.mjs) | `_syncPageStatsAfterSave`-Parität — Bucheditor ruft denselben Helper |
