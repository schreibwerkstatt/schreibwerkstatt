# Client-Vertrag — Änderungen

Neueste oben. Je Abschnitt: was sich geändert hat, und was ein Client tun **muss** (Bruch, Frist) bzw. tun **darf** (neues Feld, neuer Weg). Regeln: [README.md](README.md).

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
