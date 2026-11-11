# HubSpot-Sync (Buch ↔ HubSpot-Blog)

Spec für den HubSpot-Blog-Workflow eines Buchs vom Typ `blog`. Import (wiederholbar, holt neue Posts nach), Per-Abschnitt-Push in den **Draft-Buffer**, Abgleich. Push, Abgleich, Job-Routen, Status-Modell, Konflikt-Diff und Bild-Upload teilt HubSpot mit WordPress — **[blog-sync.md → „Geteilter Sync-Kern"](blog-sync.md#geteilter-sync-kern-wordpress--hubspot)** ist dafür die einzige Beschreibung. Hier steht nur, was HubSpot anders macht (Adapter [lib/sync/providers/hubspot.js](../lib/sync/providers/hubspot.js)).

## Eckdaten

- **Mapping:** 1 Buch == 1 HubSpot-Blog (`contentGroupId`) + 1 Autor (`blogAuthorId`). 1 HubSpot-Post == 1 Abschnitt.
- **Gating:** Verbindung nur konfigurierbar, wenn `buchtyp === 'blog'` (serverseitig hart, `HUBSPOT_REQUIRES_BLOG_TYPE`).
- **Auth:** Private Access Token (PAT, `pat-…`) als Bearer. Token pro Buch verschlüsselt in der DB ([lib/crypto.js](../lib/crypto.js)). Scopes: `content` (Blog, Posts, Autoren) und `files` (Bild-Upload beim Push).
- **Trigger:** manuell. Kein Delta-Pull für verknüpfte Posts — der einzige Weg zurück ist „HubSpot übernehmen" im Konflikt-Diff. Neue Posts holt „Neue Posts importieren".
- **Push schreibt den Draft-Buffer:** Erst-Push `POST /cms/v3/blogs/posts` mit `state: 'DRAFT'`; Re-Push `PATCH /cms/v3/blogs/posts/{id}/draft`. Die Live-Version ändert sich erst beim Veröffentlichen: im Push-Dialog («Pushen und veröffentlichen» → `POST …/draft/push-live`, «Pushen und planen» → `POST /cms/v3/blogs/posts/schedule`) oder in HubSpot. Der Teaser der Titel-Werkstatt geht als `postSummary` **und** `metaDescription` mit (HubSpot verlangt sie zum Veröffentlichen; ohne Teaser weist der Push «veröffentlichen» vorab ab), der Slug nur beim Anlegen. Tags und Featured Image: in HubSpot. Nicht gegen ein echtes Portal geprüft: ob `push-live` einen nie veröffentlichten Entwurf ebenso live schaltet wie einen Buffer.
- **Bilder:** beim Push in den File-Manager (`POST /files/v3/files`, Ordner `/schreibwerkstatt`, `PUBLIC_NOT_INDEXABLE`) — App-Seitenbilder, data-URIs und fremd gehostete Bilder; schon bei HubSpot liegende bleiben (Hosts `*.hubspotusercontent*.net`, `hubspot.net`, `hubfs.net`, `hs-sites.com` sowie jeder Pfad unter `/hubfs/` bzw. `/hs-fs/hubfs/`, auch auf der eigenen Blog-Domain). Einmal hochgeladene Quellen merkt sich der geteilte Bild-Cache je Verbindung (`sync_media_cache.hub_id`, siehe [blog-sync.md → „Geteilter Sync-Kern"](blog-sync.md#geteilter-sync-kern-wordpress--hubspot)) — ein Re-Push lädt sie nicht erneut in den File-Manager. Beim **Import** fallen Bilder weg: sie liegen im HubSpot-CDN, das die CSP der App (`img-src`) nicht zulässt — im Manuskript stünden sie als kaputte Bilder.
- **Quellen:** Chips werden zu Klartext (`span` steht in keiner Allowlist-Map, der Kurzbeleg bleibt im Satz). Bei `bibliography_in_blog` hängt der Push das Verzeichnis als `<h2>` + Liste an, jeder Block mit der Marker-Klasse `sw-bibliography`; der Lead steht als `<p class="ms-head__lead">` davor. **Beides schneidet das Zurücklesen wieder heraus** („HubSpot übernehmen", Konflikt-Diff, Import): sonst landete es im Abschnittstext, und der nächste Push hängte es ein zweites Mal an. Streicht HubSpot die Klassen, greift ein inhaltlicher Rückfall (erster Absatz = Lead der Titel-Werkstatt, letzte Überschrift = Verzeichnis-Titel).
- **Out-of-Scope:** Delta-Pull, Tags/Topics, Featured-Image, OAuth (nur PAT), mehrere Blogs pro Buch. Im Client vorbereitet, aber nicht angebunden: `metaDescription`/`slug` (Adapter `create`/`update`), `publishDraft`, `schedule`, `postStatus`.

## HTML ([lib/hubspot-html.js](../lib/hubspot-html.js))

Eine Allowlist, zwei Richtungen:

- `hubspotToAppHtml(raw, { lead, bibTitle, stats })` (Import, „HubSpot übernehmen", Konflikt-Diff): Jinja-Marker (`{{…}}`, `{%…%}`, `{#…#}`) raus — nur innerhalb eines Textstücks zwischen zwei Tags, nie über eine Elementgrenze; CMS-Wrapper (`.hs-cta-*`, `.hs-form`, `.hs-embed-wrapper`), Skripte, Medien und Bilder raus; Push-Zusätze (Lead, Verzeichnis) raus, `stats.lead` meldet den Lead-Text.
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
| Push-Dialog | Der Push-Dialog (geteilt, `sync/push-dialog.js`) zeigt bei verknüpften Posts den Hinweis `hubspot.repush.warning` (`spec.pushNote`): ein **importierter** Post kann Module/CTAs/Bilder tragen, die der Import nicht übernommen hat; die ersetzt der App-Body im Buffer. Tags, Slug, Featured Image bleiben (der `PATCH` schickt sie nicht). Ein Edit am Draft in HubSpot fällt dagegen in der Vorab-Prüfung als Konflikt auf. |
| Erst-Push ohne Link | `findExistingRemote` sucht vorher einen unverknüpften DRAFT gleichen Titels vom konfigurierten Autor (verlorene Antwort eines früheren Creates, Link nach Trennen weg); ein Treffer wird aktualisiert statt doppelt angelegt. |
| „Ansehen" | `DRAFT` → Editor-URL `https://app.hubspot.com/blog/<portalId>/editor/<postId>/content` (ohne HubSpot-Login wäre der Draft nicht erreichbar); sonst `hubspot_url`. |

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
  UNIQUE(hub_id, hubspot_post_id)
);
```

**Zielwechsel:** anderer Blog oder anderes Portal (per `me()` beim Connect ermittelt) verwirft Links und Import-Stand ([db/hubspot.js](../db/hubspot.js)#`upsertConnection`, Antwort `targetChanged`); bei einem Blogwechsel fragt das Frontend vorher. Ein anderer Autor ist kein Zielwechsel. Der nächste Import verknüpft die Abschnitte wieder (siehe Import).

## Server-Module

| File | Inhalt |
|---|---|
| [lib/hubspot-client.js](../lib/hubspot-client.js) | REST-Wrapper auf dem geteilten HTTP-Kern ([lib/sync/request.js](../lib/sync/request.js)): Bearer-Auth, Zeitdeckel pro Request (`fetchWithTimeout`, 30 s; Upload 120 s), Token-Bucket (100 req / 10 s, modulglobal). Methoden: `me()` (`/account-info/v3/details`), `listBlogs()` (`/cms/v3/blog-settings/settings`), `listAuthors()`, `iteratePosts({ authorId, blogId, state })` (Filter als Gleichheits-Parameter, Cursor `paging.next.after`), `findPostsByName({ blogId, name, state })` (Filter + lokaler Vergleich, höchstens 20 Seiten), `getPost`, `getPostDraft`, `createPost` (kein Retry bei 5xx), `updatePostDraft`, `publishDraft(id)` (`POST …/draft/push-live`), `schedule(id, publishDate)` (`POST /cms/v3/blogs/posts/schedule`), `uploadFile`; `postStatus(post)` → `{ state, currentState, publishDate, url }`. 401 → `HUBSPOT_AUTH_FAILED`, 403 → `HUBSPOT_FORBIDDEN`. |
| [lib/hubspot-html.js](../lib/hubspot-html.js) | siehe „HTML". |
| [lib/sync/providers/hubspot.js](../lib/sync/providers/hubspot.js) | Adapter (siehe oben) + `createLinkedPageFromHubspotPost` (Import über `lib/blog-pull.js#createLinkedPage`: idempotent, race-fest). |
| [db/hubspot.js](../db/hubspot.js) | Connections + Links. `getConnection` entschlüsselt das Token, `getConnectionPublic` nie. Link-Operationen wie bei WordPress: `upsertLink` (Push = Sync-Punkt, setzt `conflict_state` zurück), `setConflictState`, `markConflictResolvedApp`, `markLinkPulled`, `refreshLinkMeta`. |
| [routes/hubspot.js](../routes/hubspot.js) | `POST /:book_id/test`, `POST /:book_id/blogs`, `POST /:book_id/authors`, `POST /:book_id/connect` — Token **immer im Body** (`__keep__` = gespeichertes), nie in der URL. Rest aus [routes/sync-router.js](../routes/sync-router.js). `/links` holt eine fehlende `portalId` (Verbindungen vor Migration 150) per `me()` nach — höchstens alle 10 Minuten pro Verbindung. |
| [routes/jobs/hubspot-sync.js](../routes/jobs/hubspot-sync.js) | Import; Push und Abgleich über den geteilten Kern. Job-Typen `hubspot-import` (pro Buch exklusiv, `409 HUBSPOT_SYNC_RUNNING`), `hubspot-push`, `hubspot-reconcile`. Fehler des Imports enden als `hubspot.error.<CODE>` (`importErrorI18n`). |
| [scripts/import-hubspot.js](../scripts/import-hubspot.js) | Ops-CLI: Import per Seitenname-Abgleich (mit `--update`, `--dry-run`). Nutzt Client, Titel-/Datumsregel und Jahres-Kapitel des Import-Jobs; legt keine Links an. |

## Import (`runHubspotImportJob`)

Wiederholbar: der erste Lauf übernimmt den Blog, jeder weitere („Neue Posts importieren") holt Posts nach, die noch keinen Abschnitt haben. `initial_import_done_at` bleibt der erste Lauf, `last_import_at` ist der jüngste.

1. Alle Posts des Blogs puffern (Vorauswahl `contentGroupId` + `state=PUBLISHED`); der Job prüft Status (`PUBLISHED`) und Autor (`blogAuthorId` = konfigurierter Autor) selbst und zählt Posts anderer Autoren (`otherAuthor` im Ergebnis). Aufsteigend nach `publishDate` (sonst `created`/`updated`) sortieren — HubSpot liefert newest-first, ungesteuert lägen Kapitel und Seiten rückwärts.
2. Pro Post `createLinkedPageFromHubspotPost`:
   - schon verlinkt → übersprungen (`skipped`);
   - **unverknüpfter Abschnitt gleichen Namens** (Import-Regel `YYYY-MM-DD: Titel`, sonst Titel ohne Datum bei genau einem Treffer; `buildRelinkIndex`) → wieder verknüpft (`relinked`). Gleicher Text → synchron; abweichender Text → `conflict_state = 'detected'`, der User entscheidet im Diff. So legt ein Import nach Trennen oder Zielwechsel keine Dubletten an;
   - sonst Seite `YYYY-MM-DD: Titel` im Jahres-Kapitel + Link. `last_pushed_at` = Anlage-Zeitpunkt der Seite (sonst zählte die Anlage selbst als lokaler Edit), `hubspot_updated_at` = `post.updated`.
3. Fortschritt `job.hubspot.import.progress` mit `{ done, total }`.
4. `markInitialImportDone`; bei `imported > 0` die Vortags-Baseline (`seedImportBaseline`).

## Frontend

- **Buchorganizer:** [hubspot-sync-card.js](../public/js/cards/hubspot-sync-card.js) ist ein dünner Wrapper über `sync-core.js` (Spec: `endpointBase`, `jobTypes`, `viewUrl`, `remoteState`, `pushNote`, `publishNote`, `liveUpdate: false`). CSS-Accent `.sync-provider--hubspot`.
- **Bucheinstellungen** ([book-settings/hubspot.js](../public/js/book/book-settings/hubspot.js), Partial [book-settings-sync.html](../public/partials/book-settings-sync.html)): Token (write-only), Blog- und Autor-Combobox (`POST /blogs|/authors`), Test, Verbinden (Rückfrage bei Blogwechsel), Import bzw. „Neue Posts importieren", Verbindung prüfen, Trennen (Rückfrage nennt die Folgen). Gemeinsames mit WordPress in [sync-shared.js](../public/js/book/book-settings/sync-shared.js).

## i18n

`hubspot.connect.*`, `hubspot.status.*` (Panel), `hubspot.action.*`, `hubspot.repush.*`, `hubspot.conflict.title|remote|takeRemote`, `hubspot.error.<Server-Code>` (1:1 der `error_code`), `job.label.hubspot*`, `job.hubspot.*`. Badges und Konflikt-Knöpfe: `sync.status.*`, `sync.conflict.*` (geteilt).

## Tests

- **Unit:** [hubspot-html.test.mjs](../tests/unit/hubspot-html.test.mjs) (Allowlist, Jinja nur im Textstück, Links, Überschriften, Tabellen beidseitig, Unterlisten, Blöcke in `li`/`td`, `pre` mit `<br>`, Block-Läufe, Bilder nur im Push, Quellen als Klartext, Push-Zusätze raus beim Zurücklesen) · [hubspot-provider.test.js](../tests/unit/hubspot-provider.test.js) („übernehmen" mit Lead/Verzeichnis/Block-IDs, Stempel-Rückfall, Wiederverknüpfen, Draft-Suche vor dem Create, Import-Fehler-Keys, `/hubfs/`, `publishDraft`/`schedule`/`postStatus`) · [hubspot-db.test.js](../tests/unit/hubspot-db.test.js) · [sync-target-change.test.js](../tests/unit/sync-target-change.test.js) (Zielwechsel, Konflikt-/Pull-Stempel) · [sync-image-resolver.test.mjs](../tests/unit/sync-image-resolver.test.mjs).
- **Integration:** [hubspot-sync.test.js](../tests/integration/hubspot-sync.test.js) gegen [mock-hubspot.js](../tests/integration/_helpers/mock-hubspot.js): Import (Jahres-Kapitel, Reihenfolge, Titel aus `name`, Baseline), Push (Draft + Link, Re-Push als `PATCH …/draft`, Titel-Werkstatt, Lead/Teaser), **Konflikt** bei geändertem Draft (mutationsgeprüft: ohne Stempelvergleich rot), **gelöschter Post** → `HUBSPOT_REMOTE_GONE` ohne stillen Neuanlage-Post, Abgleich (Status/URL nachziehen, Löschung), Bilder in den File-Manager + Tabelle, **verworfenes Bild** (HEIC) → fehlt im Post, `toastWarnings` (mutationsgeprüft), **paralleler Import** ohne verwaiste Seite (mutationsgeprüft).
