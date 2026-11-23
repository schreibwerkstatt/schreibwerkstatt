# Client-Vertrag — Änderungen

Neueste oben. Je Abschnitt: was sich geändert hat, und was ein Client tun **muss** (Bruch, Frist) bzw. tun **darf** (neues Feld, neuer Weg). Regeln: [README.md](README.md).

## api 8 · editorApi 1

Recherche-Board für Android, nur additiv:

- **`GET /research?view=board` → `ResearchItem[]`:** die volle Item-Form wie in der Web-App — `body`, `pinned`, `archived`, `status`, `tags`, `links`, `has_image`, `has_doc`, `doc_name`. Nur mit `content:write`-Token (`device`); ein `capture`- oder Nur-Lese-Token bekommt `403 DEVICE_SCOPE_FORBIDDEN`. Ohne `view` bleibt die Antwort für jedes Token die reduzierte `ResearchClientItem`-Form.
- **`GET /research?offset=n`:** seitenweises Laden in jeder Sortierung, für beide Formen. `limit` bleibt Default 50, Maximum 200. Weiterladen, bis eine Seite kürzer als `limit` ist. Archivierte kommen nur mit `archived=1`.
- **`POST /research` liest `Idempotency-Key`** wie `POST /ideen` und `POST /content/pages`: derselbe Schlüssel liefert 24 h lang dasselbe Fundstück mit `Idempotent-Replayed: true`. Die Prüfung läuft vor der Dubletten-Prüfung — eine Wiederholung bekommt kein `409 DUPLICATE_URL` auf das eigene Fundstück.
- **`ResearchItem`** nennt jetzt `status` (`offen | in_arbeit | eingearbeitet | verworfen`) und `links` (`target_kind`, `target_id`, `label`); der Server lieferte beides schon.
- **`ResearchCreateRequest.allow_duplicate`** steht jetzt im Schema (gab es schon, siehe `docs/clients.md`).
- **`POST /research/{id}/image`** und **`POST /research/{id}/scrape`** sind im Vertrag (`x-clients: android`), mit Fixtures für Erfolg, `400 IMAGE_INVALID` und `422 SCRAPE_EMPTY`; dazu ein Fixture für `409 DUPLICATE_URL`.

**Clients dürfen:** das Board mit `view=board` laden und per `offset` vollständig nachladen, statt mit der reduzierten Form und 50 Treffern auszukommen. Feature-Check `clientContract.api >= 8`; ein älterer Server ignoriert `view` und `offset` und liefert die reduzierte erste Seite. Beim Anlegen einen `Idempotency-Key` je vorgemerkter Erfassung erzeugen und bei jeder Wiederholung mitschicken. Unbekannte `status`- und `target_kind`-Werte ignorieren.

## api 7 · editorApi 1

Ideen (Pendenzen), nur additiv — vier bestehende Routen der Web-App neu im Vertrag, für Android:

- **`GET /ideen/board?book_id=…` → `IdeenBoard`:** alle eigenen Ideen des Buchs in jeder Stufe (neueste zuerst, ungefiltert), dazu `statuses` (alle Stufen in Spaltenfolge), `stages` (im Buch aktive Stufen) und `auto_check`. Ideen sind privat: auch auf einem geteilten Buch kommen nur die eigenen.
- **`POST /ideen` → `Idee`:** Anker `page_id` **oder** `chapter_id` **oder** keiner (Buch-Idee); `content` getrimmt 1–4000 Zeichen, darüber `400 CONTENT_TOO_LONG`. Ein Kapitel mit genau einem Abschnitt wird zu diesem Abschnitt. Optionaler Header `Idempotency-Key` wie bei `POST /content/pages`: derselbe Schlüssel liefert 24 h lang dieselbe Idee mit `Idempotent-Replayed: true`, statt eine zweite anzulegen.
- **`PATCH /ideen/{id}` → `Idee`:** `content`, `status` und Anker-Umzug (`page_id` bzw. `chapter_id`, der andere wird geleert; beide `null` = zurück zur Buch-Idee), einzeln oder zusammen. In eine im Buch abgeschaltete Stufe → `400 IDEE_STATUS_INACTIVE`; Umzug einer erledigten/verworfenen Idee → `400 IDEE_CLOSED`.
- **`DELETE /ideen/{id}` → `{ ok: true }`.** Eine fremde oder schon gelöschte Idee → `404 IDEE_NOT_FOUND` (auch bei `PATCH`).
- **`Idee`** trägt die Namen des Ankers (`page_name`, `chapter_name`), die Board-Bahn (`lane_chapter_id`/`lane_chapter_name`), `check_hint` (Hinweis des Auto-Erledigt-Checks oder `null`) und `links` (Verknüpfungen zu Recherche, Beat, Strang, Motiv, Werkstatt-Figur).

Ein `device`-Token (`content:write`) erreicht alle vier Routen; ein `capture`-Token bekommt `403 DEVICE_SCOPE_FORBIDDEN`.

**Clients dürfen:** Ideen anzeigen, anlegen, bearbeiten und löschen. Beim Anlegen einen `Idempotency-Key` je Operation erzeugen und bei jeder Wiederholung mitschicken; ein `404 IDEE_NOT_FOUND` auf ein nachgespieltes `DELETE` als erledigt werten. Unbekannte `status`-Werte wie `offen` und unbekannte `target_kind` als ignorierbar behandeln. Stufen nur aus `stages` anbieten. Feature-Check `clientContract.api >= 7` (die Routen selbst gibt es auch auf älteren Servern).

Bundle, nur additiv:

- **`handle.onSaved(cb)` → Abmelde-Funktion:** `cb({ dirty, pageId })` nach jedem Save-Lauf (Autosave, `save()`, Escape, `destroy()`), auch wenn der Editor den Save überspringt, weil der Inhalt dem gesicherten Stand gleicht. Ein fehlgeschlagener Save meldet nichts.
- **`handle.revealCaret({ threshold? })` → gefahrene px:** zieht die Caret-Zeile auf den Typewriter-Anker, mit derselben Geometrie wie beim Tippen; der Scroll gilt der Engine als eigener.
- **`handle.insertHr()`:** fügt `<hr>` hinter dem Block des Carets ein (ohne Caret im Editor: ans Ende), dahinter einen Folge-Absatz `<p><br></p>` mit dem Caret darin; feuert `input` und ist ein Undo-Schritt.
- **`<hr>` sichtbar im Bundle-CSS:** Linie über die volle Schreibbreite in der Rahmenfarbe des Themes (Hell und Dunkel), `hr.pagebreak` gestrichelt, `hr.blankpage` doppelt — wie in Notebook, Bucheditor und Share-Reader. Bisher war die Linie unsichtbar (`border: none; height: 0`).
- **`host.editDirty`** bleibt `true`, wenn während eines laufenden `savePage` weitergetippt wurde (bisher fiel es mit dem Ende dieses Saves auf `false`, obwohl die neue Eingabe erst mit dem nächsten Autosave rausging).

Fläche (`editor-surface.json`) bereinigt: `controller`, `_focusUpdateActive`, `focusGranularity` und die `focus-mode--*`-Stufenklassen fallen weg. Sie nutzte nur noch Mac 3.23 (der neueste gepushte Release-Tag); im Einsatz ist laut Admin-Tab «Geräte» nur Mac 3.29, und der setzt die Stufen ausschliesslich über `setGranularity`.

**Clients dürfen:** `host.quickSave` nicht mehr überschreiben, sondern `onSaved` abonnieren und `dirty` direkt melden (der eigene Eingabe-Zähler entfällt). Statt `js/editor/focus/typewriter.js` zu importieren (`getCaretRect`, `typewriterScroll`), `revealCaret()` aufrufen. Beides per `typeof handle.onSaved === 'function'` bzw. `typeof handle.revealCaret === 'function'` prüfen und sonst beim bisherigen Weg bleiben. Ist `typeof handle.insertHr === 'function'`, die Trennlinie über das Handle einfügen statt per eigener DOM-Mutation und eigenes `<hr>`-CSS (auch `!important`-Overrides) weglassen — dasselbe Bundle bringt die sichtbare Linie mit; sonst beim eigenen Weg bleiben.

## api 6 · editorApi 1

Recherche-Board, strengere Eingangsprüfung:

- **`POST /research` → `400 INVALID_URL`:** eine URL in `urls`, die nicht mit http:// oder https:// beginnt oder länger als 2000 Zeichen ist (`params.max`), lehnt der Server ab. Bisher fiel sie still weg bzw. wurde abgeschnitten, und das Fundstück entstand ohne sie. Gleiches gilt für `POST /capture` (`url`).
- **`POST /research` → `400 INVALID_FIELD`:** `title`, `body` oder `source` mit einem anderen Typ als String oder `null` (`params.field` nennt das Feld). Bisher wurde das Feld still verworfen.
- **`kind: "image"`** ist beim Anlegen kein gültiger Wert mehr (wird wie jeder unbekannte Wert zu `note`): ein Bild-Fundstück entsteht nur über den Bild-Upload.
- **`GET /research?q=…` → `503 SEARCH_FAILED`:** scheitert die Volltextsuche, kommt ein Fehler statt der ungefilterten Liste.

**Clients müssen:** nichts, solange sie http(s)-URLs bis 2000 Zeichen und Strings schicken (macOS, Android und die Browser-Erweiterung tun das). **Clients dürfen:** `INVALID_URL` als Eingabefehler anzeigen und `503 SEARCH_FAILED` wie einen vorübergehenden Fehler behandeln (erneut versuchen), statt eine leere Trefferliste zu zeigen.

## api 5 · editorApi 1

Diktat, nur additiv:

- **`POST /stt/transcribe` → `uncertain`:** Konfidenz des Whisper-Modells für das Segment. `true` heisst: das Modell ist unsicher, ob überhaupt Sprache vorlag (typisch für Geisterphrasen wie «Vielen Dank.» aus einem stillen Segment); `false` heisst: sicher erkannte Sprache. Das Feld fehlt, wenn das STT-Backend keine Konfidenz liefert. Segmente, die das Modell klar als Stille einstuft, kommen jetzt als `text: ""`.
- **`bookId` wird geprüft:** ohne Zugriff auf das Buch antwortet der Endpunkt `403 NO_BOOK_ACCESS` (bisher bediente er jede `bookId`).
- **200 ohne lesbares Transkript des Backends** ist jetzt `502 STT_UPSTREAM` statt `200 { text: "" }`.

**Clients dürfen:** einen eigenen Floskel-Filter nur noch anwenden, wenn `uncertain` nicht `false` ist, damit eine klar gesprochene Dialogzeile wie «Tschüss.» erhalten bleibt. Feature-Check `clientContract.api >= 5`.

Neustart, nur additiv:

- **`503 SHUTTING_DOWN`** auf jeder Route, mit `Retry-After: 5` und `Connection: close`: der Server wird gerade gestoppt (Deploy) und hat den Request nicht bearbeitet, es wurde nichts geschrieben. Kommt nur auf einer schon offenen Keep-Alive-Verbindung; neue Verbindungen lehnt der Server in dieser Phase ab. SSE-Streams (`/events/stream`) beendet der Server dabei aktiv.

**Clients müssen:** nichts — wer 503 wie einen Netzfehler behandelt (Outbox, erneuter Versuch), liegt richtig.

Bundle, nur additiv:

- **`createSpellcheckController` → `SpellcheckController`** ist jetzt typisiert ([editor-api.d.ts](editor-api.d.ts)): `attach`, `detach`, `refresh`, `isAttached`. Das Bundle ist unverändert, die Methoden gab es schon; neu ist die Zusage.

**Clients dürfen:** nach `handle.replaceContent(html)` `refresh()` aufrufen, damit die Rechtschreibprüfung den eingespielten Stand prüft (der Tausch feuert kein `input`).

## api 4 · editorApi 1

Gliederung, nur additiv:

- **`GET /content/books/{book_id}/tree` → `order_updated_at`:** Version der Gliederung. Sie ändert sich bei jedem Anlegen, Umbenennen, Löschen oder Umsortieren von Kapiteln und Abschnitten.
- **Lesereihenfolge festgeschrieben:** Abschnitte ohne Kapitel (`topPages`) stehen vor allen Kapiteln, die eigenen Abschnitte eines Kapitels (`pages`) vor seinen Unterkapiteln (`subchapters`). Die Form der Antwort bleibt gleich.
- **`POST /content/chapters`:** ein `parent_chapter_id` auf Ebene 3 wird mit `400 CHAPTER_MAX_DEPTH` abgelehnt (bisher entstand eine vierte Ebene, die das Umsortieren des Buchs blockierte).
- **`PUT /content/pages/{page_id}`:** `chapter_id` und `position` im Body werden ignoriert. Beide standen nie im Vertrag; die Gliederung ändert sich nur über die Reihenfolge des Buchs.

**Clients dürfen:** `order_updated_at` merken und den Baum neu laden, wenn er sich ändert, statt die Gliederung bei jedem Sync komplett zu ziehen. Feature-Check `clientContract.api >= 4`.

## api 3 · editorApi 1

- **`POST /content/pages` liest den optionalen Header `Idempotency-Key`.** Derselbe Schlüssel desselben Kontos liefert 24 h lang die erste Antwort noch einmal (mit Header `Idempotent-Replayed: true`), statt einen zweiten Abschnitt anzulegen. Läuft der erste Request noch, wartet der zweite auf dessen Ausgang. Ohne Header bleibt alles wie bisher. Die Web-App schickt den Schlüssel beim ersten Versuch mit, damit ein Anlegen, dessen Antwort im Funkloch verloren ging, beim Nachspielen nicht doppelt entsteht.

**Clients dürfen:** beim Anlegen eines Abschnitts einen Schlüssel erzeugen (z.B. `op-<UUID>`), lokal mit der Operation speichern und bei jeder Wiederholung derselben Operation mitschicken. Feature-Check `clientContract.api >= 3`.

## api 2 · editorApi 1

Revisionen eines Abschnitts, nur additiv:

- **`Revision.pinned` (0/1) und `Revision.label`:** angeheftete, benannte Revisionen; die Retention löscht sie nie. Angeheftet wird im Web (`PATCH /content/pages/{page_id}/revisions/{rev_id}`, nicht Teil des Vertrags).
- **`Revision.source` kennt `restore`:** der Write aus «Wiederherstellen» (bisher `main`). Das Summary bleibt `restored from #<id>`. Neu ist ausserdem das Summary `baseline`: der Stand eines Abschnitts vor seinem ersten Save, datiert auf dessen letzten Write.
- **`GET …/revisions` → `older` und `pinned`:** `older` ist die Vorgängerin der ältesten gelieferten Revision (nur bei `has_more`), `pinned` sind alle angehefteten Revisionen der Seite (nur ohne Cursor).
- **`GET …/revisions/{rev_id}` → `prev`:** Meta der unmittelbaren Vorgängerin, null bei der ältesten. `body_html` geht ohne aktive Inhalte raus (`<script>`, `on*`, `javascript:`).
- **Dedup:** eine neue Revision entsteht jetzt auch bei Änderungen ohne Textunterschied (Formatierung, Bild, Link-Ziel, Todo-Haken, Diagramm-Quelltext). Die Liste eines Abschnitts kann deshalb dichter werden.

**Clients dürfen:** `restore` als eigene Quelle beschriften (bis dahin zeigen beide Clients den Rohwert), `label` statt Datum als Titel einer angehefteten Revision zeigen und `prev` für den Vergleich mit der Vorgängerin nutzen.

Bundle, additiv in editorApi 1:

- **`handle.replaceContent(html): boolean`:** spielt einen neuen Server-Stand desselben Abschnitts ein, ohne ihn wie einen Abschnittswechsel zu behandeln. Caret bleibt im selben Block an derselben Textstelle (auch im letzten Block), kein Sprung ans Ende, kein Auto-Slot, kein Save; die Undo-Historie bleibt und bekommt den Tausch als einen Schritt. `false` heisst: seit dem gesendeten Stand wurde weitergeschrieben, nichts geändert — der vorgemerkte Autosave pusht diese Eingaben, und die nächste `merged: true`-Antwort spielt sich ein.

**Clients dürfen:** die `html` einer `200 merged: true`-Antwort (und einen Sync-Pull der sauberen offenen Seite) per `replaceContent` statt `setPage` einspielen. Feature-Check `typeof handle.replaceContent === 'function'`, sonst wie bisher `setPage` (ältere Bundles). Rechtschreibprüfung und Zähler der Schale danach selbst anstossen — der Tausch feuert kein `input`.

## api 1 · editorApi 1

Erster festgeschriebener Stand. Er beschreibt, was macOS (3.27) und Android (`65408bb`) heute nutzen, plus drei Ergänzungen:

- **`GET /config` → `clientContract: { api, editorApi }`.** Damit erkennt ein Client Features (`api >= n`).
- **`PUT /content/pages/{page_id}` mit `base_html`:** Bei veraltetem Stempel mergt der Server blockweise mit derselben Engine wie der Mac-Client. Kollisionsfrei kommt `200` mit `merged: true` zurück; `html` ist dann der neue Stand und lokal zu übernehmen. Der gemergte Write trägt **keine** Save-Kennung (`last_save_id: null`), weil sein Stand fremde Blöcke enthält, die der Client erst mit der Antwort sieht. Eine Wiederholung oder ein Nachfolger läuft deshalb erneut durch den Merge; ein Nachfolger schickt als `base_html` den zuletzt gesendeten Stand. Bei echter Kollision kommt `409 PAGE_CONFLICT` mit `merge_conflicts: [data-bid]`, und es wird nichts geschrieben. Ohne `base_html` bleibt alles wie bisher.
- **Bundle:** Das `bundle-manifest.json` trägt `editorApi`. `GET /content/editor-bundle.zip` liest den Header `X-Editor-Api` (Majors, die die Schale kann; ohne Header gilt 1). Passt kein Major, kommt `409 EDITOR_API_UNSUPPORTED` mit `params: { client, server }`.

**Clients dürfen:** `base_html` beim Push mitschicken (Android: damit gibt es Auto-Merge ohne eigene Merge-Logik), `X-Editor-Api: 1` senden und `409 EDITOR_API_UNSUPPORTED` als «gecachtes Bundle behalten, Update-Hinweis» behandeln.

**Entfernt:** `GET /content/macclient-i18n.json` (OTA-Override der macOS-UI-Strings). Die Strings der Mac-Schale kommen nur noch aus den gebündelten Katalogen der App. Ältere Macs bekommen `404`, das sie schon immer still als «kein Override» behandeln; ihr zuletzt gecachter Override bleibt bis zum App-Update liegen.

**macOS muss:** `I18nBundleStore` und den OTA-Zweig im `L10nStore` streichen und den Cache `i18n-cache.json` (+ `.meta.json`) beim Start löschen.

**Clients sollen:** Ihre Decoding-Tests auf `contract/fixtures/` umstellen (`scripts/sync-contract.sh` im Client-Repo).

**macOS soll:** Den Fallback auf `controller._focusUpdateActive` in `applyGranularity` streichen; `setGranularity` liefert jedes Bundle seit dem Standalone-Hook. Aus `editor-surface.json` und der Schuldenliste in `tests/unit/editor-surface.test.js` fällt der Eintrag erst mit `npm run contract:surface -- --prune`, wenn der Admin-Tab «Geräte» keinen Mac unter dieser Version mehr zeigt: Mac 3.27 und älter greifen weiter darauf zu.
