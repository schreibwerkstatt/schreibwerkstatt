# HubSpot-Sync (Buch ↔ HubSpot-Blog)

Spec für den HubSpot-Blog-Workflow eines Buchs vom Typ `blog`. Import (wiederholbar, holt neue Posts nach), Per-Abschnitt-Push in den **Draft-Buffer**, Abgleich. Push, Abgleich, Job-Routen, Status-Modell, Konflikt-Diff und Bild-Upload teilt HubSpot mit WordPress — **[blog-sync.md → „Geteilter Sync-Kern"](blog-sync.md#geteilter-sync-kern-wordpress--hubspot)** ist dafür die einzige Beschreibung. Hier steht nur, was HubSpot anders macht (Adapter [lib/sync/providers/hubspot.js](../lib/sync/providers/hubspot.js)).

## Eckdaten

- **Mapping:** 1 Buch == 1 HubSpot-Blog (`contentGroupId`) + 1 Autor (`blogAuthorId`). 1 HubSpot-Post == 1 Abschnitt.
- **Gating:** Verbindung nur konfigurierbar, wenn `buchtyp === 'blog'` (serverseitig hart, `HUBSPOT_REQUIRES_BLOG_TYPE`).
- **Auth:** Private Access Token (PAT, `pat-…`) als Bearer. Token pro Buch verschlüsselt in der DB ([lib/crypto.js](../lib/crypto.js)). Scopes: `content` (Blog, Posts, Autoren) und `files` (Bild-Upload beim Push).
- **Trigger:** manuell. Kein Delta-Pull für verknüpfte Posts — der einzige Weg zurück ist „HubSpot übernehmen" im Konflikt-Diff. Neue Posts holt „Neue Posts importieren".
- **Push schreibt den Draft-Buffer:** Erst-Push `POST /cms/v3/blogs/posts` mit `state: 'DRAFT'`; Re-Push `PATCH /cms/v3/blogs/posts/{id}/draft`. Die Live-Version ändert sich erst beim Veröffentlichen: im Push-Dialog («Pushen und veröffentlichen» → `POST …/draft/push-live`, «Pushen und planen» → `POST /cms/v3/blogs/posts/schedule`) oder in HubSpot. Der Teaser der Titel-Werkstatt geht als `postSummary` **und** `metaDescription` mit (HubSpot verlangt sie zum Veröffentlichen; ohne Teaser weist der Push «veröffentlichen» vorab ab), der Slug nur beim Anlegen. Tags und Featured Image: in HubSpot. Nicht gegen ein echtes Portal geprüft: ob `push-live` einen nie veröffentlichten Entwurf ebenso live schaltet wie einen Buffer.
- **Bilder beim Zurücklesen:** Import, „HubSpot übernehmen" und der Bilder-Nachzug übernehmen die Bilder des Posts und legen sie als **Abschnittsbilder** ab ([lib/sync/image-mirror.js](../lib/sync/image-mirror.js)#`mirrorRemoteImages`): `safeFetch` (SSRF-Guard pro Hop, Typ-Allowlist, 20 MB), `preparePageImage`, `insertPageImage`, `<img src="/content/page-image/<id>">`; ein `<p>`, das nur ein Bild trägt, wird `<figure>`. Grund: das HubSpot-CDN steht nicht in der CSP der App (`img-src`); ein Abschnittsbild geht dagegen überall (Editoren, Share-Reader, Exporte, offline). **Rundweg:** der Spiegel schreibt in den geteilten Bild-Cache `sha256:<gespeicherte Bytes>` → **Original-Adresse** — genau den Schlüssel, den der Push-Resolver für ein Abschnittsbild bildet. Ein Push setzt darum die ursprüngliche HubSpot-Adresse wieder ein, ohne Upload und ohne Dublette im File-Manager. Ein Bild, das sich nicht laden lässt, behält seine HubSpot-Adresse (in der App unsichtbar, beim Push unverändert). Wiederholtes Zurücklesen nutzt schon gespiegelte Bilder des Abschnitts wieder (`appImageRemoteMap`), statt neue Zeilen anzulegen; dieselbe Datei unter CDN-, Blog- und Skalier-Adresse gilt als ein Bild (`remoteImageKey`: alles ab `/hubfs/`, ohne Portal-Segment und Query). Deckel 60 Bilder je Post.
- **Bilder beim Push:** in den File-Manager (`POST /files/v3/files`, Ordner `/schreibwerkstatt`, `PUBLIC_NOT_INDEXABLE`) — App-Seitenbilder, data-URIs und fremd gehostete Bilder; schon bei HubSpot liegende bleiben (Hosts `*.hubspotusercontent*.net`, `hubspot.net`, `hubfs.net`, `hs-sites.com` sowie jeder Pfad unter `/hubfs/` bzw. `/hs-fs/hubfs/`, auch auf der eigenen Blog-Domain). Einmal hochgeladene Quellen merkt sich der geteilte Bild-Cache je Verbindung (`sync_media_cache.hub_id`, siehe [blog-sync.md → „Geteilter Sync-Kern"](blog-sync.md#geteilter-sync-kern-wordpress--hubspot)) — ein Re-Push lädt sie nicht erneut in den File-Manager. Ein gespiegeltes Abschnittsbild findet der Resolver über den Bild-Cache und nimmt die Original-Adresse (siehe oben).
- **Quellen:** Chips werden zu Klartext (`span` steht in keiner Allowlist-Map, der Kurzbeleg bleibt im Satz). Bei `bibliography_in_blog` hängt der Push das Verzeichnis als `<h2>` + Liste an, jeder Block mit der Marker-Klasse `sw-bibliography`; der Lead steht als `<p class="ms-head__lead">` davor. **Beides schneidet das Zurücklesen wieder heraus** („HubSpot übernehmen", Konflikt-Diff, Import): sonst landete es im Abschnittstext, und der nächste Push hängte es ein zweites Mal an. Streicht HubSpot die Klassen, greift ein inhaltlicher Rückfall (erster Absatz = Lead der Titel-Werkstatt, letzte Überschrift = Verzeichnis-Titel).
- **Out-of-Scope:** Delta-Pull, Tags/Topics, Featured-Image, OAuth (nur PAT), mehrere Blogs pro Buch, Inline-Formatierung aus HubSpot (Farben, Schriftarten — geht beim Push verloren, sperrt bewusst nicht, siehe „Push-Sperre"). Im Client vorbereitet, aber nicht angebunden: `metaDescription`/`slug` (Adapter `create`/`update`), `publishDraft`, `schedule`, `postStatus`.

## HTML ([lib/hubspot-html.js](../lib/hubspot-html.js))

Eine Allowlist, zwei Richtungen:

- `hubspotToAppHtml(raw, { lead, bibTitle, stats, images })` (Import, „HubSpot übernehmen", Konflikt-Diff, Push-Sperre): Jinja-Marker (`{{…}}`, `{%…%}`, `{#…#}`) raus — nur innerhalb eines Textstücks zwischen zwei Tags, nie über eine Elementgrenze; CMS-Wrapper (`.hs-cta-*`, `.hs-form`, `.hs-embed-wrapper`), Skripte und Medien raus; Bilder nur mit `images: true` (https-`src` + `alt`, `<figure>` mit Legende — Import und „übernehmen" spiegeln sie danach); Push-Zusätze (Lead, Verzeichnis) raus, `stats.lead` meldet den Lead-Text.
- `hubspotLossyParts(raw)` (Push-Sperre) und `hubspotImageSrcs(raw)` (Bildabgleich), siehe „Push-Sperre".
- `appToHubspotHtml(html, { images })` (Push): dieselbe Allowlist; `images: true` erst nach dem Media-Pass (nur `https://`-Quellen, `alt`, `<figure>` + `<figcaption>`). Eine wörtliche `{` vor `{`/`%`/`#` geht als `&#123;` raus — HubSpot sähe sonst HubL, und der Import strich sie.

| App/HubSpot | Ergebnis |
|---|---|
| `strong`/`b`, `em`/`i`, `u`, `s`/`del`/`strike`, `sup`, `sub`, `code`, `br` | `strong`, `em`, `u`, `s`, `sup`, `sub`, `code`, `br` (fette `font-weight` ≥ 600 → `strong`) |
| `a[href^=http(s)]` | Link; sonst nur der Text |
| `h1`, `h2` · `h3` · `h4`–`h6` | `h2` · `h3` · `h4` |
| `p`, `ul`/`ol[start]`/`li` (Unterlisten bleiben), `blockquote` (mit Absätzen), `pre` (`<br>` → Zeilenumbruch), `hr` | gleich |
| mehrere Blöcke in `li` / `td` | durch `<br>` getrennt |
| `table` | `table` mit `caption`, `thead` (`th scope="col"`), `tbody`; Ausrichtung App `data-align` ↔ HubSpot `style="text-align"` |
| unbekanntes Element | entpackt; lose Inline-Läufe auf Block-Ebene werden eigene `<p>` |

**Invarianten:** Text vor der ersten Überschrift oder eine Tabelle am Anfang darf den Rest des Posts nie zu einem Absatz zusammenziehen — jeder Block bleibt Block. Push-Zusätze wandern nie in den Abschnitt zurück (gegated in [hubspot-html.test.mjs](../tests/unit/hubspot-html.test.mjs)).

## Was der Adapter anders macht

| Punkt | HubSpot |
|---|---|
| Vorab-Prüfung + Konflikt-Diff | lesen den **Draft** (`GET …/draft`), weil der Push genau ihn überschreibt; Stempel `updated` gegen `hubspot_updated_at`. Links ohne Stempel (Import vor Migration 330) vergleichen gegen ihren Sync-Punkt (`last_pulled_at`/`last_pushed_at` = Zeitpunkt, an dem der Abschnitt den Post-Stand übernahm): ein danach geänderter Draft ist ein Konflikt. Der nächste Push setzt den Stempel. |
| Abgleich | liest den **Post** (`GET /cms/v3/blogs/posts/{id}`): 404 oder archiviert → Link weg; sonst `hubspot_state` + `hubspot_url` nachziehen (in HubSpot publiziert → „Ansehen" zeigt den Live-Post). |
| Titel | `name` **und** `htmlTitle` = Titel nach [lib/blog-title.js](../lib/blog-title.js); beim Import zählt `name` (der Post-Titel), `htmlTitle` (SEO-/Tab-Titel, oft mit « \| Blogname») nur als Rückfall. |
| Lead · Teaser · Dachzeile | Lead als erster Absatz vor dem Body · Teaser → `postSummary` (escapet) · Dachzeile geht nicht mit (stünde unter dem Titel). |
| Autor | `blogAuthorId` + `authorName` (einmal pro Job aus `listAuthors()` aufgelöst — HubSpot v3 setzt den Autor bei manchen Portalen nur mit Namen). |
| „HubSpot übernehmen" | Draft-Body durch `hubspotToAppHtml` ohne Push-Zusätze (Bilder, Module, CTAs entfallen — der Button sagt das; Quellen-Chips kommen als Text, Diagramme als Codeblock zurück), Block-IDs des bisherigen Stands per `carryBlockIds`, Lead aus dem markierten Lead-Absatz in die Titel-Werkstatt, Titel nach `planPulledTitle`; danach `last_pulled_at` = Stempel der eigenen Writes. |
| Push-Dialog | Der Push-Dialog (geteilt, `sync/push-dialog.js`) zeigt bei verknüpften Posts den Hinweis `hubspot.repush.warning` (`spec.pushNote`): Inline-Formatierung aus HubSpot geht verloren; Module, CTAs, Formulare und fehlende Bilder sperren den Push (siehe „Push-Sperre"). Tags, Slug, Featured Image bleiben (der `PATCH` schickt sie nicht). Ein Edit am Draft in HubSpot fällt in der Vorab-Prüfung als Konflikt auf. |
| Push-Sperre | `lossyParts(draft, { pageId, bookId, html })`, siehe unten; Tooltip `hubspot.status.lockedTip` (`spec.lockedTip`). |
| Erst-Push ohne Link | `findExistingRemote` sucht vorher einen unverknüpften DRAFT gleichen Titels vom konfigurierten Autor (verlorene Antwort eines früheren Creates, Link nach Trennen weg); ein Treffer wird aktualisiert statt doppelt angelegt. |
| „Ansehen" | `DRAFT` → Editor-URL `https://app.hubspot.com/blog/<portalId>/editor/<postId>/content` (ohne HubSpot-Login wäre der Draft nicht erreichbar); sonst `hubspot_url`. |

## Push-Sperre

Der Push ersetzt den ganzen Body des Entwurfs. Was der Entwurf trägt, die App aber nicht übernimmt, wäre danach weg — darum sperrt die Vorab-Prüfung den Abschnitt (`HUBSPOT_UNSUPPORTED_BLOCKS` mit `blocks`, Badge «nur im Blog»), wie bei WordPress ([blog-sync.md → „Push-Sperre"](blog-sync.md)). Zwei Quellen:

- **Strukturell** ([lib/hubspot-html.js](../lib/hubspot-html.js)#`hubspotLossyParts`, Allowlist-Denken: alles, was `hubspotToAppHtml` entfernt, statt seinen Text zu behalten): `hs-cta` (CTA-Wrapper oder HubL `{{ cta(…) }}`), `hs-form` (`.hs-form`, `<form>`, HubL `{% form %}`), `hs-module` (jedes andere HubL im Text), `hs-embed`, `iframe`, `video`, `audio`, `object`, `embed`, `picture`, `hs-graphic` (SVG/Canvas), `hs-script`, `hs-style`, `image-unsupported` (Bild ohne https-Adresse). Unbekannte Container (div/span) sperren nicht — ihr Text bleibt. **Inline-Formatierung sperrt bewusst nicht:** eingefügter Text trägt Farbe/Schrift in fast jedem Post; die Sperre gälte sonst überall, und verloren geht nur Optik, kein Inhalt.
- **Bild fehlt im Abschnitt** (`image-missing`, nur in der Vorab-Prüfung, weil sie den Abschnitt kennt): ein Bild des Entwurfs, das der Abschnitt weder als HubSpot-Adresse noch als gespiegeltes Abschnittsbild mit Cache-Eintrag trägt (`missingImageCount`). Typischer Fall: ein Post, der vor dem Bild-Spiegel importiert wurde. Hat jemand ein Bild in der App bewusst gelöscht, bleibt die Sperre, bis es auch in HubSpot weg ist — sonst wäre «bewusst gelöscht» nicht von «nie übernommen» zu unterscheiden.

Geführt wird `locked_blocks` beim Import und Wiederverknüpfen (strukturell aus dem veröffentlichten Post), in der Vorab-Prüfung (beides), nach „HubSpot übernehmen" (strukturell; die Bilder sind dann gespiegelt) und beim Abgleich (strukturell aus dem Post, eine bestehende Bildsperre bleibt stehen).

## Bilder-Nachzug (Job `hubspot-images`)

Für Posts, die vor dem Bild-Spiegel importiert wurden: «Bilder nachholen» in den Bucheinstellungen ([routes/jobs/hubspot-sync.js](../routes/jobs/hubspot-sync.js)#`runHubspotImageRepairJob`, buchweit exklusiv mit dem Import). Je verknüpftem Abschnitt wird der Entwurf gelesen; nur wo Bilder fehlen und es sicher ist, zieht `applyRemote` ihn neu (Inhalt + gespiegelte Bilder, Block-IDs bleiben, `expected_updated_at`, Revisions-Quelle `import` mit Baseline):

- Abschnitt seit dem Sync-Punkt bearbeitet → **unangetastet**, `LOCAL_CHANGES`, Bildsperre gesetzt; der Toast nennt die Zahl (`hubspot.images.localChanges`).
- Entwurf seit dem gesehenen Stand geändert → `conflict_state = 'detected'`, der Konflikt-Diff entscheidet (übernehmen spiegelt ebenfalls).
- Offener Konflikt, gelöschter Post → übersprungen mit Grund.

Ergebnis `{ repaired, images, skipped: [{ pageId, reason }] }`.

## Schema

```sql
CREATE TABLE hubspot_connections (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id                INTEGER NOT NULL UNIQUE REFERENCES books(book_id) ON DELETE CASCADE,
  token_enc              BLOB NOT NULL,          -- AES via lib/crypto.js
  blog_id                TEXT NOT NULL,          -- contentGroupId
  author_id              TEXT NOT NULL,          -- blogAuthorId
  portal_id              TEXT,                   -- HubID für die Editor-URL
  initial_import_done_at TEXT,                   -- NULL = noch nie importiert
  last_import_at         TEXT,
  last_push_at           TEXT,
  created_at, updated_at TEXT …
);

CREATE TABLE hubspot_page_links (
  page_id            INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
  hub_id             INTEGER NOT NULL REFERENCES hubspot_connections(id) ON DELETE CASCADE,
  hubspot_post_id    TEXT NOT NULL,
  hubspot_state      TEXT,                       -- DRAFT | PUBLISHED | …
  hubspot_created_at TEXT,
  hubspot_updated_at TEXT,                       -- zuletzt gesehener Draft-`updated` (Vorab-Prüfung)
  last_pushed_at     TEXT,                       -- Sync-Punkt (Push; Import = Anlage der Seite)
  last_pulled_at     TEXT,                       -- Sync-Punkt nach „HubSpot übernehmen"
  hubspot_url        TEXT,
  conflict_state     TEXT CHECK(conflict_state IS NULL OR conflict_state IN ('detected','resolved-app','resolved-remote')),
  locked_blocks      TEXT,                       -- Push-Sperre (Migration 371), NULL = pushbar
  UNIQUE(hub_id, hubspot_post_id)
);
```

**Zielwechsel:** anderer Blog oder anderes Portal (per `me()` beim Connect ermittelt) verwirft Links und Import-Stand ([db/hubspot.js](../db/hubspot.js)#`upsertConnection`, Antwort `targetChanged`); bei einem Blogwechsel fragt das Frontend vorher. Ein anderer Autor ist kein Zielwechsel. Der nächste Import verknüpft die Abschnitte wieder (siehe Import).

## Server-Module

| File | Inhalt |
|---|---|
| [lib/hubspot-client.js](../lib/hubspot-client.js) | REST-Wrapper auf dem geteilten HTTP-Kern ([lib/sync/request.js](../lib/sync/request.js)): Bearer-Auth, Zeitdeckel pro Request (`fetchWithTimeout`, 30 s; Upload 120 s), Token-Bucket (100 req / 10 s, modulglobal). Methoden: `me()` (`/account-info/v3/details`), `listBlogs()` (`/cms/v3/blog-settings/settings`), `listAuthors()`, `iteratePosts({ authorId, blogId, state })` (Filter als Gleichheits-Parameter, Cursor `paging.next.after`), `findPostsByName({ blogId, name, state })` (Filter + lokaler Vergleich, höchstens 20 Seiten), `getPost`, `getPostDraft`, `createPost` (kein Retry bei 5xx), `updatePostDraft`, `publishDraft(id)` (`POST …/draft/push-live`), `schedule(id, publishDate)` (`POST /cms/v3/blogs/posts/schedule`), `uploadFile`; `postStatus(post)` → `{ state, currentState, publishDate, url }`. 401 → `HUBSPOT_AUTH_FAILED`, 403 → `HUBSPOT_FORBIDDEN`. |
| [lib/hubspot-html.js](../lib/hubspot-html.js) | siehe „HTML". |
| [lib/sync/image-mirror.js](../lib/sync/image-mirror.js) | Bild-Spiegel beim Zurücklesen (`mirrorRemoteImages`, `appImageRemoteMap`, `remoteImageKey`), siehe Eckdaten „Bilder beim Zurücklesen". Anbieter-neutral; heute nur HubSpot. |
| [lib/sync/providers/hubspot.js](../lib/sync/providers/hubspot.js) | Adapter (siehe oben) + `createLinkedPageFromHubspotPost` (Import über `lib/blog-pull.js#createLinkedPage`: idempotent, race-fest). |
| [db/hubspot.js](../db/hubspot.js) | Connections + Links. `getConnection` entschlüsselt das Token, `getConnectionPublic` nie. Link-Operationen wie bei WordPress: `upsertLink` (Push = Sync-Punkt, setzt `conflict_state` zurück), `setConflictState`, `markConflictResolvedApp`, `markLinkPulled`, `refreshLinkMeta`. |
| [routes/hubspot.js](../routes/hubspot.js) | `POST /:book_id/test`, `POST /:book_id/blogs`, `POST /:book_id/authors`, `POST /:book_id/connect` — Token **immer im Body** (`__keep__` = gespeichertes), nie in der URL. Rest aus [routes/sync-router.js](../routes/sync-router.js). `/links` holt eine fehlende `portalId` (Verbindungen vor Migration 150) per `me()` nach — höchstens alle 10 Minuten pro Verbindung. |
| [routes/jobs/hubspot-sync.js](../routes/jobs/hubspot-sync.js) | Import und Bilder-Nachzug; Push und Abgleich über den geteilten Kern. Job-Typen `hubspot-import` und `hubspot-images` (pro Buch gegenseitig exklusiv, `409 HUBSPOT_SYNC_RUNNING`), `hubspot-push`, `hubspot-reconcile`. Fehler des Imports enden als `hubspot.error.<CODE>` (`importErrorI18n`). |
| [scripts/import-hubspot.js](../scripts/import-hubspot.js) | Ops-CLI: Import per Seitenname-Abgleich (mit `--update`, `--dry-run`). Nutzt Client, Titel-/Datumsregel und Jahres-Kapitel des Import-Jobs; legt keine Links an. |

## Import (`runHubspotImportJob`)

Wiederholbar: der erste Lauf übernimmt den Blog, jeder weitere („Neue Posts importieren") holt Posts nach, die noch keinen Abschnitt haben. `initial_import_done_at` bleibt der erste Lauf, `last_import_at` ist der jüngste.

1. Alle Posts des Blogs puffern (Vorauswahl `contentGroupId` + `state=PUBLISHED`); der Job prüft Status (`PUBLISHED`) und Autor (`blogAuthorId` = konfigurierter Autor) selbst und zählt Posts anderer Autoren (`otherAuthor` im Ergebnis). Aufsteigend nach `publishDate` (sonst `created`/`updated`) sortieren — HubSpot liefert newest-first, ungesteuert lägen Kapitel und Seiten rückwärts.
2. Pro Post `createLinkedPageFromHubspotPost`:
   - schon verlinkt → übersprungen (`skipped`);
   - **unverknüpfter Abschnitt gleichen Namens** (Import-Regel `YYYY-MM-DD: Titel`, sonst Titel ohne Datum bei genau einem Treffer; `buildRelinkIndex`) → wieder verknüpft (`relinked`). Gleicher Text → synchron; abweichender Text → `conflict_state = 'detected'`, der User entscheidet im Diff. So legt ein Import nach Trennen oder Zielwechsel keine Dubletten an;
   - sonst Seite `YYYY-MM-DD: Titel` im Jahres-Kapitel + Link; trägt der Post Bilder, wird die Seite erst ohne Bilder angelegt (das Abschnittsbild braucht die `page_id`) und dann gespiegelt gespeichert. Die Push-Sperre steht gleich am Link. `last_pushed_at` = Anlage-Zeitpunkt der Seite (sonst zählte die Anlage selbst als lokaler Edit), `hubspot_updated_at` = `post.updated`.
3. Fortschritt `job.hubspot.import.progress` mit `{ done, total }`.
4. `markInitialImportDone`; bei `imported > 0` die Vortags-Baseline (`seedImportBaseline`).

## Frontend

- **Buchorganizer:** [hubspot-sync-card.js](../public/js/cards/hubspot-sync-card.js) ist ein dünner Wrapper über `sync-core.js` (Spec: `endpointBase`, `jobTypes`, `viewUrl`, `remoteState`, `pushNote`, `publishNote`, `liveUpdate: false`). CSS-Accent `.sync-provider--hubspot`.
- **Bucheinstellungen** ([book-settings/hubspot.js](../public/js/book/book-settings/hubspot.js), Partial [book-settings-sync.html](../public/partials/book-settings-sync.html)): Token (write-only), Blog- und Autor-Combobox (`POST /blogs|/authors`), Test, Verbinden (Rückfrage bei Blogwechsel), Import bzw. „Neue Posts importieren", Verbindung prüfen, «Bilder nachholen» (Job `hubspot-images`, mit Rückfrage), Trennen (Rückfrage nennt die Folgen). Gemeinsames mit WordPress in [sync-shared.js](../public/js/book/book-settings/sync-shared.js).

## i18n

`hubspot.connect.*`, `hubspot.status.*` (Panel), `hubspot.action.*`, `hubspot.repush.*`, `hubspot.conflict.title|remote|takeRemote`, `hubspot.error.<Server-Code>` (1:1 der `error_code`), `job.label.hubspot*`, `job.hubspot.*`. Badges und Konflikt-Knöpfe: `sync.status.*`, `sync.conflict.*` (geteilt).

## Tests

- **Unit:** [hubspot-html.test.mjs](../tests/unit/hubspot-html.test.mjs) (Allowlist, Jinja nur im Textstück, Links, Überschriften, Tabellen beidseitig, Unterlisten, Blöcke in `li`/`td`, `pre` mit `<br>`, Block-Läufe, Bilder nur im Push, Quellen als Klartext, Push-Zusätze raus beim Zurücklesen) · [hubspot-provider.test.js](../tests/unit/hubspot-provider.test.js) („übernehmen" mit Lead/Verzeichnis/Block-IDs, Stempel-Rückfall, Wiederverknüpfen, Draft-Suche vor dem Create, Import-Fehler-Keys, `/hubfs/`, `publishDraft`/`schedule`/`postStatus`) · [hubspot-db.test.js](../tests/unit/hubspot-db.test.js) · [sync-target-change.test.js](../tests/unit/sync-target-change.test.js) (Zielwechsel, Konflikt-/Pull-Stempel) · [sync-image-resolver.test.mjs](../tests/unit/sync-image-resolver.test.mjs).
- **Unit:** [hubspot-lossy.test.mjs](../tests/unit/hubspot-lossy.test.mjs) (Sperr-Kennungen, Entity-Klammer kein Modul, `images`-Option, `remoteImageKey`).
- **Integration:** [hubspot-images.test.js](../tests/integration/hubspot-images.test.js) (Import spiegelt, Re-Push setzt die Original-Adresse ohne Upload ein; CTA/Modul sperren; altes Import-Abbild: Bildsperre, Nachzug für unveränderte, bearbeitete bleiben gesperrt — mutationsgeprüft: ohne Sperre bzw. ohne Cache-Eintrag rot) · [hubspot-sync.test.js](../tests/integration/hubspot-sync.test.js) gegen [mock-hubspot.js](../tests/integration/_helpers/mock-hubspot.js): Import (Jahres-Kapitel, Reihenfolge, Titel aus `name`, Baseline), Push (Draft + Link, Re-Push als `PATCH …/draft`, Titel-Werkstatt, Lead/Teaser), **Konflikt** bei geändertem Draft (mutationsgeprüft: ohne Stempelvergleich rot), **gelöschter Post** → `HUBSPOT_REMOTE_GONE` ohne stillen Neuanlage-Post, Abgleich (Status/URL nachziehen, Löschung), Bilder in den File-Manager + Tabelle, **verworfenes Bild** (HEIC) → fehlt im Post, `toastWarnings` (mutationsgeprüft), **paralleler Import** ohne verwaiste Seite (mutationsgeprüft).
