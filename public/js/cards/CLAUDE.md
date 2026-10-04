# Karten-Regeln (`public/js/cards/`)

Gilt zusaetzlich zur Root-[CLAUDE.md](../../../CLAUDE.md).

- **Frontend-State-Architektur Pflicht: [docs/state-modell.md](../../../docs/state-modell.md)** — die Datei ist die **verbindliche, drift-gepflegte SSoT** für den gesamten Alpine-State-Aufbau. Vor **jeder** Änderung am Frontend-State **zuerst dort die richtige Ebene wählen** — Root (`Alpine.data('lektorat')`) vs. Sub-Karte (`Alpine.data('xxxCard')`) vs. Store (`Alpine.store(...)`) entscheidet über Reaktivität, Lifecycle und Speicherlecks. Gilt für: neues Root-State-Feld (→ passender Slice in [app-state.js](../../../public/js/app/app-state.js)), neue Karte (Lifecycle via `setupCardLifecycle`), geteilten Fach-State (Store statt Root-Proxy als Soll-Endbild), Window-Event-Bus, Root-Zugriff aus Subs (`$app`/`window.__app`, nie `$root`), globale Listener (Pflicht: `{ signal: this._abortCtrl.signal }`), sowie die **vier orthogonalen Editor-Modi des Notebook-Editors** mit ihrer Kombinations-Matrix + 7 Pflicht-Invarianten. **Bei jeder Änderung, die das State-Modell berührt, die Doku im selben Commit aktualisieren** (Slice-Tabelle, Karten-Inventar verweist auf [register-cards.js](../../../public/js/app/register-cards.js) als SSoT, Editor-Modi-Invarianten + Zeilen-Refs) — sonst driftet sie wie zuletzt geschehen. Editor-Modus-Erweiterung folgt zwingend dem Schritt-Rezept am Ende der Doku.

- **Memo-Pattern: ein Helper pro Modul** — Aggregat-Methoden, die im Template mehrfach pro Render aufgerufen werden, MÜSSEN memoized sein. Der **eine** `_memo(key, deps[], fn)`-Helper (Array-Deps, shallow `===`) kommt aus [card-memo.js](card-memo.js): Methods-Objekt bzw. Karte spreadet `...memoMethods`, keine lokale Kopie. Kein Mix aus `_memo`/`_memoN`/handrolled Cache-Vergleichen. Gemeinsamer `this._memos`-Speicher pro Card-Instanz (im Initial-State deklarieren). `loadXxx`/`resetXxx` weisen `this._memos = {}` zu (Cache-Reset bei Daten-Reload). Pure Compute-Body (ohne `this._memo`) als `_computeXxx` extrahieren, vom memoizierten Wrapper aufrufen — testbar ohne Alpine. Gegated: [tests/unit/dedup-tripwire.test.mjs](../../../tests/unit/dedup-tripwire.test.mjs) (bant `_memoN`-Varianten und lokale `_memo`-Definitionen).

- **State explizit deklariert** — fachlicher Karten-State gehört entweder in `app-state.js` (wenn root-relevant) oder als Initial-Feld im `Alpine.data`-Objekt. Lazy `this._privates`, die nur in Methoden auftauchen, sind verboten — nicht inventarisierbar via Lookup. Ausnahme: kurzlebige Re-Entry-Guards in async-Methoden (z.B. `_loadingBookId`, `_staleCheckBookId`), wenn klar als solche dokumentiert.

## Neue Karte anlegen

Der Frontend-Scope ist in **Alpine.data-Sub-Komponenten** aufgeteilt:
- **Root** (`x-data="lektorat"` am `<body>`): Navigations-/Session-/i18n-Methoden (der State dazu liegt in `$store.nav`/`$store.session`/`$store.shell`), `showXxxCard`-Flags (Single Source of Truth für Hash-Router + Exklusivität), Job-Queue-Footer, globale Cross-Cutting-Methoden (`t`, `loadFiguren`, `selectPage`, `gotoStelle` …).
- **Sub-Komponenten** in [public/js/cards/](../../../public/js/cards/) — eine pro UI-Karte. Buchebene: Figuren, Orte, Szenen, Ereignisse, Stil, Fehler-Heatmap, BookStats, BookSettings, UserSettings, Kontinuität, Ideen, Finetune-Export, PDF-Export, Buch-Overview, Buch-Chat, Buch-Review, Kapitel-Review, Palette. Editor-Subs: editor-find, editor-synonyme, editor-figur-lookup, editor-toolbar, editor-focus, editor-entities, lektorat-findings, page-history. Plus Abschnitts-Chat. Jede besitzt fachlichen State + Lifecycle.
- **Im Root** verbleibt: `page-view`, `editor/edit`, `editor/utils`, Hash-Router, Auto-Save, Selection-Management, Navigation. Editor-UI-Slices laufen als eigene Cards mit Trampoline-Events aus dem Root (z.B. `editor:focus:toggle`).

**Neue Karte anlegen:**
1. Fachmodul in `public/js/` → Methods-Export (`export const xxxMethods = { ... }`), Root-Zugriffe via `window.__app.xxx` (siehe unten).
2. Sub-Komponente in `public/js/cards/xxx-card.js` → `Alpine.data('xxxCard', () => ({ ...state, init(), destroy(), ...xxxMethods }))`, Lifecycle über `setupCardLifecycle` ([public/js/cards/card-lifecycle.js](../../../public/js/cards/card-lifecycle.js)); als `registerXxxCard()` exportiert und in [public/js/app/register-cards.js](../../../public/js/app/register-cards.js) aufgerufen (SSoT des Karten-Inventars).
3. Partial in `public/partials/xxx.html` mit `x-data="xxxCard"` am Wurzel-`<div class="card">`. Root-Zugriffe im Template via `$app.xxx`.
4. `showXxxCard`-Flag in `app-state.js` → `cardsState`.
5. **Pflicht: Eintrag in `EXCLUSIVE_CARDS` ([public/js/cards/feature-registry.js](../../../public/js/cards/feature-registry.js))** — minimal `{ key: 'xxx', flag: 'showXxxCard', toggle: 'toggleXxxCard', partial: 'xxx' }`. Daraus **generiert** `_toggleCardGeneric` die Root-Toggle-Methode (`generatedToggles` in [public/js/app/app-view/_shared.js](../../../public/js/app/app-view/_shared.js)) inkl. Exklusivität, Lazy-Partial-Load und Scroll-to; `_closeOtherMainCards`, `resetView` und `_maybeOpenBookOverview` iterieren über dieselbe Liste. Ohne Eintrag existiert die Toggle-Methode nicht, Exklusivität bricht und der Home-Klick öffnet keine Übersicht. Verhalten steuern die optionalen Felder (`onReclick: 'refresh'` statt Schliessen, `requiresBook`, `loadDeps`, `refreshName`, `auditEvent`, `extraRefreshOnOpen` — Feldliste im Kommentarblock über `EXCLUSIVE_CARDS`). **Keine handgeschriebene `toggleXxxCard()`** — nur bei echter Sonderlogik `bespoke: true` setzen und die Methode in [public/js/app/app-view/cards.js](../../../public/js/app/app-view/cards.js) implementieren (bzw. im Fachmodul, wie `toggleKapitelReviewCard`).
6. **Eintrag in `FEATURES` ([public/js/cards/feature-registry.js](../../../public/js/cards/feature-registry.js))** (Single Source of Truth für Quick-Pills + Command-Palette + Usage-Tracking) — bei `kind: 'toggle'` zusätzlich Key in `ALLOWED_KEYS` von [routes/usage.js](../../../routes/usage.js) ergänzen, sonst verwirft `/usage/track` lautlos. Karten, die nicht in der Palette erscheinen sollen (`kapitelReview`, `userSettings`), bleiben nur in `EXCLUSIVE_CARDS`.
7. Hash-Router ([public/js/app/app-hash-router.js](../../../public/js/app/app-hash-router.js)): Build-Branch in `_computeHash()`, Parse-Branch in `_applyHash()`, Flag ins `watchers`-Array in `_setupHashRouting()` aufnehmen (Store-basierte Quellen stattdessen als Getter in `storeWatched`).
8. **Pflicht bei neuer Karte: `npm run test:smoke`** — der Smoke-Test iteriert über `EXCLUSIVE_CARDS` und öffnet jede Karte in der echten App; nur diese Schicht deckt verschluckte Alpine-Expression-Fehler und eine vergessene Registrierung auf.
9. **Hilfetext pflegen (bei user-sichtbarem Feature):** Der Reiter „Funktionen" der Hilfe-Karte wird aus der Feature-Registry erzeugt ([help-catalog.js](../../../public/js/cards/help-catalog.js)). Neue Karte in `FEATURES` → `help.feat.<key>` in beiden Locales; Funktion ohne eigene Karte (Editor-Werkzeug, Panel, Dienst) → Eintrag in `HELP_EXTRAS` + `help.extra.<key>.title`/`.desc`. Rahmen und Plaketten: DESIGN.md „Hilfetext (Hilfe-Katalog)", gegated durch [tests/unit/help-catalog.test.mjs](../../../tests/unit/help-catalog.test.mjs) — eine Karte ohne Hilfetext macht CI rot. Soll das Feature auch auf die öffentliche Landing-Page, zusätzlich einen `landing.feat<N>Title`/`Desc`-Block nach DESIGN.md „Feature-Text (Landing)".

### Root-Zugriff aus Sub-Komponenten (`$app` / `window.__app`)

Alpine's `$root` zeigt auf das **nächste x-data-Element** (bei Sub-Komponenten also die Sub selbst), nicht auf die `lektorat`-Root. Darum gibt es `$app`:
- **In Templates** (Alpine-Expressions): `$app.t('key')`, `$app.selectedBookName`, `$app.editMode` — nur Root-Felder und -Methoden. Funktioniert über die Custom-Magic `Alpine.magic('app', …)` in [register-cards.js](../../../public/js/app/register-cards.js) (`registerAppMagics`).
- **In JS-Methoden/Gettern** (Sub-Komponenten): `window.__app.xxx` — der Root cached sich in `init()` in `window.__app` (garantiert reaktiver Alpine-Proxy). Alpine-Magics sind in JS-Getter-Ausführungen **nicht** zuverlässig verfügbar; `window.__app` ist robust.
- **Store-Felder nie über den Root:** `selectedBookId`, `uiLocale`, `currentUser`, `figuren` … leben in Stores ([docs/state-modell.md](../../../docs/state-modell.md), Ebene 3) und haben keinen Root-Proxy — `$app.selectedBookId`/`window.__app?.uiLocale` liefern still `undefined`. Zugriff via `$store.<name>.<feld>` (Template) bzw. `Alpine.store('<name>').<feld>` (JS). Gegated: [tests/unit/store-proxy-tripwire.test.mjs](../../../tests/unit/store-proxy-tripwire.test.mjs).

### Geteilter Fach-State: `Alpine.store('catalog')`

`figuren`, `orte`, `songs`, `szenen`, `globalZeitstrahl` leben in [public/js/cards/catalog-store.js](../../../public/js/cards/catalog-store.js). Kein Root-Proxy: Root-Methoden und gespreadete Module lesen `this.$store.catalog.figuren`, Sub-Komponenten `Alpine.store('catalog').figuren`, Templates `$store.catalog.figuren`. Loader reassignen die Arrays (nie pushen), damit die Lookup-Maps (`figurenById` …) neu bauen.

### Events zwischen Root und Subs

Root dispatched, Subs hören:
- **`book:changed`** — aus `_resetBookScopedState()`; Subs resetten State + laden bei offener Karte neu.
- **`view:reset`** — aus `resetView()`; Subs nullen lokalen State komplett.
- **`card:refresh` `{ name }`** — erneuter Klick auf offene Karte → Daten neu laden.
- **`job:reconnect` `{ type, jobId, job, extra? }`** — aus `checkPendingJobs()`; Review/Kapitel-Review-Subs übernehmen Loading-State + starten Polling.
- **`chat:reset` / `book-chat:reset`** — Root dispatcht beim Seitenwechsel / User-Settings-Danger-Reset; Chat-Subs leeren Session.
- **`kapitel-review:select` `{ chapterId }`** — aus Sidebar/Hash-Router; Sub setzt ihre `kapitelReviewChapterId`.

### Job-Polling (shared utilities)

Pure Funktionen in [public/js/cards/job-helpers.js](../../../public/js/cards/job-helpers.js):
- `startPoll(ctx, config)` — generischer Job-Poller mit explizitem ctx.
- `runningJobStatus(translate, …)` — Status-HTML mit Token-Info.

Für createJobFeature-ähnliche Karten: [public/js/cards/job-feature-card.js](../../../public/js/cards/job-feature-card.js) exportiert `createCardJobFeature(cfg)` — Sub-Variante der Root-Factory mit Flag am `$app` statt lokal.

### Feature-Toggle (Exklusivität)

Immer nur eine Hauptansicht aktiv. Buchebenen-Features und Seitenebenen-Features (Editor) sind gegenseitig exklusiv.
- Die Root-Toggle-Methode ruft `_closeOtherMainCards(keep)` auf (schliesst alle anderen Karten + Editor). Sie wird aus dem Registry-Eintrag **generiert** — `generatedToggles` in [public/js/app/app-view/_shared.js](../../../public/js/app/app-view/_shared.js) bindet `entry.toggle` an `_toggleCardGeneric`; nur `bespoke: true`-Karten bringen eine handgeschriebene Methode mit ([app-view/cards.js](../../../public/js/app/app-view/cards.js) bzw. dem Fachmodul).
- `selectPage()` ruft `_closeOtherMainCards()` (kein keep) — schliesst alle Buchkarten bevor der Editor öffnet. **Niemals Show-Flags in `selectPage` hand-pflegen** — drift-anfällig (neue Karte vergessen → bleibt beim Seitenklick offen). Helper ist SSoT für „alle Buchkarten zu".
- Jede neue Buchkarte braucht einen `EXCLUSIVE_CARDS`-Eintrag in [public/js/cards/feature-registry.js](../../../public/js/cards/feature-registry.js) (mindestens `{ key, flag, toggle, partial }`). `_closeOtherMainCards`, `resetView`, `_maybeOpenBookOverview` und die Toggle-Generierung lesen ausschliesslich daraus — keine Hand-Pflege in `app-view/` mehr.
- Sub-Komponenten haben **keine** eigenen `showXxxCard`-Flags — der Root ist SSoT. Subs hören auf `$watch(() => window.__app.showXxxCard)`.
- Abschnitts-Chat ist eine Ausnahme: läuft neben dem Editor, kein `_closeOtherMainCards` beim Öffnen.

### Scroll-to bei Karten-Toggle

SSoT: `_scrollToCardByKey(key)` + `_scrollToCardEl(el)` in [public/js/app/app-view/scroll.js](../../../public/js/app/app-view/scroll.js) (Facade [app-view.js](../../../public/js/app/app-view.js) spreadet die Submodule). Mobile (<960px): `scrollIntoView({ block: 'start' })` aufs Karten-Element. Desktop (>=960px): `window.scrollTo({ top: 0 })`.

**Pflicht-Aufrufer:**
- `_toggleCardGeneric` ruft `_scrollToCardByKey(entry.key)` nach `_ensurePartial` + Flag-Set. Reihenfolge zwingend — Selector `[x-show="$app.${flag}"]` findet das Element erst nach Partial-Inject.
- Refresh-Pfad (`onReclick: 'refresh'`) scrollt **auch** — Re-Klick auf offene Karte zentriert sie wieder, statt User weggescrollt zu lassen.
- Hash-Apply für bereits offene Karte (`_applyHash`-Branches): explizit `_scrollToCardByKey(key)` ergänzen, sonst landet User nach Deep-Link-Click ins Nichts.
- **Ausnahme `toggleXxxCard({ skipCardScroll: true })`:** wer direkt danach eine ZEILE anspringt (`openFigurById`/`openOrtById`/`openSzeneById`/`openEreignisById` via `_scrollToWhenReady`), unterdrückt den Karten-Scroll. **Why:** sonst laufen zwei Smooth-Animationen gegeneinander (Sprung an den Karten-Anfang + Sprung zur Zeile); landen sie im selben Frame, schluckt der Browser die zweite und das Ziel bleibt ausserhalb des Bildes. Nur mit einem präziseren Ziel setzen — ohne Zeilen-Scroll bliebe der User stehen, wo er war. Der Zeilen-Scroll wartet dafür auf eine **stabile dokument-absolute Position** des Ziels: „im DOM" heisst noch nicht „an seinem Platz", und ein Scroll in eine halb aufgebaute Liste ist ein No-op, nach dem das Ziel unbemerkt unterhalb des Bildes liegt.

**Anti-Pattern:**
- Eigene `el.scrollIntoView()`-Calls in Sub-Komponenten oder Toggle-Methoden — Mobile/Desktop-Branching dann doppelt + drift-anfällig.
- Scroll **vor** `await _ensurePartial`: Selector findet nichts (Cold-Open hat leeres `partial-<name>`-Div).
- `_closeOtherMainCards` selbst scrollen lassen: Helper schliesst nur, scroll gehört in den Toggle-Pfad.

**`onCardRefresh` ≠ Re-Load vom Server.** Standardfall ist lokaler Re-Render aus bereits geladenem State (z.B. `_rerender()` im Buchorganizer snapshot't aus `root.tree`). Server-Fetch (z.B. `root.loadPages()`) clear't Tree/Listen visible → Sidebar-Flicker bei jedem Re-Klick. Nur dispatchen, wenn Karte wirklich externe Drift hat.

## Command-Palette + Feature-Registry

**SSoT für UI-Features:** [public/js/cards/feature-registry.js](../../../public/js/cards/feature-registry.js) listet alle Karten (`kind: 'toggle'`), globalen Aktionen und Such-Provider. Quick-Pills, Command-Palette und Usage-Tracking lesen ausschliesslich daraus.

**Palette:** [public/js/cards/palette-card.js](../../../public/js/cards/palette-card.js) — Modal mit Such-Input + Sektionen aus Karten + globalen Aktionen + Such-Providern. Trigger: Cmd/Ctrl+K bzw. `/`. Prefix-Modi: `>` Befehle, `#` Seiten, `!` Kapitel, `@` Figuren, `$` Orte, `%` Szenen. Ohne Prefix: alles fuzzy gemixt (Score-Threshold in `FUZZY_THRESHOLD_PER_CHAR`).

**Karten-Keys synchron halten:** Wer eine neue Toggle-Karte hinzufügt, ergänzt sie in `FEATURES` (feature-registry) **und** in `ALLOWED_KEYS` von [routes/usage.js](../../../routes/usage.js). Sonst wird `/usage/track` lautlos verworfen → keine Recency-Position in der Palette.

**Recency:** [public/js/features-usage.js](../../../public/js/features-usage.js) wird in den Root gespreaded; `$watch` auf jeden Show-Flag (rising edge) ruft `/usage/track`. Beim Login lädt `/usage/recent` die letzten Keys; Fallback: `DEFAULT_RECENT_KEYS` aus feature-registry.
