# LanguageTool-Integration

Self-hosted Rechtschreib-/Grammatik-/Stilprüfung über LanguageTool-Docker. Aktiv in allen drei Editoren ([docs/notebook-editor.md](notebook-editor.md), [docs/focus-editor.md](focus-editor.md), [docs/book-editor.md](book-editor.md)) und in Form-Feldern mit `data-spellcheck="spelling"`. Regelbasiert — **kein KI-Call**, daher als synchroner Proxy ausserhalb der Job-Queue erlaubt (Ausnahme von der „KI-Calls nur via Job-Queue"-Regel).

Browser-Spellcheck wird automatisch deaktiviert (`:spellcheck="!$app.languagetoolEnabled"`), wenn LT aktiv ist.

## Datenfluss

```
contenteditable ─ MutationObserver/input ─ debounce 1500ms ─┐
                                                            ▼
                                                  buildOffsetTable(root)
                                                            │
                                  text + positions[]        │
                                                            ▼
                                  POST /languagetool/check { text, language, bookId, pageId }
                                                            │
        ┌─────────────────── routes/languagetool.js ────────┴───────────────┐
        │  guardBook(bookId) ─► splitSegments (ein Segment pro Absatz)      │
        │  languagetool_para_cache: Treffer pro Segment-Hash                │
        │  Misses ─► packSegments(50KB) ─► Pool=4 fetch ${url}/v2/check     │
        │         ─► assignMatches ─► Cache (UNGEFILTERT)                   │
        │  alle Segmente ─► absolute Offsets ─► filterMatches               │
        │                   (Woerterbuch + Buchnamen + abgeschaltete Regeln)│
        └──────────────────────────────────────────────────────────────────┘
                                                            │
                                                            ▼
                            rangeFromOffset(table, m.offset, m.length)
                                                            │
                                  ┌─ Range pro Match ───────┴───────┐
                                  ▼                                 ▼
                       CSS.highlights.add(range)              squiggles.set(id, …)
                       (native wavy underline)                (Click-Hit-Test)
```

## Backend

### Settings & Routes

| Key | Default | Wo |
|---|---|---|
| `languagetool.enabled` | `false` | [lib/app-settings.js#DEFAULTS](../lib/app-settings.js) |
| `languagetool.url` | `''` | dito (z.B. `http://localhost:8010`) |
| `languagetool.picky` | `false` | dito |

Admin-UI: [public/partials/admin-settings.html](../public/partials/admin-settings.html) Tab `languagetool`. Test-Endpoint [routes/admin-settings.js#POST /admin/settings/test-languagetool](../routes/admin-settings.js) pingt `${url}/v2/languages`.

`/config` exposed nur Existenz-Flag, niemals URL: [routes/proxies.js#languagetool](../routes/proxies.js). Frontend liest in [app-state.js#languagetoolEnabled](../public/js/app/app-state.js) + [app.js](../public/js/app.js) via `cfg.languagetool?.enabled`.

### Proxy [routes/languagetool.js](../routes/languagetool.js)

`POST /languagetool/check` `{ text, language?, bookId?, pageId?, picky? }`:

- **Disabled-Fall:** `!enabled || !url` → `404 { error_code: 'LANGUAGETOOL_DISABLED', error: 'languagetool_disabled' }` (jede Fehlerantwort trägt `error_code` in Grossschreibung, `error` bleibt für ausgelieferte Clients daneben). Frontend behandelt als „Feature aus", kein Retry.
- **Buch-ACL:** `bookId` steuert Sprache, Buch-Wörterbuch und die Eigennamen des Buchs → `guardBook(req, res, bookId, 'viewer')`; fremdes Buch = `403`, kein Upstream-Call. `pageId` wird angenommen (ausgelieferte Clients senden es), aber nicht mehr verwendet — der Cache ist seitenunabhängig.
- **Sprache:** Buch-Locale (`getBookLocale`) > explizite Client-Sprache (≠ `'auto'`) > Profil-Default (`default_language`/`default_region`) > `'auto'`. Bei `'auto'` geht `preferredVariants` mit (Profil-Variante, sonst `de-CH,en-US` wie die Buch-Defaults) — ohne sie prüft LanguageTool erkanntes Deutsch nach de-DE. Das SPA schickt immer `'auto'`: die Buchliste trägt keine Locale, der Server löst auf.
- **Body-Cap:** `TEXT_MAX = 500_000` Zeichen, JSON-Body 600 KB. Übergross → `413 { error: 'text_too_large' }`. Das Frontend teilt nicht; eine Seite dieser Grösse zeigt dann die Fehler-Plakette.
- **Absatz-Cache:** `splitSegments(text)` ([lib/languagetool-chunk.js](../lib/languagetool-chunk.js)) zerlegt an `\n{2,}` (die Block-Grenzen aus `buildOffsetTable`) in Segmente; ein Absatz > 50 000 Zeichen wird an Satz-, notfalls an Wortgrenzen geteilt. Pro Segment `sha1` → `ltCache.getMany`. Nur Misses gehen an LT. **Why:** bei jeder Tipp-Pause geht der ganze Seitentext an den Proxy; geändert hat sich meist ein Absatz. Ein unveränderter Absatz kostet so keinen LT-Call, egal in welcher Seite, welchem Editor oder bei welchem Mitarbeiter er steht.
- **Packen + Pool:** `packSegments(misses, CHUNK_MAX=50_000)` verbindet Misses mit `\n\n` zu Upstream-Anfragen; `PARALLEL = 4` Worker. `assignMatches` verteilt die Treffer zurück auf die Segmente (Offsets relativ zum Segment); ein Treffer, der über eine Segmentgrenze reicht, fällt weg — er gehört keinem Absatz allein. Grenze bewusst: absatzübergreifende Stil-Regeln (z.B. gleiche Satzanfänge über Absätze hinweg) bleiben am Absatz kleben, in dem sie beim ersten Check standen, bis dieser sich ändert.
- **Cache-Write:** **ungefilterte** Treffer pro Segment, `ltCache.setMany` in einer Transaktion. TTL 30 Tage über [lib/cache-cleanup.js](../lib/cache-cleanup.js).
- **Filter beim Ausliefern** ([lib/languagetool-filter.js](../lib/languagetool-filter.js)#`filterMatches`), nach dem Zusammensetzen mit absoluten Offsets: Wörterbuch des Users (`dict.getCheckSet`, Buch + global), Eigennamen des Buchs (`ltNames.listBookNames` → `buildNameSet`: Figurenname, Kurzname, Schauplatz; Einzelwörter, Genitiv „Annas"/„Hans'"; nur gegen Rechtschreib-Treffer) und abgeschaltete Regeln (`ltRules.getCheckSet`). **Why:** der Cache wird zwischen Usern geteilt — würde gefiltert gecacht, verschwände das Wörterbuch eines Mitarbeiters auch beim anderen. Und ein Wörterbuch-Add/-Remove wirkt ohne Cache-Invalidierung sofort.
- **Timeout + Abbruch:** `UPSTREAM_TIMEOUT_MS = 15_000` **pro Upstream-Anfrage** (`AbortSignal.any` aus Request-Signal und `AbortSignal.timeout`). Wirft ein Worker (Upstream-Fehler, Timeout), bricht der Request-Signal die übrigen ab; trennt der Client die Verbindung (`res.on('close')` vor dem Antworten — neuer Check nach Weitertippen), ebenso. Upstream-Fehler → `502 { error: 'languagetool_upstream', upstream_status }`, Timeout → `408 { error: 'languagetool_timeout' }`.
- **Antwort:** `{ matches, language, chunks, cached, segments }` — `chunks` = Upstream-Anfragen, `cached` = Segmente aus dem Cache.
- **Logging-Context:** `guardBook` setzt den `book`-Slot.
- **Auth-Vertrag:** Abgelaufene Session bzw. ungültiges Device-Token (`swd_…`) liefert `401 { error_code: 'NOT_LOGGED_IN' }` ([lib/auth-guard.js](../lib/auth-guard.js): Redirect nur für Browser-Navigationen). Nötig, damit der Android-Client den Auth-Fehler erkennt (Token verwerfen → Pairing) statt nur ein generisches Fehler-Badge zu zeigen.

### Abgeschaltete Regeln [routes/languagetool.js](../routes/languagetool.js) `/rules` + [db/languagetool-rules.js](../db/languagetool-rules.js)

`GET/POST/DELETE /languagetool/rules` mit `{ ruleId, bookId?, label? }`. `book_id` NULL = in allen Büchern aus, sonst nur in diesem Buch (`guardBook` viewer). `label` ist die LT-Regelbeschreibung für die Liste im Profil (`#profil` → „Ausgeschaltete Regeln", dort wieder einschaltbar). Gefiltert wird im Proxy, **nicht** über LTs `disabledRules`-Parameter — sonst hinge der geteilte Absatz-Cache an der Regelmenge eines Users.

### Dictionary [routes/dictionary.js](../routes/dictionary.js) + [db/user-dictionary.js](../db/user-dictionary.js)

`GET/POST/DELETE /dictionary` mit `{ word, bookId?, lang? }`.

- **Sprache:** `lang = '*'` → alle Sprachen, sonst LT-Locale-Tag (`de-CH`, `en-US`, …). `'auto'` ist **kein** gültiger Wert (Migration 142 normalisiert auf `'*'`).
- **Scope:** `book_id` NULL → User-global, `> 0` → nur dieses Buch (Popover: „Ins Buch-Wörterbuch" / „Ins Wörterbuch (alle Bücher)"). `lang` ist faktisch immer `'*'` (das SPA kennt die Buch-Locale nicht und schickt `'auto'` → `'*'`).
- **Lookup im Proxy:** `getCheckSet(userEmail, bookId, lang)` matched `(book_id IS NULL OR book_id = ?) AND (lang = '*' OR lang = ?)`. Case-insensitive via lower-cased Set.
- **Auth-Vertrag:** `401 JSON` statt Redirect über denselben Auth-Guard, gleiche Begründung wie beim Proxy.
- **Zweiter Konsument: das KI-Lektorat** ([routes/jobs/lektorat-dictionary.js](../routes/jobs/lektorat-dictionary.js), eingehängt in `lektorat-page.js#checkOnePage`, gilt damit für Abschnitts- und Buch-Lektorat). Dieselbe `getCheckSet`-Menge mit der Buch-Locale; davon nur die Wörter, die auf der Seite vorkommen (max. 200 im Prompt). Zwei Schichten: Block „KEINE Rechtschreibfehler“ in Einzel-/Stil- **und** Objektiv-Prompt (`blocks.js#_buildWoerterbuchBlock`) plus Backstop `dropDictionaryFindings`, der `rechtschreibung`-Findings auf Wörterbuch-Wörtern verwirft (andere Typen bleiben). Die Wörter der Seite stehen als `wb` in der Lektorat-`ctxSig` — nur wenn nicht leer, damit bestehende Cache-Zeilen ohne Wörterbuch-Treffer gültig bleiben. **Why:** sonst meldet das Lektorat, was LanguageTool still akzeptiert.
- **Keine Cache-Invalidierung beim Add/Remove:** der Absatz-Cache hält ungefilterte Treffer, der Proxy filtert beim Ausliefern.
- **Word-Cap:** 80 Zeichen.

### DB-Schema

```
languagetool_para_cache                       (Migration 305)
  PK (content_hash, lang, picky)
  matches_json TEXT  → UNGEFILTERTE Treffer, Offsets relativ zum Segment
  → kein Seiten-/User-Bezug; content_hash = sha1 über den Segment-Text.

languagetool_disabled_rules                   (Migration 305)
  user_email FK → app_users(email) ON DELETE CASCADE
  book_id    FK → books(book_id)   ON DELETE CASCADE, NULL = alle Bücher
  rule_id, rule_label
  UNIQUE (user_email, rule_id) WHERE book_id IS NULL
  UNIQUE (user_email, book_id, rule_id) WHERE book_id IS NOT NULL

user_dictionary
  user_email FK → app_users(email) ON DELETE CASCADE
  book_id    FK → books(book_id)   ON DELETE CASCADE, NULL = global
  UNIQUE analog languagetool_disabled_rules (+ lang)
```

## Frontend

### Dispatcher [public/js/cards/editor-spellcheck/dispatch.js](../public/js/cards/editor-spellcheck/dispatch.js)

Eine Instanz pro App, gestartet in [app.js#setupSpellcheckDispatch](../public/js/app.js). Beobachtet `editMode`, `focusActive`, `showBookEditorCard`, `languagetoolEnabled`, `selectedBookId` und hält **genau einen** Controller auf dem aktiven contenteditable. Prioritätskette: Focus > Notebook > Bucheditor.

| Editor | Selector | Scroll-Container |
|---|---|---|
| Notebook | `.page-content-view--editing` | gleich (overflow-y:auto + max-height:70vh) |
| Focus | `.focus-editor__content` | gleich (Scroll-Events bubblen nicht) |
| Bucheditor | `.book-editor-page-body[contenteditable="true"]` | window |

Bucheditor-Block-Wechsel via dedizierter MutationObserver auf `.card--bookeditor` mit `attributeFilter: ['contenteditable']` — bei jedem Block-Activate wird detach+attach getriggert.

Form-Felder (`input/textarea[data-spellcheck="spelling"]`) laufen parallel: focusin-getrieben, eine Controller-Instanz pro Feld (WeakMap-Cache), Cleanup via MutationObserver auf DOM-Removal. Kein Single-Active-Constraint.

### Controller [public/js/cards/editor-spellcheck/controller.js](../public/js/cards/editor-spellcheck/controller.js)

`createSpellcheckController({ root, scrollContainer, getHtml, onApplyReplacement, editorKind, getBookLocale, getBookId, getPageId, isEnabled, i18n })` → `{ attach, detach, refresh }`. Einziger externer Einstieg — die Bestandteile daneben werden nicht direkt konsumiert:

| Modul | Inhalt |
|---|---|
| `controller.js` | Pruef-Pipeline (debounce → fetch → render), Hit-Test, attach/detach |
| [categories.js](../public/js/cards/editor-spellcheck/categories.js) | Klassifikation eines Matches (`categoryKey`, `matchId`, `isSpellingMatch`) + die drei Highlight-Toepfe (`createHighlightBuckets`) |
| [badge.js](../public/js/cards/editor-spellcheck/badge.js) | Status-Plakette am Editor-Eck |
| [popover.js](../public/js/cards/editor-spellcheck/popover.js) | Befund-Popover samt Mount, Position und den drei Schliesswegen |
| [extension-guard.js](../public/js/cards/editor-spellcheck/extension-guard.js) | Erkennung der LT-Browser-Erweiterung |
| [mapping.js](../public/js/cards/editor-spellcheck/mapping.js) | Text-Offsets ↔ DOM-Ranges, Schutzzonen |
| [position.js](../public/js/cards/editor-spellcheck/position.js) | Host-Wahl + Geometrie des Popovers |

**Squiggles ohne Overlay-DOM:** Native CSS Custom Highlight API (`CSS.highlights` + `Highlight`). Pro Kategorie ein globaler Highlight-Bucket (`lt-typo`, `lt-grammar`, `lt-style`), DOM-Ranges werden direkt hinzugefügt. Browser zeichnet wavy-Underline am Text-Lauf, scrollt nativ mit. Kein JS-Reposition bei Scroll, keine Span-Inseln im contenteditable.

Fallback bei fehlendem API-Support: `badge.update('disabled')`, sonst läuft die App ohne LT-Markierungen weiter.

**Kategorie-Mapping** ([categories.js](../public/js/cards/editor-spellcheck/categories.js)#`categoryKey`):
- `rule.id` enthält `SPELL` oder `category.id === 'TYPOS'` → `lt-typo` (rot).
- `category.id ∈ {STYLE, REDUNDANCY, TYPOGRAPHY}` → `lt-style` (gelb).
- Sonst → `lt-grammar` (blau).

**Staleness-Schutz:**
- `seq`-Counter pro Request; Late-Response mit `myReq !== seq` wird verworfen.
- `lastHtmlSnapshot = getHtml()` vor Fetch; nach Response Vergleich mit aktuellem `getHtml()` — Mismatch verwirft.
- `AbortController` bricht ältere Requests bei neuem `_runCheck`.

**Plakette zählt die Markierungen** (`squiggles.size`, `_updateCount`) und wird nach Ignorieren/Wörterbuch/Regel sofort nachgezogen, nicht erst beim nächsten Check.

**Ersetzen prüft den Text unter der Range:** beim Rendern merkt sich jeder Squiggle `range.toString()`. Weicht der Text beim Klick auf einen Vorschlag ab (User hat ins markierte Wort getippt, Re-Check läuft noch im Debounce) oder ist die Range kollabiert, wird **nicht** ersetzt — Squiggle weg, Force-Re-Check. Die Range lebt mit dem DOM mit; ohne den Vergleich schriebe der Vorschlag über den veränderten Text.

**Click-Hit-Test:** Kein DOM-Element pro Match — `mousedown` auf root → `_findMatchAtPoint(x, y)` prüft den Klickpunkt **geometrisch** gegen die `getClientRects()` der gespeicherten Squiggle-Ranges. Bewusst **nicht** über `caretPositionFromPoint`/`caretRangeFromPoint`: die liefern in einem gescrollten overflow-Container (`.page-content-view--editing`, `max-height: 70vh`) eine falsche oder leere Caret-Position, sodass der Treffer beim Scrollen zunehmend danebenliegt. ClientRects sind scroll- und engine-unabhängig korrekt.

`mousedown` und `click` teilen die Vorprüfung `_hitAt(ev)`: linke Taste, nicht im Popover, `ev.detail < 2` (Doppel-/Dreifachklick gewinnt — sonst liesse sich ein Wort unter einem Squiggle nicht mehr per Doppelklick markieren), Squiggles vorhanden. `mousedown` öffnet den Popover **ohne** `preventDefault` (die native Caret-Platzierung soll laufen); der Folge-`click` wird am selben Punkt unterdrückt, sonst folgte ein `<a href>` unter dem Squiggle dem Link.

**Popover-Mounting** (Host-Wahl + Geometrie in [position.js](../public/js/cards/editor-spellcheck/position.js), pure DOM-Mathematik ohne Controller-State — `resolvePopoverHost(scrollEl)` + `positionPopover(el, anchorRect, host)`):
- Interner Scroll-Container (Notebook/Focus): Popover als Kind des Scroll-Containers, `position: absolute` in Scroll-Content-Koordinaten. Popover ist `contenteditable="false"` (nicht-editbare Insel), MutationObserver filtert popover-eigene Mutationen (sonst trigger das Anhängen einen Re-Check, der Squiggles vor dem User-Klick verwirft).
- Window-Scroll (Bucheditor): Popover an `document.body`, position absolute in Document-Koordinaten.
- Vertical/Horizontal Clamp + Flip gegen Viewport bzw. Host-Sichtbereich.

**MutationObserver-Filter `_isPopoverOnlyMutation`** — Mutationen, deren betroffene Knoten ausschliesslich im Popover-Subtree liegen, triggern keinen Re-Check.

**Drei Schliesswege** — Outside-`mousedown` (einmaliger document-Listener in Capture), **Escape** und der **Close-Button** im Header (`.lt-popover__close`, Glyph `×` + `aria-label`/`data-tip` aus `spellcheck.popover.close`); dazu die Aktionen Vorschlag-Anwenden / Ignorieren / Zum-Wörterbuch. Escape hängt als document-**Capture**-Listener (per `AbortController` beim Schliessen abgemeldet) und ruft `stopPropagation()`: der Focus-Editor hört Escape an `window` in der Bubble-Phase ([editor/focus/card.js](../public/js/editor/focus/card.js)), würde also gleichzeitig den Fokus-Modus verlassen. Erstes Escape schliesst nur den Popover, zweites wirkt wieder normal. Bewusst nicht über ein `app`-Flag (wie Synonym-/Figur-Overlay) — der Controller ist host-agnostisch.

**Waisen-Knoten-Schutz `_purgeStrayUi()`** (im Controller, nicht im Popover-Modul — er raeumt fremde Kopien, nicht die eigene Referenz) — bei Notebook/Focus hängt der Popover IM contenteditable. Jede Operation, die den Root-Inhalt aus HTML neu aufbaut oder Blöcke teilt (Enter-Split, Undo, `content.innerHTML = …`, Laden von HTML mit mitgespeichertem UI-Markup), kann eine Kopie erzeugen, die die `popover`-Closure nicht kennt — ein Knoten ohne jeden Handler, den `popover.close()` nie abträgt: unschliessbar bis zum Reload. Darum entfernen `_openPopover`, `attach()` und `detach()` **jedes** `.lt-popover`/`.lt-badge` im Root, nicht nur die eigene Referenz. Das echte Badge ist Sibling von `root` und damit nicht betroffen.

**Apply-Replacement** läuft über editor-spezifischen Callback (`onApplyReplacement(range, text)`), zentral in [dispatch.js#_onApply](../public/js/cards/editor-spellcheck/dispatch.js): `range.deleteContents()` + `insertNode(textNode)` + Selection hinter Insertion + `input`-Event-Dispatch (Editor-Save-Pipeline triggert).

**Ignore (Session-only):** `ignored: Set` mit Schlüsseln aus [categories.js](../public/js/cards/editor-spellcheck/categories.js): „Ignorieren" = `ignoreKey` (Regel + beanstandetes Wort + Satz), „Alle ignorieren" = `ignoreAllKey` (Regel + Wort, jede Stelle). **Nicht** über `matchId` (`offset:length:rule`) — der verschiebt sich mit jedem Zeichen davor, und der ignorierte Befund käme zurück. Kein DB-Persist.

**Add-to-Dictionary:** nur bei Spelling-Matches. Mit Buch zwei Knöpfe (Buch / alle Bücher), ohne Buch einer. POST `/dictionary` mit `{ word, bookId, lang }` (lang `'auto'` wird zu `'*'` gemappt). Bei Erfolg: Squiggle weg + Force-Check (der Server filtert neu, gleiche Wörter an anderen Stellen fallen mit).

**Regel abschalten:** mit Buch „in diesem Buch", sonst global; POST `/languagetool/rules` über die Controller-Dep `disableRule`. Alle Squiggles derselben Regel fallen sofort weg, dann Force-Check.

**Optionale Knöpfe nur mit Übersetzung:** „Alle ignorieren", „Ins Buch-Wörterbuch" und „Regel abschalten" rendert der Popover nur, wenn `i18n(key) !== key`. Der macOS-Client zieht den Controller per OTA-Bundle, löst Strings aber über seine eigene i18n-Bridge auf, die für unbekannte Keys den rohen Key liefert — dort erscheinen die Knöpfe erst, wenn der Client (bzw. [assets/macclient-i18n/](../assets/macclient-i18n/)) die Keys kennt und die Requests verdrahtet sind. Bewusst nicht in die OTA-Override-Kataloge gelegt: ob der Client `getBookId` liefert und `/languagetool/rules` erreicht, entscheidet die Client-Seite.

**Badge** (`.lt-badge`): floating oben-rechts vom Editor (`offsetTop+6`, `offsetLeft+offsetWidth-8`), States `loading|matches|clean|extension|error|disabled|idle` mit Lucide-Icons + Tooltip via `data-tip`.

### Mapping [public/js/cards/editor-spellcheck/mapping.js](../public/js/cards/editor-spellcheck/mapping.js)

Pure Funktionen, testbar ohne Browser (läuft in linkedom — `SHOW_ELEMENT_AND_TEXT = 1 | 4` als rohe Bitmask, kein `NodeFilter.*`-Constructor):

- `buildOffsetTable(root)` → `{ text, positions: [{node, start, end}] }`. TreeWalker, Text-Node-Werte verketten. Block-Tags (P/DIV/LI/UL/OL/BLOCKQUOTE/H1-6/PRE/SECTION/…) fügen `\n\n` ein (LT-Paragraph-Break), `<br>` fügt `\n` ein. **Whitespace innerhalb von Text-Nodes bleibt unangetastet** — LT handhabt Tokenisierung selbst.
- `locateOffset(table, offset, length)` → `{ startNode, startOffset, endNode, endOffset }` oder `null`. Match darf über mehrere Text-Nodes spannen.
- `rangeFromOffset(table, offset, length)` → DOM-`Range` oder `null` (falls Offsets ausserhalb der Tabelle, z.B. nach DOM-Mutation).

UTF-16 Code Units = JS `String.length` = LT-Offset-Semantik. Keine Konvertierung nötig.

### Form-Controller [public/js/cards/editor-spellcheck/form-controller.js](../public/js/cards/editor-spellcheck/form-controller.js)

Eine Instanz pro `<input>`/`<textarea>` mit `data-spellcheck="spelling"`. Unterschiede zum contenteditable-Controller:

- Quelle: `el.value`, kein DOM-Walk.
- **Kein Inline-Squiggle** — Form-Felder rendern Text intern, kein `CSS.highlights`-Support. Stattdessen `.lt-badge.lt-badge--form` absolut **im** Feld (top/bottom-right); Klick öffnet Popover mit Liste aller Tippfehler.
- **Wrap-Pattern:** Beim ersten attach wickelt `_insertBadge` das Feld in `<span class="lt-field-wrap">` (Textarea: zusätzlich `lt-field-wrap--textarea`) und hängt den Badge als zweites Kind ein. Beim detach unwrap (Feld zurück an Grandparent, Wrap entfernt). Alpine-Bindings bleiben intakt — das Element-Objekt wird nur verschoben, nicht ersetzt. Idempotent: wenn Feld bei Re-Attach schon gewrappt ist, wird nicht doppelt gewrappt.
- **Position:** `position: absolute` auf `.lt-badge--form`, default top:50%/right:6px (vertikal mittig). Textarea-Variante: `bottom: 8px/right: 6px` (Badge sitzt am unteren Rand, blockiert nicht die erste Zeile).
- **Padding-Reservation:** CSS-Regel `.lt-field-wrap > input[data-spellcheck], .lt-field-wrap > textarea[data-spellcheck] { padding-inline-end: 32px !important }` reserviert rechts Platz. `!important` ist Pflicht, weil Karten wie `.card-title--input:focus` per `padding`-Shorthand alle 4 Seiten neu setzen — sonst überschreibt der Focus-Shorthand das `padding-inline-end` zurück und Text klebt am Badge.
- **Flex/Grid-Parents:** `.lt-field-wrap { flex: 1; min-width: 0; display: block; }`. In flex-Containern (Buchorganizer-`.organizer-page`, `.ideen-input-row`, `.kapitel-new-page`, `.book-settings-kontext-wrap`) übernimmt der Wrap die `flex:1`-Rolle des Feldes; in grid-Cells (`.card-form-row`) und block-Stacks (`.card-header-titlebar`) bleibt es block-level. Kein JS-Reposition bei Scroll/Resize nötig — alles CSS.
- **Schliesswege** — Close-Button im Kopf, Escape (document-Capture + `stopPropagation`, per `AbortController` abgemeldet), Outside-Click.
- **Ignorieren/Wörterbuch** wie im Editor-Popover (`ignoreKey`, Buch-/Global-Knopf); Plakette und Liste werden sofort nachgezogen.
- **Lifecycle:** `_detachAllForms` (LT aus) leert auch die WeakMap `el → ctl` — sonst fände `_ensureFormCtl` nach dem Wiedereinschalten den abgehängten Controller und hinge ihn nie neu an.
- **Spelling-only Filter** — Grammar/Style/Punctuation wegfiltern. Titel/Notizen sind kurz, Grammar/Style bringen keinen Mehrwert und nerven.
- Apply via `el.setRangeText(text, off, off+len, 'end')` + `input`/`change`-Event (Alpine `x-model` bekommt mit, Undo-Stack bleibt intakt).
- Snapshot-Drift-Check vor Apply: wenn `el.value.substr(off, len).trim() !== lastValueSnapshot`-Word, abbrechen + Re-Check.
- Debounce: `500ms` für `<input>`, `1000ms` für `<textarea>`.

### Locale [dispatch.js#_locale](../public/js/cards/editor-spellcheck/dispatch.js)

Liefert `'auto'`: die Buchliste (`/content/books`) trägt keine Sprache. Der Server löst über `bookId` bzw. den Profil-Default auf (siehe Proxy).

### Seiten-ID im Bucheditor

`getPageId` liest beim Bucheditor `data-book-editor-page` des aktiven Blocks, nicht `app.currentPage` (die Baum-Auswahl, die der Bucheditor nicht nachführt).

### Extension-Konflikt

LT-Browser-Extension injiziert eigene Squiggles → doppelte Underline. Detection in [extension-guard.js](../public/js/cards/editor-spellcheck/extension-guard.js): MutationObserver auf `document.body` (Trailing-Throttle 300 ms — ungedrosselt waere der Dokument-Scan Tipp-Latenz pro Tastendruck) prüft Selektoren `lt-div`, `lt-highlighter`, `[class*="lt-toolbar"]`, `[class*="languagetool"]`. Hit → Highlights leeren, Badge `'extension'`, Event `languagetool:extension-detected` dispatched.

Banner-Card [public/js/cards/editor-spellcheck-card.js](../public/js/cards/editor-spellcheck-card.js) (`editorSpellcheckCard`, Markup in [public/index.html](../public/index.html)) hört auf das Event und zeigt Hinweis. Per-Session dismissable via `sessionStorage['lt:extension-banner-dismissed']`. Marker verschwinden → `languagetool:extension-cleared`, Banner aus.

## CSS [public/css/editor/spellcheck.css](../public/css/editor/spellcheck.css)

Shared für alle Editoren + Form-Felder. Pflicht-Token: `--z-overlay-spellcheck` (Squiggle-Layer), `--z-popover` (Popover-Layer).

`::highlight(lt-typo|lt-grammar|lt-style)` setzen `text-decoration: underline wavy …` mit `text-decoration-skip-ink: none` (sonst Lücken unter `g`/`p`/`y`). Farben via `--color-err-border`/`--color-running`/`--color-style-border`.

Pro-Editor-Tweaks via `[data-editor="focus"]`/`[data-editor="book"]` auf Popover/Badge.

`.lt-popover__close` sitzt via `margin-left: auto` rechts im Header, 24×24 Trefferfläche (Mobile 32×32).

## Tests

| Layer | Datei | Scope |
|---|---|---|
| Unit | [tests/unit/languagetool-mapping.test.mjs](../tests/unit/languagetool-mapping.test.mjs) | `buildOffsetTable`/`rangeFromOffset`: Block-Boundaries, Cross-Node-Matches, Whitespace |
| Unit | [tests/unit/languagetool-chunk.test.mjs](../tests/unit/languagetool-chunk.test.mjs) | `splitSegments`/`packSegments`/`assignMatches`: Absatz-Segmente, Satz-/Hard-Split, grenzüberschreitende Treffer |
| Unit | [tests/unit/languagetool-filter.test.mjs](../tests/unit/languagetool-filter.test.mjs) | Wörterbuch, Buchnamen (Genitiv, nur Rechtschreibung), abgeschaltete Regeln |
| Integration | [tests/integration/languagetool-proxy.test.js](../tests/integration/languagetool-proxy.test.js) | Mock-LT: Forward, Disabled-404, Upstream-502, Timeout-408, Absatz-Cache, Wörterbuch pro User trotz geteiltem Cache, Buchnamen, Regeln, Buch-403, Worker-Abbruch bei Fehler |
| E2E | [tests/e2e/spellcheck-actions.spec.js](../tests/e2e/spellcheck-actions.spec.js) | Ignorieren überlebt Text davor, Alle ignorieren, Plakette nach Ignorieren, kein Ersetzen über veränderten Text, optionale Knöpfe nur mit Übersetzung |
| Unit | [tests/unit/editor-shared-save.test.mjs](../tests/unit/editor-shared-save.test.mjs) | `stripLektoratMarks`: `.lt-popover`/`.lt-badge` raus (inkl. Fast-Path-Regression), `normalizeForCompare` bleibt stabil |
| Unit | [tests/unit/html-clean.test.js](../tests/unit/html-clean.test.js) | `stripEditorUiArtefacts` + `cleanPageHtml`: UI-Markup eines alten Clients landet nicht im Content |
| E2E | [tests/e2e/spellcheck-notebook.spec.js](../tests/e2e/spellcheck-notebook.spec.js) | Tippen → Debounce → Squiggle → Popover → Replace → Save; Escape, Close-Button (Maus + Tab/Enter), kein UI-Markup im Save |
| E2E | [tests/e2e/spellcheck-focus.spec.js](../tests/e2e/spellcheck-focus.spec.js) | Focus-Enter/Exit-Lifecycle, internes Scrollen (Container-Scroll, nicht Window); Escape-Priorität gegen den Editor-Handler, Waisen-Popover-Purge bei Open + Mount |
| E2E | [tests/e2e/spellcheck-book.spec.js](../tests/e2e/spellcheck-book.spec.js) | Block-Activate-Switch: Squiggle wandert mit aktivem Block; Escape/Close am `<body>`-gemounteten Popover |

## Pflicht-Invarianten

- **`data-spellcheck="spelling"` auf jedem Prosa-Feld.** Buch-/Seiten-/Kapiteltitel, Notizen, Beschreibungen, Einleitungen, Ideen, Freitext-Kontext — alles bekommt das Attribut (siehe CLAUDE.md „LanguageTool auf Prosatextfeldern Pflicht"). Ausnahmen: Suchfelder, `numInput`, Admin-Settings, Find/Replace, Readonly-Felder. Wer ein neues Prosa-Feld baut, ohne das Attribut zu setzen, bricht die Regel.
- **Wrap-Pattern via Form-Controller, nicht im Markup.** Der `.lt-field-wrap`-Span entsteht beim attach automatisch, das Partial enthält nur das Attribut. Hand-Markup-Wrap ist Anti-Pattern und führt zu Drift mit dem Controller-Unwrap.
- **Locale-SSoT Server.** Wenn der Proxy eine `bookId` bekommt, gewinnt `getBookLocale(bookId)` über alles, was das Frontend mitschickt. Frontend liefert Locale nur als Fallback (Form-Felder ohne Buchscope).
- **`'auto'` ist kein Dictionary-Lang.** Wert `'auto'` wird in `/dictionary` zu `'*'` gemappt, sonst matched `getCheckSet` nie (Migration 142 hat tote Daten gelöscht). Frontend-Add muss das mappen.
- **Cache-Key enthält `picky` + `lang`.** Sprachwechsel oder Picky-Toggle dürfen alten Cache **nicht** wiederverwenden. PRIMARY KEY `(content_hash, lang, picky)`.
- **Cache ungefiltert, Filter beim Ausliefern.** Nichts Benutzerbezogenes (Wörterbuch, Buchnamen, Regeln) darf vor `ltCache.setMany` greifen und nichts davon als LT-Parameter (`disabledRules`) mitgehen — der Cache ist zwischen Usern und Seiten geteilt.
- **Buch-ACL vor allem anderen.** `bookId` entscheidet über Sprache, Buch-Wörterbuch und Eigennamen; `guardBook` läuft vor jedem Lookup.
- **Fehler und Client-Abbruch stoppen alle Worker.** Neue Upstream-Pfade hängen am Request-`AbortController`, Timeouts pro Anfrage.
- **Popover ist `contenteditable="false"`.** MutationObserver filtert Popover-Mutationen (`_isPopoverOnlyMutation`), sonst verschwinden Squiggles vor dem Klick. Gilt für jede neue UI, die der Controller in den Editor-Subtree einhängt.
- **Nie nur die eigene Popover-Referenz entfernen.** Wer den Popover-Lifecycle anfasst, räumt beim Öffnen/Mount/Unmount **alle** `.lt-popover`/`.lt-badge` im Root weg (`_purgeStrayUi`). Eine Kopie, die kein Controller mehr kennt, ist per Definition unschliessbar — sie hat keinen einzigen Handler.
- **Mindestens ein Schliessweg ohne Maus und einer ohne Tastatur.** Escape **und** sichtbarer Close-Button sind Pflicht, nicht nur Outside-Click: der Popover sitzt im contenteditable, auf Touch ist „daneben tippen" ein Klick in den Text.
- **Escape-Handler in Capture + `stopPropagation`.** Nicht in der Bubble-Phase registrieren — der Focus-Editor-Handler an `window` würde sonst zusätzlich feuern und den Fokus-Modus verlassen. Listener beim Schliessen abmelden (`AbortController`), sonst frisst ein toter Handler das nächste Escape.
- **UI-Markup nie persistieren.** `.lt-popover`/`.lt-badge` fliegen client-seitig in `stripLektoratMarks` ([editor/shared/html-clean.js](../public/js/editor/shared/html-clean.js)) und server-seitig in `stripEditorUiArtefacts` (Teil von `cleanPageHtml`, [lib/html-clean.js](../lib/html-clean.js)) raus. Der Client-Filter hat einen Fast-Path — ein neuer UI-Klassenname muss **auch in die `hasLtUi`-Trigger-Bedingung**, sonst greift der Early-Return und der Filter läuft nie.
- **Quellennachweise sind geschützte Bereiche, kein Text-Schnitt.** Quellen-Chips (`span.cite[data-src]`, [sources/cite-html.js](../public/js/sources/cite-html.js)) bleiben IM LT-Eingabe-Stream; `buildOffsetTable` liefert stattdessen `protectedRanges`, und `filterProtectedMatches` verwirft jeden Treffer, der ein Intervall **berührt** (nicht erst, wenn er ganz darin liegt — ein angewandter Vorschlag würde sonst Chip-Zeichen ersetzen und den Zeiger auf die Quelle zerstören). **Nicht** herausschneiden: die beiden Nachbar-Textknoten ergäben ein doppeltes Leerzeichen, und darauf hat LanguageTool eine eigene Regel — die Quellenangabe erzeugte den Fehler, den sie vermeiden soll. Gefiltert wird **genau einmal** (im Controller vor `_renderMatches`), damit Squiggles und Badge-Zahl dieselbe Menge sehen. `CITE_SKIP_SEL` in [mapping.js](../public/js/cards/editor-spellcheck/mapping.js) ist eine bewusste Kopie von `CITE_SEL` (das Modul hält sich frei von App-Bundle-Kanten), gegated durch [tests/unit/cite-guard-drift.test.mjs](../tests/unit/cite-guard-drift.test.mjs).
- **`seq` + `htmlSnapshot` doppelte Staleness.** Both checks sind Pflicht: Race „User tippt während Fetch" + Race „mehrere Checks parallel". AbortController allein reicht nicht (Response kann durch sein, bevor abort durchläuft).
- **Apply geht über `input`-Event, nicht direkt an Editor-State.** Save-Pipeline muss triggern (Notebook-Autosave/Focus-Save/Bucheditor-`_markDirty`). Direkter State-Write umgeht Stale-Write-Schutz und Draft-Storage.
- **CSS-Highlights sind global.** `CSS.highlights.set(name, …)` ist Document-scoped. Bei mehreren parallelen Editoren (theoretisch — Dispatcher verbietet's) würden Buckets kollidieren. Single-Active-Constraint ist die Garantie.
- **LT-URL niemals ans Frontend.** Nur Existenz-Flag in `/config`. Bei neuen Routes/Endpoints, die LT-Config zurückgeben, das wahren.
- **Body-Cap 500 KB im Proxy.** Das Frontend teilt nicht; > Limit antwortet der Proxy `413` ohne Retry.
