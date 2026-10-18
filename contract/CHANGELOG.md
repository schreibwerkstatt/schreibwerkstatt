# Client-Vertrag — Änderungen

Neueste oben. Je Abschnitt: was sich geändert hat, und was ein Client tun **muss** (Bruch, Frist) bzw. tun **darf** (neues Feld, neuer Weg). Regeln: [README.md](README.md).

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
