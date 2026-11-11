# Blog-Sync (WordPress ↔ Buch)

Spec für bidirektionale Synchronisation zwischen einem self-hosted WordPress-Blog und einem Buch vom Typ `blog`.

## Eckdaten

- **Mapping:** 1 Blog == 1 Buch. 1 WP-Post == 1 Page in der App.
- **Gating:** Verbindung nur konfigurierbar, wenn `buchtyp === 'blog'` (siehe `prompt-config.json`).
- **Auth:** Basic-Auth über HTTPS mit einem WordPress-**Anwendungspasswort** (Benutzer → Profil → Anwendungspasswörter; das Login-Passwort nimmt die REST-API per Basic-Auth nicht an). URL/User/Passwort pro Buch in den Bucheinstellungen.
- **Trigger:** manuell. Einmaliger Initial-Import + ad-hoc Pull/Push + on-demand Reconcile (Link-Drift-Check). Kein Cron.
- **Editor:** WordPress Block-Editor (Gutenberg). Classic-Editor-Posts (ohne `<!-- wp:`-Kommentare) speichern in `content.raw` keine `<p>` — Absätze sind Leerzeilen, und erst `wpautop` macht beim Rendern HTML daraus. Der Pull wendet darum denselben Schritt an (`lib/wp-html/autop.js`, Nachbau von `wpautop`: Leerzeile → Absatz, einzelner Umbruch → `<br>`, Block-Elemente und `<pre>` unangetastet); ohne ihn würde der ganze Post **ein** Absatz, und ein Push schriebe ihn als einen Absatz-Block zurück (in einem Post mit Blöcken lässt WordPress `wpautop` weg). Beim Push gehen Classic-Posts als Block-HTML raus. Abschnitte, die ein früherer Import ohne Absatzbildung angelegt hat, repariert `lib/blog-pull.js#repullPages` (siehe „Reparatur").
- **Inline-Bilder:** werden bei Import erhalten (`<figure>`/`<img>` bleiben, `wp-image-<n>`-Klasse trägt die Attachment-ID) und bei Push als `wp:image`-Block rausgeschrieben. Relative Bildadressen (`/wp-content/uploads/…`) löst der Pull gegen die Blog-URL auf (sonst die Origin des Permalinks `link`) — in der App zeigten sie ins Leere, und der Push verwürfe sie. Bereits blog-gehostete Bilder bleiben unangetastet („gehostet" = derselbe Host wie die Verbindung, mit und ohne `www.`, Schema egal, oder Jetpacks Bild-CDN `i0…i3.wp.com/<host>/…`; `lib/wp-media.js#isBlogHosted`); data-URIs und fremd-gehostete Bilder werden vor dem Push in die WP-Mediathek hochgeladen (`lib/wp-media.js`, SSRF-guarded). Nicht-Bild-Embeds (`video`/`audio`/`iframe`/`embed`/`object`) werden beidseitig verworfen — ein Post, der sie in WordPress trägt, ist darum für den Push gesperrt (siehe „Push-Sperre" unter `runBlogPushJob`).
- **Categories/Tags/Featured-Image:** bewusst kein eigenes Mapping. Der Push sendet nur `content` (`updatePost` ist ein Partial-Update) → WP lässt Kategorien, Tags und Featured-Image unangetastet, sie bleiben also über einen Content-Push erhalten. In-App werden sie nicht gelesen/gesetzt.
- **Out-of-Scope:** Categories/Tags in-App bearbeiten, Featured-Image setzen, Auto-Pull, Mehrere Blogs pro Buch.

## Konflikt-Strategie (LWW)

Zwei Fragen pro Post (`lib/blog-merge.js#classifyPull`):

- **WP neuer?** — `post.modified_gmt` > `blog_page_links.wp_modified_at` (der zuletzt gesehene WP-Stand; Pull, Push und „App gewinnt" schreiben ihn).
- **App neuer?** — der jüngere von `pages.updated_at` und `page_headline.updated_at` (ein Titel-Werkstatt-Edit ist ein Edit des Beitrags, bewegt aber die Seite nicht) > **Sync-Punkt** = der jüngere von `last_pulled_at` und `last_pushed_at`.

| WP neuer | App neuer | Aktion |
|---|---|---|
| ja | nein | WP → App (Update der Page) |
| nein | ja | nichts; gehört in Push |
| nein | nein | no-op |
| ja | ja | `conflict_state='detected'` → User löst via Diff |

**Der Sync-Punkt ist der Stand, der wirklich abgeglichen wurde — nie „jetzt".** Der Push nimmt `last_pushed_at` **bevor** er Seite und Titel-Werkstatt liest; der Pull (und „WP gewinnt") nimmt den Stempel seiner eigenen Writes (`applyPostToPage` → `syncedAt` = jüngerer von `pages.updated_at` und `page_headline.updated_at` nach dem Schreiben, `blogs.markLinkPulled({ pulledAt })`). **Why:** ein Stempel „jetzt" nach dem HTTP-Call schloss einen Save ein, der während Bild-Upload oder Request landete — das Badge zeigte `synced`, obwohl die Änderung nie im Blog ankam. Gegated in `tests/integration/blog-sync-hardening.test.js` (mutationsgeprüft).

**Der Sync-Punkt ist Pull ODER Push.** Ein Push macht den App-Stand genauso zum gemeinsamen Stand wie ein Pull; nur gegen `last_pulled_at` verglichen, liefe jede gepushte Seite beim nächsten WP-Edit in einen Konflikt (und eine per Push entstandene Seite hat gar keinen Pull-Stamp). Das Badge im Buchorganizer rechnet mit derselben Regel (`sync-core.js#computeSyncStatus`, für beide Blog-Syncs).

**Push-Pre-Check:** vor jedem Update-Push liest der Job den Post (`getPost`). Ist `modified_gmt` jünger als `wp_modified_at`, hat jemand in WordPress geändert, was die App nie gesehen hat → `conflict_state='detected'`, `BLOG_CONFLICT` im Result, **kein** Schreib-Call (und kein Bild-Upload — der Check läuft vor dem Media-Pass). Ohne ihn überschriebe der Push fremde Änderungen stumm.

**Konflikt lösen** (`POST /blog/:book_id/pages/:page_id/resolve`, geteilte Route `routes/sync-router.js`): beide Seiten lesen den aktuellen Remote-Stand. `remote` (Alias `wp`) übernimmt ihn über denselben Weg wie der Pull (`lib/blog-pull.js#applyPostToPage`, inkl. Titel-Regel). `app` setzt `wp_modified_at` auf den gesehenen Stand und `conflict_state='resolved-app'` (`blogs.markConflictResolvedApp`) — sonst meldeten Pull und Pre-Check denselben WP-Edit sofort wieder.

## Schema-Migration N

Zwei neue Tabellen. Pflicht: `foreign_key_check`, `UPDATE schema_version`, `npm run squash:regen`, [erd.md](erd.md) updaten.

```sql
CREATE TABLE blog_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL UNIQUE REFERENCES books(book_id) ON DELETE CASCADE,
  base_url TEXT NOT NULL,                -- https:// nur
  username TEXT NOT NULL,
  password_enc BLOB NOT NULL,            -- AES via lib/crypto.js
  default_status TEXT NOT NULL DEFAULT 'draft'
    CHECK(default_status IN ('draft','publish','private')),
  initial_import_done_at TEXT,           -- NULL = noch nie importiert
  last_pull_at TEXT,
  last_push_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE blog_page_links (
  page_id INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
  blog_id INTEGER NOT NULL REFERENCES blog_connections(id) ON DELETE CASCADE,
  wp_post_id INTEGER NOT NULL,
  wp_modified_at TEXT NOT NULL,
  wp_status TEXT,
  wp_slug TEXT,
  last_pulled_at TEXT,
  last_pushed_at TEXT,
  conflict_state TEXT
    CHECK(conflict_state IN (NULL,'detected','resolved-app','resolved-wp')),
  locked_blocks TEXT,                    -- Push-Sperre, Migration 333 (siehe „Push-Sperre")
  UNIQUE(blog_id, wp_post_id)
);
CREATE INDEX idx_blog_page_links_blog ON blog_page_links(blog_id);
```

Dazu `sync_media_cache` (Migration 332, geteilt mit HubSpot) — siehe „Bild-Cache".

## Server-Module

| File | Inhalt |
|---|---|
| `lib/wp-client.js` | Basic-Auth-Header, HTTPS-Pflicht + SSRF-Guard (`validateBaseUrl`, `safeFetch` auf jedem Hop), Pagination via `X-WP-TotalPages` (sortiert nach `id` — eine Folge nach `modified` verschiebt sich, wenn drüben während des Laufs ein Post bearbeitet wird, und überspringt den Post an der Seitengrenze). Retry, Fehler-Codes und Byte-Deckel aus dem geteilten Kern (`lib/sync/request.js`, siehe „Geteilter Sync-Kern"); 401 → `BLOG_AUTH_FAILED` (Zugangsdaten falsch), 403 → `BLOG_FORBIDDEN` (angemeldet, aber abgewiesen: Sicherheits-Erweiterung sperrt die REST-API, oder die Rolle darf den Beitrag nicht bearbeiten). **Weiterleitung:** eine Blog-URL, die umleitet, ist eine falsch eingetragene URL. Ein Schreib-Request folgt keinem Redirect, und ein GET auf eine fremde Origin verliert die Anmeldung (`safeFetch` nimmt Credentials nicht mit) — WordPress antwortet dort 401. Beides wird `BLOG_REDIRECT` mit `location` = der vermutlich richtigen Blog-URL (Zieladresse ohne den REST-Pfad), statt „Passwort falsch" bzw. eines nackten `BLOG_HTTP_301`. `listPosts` liest `_fields` `id,title,content,excerpt,status,modified_gmt,date_gmt,date,slug,link,featured_media`. Methoden: `me()`, `listPosts({ page, perPage, modifiedAfter? })`, `getPost(id)`, `createPost(payload)` (kein Retry bei Netzfehler/5xx), `updatePost(id, payload)` (idempotent, Retry erlaubt), `uploadMedia({ data, filename, mimeType })` (Binär-Upload via `raw`-Body + `Content-Disposition`, kein Retry). Keine Categories/Tags-Endpoints. |
| `lib/wp-html.js` | Facade; Teilmodule unter `lib/wp-html/`: `dom.js` (Parser-Wurzel, Kommentar-Muster, `isAppClass`), `autop.js` (Absatzbildung für Classic-Posts), `lossy.js` (Push-Sperre, `ROUND_TRIP_BLOCKS`, Format-Prüfung). `wpToAppHtml(raw, stats?, { baseUrl? })` (**async**): Classic-Post → erst `wpautop`, dann strip alle `<!-- wp:* -->`/`<!-- /wp:* -->` Kommentare, **angehängtes Quellenverzeichnis entfernen** (`div.sw-bibliography`, siehe „Quellenverzeichnis im Post"), **Quellen-Chips ohne `data-src` zu Klartext degradieren** (zählt in `stats.citesDegraded`), `<pre><code>` zu `<pre>` auspacken (Gutenbergs Codeblock), relative `img`-Adressen gegen `baseUrl` auflösen, `img` auf `src`/`alt`/`class`(`wp-image-<n>`) reduzieren, Nicht-Bild-Embeds + bild-lose Figuren entfernen, Theme-Klassen verwerfen (`dom.js#isAppClass`: `wp-*` ausser `wp-image-<n>`, `has-*`, `is-*`, `size-*`, `align*`, `columns-*`), einen Bildnachweis-Absatz direkt hinter einer Abbildung wieder in die `<figure>` hängen, dann durch `lib/html-clean.js` (Single Chokepoint). Async, weil die Chip-Selektoren aus der ESM-SSoT `public/js/sources/cite-html.js` kommen statt aus einer Kopie. `appToWpHtml(html, { bibliography?, lead? })`: parse via linkedom, pro Block-Element passenden Gutenberg-Kommentar wrappen (siehe Block-Mapping); `<figure>`/`<img>` → `wp:image`. `appToWpHtmlWithMedia(html, { resolveImage, bibliography? })`: async Variante mit vorgelagertem Media-Pass (jedes `<img>` durch `resolveImage(src)` → src ersetzen / verwerfen). |
| `lib/wp-media.js` | WordPress-Hülle um den geteilten Bild-Resolver (`lib/sync/image-resolver.js`): „schon gehostet" = `isBlogHosted` (gleicher Host mit/ohne `www.`, Jetpack-CDN mit eigenem Host im Pfad), Upload in die Mediathek (`wp.uploadMedia`), Attachment-ID → `wp:image {"id":N}`. |
| `lib/blog-merge.js` | Pure `classifyPull({ hasLink, wpModifiedAt, linkModifiedAt, pageUpdatedAt, headlineUpdatedAt, lastPulledAt, lastPushedAt })` → `'create'`/`'update'`/`'conflict'`/`'skip'` + `newer(a,b)`, `latest(...)`, `syncPoint(link)`. Ausgelagert für testbare LWW-Logik ohne Job-/DB-Kontext. |
| `lib/blog-title.js` | Titel-Regeln für **beide** Blog-Syncs (WordPress + HubSpot), siehe „Titel". `splitDatePrefix`, `outgoingTitle`, `wpTitleText`, `importedPageName`, `planPulledTitle`. |
| `lib/blog-pull.js` | WP-Post → Seite für Import, Pull und „WP gewinnt": `createPageFromPost`, `applyPostToPage` (HTML, Titel, Lead, Teaser). Dazu die Import-Helfer, die WordPress und HubSpot teilen: `resolveYearChapter`, `yearOf` und `createLinkedPage` (Seite + Link idempotent, siehe „Sync-Jobs"). Die Vortags-Baseline nach dem Import kommt aus `lib/import-baseline.js#seedImportBaseline` (geteilt mit allen Import-Wegen). Dazu: Wieder-Anschluss beim Import (`makeRelinkIndex`, `pickRelinkTarget`), Delta-Cursor (`pullCursor`) und die Reparatur `repullPages` (siehe „Sync-Jobs"). Post-Datum (`postDay`, `postYear`) = `date` (Ortszeit der Website), nicht `date_gmt`. |
| `db/blogs.js` | CRUD für `blog_connections` + `blog_page_links`. Passwort beim Read via `lib/crypto.js` entschlüsseln, nie an Client returnen. `markLinkPulled({ …, pulledAt })` (Sync-Punkt), `setLockedBlocks` (Push-Sperre), `maxLinkModifiedAt` (jüngster gesehener WordPress-Stempel, Delta-Cursor). |
| `lib/html-clean.js#carryBlockIds` | Pull/„WP gewinnt": Block-IDs (`data-bid`) des bisherigen Stands auf das zurückgekommene HTML übertragen (Zuordnung Tag + Text in Dokumentreihenfolge, Abbildung über Alt-Text + Legende statt URL). WordPress kennt `data-bid` nicht; ohne Übertrag vergäbe jeder Pull neue IDs, und Querverweise auf Abbildungen/Tabellen (`data-xref-id`) verlören ihr Ziel. Ein geänderter Block bekommt bewusst eine neue ID. |
| `routes/blog.js` | `POST /blog/:book_id/test`, `POST /blog/:book_id/connect`; Status, Trennen, Links, Konflikt-Diff und -Auflösung kommen aus `routes/sync-router.js`. `router.param('book_id', bookParamHandler)` aus `lib/log-context.js`. Connect prüft serverseitig `buchtyp === 'blog'` (sonst 400 `BLOG_REQUIRES_BLOG_TYPE`); `__keep__` bzw. ein leeres Passwort übernimmt das gespeicherte Passwort **dieses Buchs** nur bei unveränderter URL + Benutzer (`_effectivePassword`, für Test **und** Connect — „Verbindung testen" geht so auch mit gespeichertem Passwort). `BLOG_REDIRECT` antwortet 422 mit `location`, das Formular nennt die Adresse (`blog.error.BLOG_REDIRECT_TO`). Eine **neue Blog-URL** verwirft Links und Import-/Pull-Stand (`db/blogs.js#upsertConnection`, Antwort `connection.targetChanged`). |
| `routes/jobs/blog-sync.js` | Import und Pull (WordPress-spezifisch). Push, Abgleich und die POST-Routen aller vier Job-Typen laufen über den geteilten Kern mit dem Adapter `lib/sync/providers/wordpress.js`. |

## Geteilter Sync-Kern (WordPress + HubSpot)

Beide Blog-Syncs laufen durch denselben Kern; der Anbieter liefert nur einen **Adapter** (`lib/sync/providers/wordpress.js`, `lib/sync/providers/hubspot.js`). Der Adapter-Vertrag steht im Kopfkommentar von `routes/jobs/sync/push.js`. Eine neue Regel, die beide betrifft, gehört hierher und in den Kern, nicht in einen Adapter.

| File | Inhalt |
|---|---|
| `lib/sync/request.js` | HTTP-Kern beider Clients: Retry, Backoff, `Retry-After`, Abbruch, Byte-Deckel (`readJson`, 32 MB), Fehler-Codes mit Präfix (`BLOG_*` / `HUBSPOT_*`: `_AUTH_FAILED`/`_FORBIDDEN` laut Client, `_RATE_LIMIT`, `_UPSTREAM`, `_TIMEOUT`, `_FETCH_FAILED`, `_HTTP_<n>`). **Retry-Regel:** 429 immer (nicht verarbeitet), Netzfehler/5xx nur bei idempotenten Requests — ein Create, dessen Antwort verloren ging, ist drüben womöglich angelegt; ein Retry legte den Post doppelt an. |
| `lib/sync/image-resolver.js` | Bild-Resolver für den Push, mit **Bild-Cache** (siehe unten): beim Ziel gehostet → bleibt; App-Seitenbild `/content/page-image/<id>` → Bytes aus der DB (nur aus **diesem** Buch, `getBookPageImage`) + Upload; data-URI/fremde URL → `safeFetch` (SSRF-Guard pro Hop, Hop-Limit 5) + Upload. MIME-Allowlist (jpeg/png/gif/webp/avif), 20-MB-Deckel; Fehler verwerfen nur das Bild. `resolveImagesInTree` ist der Media-Pass über einen geparsten Baum und reicht den Alt-Text des `<img>` an den Upload (`upload({ …, alt })`; WordPress setzt ihn als `alt_text` in der Mediathek). |
| `db/sync-media-cache.js` | **Bild-Cache** (`sync_media_cache`, je Verbindung `blog_id` XOR `hub_id`): Quelle → Adresse + ID beim Ziel. Schlüssel `sha256:<bytes>` (data-URI, App-Seitenbild) bzw. `url:<adresse>` (fremd gehostet, spart den Fetch). **Why:** der Push schreibt die neue Adresse nicht in den Abschnitt zurück (data-URIs und Seitenbilder bleiben in der App) — ohne Cache lud jeder Push dieselben Bilder erneut in Mediathek bzw. File-Manager. Ein Treffer zählt nicht als Upload; ein Cache-Fehler hält den Push nie auf. Geleert beim Zielwechsel. „Verbindung prüfen" prüft jeden Eintrag einzeln beim Ziel (Adapter `mediaOwner` + `mediaExists`: WordPress `GET /media/:id`, HubSpot `GET /files/v3/files/:id`) und verwirft nur gelöschte — den ganzen Cache zu leeren, liesse den nächsten Push jedes Bild als Dublette hochladen. Scheitert die Prüfung (anderer Fehler als 404), wird der Cache wie früher verworfen. |
| `lib/sync/providers/*.js` | Adapter: Client, DB-Zugriff, Remote-Stempel, `fetchRemote`/`isGone`/`lossyParts`, Render/Create/Update, Konflikt-Diff (`remoteView`, `applyRemote`). |
| `routes/jobs/sync/push.js` | Push-Schleife (siehe unten). |
| `routes/jobs/sync/reconcile.js` | Abgleich: 404 / Papierkorb / archiviert → Link weg; lebt → Status/URL (WordPress zusätzlich die Push-Sperre) nachziehen (`refreshLinkMeta`). Prüft danach den Bild-Cache je Eintrag (siehe `db/sync-media-cache.js`). Fehler als `<key>.error.<CODE>` (`push.js#errorKey`, sonst `<P>_RECONCILE_FAILED`). Ergebnis `{ checked, removed, refreshed }`. |
| `routes/jobs/sync/routes.js` | `mountSyncJobRoute` für alle `POST /jobs/<anbieter>-<aktion>`: Buch-ID → `setContext` → `guardBook(editor)` → Buchtyp → Dedup → `createJob`. Push dedupt pro **Abschnitts-Menge** und Modus (`dedupId = <book>:<sortierte ids>[:now|schedule]`) und nimmt optional `publish: 'now'` bzw. `publish_at: <ISO>` (Zukunft, höchstens zwei Jahre; sonst `400 <P>_PUBLISH_INVALID`). Import/Pull/Neu-Einlesen sind pro Buch exklusiv (`activeBookJob`, `409 <P>_SYNC_RUNNING`). |
| `routes/sync-router.js` | `GET /status`, `DELETE /`, `GET /links`, `GET /pages/:page_id/remote`, `POST /pages/:page_id/resolve` (`'app'` oder `'remote'`; `'wp'` als Alias). Remote-Fehler antworten **nie 401** — der globale fetch-Wrapper deutet jede 401 als abgelaufene Sitzung —, sondern 422 (Zugang abgelehnt), 429 oder 502. |
| `public/js/cards/sync/sync-core.js` | Frontend: Status-Modell, Push mit Polling, Konflikt-Diff, Fehler-Toasts für Aufrufe ohne Job (`_reportError`), lesbare Sperr-Gründe (`lockedPartKey`). |
| `public/js/cards/sync/push-dialog.js` | Push-Dialog: jeder Push läuft über ihn — Wort-Diff Blogstand → App-Stand (`page-revision-diff.js#renderInline`, nur bei verknüpften Beiträgen), Remote-Status, drei Wege: pushen, pushen + veröffentlichen, pushen + planen (Wanduhr der App-Zeitzone → UTC über `utils/date.js#zonedWallToIso`). |
| `public/partials/sync-dialogs.html` | Push-Dialog und Konflikt-Diff als natives `<dialog>` (`modal()`), im Root eingehängt und lazy geladen — beide gehen aus Buchorganizer **und** Notebook-Editor auf; in einer per `x-show` versteckten Karte blieben sie unsichtbar. |
| `public/js/book/book-settings/sync-shared.js` | Bucheinstellungen: laufende Jobs wiederfinden (`/jobs/active` → `{ jobId, status }`), Jobs starten, Trennen, Fehlertexte. |

**Push-Schleife** (`runSyncPushJob`) pro Abschnitt:

0. Pushes einer Verbindung (Anbieter + Buch) laufen **nacheinander** (`_serialized`): zwei parallele Jobs riefen sonst für denselben neuen Abschnitt beide `create` auf. Der Link wird deshalb erst in der Schleife gelesen.
1. Sync-Punkt `pushedAt` nehmen, dann Abschnitt laden; gehört er zum Buch?
2. Mit Link: offener Konflikt → `<P>_CONFLICT`. Sonst Vorab-Prüfung gegen den Remote-Stand (`fetchRemote(…, 'precheck')`): 404 oder Papierkorb/archiviert → Link weg, `<P>_REMOTE_GONE` (der **nächste** Push legt bewusst neu an — nie still im selben Lauf); Remote-Stempel jünger als der gesehene → `conflict_state='detected'`, `<P>_CONFLICT`; nicht übernehmbare Bestandteile → `<P>_UNSUPPORTED_BLOCKS` (nur WordPress; der Befund landet als `locked_blocks` am Link, auch wenn er wieder weg ist).
3. Quellen (Einheit = Seite), Titel nach `lib/blog-title.js`, Teaser, Render mit Media-Pass, Create bzw. Update — alles in **einem** `try` pro Abschnitt: ein Fehler im Vorbau trifft nur diesen Abschnitt, nie den ganzen Job. Der Teaser geht als Excerpt (WordPress) bzw. `postSummary` + `metaDescription` (HubSpot) mit; `slug` (`lib/slug.js#slugify` des Titels) **nur beim Anlegen** — danach nie mehr, ein geänderter Slug bräche jeden Link. Soll veröffentlicht werden und verlangt der Anbieter eine Meta-Description (`publishNeedsTeaser`, HubSpot), wird ein Abschnitt ohne Teaser **vor** dem Schreiben abgewiesen (`<P>_PUBLISH_NEEDS_TEASER`).
   - **Zweiter Blick vor dem Schreiben** (`changedSincePrecheck`): zwischen Vorab-Prüfung und Update liegen Quellen, Rendering und Bild-Uploads; der Remote-Stempel wird direkt davor noch einmal gelesen. Ist er jünger als der der Vorab-Prüfung → Konflikt statt stillem Überschreiben.
   - **Kein Doppel-Post nach Timeout:** ohne Link fragt der Push zuerst `findExistingRemote` (HubSpot: unverknüpfter Draft gleichen Titels vom eingestellten Autor) und aktualisiert einen Treffer statt neu anzulegen.
4. Link **sofort** nach dem Remote-Write (`linkAfterPush({ …, pushedAt })`). Ohne Link legte der nächste Push denselben Beitrag ein zweites Mal an.
5. Optional veröffentlichen/planen (`publish({ client, conn, pageId, remote, publish })`), **nach** dem letzten `linkAfterPush` (der setzte den Status sonst auf den des eben geschriebenen Entwurfs zurück). Der Adapter zieht Status/URL am Link nach. Scheitert nur das, ist der Push gelungen und `toastWarnings` meldet `sync.publish.failed`.
6. Create: lokaler Seitenname bekommt den app-internen Datums-Präfix von heute (`result.renamed`). Die Umbenennung läuft mit `expected_updated_at`; gelingt sie so, wird ihr Stempel der Sync-Punkt (eigener Write, kein lokaler Edit). Hat dazwischen jemand gespeichert, wird nur der Name nachgezogen und der Sync-Punkt bleibt `pushedAt`. Scheitert sie ganz, ist der Push trotzdem gelungen. `touchPush` (Anzeige „Letzter Push") nur, wenn mindestens ein Abschnitt ankam.
7. Ergebnis `{ pushed, createdRemote, conflictSkipped, published, imagesUploaded, imagesDropped, errors, renamed, toastWarnings }`. Ein Bild, das der Resolver verwirft (MIME, Grösse, nicht erreichbar), lässt den Push nicht scheitern, fehlt aber im Beitrag: gezählt wird es nur für gelungene Abschnitte, und `toastWarnings` (`sync.push.imagesDropped` mit Anzahl + Titeln) färbt den Job-Toast gelb (`app-jobs-core.js#_maybeShowJobToast`, gilt für jeden Job mit `result.toastWarnings`). Geht **kein** Abschnitt durch, endet der Job mit `failJob` und `<key>.error.<Code>` des ersten Grunds (unbekannte Codes → `<P>_PUSH_FAILED`; eine Weiterleitung mit bekanntem Ziel als `<key>.error.<P>_REDIRECT_TO` mit `{location}`). `toastWarnings`-Einträge mit `n` laufen im Frontend über `tn()` (Zähl-Text).

**Status-Modell** (Badge, `computeSyncStatus` in `sync-core.js`, für beide gleich): `new` (kein Link) · `conflict` (`conflict_state='detected'`) · `locked` (`locked_blocks` gesetzt — nur WordPress; nicht pushbar, Tooltip `sync.status.lockedTip` nennt die Elemente) · `push-needed` (`max(page.updated_at, headline_updated_at) > max(last_pulled_at, last_pushed_at)`) · `synced`. Labels `sync.status.*`. Daneben die Plakette des **Remote-Status** (`spec.remoteState(link)` → `draft` | `published` | `scheduled` | `private` | `pending`, Klassen `.badge--remote-*`, Labels `sync.remote.*`; WordPress aus `wp_status`, HubSpot aus `hubspot_state`). Der Push-Knopf erscheint auch bei `synced`, wenn der Beitrag drüben Entwurf oder geplant ist — der Dialog veröffentlicht bzw. plant ihn dann um.

**Zielwechsel:** eine Verbindung auf ein anderes Ziel (WordPress: andere URL; HubSpot: anderer Blog oder anderes Portal) verwirft Links, Import-Stand und Bild-Cache im selben Schreibvorgang. Sonst trüge ein Link die Post-ID des alten Ziels, und der nächste Push überschriebe drüben einen fremden Post mit derselben ID.

## Gutenberg-Block-Mapping (Push)

App-HTML → WP-Block-HTML:

| App-Tag | Gutenberg-Wrap |
|---|---|
| `<p>` | `<!-- wp:paragraph -->\n<p>…</p>\n<!-- /wp:paragraph -->` |
| `<h1>`…`<h6>` | `<!-- wp:heading {"level":N} -->\n<hN class="wp-block-heading">…</hN>\n<!-- /wp:heading -->` (Ebene 2 ohne `level`, Gutenbergs Vorgabe) |
| `<ul>` / `<ol>` | `<!-- wp:list -->` bzw. `{"ordered":true}`, je Punkt `wp:list-item`; eine **verschachtelte** Liste als eigener `wp:list`-Block im Listenpunkt (als rohes `<ul>` im `<li>` meldete der Block-Editor „unerwarteter Inhalt") |
| App-Klassen an `p`/`hN`/`ul`/`ol`/`li` | als Gutenberg-`className` + `class` (z.B. Todo-Liste `ul.todo`/`li.todo-item`) — der Pull behält genau diese (`_isAppClass`), die Blockart kommt zurück |
| `div.poem`, `div.msg-thread` | `wp:group {"className":"poem"}` bzw. `msg-thread`, je Zeile ein `wp:paragraph` (dieselbe Klassenliste wie `html-clean.js#_STRUCTURAL_DIV_CLASSES`) |
| loser Wrapper mit Blöcken (`<div>`, `<section>`…) | seine Kinder als Blöcke — nie `<p><p>…</p></p>` |
| `<blockquote>` | `<!-- wp:quote -->\n<blockquote class="wp-block-quote">…</blockquote>\n<!-- /wp:quote -->` |
| `<pre>` | `<!-- wp:code -->\n<pre class="wp-block-code"><code>…</code></pre>\n<!-- /wp:code -->` — der Text steht in `<code>`, weil Gutenbergs `core/code` ihn dort liest (ohne: „unerwarteter Inhalt"); App-Klassen (Diagramm `mermaid`) als `className`. Der Pull packt `<pre><code>` wieder zu `<pre>` aus. |
| `<hr>` | `<!-- wp:separator -->\n<hr class="wp-block-separator"/>\n<!-- /wp:separator -->` |
| Inline (`strong`, `em`, `a`, `u`) | unverändert innerhalb des Blocks |
| `<figure>`/`<img>` | `<!-- wp:image {"id":N,"sizeSlug":"full"} -->\n<figure class="wp-block-image size-full"><img src="…" alt="…" class="wp-image-N"/>…figcaption…</figure>\n<!-- /wp:image -->` (Attachment-ID `N` nur wenn bekannt; `figcaption` und ein Link ums Bild erhalten). Der **Bildnachweis** (`p.figure-credit`) folgt als eigener `wp:paragraph {"className":"figure-credit"}` — ein `<p>` in der Figur machte den Bildblock ungültig; der Pull hängt ihn wieder ein. Verschachtelte Figuren (früher importierte Galerie) → ein Bildblock je Bild. |
| `<video>`, `<audio>`, `<iframe>`, `<embed>`, `<object>` | strip (nicht round-trip-fähig) |

Unit-Tests: Grund-Mapping in `tests/unit/wp-html.test.mjs`, App-Blöcke + Round-Trip + Sperre in `tests/unit/wp-html-blocks.test.mjs`.

## Titel

SSoT [lib/blog-title.js](../lib/blog-title.js), gilt für WordPress **und** HubSpot.

**Raus (Push, Create und Update):** Titel-Werkstatt-Titel (`page_headline.titel`), sonst der Seitenname **ohne** den app-internen Datums-Präfix `YYYY-MM-DD: `. Beim Update geht der Titel immer mit (leer → nicht), damit eine Umbenennung in der App in WordPress ankommt — der Push-Pre-Check fängt vorher ab, dass drüben jemand den Titel geändert hat.

**Rein (Pull-Update, „WP gewinnt"):** `title.raw` (context=edit, unkodiert); nur ohne `raw` wird `title.rendered` gelesen und **entity-dekodiert** — wptexturize schreibt dort `&#8217;`/`&#8211;`/`&amp;`. Ziel ist dieselbe Stelle, aus der der Push liest: hat die Seite einen Werkstatt-Titel, landet ein geänderter WP-Titel **dort** (sonst überschriebe der nächste Push ihn mit dem alten); sonst im Seitennamen, und dessen **lokaler Datums-Präfix bleibt stehen** (er ist Ordnung im Buchorganizer und soll nicht auf das UTC-Datum des Posts springen). Umbenennungen landen in `job.result.renamed`; `sync-core.js#_applyPushRenames` zieht Tree und offenen Editor-Titel nach.

**Neu angelegt (Import, Pull-Create):** `YYYY-MM-DD: Titel` mit dem Datum des Posts in Ortszeit der Website (`date`, sonst `date_gmt`/`modified_gmt`) — dasselbe Datum, das der Blog zeigt; `date_gmt` schob Posts kurz nach Mitternacht auf den Vortag und am Neujahrsmorgen ins Vorjahres-Kapitel.

**Titel-Werkstatt, übrige Felder:**

- **Lead** → erster Block des Posts, in einem `wp:group` mit Marker-Klasse `sw-headline` (`HEADLINE_MARKER_CLASS` in `lib/wp-html.js`). Der Pull schneidet ihn heraus und meldet den Text (`stats.lead`) → `page_headline.lead`. Derselbe Akkumulations-Schutz wie beim Quellenverzeichnis: im Manuskript darf er nie ankommen. Fehlt der Block im Post, bleibt der Werkstatt-Lead unangetastet (keine Aussage).
- **Teaser** → `excerpt`. Zurück nur, wenn die Seite einen Teaser führt — ohne ihn schickt der Push auch keinen, und ein in WordPress gepflegter Auszug gehört WordPress.
- **Dachzeile** → geht nicht mit: WordPress setzt den Post-Titel über den Inhalt, eine Dachzeile im Inhalt stünde **unter** der Schlagzeile.

## Quellenverzeichnis im Post

Bei `bibliography_enabled && bibliography_in_blog` (Bucheinstellungen → Quellen) hängt der Push das Quellenverzeichnis an den Post. **Einheit ist die Seite** — ein Post ist genau eine Seite, also läuft `buildBibliography({ bookId, pageIds: [pageId], userEmail })`; die Nummern des numerischen Stils folgen den Fundstellen dieses einen Posts ab 1. Davor läuft `resolveCitesInHtml` über das Seiten-HTML, damit der Kurzbeleg im Chip den aktuellen Zitierstil zeigt (der gespeicherte Text ist nur ein Cache — siehe [publikation-export.md](publikation-export.md) und `lib/bibliography.js`).

Markup: ein `wp:group` mit der Marker-Klasse, darin `wp:heading` + `wp:list` (Autor-Jahr-Stile) bzw. `wp:paragraph` je Eintrag (numerischer Stil — sein `[n]`-Präfix ist selbst das Label, und eine auto-numerierte `<ol>` würde bei `bibliography_scope='all'` falsch zählen, weil unzitierte Quellen ohne Nummer hinten anhängen).

```
<!-- wp:group {"className":"sw-bibliography"} -->
<div class="wp-block-group sw-bibliography">
<!-- wp:heading --><h2 class="wp-block-heading">Quellenverzeichnis</h2><!-- /wp:heading -->
<!-- wp:list --><ul><!-- wp:list-item --><li>Kafka, F. (1915). <em>Die Verwandlung</em>.</li><!-- /wp:list-item --></ul><!-- /wp:list -->
</div>
<!-- /wp:group -->
```

### Pflicht-Invariante: der Pull entfernt es wieder

**Das angehängte Verzeichnis MUSS beim Pull verschwinden.** Der Sync ist bidirektional mit LWW: bleibt es stehen, liest der nächste Pull es als Seitentext ins Manuskript, der Push danach hängt ein zweites an — und es wächst pro Zyklus weiter. Das Verzeichnis ist ein **Render-Artefakt** und darf nie in `pages.content` landen (Invariante A in `lib/bibliography.js`).

Umsetzung: `appToWpHtml` schreibt den Marker (`BIBLIOGRAPHY_MARKER_CLASS`), `wpToAppHtml` entfernt `div.sw-bibliography` wie die `_DROP_EMBEDS`. Beide Richtungen stehen **bewusst in derselben Datei** — auf zwei Module verteilt hält die Invariante nicht. Gutenberg schreibt `className` in die Klassenliste des gerenderten `<div>`, der Marker ist also in `content.raw` **und** `content.rendered` zu finden; der Klassenfilter von `wpToAppHtml` behält ihn (Theme-Klassen fliegen raus, siehe `_isAppClass`).

Gegated durch `tests/unit/wp-html.test.mjs`: `appToWpHtml → wpToAppHtml` mit Verzeichnis muss buchstabengleich dasselbe liefern wie ohne, über drei Zyklen hinweg, mit erhaltenem `data-src`/`data-loc` am Chip. Der Pull-Strip ist mutationsgeprüft (Strip deaktivieren ⇒ drei Tests rot).

### KSES: Chip ohne Zeiger

WordPress' KSES entfernt `data-*`-Attribute, wenn dem verbundenen Benutzer die Capability `unfiltered_html` fehlt (bei Multisite fehlt sie auch Admins). Dann kommt vom Pull ein `<span class="cite">(Kafka, 1915, S. 44)</span>` **ohne Zeiger** zurück — eine Quellenangabe, die auf nichts zeigt.

> **Nicht empirisch verifiziert.** Ob eine konkrete Instanz die `data-*`-Attribute durchlässt, hängt an Rolle und Multisite-Setup des verbundenen Benutzers und ist gegen eine echte Instanz noch nicht gemessen. Der Code ist deshalb defensiv gebaut und funktioniert in **beiden** Fällen: überlebt der Zeiger, passiert nichts; fällt er weg, greift die Degradierung unten. Wer es prüft: eine Seite mit Quellenangabe pushen, pullen, im Seiten-HTML nach `data-src` sehen — bzw. auf den Hinweis im Blog-Tab achten. Ergebnis dann hier eintragen und diesen Kasten entfernen.

`wpToAppHtml` degradiert solche Chips zu reinem Text: der lesbare Kurzbeleg bleibt im Satz (er ist das einzige, was noch da ist), das Chip-Markup fällt weg. **Es wird nie auf eine Quelle geraten** — nicht über den Chip-Text (der ist explizit nur ein Cache und unterscheidet zwei Quellen desselben Autors im selben Jahr nicht) und nicht über die Quellenliste des Buchs; ein falscher Zeiger wäre schlimmer als keiner, weil er unbemerkt ins Verzeichnis wanderte. Der Fall wird gezählt (`stats.citesDegraded`), landet in `job.result.citesDegraded` von Import und Pull, geht als Warnung ins Log und erscheint im Blog-Tab als `.card-form-warn`-Hinweis (`blog.status.citesDegraded`).

Ein `span.cite` mit unbrauchbarem `data-src` (`"0"`, `"abc"`) ist laut SSoT kein Nachweis, sondern Fremdmarkup — es wird ebenfalls entpackt, aber **nicht** als KSES-Verlust gezählt.

## Sync-Jobs

**Import und Pull sind pro Buch exklusiv** (`BOOK_EXCLUSIVE_TYPES` in [routes/jobs/blog-sync.js](../routes/jobs/blog-sync.js), Prüfung in `routes/jobs/sync/routes.js#activeBookJob`): beide legen Seiten und Links an. Läuft für das Buch schon einer der beiden — egal von wem —, antwortet `POST /jobs/blog-import` bzw. `/jobs/blog-pull` mit `409 BLOG_SYNC_RUNNING`; den eigenen laufenden Job desselben Typs bekommt der Aufrufer wie üblich als `{ jobId, existing: true }` zurück.

**Seite + Link entstehen idempotent** über `lib/blog-pull.js#createLinkedPage` (WordPress: `createLinkedPageFromPost` für Import und Pull-Create; derselbe Baustein trägt den HubSpot-Import): ein schon verlinkter Post wird übersprungen; verliert der Lauf zwischen Check und Link das Rennen um `UNIQUE(blog_id, wp_post_id)`, entfernt er die eben angelegte Seite wieder, statt sie verwaist im Buch zu lassen.

### `runBlogImportJob(bookId)` — einmalig

Gated: `initial_import_done_at IS NULL`. Zweiter Aufruf → 400 `ALREADY_IMPORTED`.

1. paginate `listPosts({ perPage: 100 })` — ein 400 jenseits der ersten Seite ist das Listenende (drüben während des Laufs gelöschte Posts lassen `X-WP-TotalPages` schrumpfen), kein Fehler des Laufs (`_listPage`, auch im Pull)
2. pro Post: **bereits verlinkt → überspringen** (`job.result.skipped`). Ein abgebrochener Import hinterlässt Links ohne `initial_import_done_at`; ohne den Skip scheiterte jeder weitere Lauf an `UNIQUE(blog_id, wp_post_id)`.
3. **Wieder-Anschluss** (`createLinkedPageFromPost` mit `relinkIndex`): nach einem Zielwechsel oder Trennen + neu Verbinden sind die Links weg, die Abschnitte nicht. Eine Post-ID-Spur gibt es dann nirgends mehr (`wp_post_id` lebt nur in `blog_page_links`). Der Import hängt den Post darum an einen **unverlinkten** Abschnitt desselben Buchs (auch nicht an einem HubSpot-Blog), dessen Name dem entspricht, den er selbst vergäbe (`importedPageName`), sonst an einen mit demselben Titel ohne Datums-Präfix — nur bei **genau einem** Treffer, mehrdeutig → neu anlegen. Gleicher Inhalt (ohne Block-IDs, Leerraum zwischen Tags) → verknüpft und `synced`; abweichender Inhalt → `conflict_state='detected'`, der User entscheidet im Diff, statt dass der Import still überschreibt. Zählt in `job.result.relinked` / `relinkConflicts`. Titel-Werkstatt-Titel zählen beim Abgleich nicht.
4. sonst Page + Link anlegen (`createLinkedPageFromPost`, Name siehe „Titel"), Link mit `wp_modified_at = post.modified_gmt`, `last_pulled_at = jetzt`
5. Status via `updateJob` mit Key `job.blog.import.progress`, Params `{done, total}`
6. am Ende `initial_import_done_at`, `last_pull_at = Start des Laufs`

### `runBlogPullJob(bookId)` — manuell, Delta

Voraussetzung: Initial-Import durch. Sonst 400 `IMPORT_FIRST`.

1. `listPosts({ modifiedAfter })` paginieren. `modified_after` vergleicht WordPress mit **seiner** Uhr, `last_pull_at` ist ein Stempel der App-Uhr. Darum `lib/blog-pull.js#pullCursor`: der **frühere** von `last_pull_at` und dem jüngsten gesehenen WordPress-Stempel (`MAX(wp_modified_at)` der Links, WP-Uhr) minus 60 s Marge. Geht WordPress nach, bestimmt der WP-Stempel (sonst fiele ein Edit kurz nach dem Start aus jedem Delta); ein Zukunftsstempel (Migrations-Plugin) zieht den Cursor nicht nach vorn, weil `last_pull_at` ihn deckelt. Doppelt gesehene Posts sind harmlos: `classifyPull` → `skip`, ein verlinkter Post wird nicht neu angelegt.
2. pro Post: Push-Sperre nachführen (`setLockedBlocks`), **`wp_status`/`wp_slug` immer nachziehen** (`refreshLinkMeta`, auch ohne Inhaltsänderung — „in WordPress veröffentlicht" kommt so an), dann 4-Fall-LWW aus „Konflikt-Strategie"; `update` schreibt über `applyPostToPage` (HTML mit übertragenen Block-IDs, Titel, Lead, Teaser; Sync-Punkt = Stempel der eigenen Writes) mit `expected_updated_at` = dem Seitenstand, auf dem `classifyPull` entschieden hat. Speichert jemand die Seite während des Pulls, wirft `savePage` `PAGE_CONFLICT` — der Pull überschreibt dann nicht, sondern setzt `conflict_state='detected'` und zählt den Post als Konflikt wie einen LWW-Konflikt.
3. neue Posts (kein Link) → `createLinkedPageFromPost`
4. `last_pull_at = Start des Laufs` — ein Stempel vom Ende liesse Posts aus, die WordPress während des Laufs geändert hat

### Reparatur: Job `blog-repull` → `repullPages({ bookId, pageIds, userEmail, signal?, logger?, onProgress? })`

Knopf «Unbearbeitete neu einlesen» in den Bucheinstellungen (`appConfirm` davor) startet `runBlogRepullJob` über **alle** Links der Verbindung; pro Buch exklusiv wie Import/Pull. Übersprungene lokal bearbeitete Abschnitte und Konflikte meldet ein gelber Toast (`sync.repull.skipped`).

Zieht die verlinkten Posts der Abschnitte neu (`applyPostToPage`: Inhalt, Titel, Lead, Teaser) — für Abschnitte, die ein früherer Import falsch umgesetzt hat (Classic-Posts ohne Absatzbildung). Rechte und Buchtyp prüft der Aufrufer. Überschrieben wird nur, was seit dem Sync-Punkt lokal unverändert ist (Seite und Titel-Werkstatt nicht jünger als `max(last_pulled_at, last_pushed_at)`, kein offener Konflikt), mit `expected_updated_at`. Revision: `contentStore.savePage` legt vorher eine Baseline an, falls der Abschnitt noch keine hat, und danach eine Revision des neuen Stands (Quelle `import`) — der alte Stand bleibt wiederherstellbar. Rückgabe `{ repulled, skipped: [{ pageId, reason }], renamed }`, Gründe `NOT_LINKED`, `PAGE_NOT_FOUND`, `CONFLICT`, `LOCAL_CHANGES`, `REMOTE_GONE` oder der Remote-Code (`BLOG_*`).

### `runBlogPushJob(bookId, pageIds[])` — manuell, Multi-Select

Läuft durch die geteilte Push-Schleife (siehe „Geteilter Sync-Kern"). WordPress-spezifisch:

- **Render:** `appToWpHtmlWithMedia(html, { resolveImage, bibliography, lead })` — Media-Pass (WP-Mediathek, `job.result.imagesUploaded`), Lead als markierter erster Block, Verzeichnis bei aktivem `bibliography_in_blog` als markierter Anhang (siehe „Quellenverzeichnis im Post").
- **Create:** `createPost({ title, content, excerpt?, slug?, status: conn.default_status })`. **Update:** `updatePost(id, { content, title?, excerpt? })`, `wp_modified_at` aus der Response.
- **Veröffentlichen/Planen** (Push-Dialog): `updatePost(id, { status: 'publish' })` bzw. `{ status: 'future', date_gmt }` (UTC ohne Zone). `future` ist nur hier erlaubt, nicht als Standard-Status einer Verbindung. Der Statuswechsel ändert `modified_gmt`; `blogs.markLinkPublished` übernimmt ihn als gesehenen Stand, sonst meldete der nächste Push den eigenen Statuswechsel als Konflikt.
- **Vorab-Prüfung:** Remote-Stempel `modified_gmt` gegen `wp_modified_at` (siehe „Konflikt-Strategie"); Papierkorb (`status: 'trash'`) gilt als gelöscht.
- **Push-Sperre** (nach der Konfliktprüfung): enthält der aktuelle WordPress-Stand etwas, das `wpToAppHtml` nicht übernimmt — `lib/wp-html.js#wpLossyBlocks`: jeder Gutenberg-Block **ausserhalb der Allowlist** `_ROUND_TRIP_BLOCKS` (genau die Blöcke, die `_wrapBlock` selbst schreibt, plus `freeform`; z.B. Galerie, Spalten, Buttons, Embeds, Weiterlesen-Marke `wp:more`, Plugin- und wiederverwendbare Blöcke), dazu `video`/`audio`/`iframe`/`embed`/`object`/`picture`, Figuren ohne Bild, Figuren mit mehreren Bildern (Classic-Galerie), Inline-Hintergrundbilder, Weiterlesen-/Seitenumbruch-Marke im Classic-Post (`more`, `nextpage`; im Block-Post meldet `wp:more` sie) und **Format-Attribute, die der Pull verwirft** (`format:*`, siehe unten) —, wird **nicht** gepusht. Allowlist statt Blocklist: ein unvorhergesehener Block ist gesperrt, nicht still verloren. Neuer Block in `_wrapBlock` ⇒ in `lib/wp-html/lossy.js#ROUND_TRIP_BLOCKS` eintragen.

  **Format-Sperre** (`lossy.js#formatLosses`, Entscheid: sperren statt mitführen). Der Pull verwirft `style` und die WordPress-Klassen (`dom.js#isAppClass`); was davon im Blog **sichtbar** war, sperrt mit Grund: `format:text-align` (`has-text-align-center|right|justify`, `style="text-align"`), `format:drop-cap`, `format:color` (`has-*-color`, `has-background`, `has-inline-color`, `<mark style>`, `style="color|background"`), `format:font-size`, `format:font-family`, `format:align` (`alignleft|right|center|wide|full` an Bild/Block), `format:image-size` (`is-resized`, `style="width|height"` an Bild/Figur), `format:block-style` (`is-style-*` ausser `default`), `format:list-start` (`<ol start|reversed>`), jede andere Style-Deklaration als `format:style-<eigenschaft>` und jede andere verworfene WP-Klasse als `format:<klasse>`. **Frei** (gemessen an Block- und Classic-Editor-Ausgaben, verworfen ohne sichtbare Folge): `wp-*` (Block-Kennung; `wp-image-<n>` behält der Pull ohnehin), `size-*` (Grössenwahl — die Datei-URL in `src` bleibt dieselbe; Gutenbergs Vorgabe `size-large` sperrte sonst fast jeden Post mit Bild), `alignnone` (Classic-Vorgabe), `is-layout-*`, `is-style-default`, `has-fixed-layout` (Tabellen-Vorgabe), `has-alpha-channel-opacity` (Trenner-Vorgabe, schreibt der Push selbst), `has-text-align-left` (LTR-Vorgabe), `has-text-align-*` an `td`/`th` (der Pull hebt sie auf `data-align`), `width`/`height`-**Attribute** an Classic-Bildern (passen zur Datei), `srcset`/`sizes`, Block-Attribute ohne HTML-Spur (`sizeSlug`, `linkDestination`), Kopier-Reste ohne Wirkung im `style` (`font-weight:400|normal`, `font-style:normal`, `text-decoration:none`, `vertical-align:baseline`, `white-space:pre-wrap`, transparenter Hintergrund). Eine weitere Ausnahme muss dieselbe Bedingung erfüllen; der eigene Push-Output bleibt frei (gegated in `wp-html-blocks.test.mjs` und `wp-sync-fixes.test.js`). Der Befund steht als `blog_page_links.locked_blocks` am Link (Import, Pull, Vorab-Prüfung, Abgleich, „WP gewinnt" führen ihn nach) — das Badge `locked` zeigt die Sperre, **bevor** jemand den Abschnitt in der App bearbeitet. Bei der Sperre: `BLOG_UNSUPPORTED_BLOCKS` mit `blocks` (Kennungen) ins Result. **Why:** der Push ersetzt den ganzen `content`; ein Tippfehler-Fix in der App löschte sonst das Video im Live-Blog, das in der App nie sichtbar war. Solche Beiträge werden in WordPress bearbeitet. Der eigene Push-Output gilt immer als sicher (gegated in `wp-html.test.mjs`), ein von der App geschriebener Post wird also nie gesperrt.

### `runBlogReconcileJob(bookId)` — on demand

Geteilter Abgleich (siehe „Geteilter Sync-Kern"): pro Link `getPost`; 404 oder Papierkorb → Link weg (Abschnitt bleibt, Badge `new`), sonst `wp_status`/`wp_slug` nachziehen. Deckt Hard-Delete und Papierkorb drüben — beides taucht in keinem Pull-Delta auf.

## UI

### BookSettings-Tab „Blog-Verbindung"

Sichtbar nur bei `buchtyp === 'blog'`. Form-Felder:

- URL (HTTPS-Validierung, sonst Submit-Button disabled + Hint)
- Username
- Password (write-only; Read liefert `hasCredentials: true`); Hinweis darunter: Anwendungspasswort, nicht Login-Passwort (`blog.connect.passwordHint`)
- Default-Status (Combobox: draft/publish/private)
- Test-Button → `users/me` mit `capabilities.edit_posts`-Check; mit leerem Passwortfeld bei gespeicherter Verbindung testet er das gespeicherte Passwort
- Speichern mit **geänderter Blog-URL** → vorher `appConfirm` (`blog.connect.targetChangeConfirm`, `danger`): Links und Import-Stand werden zurückgesetzt, der nächste Import verknüpft gleichnamige Abschnitte wieder

Status-Panel: `initial_import_done_at`, `last_pull_at`, `last_push_at` (alle via `tzOpts`).

Aktion-Buttons:
- **„Initial-Import starten"** — nur sichtbar wenn `!initial_import_done_at`
- **„Pull"** — nur sichtbar wenn Import durch
- **„Verbindung prüfen"** — Reconcile-Job; nur sichtbar wenn Import durch. Ruft `GET /posts/{id}` für jeden Link, dropt 404-/Papierkorb-Orphans, prüft den Bild-Cache je Medium. Confirm-Dialog vor Start (kann je nach Link-Anzahl dauern).
- **„Unbearbeitete neu einlesen"** — Reparatur-Job `blog-repull` (siehe „Reparatur"); nur sichtbar wenn Import durch.
- **„Disconnect"** — löscht Connection-Row + Links via FK-CASCADE; die Rückfrage (`blog.connect.disconnectConfirm`) nennt die Folgen und den Wieder-Anschluss beim nächsten Import

### Sync-Core (geteilt mit HubSpot)

`blog-sync-card.js` ist ein dünner Wrapper über [public/js/cards/sync/sync-core.js](../public/js/cards/sync/sync-core.js): die Provider-Spec liefert nur `endpointBase: '/blog'`, `jobTypes: { push: 'blog-push', refresh: ['blog-import','blog-pull','blog-repull'], reconcile: 'blog-reconcile' }`, `remoteState`, `liveUpdate: true` (ein Update an einem veröffentlichten Beitrag ist sofort live — der Dialog sagt das) und `viewUrl` (nicht veröffentlichte Beiträge mit `&preview=true`). Status-Modell, Push und Konflikt-Diff gelten für alle Provider. Templates iterieren über `$syncProviders` ([register-cards.js](../public/js/app/register-cards.js)) — Badges in [organizer-page-actions.html](../public/partials/organizer-page-actions.html) / [editor-notebook.html](../public/partials/editor-notebook.html), Push-Dialog und Konflikt-Diff in [sync-dialogs.html](../public/partials/sync-dialogs.html). CSS-Accent: `.sync-provider--blog { --sync-accent: var(--card-accent-blog); }`.

### Buchorganizer

Pro Page ein eckiges Badge (`--card-accent-blog`) mit Status (Modell siehe „Geteilter Sync-Kern"):

- `new` — kein Link
- `synced` — Seite und Titel-Werkstatt nicht jünger als der Sync-Punkt
- `push-needed` — `max(page.updated_at, headline_updated_at) > max(last_pulled_at, last_pushed_at)` (`/blog/:book_id/links` liefert `headline_updated_at` per Join mit)
- `conflict` — `conflict_state='detected'`
- `locked` — `locked_blocks` gesetzt: Beitrag enthält drüben nicht übernehmbare Elemente, Push gesperrt

Tooltip via `data-tip` (`statusTip(page)`; bei `locked` mit der Liste der Elemente).

Page-Kontext:
- „Zu Blog pushen" — öffnet den Push-Dialog (Vorschau, pushen / veröffentlichen / planen)
- „Konflikt lösen" — Diff-Modal lokal vs. WordPress (`GET /blog/:book_id/pages/:page_id/remote`), Auflösung über `POST …/resolve`

Buch-Level: Multi-Select aus Tree + „Lokale Änderungen pushen".

## i18n

Neue Keys in `public/js/i18n/de.json` + `public/js/i18n/en.json`:

```
blog.connect.title|url|user|password|defaultStatus|test|save|disconnect
blog.status.notImported|imported|draft|publish|private|citesDegraded
sync.status.new|synced|pushNeeded|conflict|locked|lockedTip   (geteilt mit HubSpot)
sync.conflict.local|keepApp                          (geteilt mit HubSpot)
blog.conflict.title|remote|takeRemote
blog.action.import|pull|push|reconcile|reconcileHint|reconcileConfirm|resolveConflict
blog.error.<Server-Code>   (1:1 der error_code, z.B. BLOG_AUTH_FAILED, BLOG_FORBIDDEN, BLOG_CONFLICT, BLOG_REMOTE_GONE, BLOG_RATE_LIMIT, BLOG_TIMEOUT, BLOG_REDIRECT, BLOG_INVALID_STATUS, SSRF_*)
blog.error.BLOG_REDIRECT_TO (mit {location}, nur Formular Test/Connect — der Push-Toast nennt keine Adresse)
blog.connect.targetChangeConfirm (Parameter {from}, {to})
blog.error.BLOG_HTTP       (Sammeltext für BLOG_HTTP_<n>, Parameter {status} — sync-shared.js#syncErrorText)
job.label.blogReconcile
job.blog.import.progress
job.blog.pull.fetch|job.blog.pull.merge
job.blog.push.upload
job.blog.reconcile.check
```

Persistierte Conflict-Notice in DB: `__i18n:blog.conflict.detected__`.

Buchtyp-Label in [prompt-config.json](../prompt-config.json):

```json
"buchtypen": {
  "de": { "blog": { "label": "Blog", "zusatz": "Blog-Einträge. Pro Eintrag eigenständig…" } },
  "en": { "blog": { "label": "Blog", "zusatz": "Blog posts. Each entry self-contained…" } }
}
```

## Sicherheit

- `base_url` MUSS mit `https://` beginnen — sonst 400 `BLOG_HTTPS_REQUIRED`
- Passwort: AES-Encrypt via [lib/crypto.js](../lib/crypto.js). `GET /blog/:book_id/status` liefert nur `{ hasCredentials, baseUrl, username, defaultStatus, …timestamps }`. PW nie an Client.
- Connect-Test: `users/me` muss `capabilities.edit_posts === true` zurückgeben.
- 401 von WP → `BLOG_AUTH_FAILED`, 403 → `BLOG_FORBIDDEN`; die Routen antworten darauf mit 422, nie mit 401 (siehe „Geteilter Sync-Kern")
- Buchtyp-Gate serverseitig hart: Connect/Import/Pull/Push prüfen `buchtyp === 'blog'`, sonst 400 `BLOG_REQUIRES_BLOG_TYPE`
- Job-Dedup via `findActiveJobId` verhindert doppelte Läufe desselben Typs pro User (Push: pro Abschnitts-Menge); Import und Pull sind zusätzlich buchweit exklusiv (`409 BLOG_SYNC_RUNNING`, siehe „Sync-Jobs")
- `setContext({ book: bookId })` in jedem Job-POST (Logging-Slot)

## Tests

### Unit (`tests/unit/`)
- `wp-html-lead.test.mjs` — Lead-Block: Marker + Escape beim Push, `stats.lead` beim Pull, nie im Seitentext, genau einmal über drei Zyklen
- `blog-title.test.mjs` — Titel-Regeln (Datums-Präfix, Werkstatt-Vorrang, Entity-Decode, Pull-Plan)
- `wp-sync-fixes.test.js` — Classic-Absätze + `more`/`nextpage`-Sperre, Format-Sperre (freie Standard-Ausgaben vs. gesperrte Formate), Codeblock mit `<code>`, relative Bilder, `isBlogHosted`, Post-Datum `date`, `pullCursor`, Redirect → `BLOG_REDIRECT`, Lesefelder, Wieder-Anschluss beim Import, `wp_status` bei jedem Pull, Pagination-Ende, gespeichertes Passwort beim Test, `repullPages`
- `wp-html.test.mjs` — Block-Wrap/Unwrap Round-Trip, Inline-Erhalt, Bild-Erhalt bei Import + `wp:image`-Wrap bei Export (inkl. Attachment-ID + figcaption), Nicht-Bild-Embed-Strip, async Media-Pass (`appToWpHtmlWithMedia`); **Quellenverzeichnis:** markierter `wp:group`-Anhang, Listen- vs. Absatz-Form je Zitierstil, die Akkumulations-Invariante (Round-Trip mit == ohne Verzeichnis, auch über drei Zyklen, `data-src` erhalten — mutationsgeprüft) und der KSES-Guard (Chip ohne `data-src` → Klartext + gezählt, nie geraten)
- `wp-html-blocks.test.mjs` — App-Blöcke im Round-Trip (Bildnachweis, Bild-Link, Gedicht, h5/h6, Todo, verschachtelte Liste), Allowlist der Push-Sperre (Galerie, Spalten, `wp:more`, Plugin-Block; eigener Push nie gesperrt), Theme-Klassen-Filter, `carryBlockIds`
- `wp-client.test.mjs` — Pagination via `X-WP-TotalPages` (Folge nach `id`), 401/403-Handling, HTTPS-Reject, Backoff bei 429/5xx, kein Retry eines Creates bei 5xx, Retry des Updates
- `sync-image-resolver.test.mjs` — geteilter Resolver: App-Seitenbild nur aus dem eigenen Buch, beim Ziel gehostete Bilder ohne Upload, Media-Pass über den Baum, Bild-Cache (Treffer ohne Upload/Fetch, kaputter Cache hält nicht auf), kaputte data-URI → verworfen
- `sync-target-change.test.js` — Zielwechsel verwirft Links + Import-Stand (WordPress-URL, HubSpot-Blog/-Portal), anderer Benutzer/Autor nicht
- `wp-media.test.mjs` — Resolver: blog-gehostet unverändert, data-URI/fremde URL → Upload, MIME-Reject, Fetch-Fehler → `null`
- `blog-merge.test.mjs` — alle 4 LWW-Fälle (`classifyPull`) + `newer`-Vergleich, Sync-Punkt Pull-oder-Push, Titel-Werkstatt-Edit als lokaler Edit

### Integration (`tests/integration/`)
- `blog-sync.test.js` — WP-Stub ([_helpers/mock-wp.js](../tests/integration/_helpers/mock-wp.js)), Initial-Import, Push (Update/Create mit Datums-Präfix), Konflikt-Pfad: gleichzeitige Änderung beidseits → `conflict_state='detected'`, Papierkorb im Push (`BLOG_REMOTE_GONE`) und im Abgleich.
- `blog-sync-hardening.test.js` — Save während des Pushs bleibt `push-needed`, Bild nur einmal hochgeladen (Cache; „Verbindung prüfen" leert ihn), Link steht auch bei gescheiterter Umbenennung, Galerie nach Import gesperrt (`locked_blocks`, Push abgewiesen), Pull behält Block-IDs. Sync-Punkt, Cache und Block-ID-Übertrag sind mutationsgeprüft.
- `blog-sync-roundtrip.test.js` — mehrstufige Fälle: Push → WP-Edit → Pull ohne falschen Konflikt (Create- und Update-Weg), Push-Pre-Check + „App gewinnt", Import nach Abbruch, Entity-Titel, Titel-Werkstatt raus und zurück. Die ersten drei plus der Werkstatt-Fall sind mutationsgeprüft (Sync-Punkt nur Pull bzw. Pre-Check aus ⇒ rot).

### Drift
- `tests/unit/erd-drift.test.mjs` grünt nach ERD-Update
- `tests/unit/squash-drift.test.mjs` grünt nach `npm run squash:regen`

## Reihenfolge der Umsetzung

1. Buchtyp `blog` in [prompt-config.json](../prompt-config.json) (de+en)
2. Migration N + ERD + `npm run squash:regen` + Drift-Tests grün
3. `lib/wp-client.js` + Unit-Tests
4. `lib/wp-html.js` + Block-Mapping + Unit-Tests
5. `db/blogs.js` + `routes/blog.js` (mit Buchtyp-Gate)
6. `routes/jobs/blog-sync.js` (Import → Pull → Push) + Integration-Tests
7. BookSettings-Tab (Form + Aktionen)
8. Buchorganizer-Badges + Push-Action + Konflikt-Diff-Reuse
9. i18n komplett (de + en synchron)
10. `SHELL_CACHE` bump in [public/sw.js](../public/sw.js)
11. Manuell gegen echte WP-Instanz testen (Test-Buch 102 als Typ `blog`)
