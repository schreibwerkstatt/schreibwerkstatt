# HubSpot-Sync (Buch ↔ HubSpot-Blog)

Spec für den HubSpot-Blog-Workflow eines Buchs vom Typ `blog`. Einmaliger Initial-Import, Per-Abschnitt-Push in den **Draft-Buffer**, Abgleich. Push, Abgleich, Job-Routen, Status-Modell, Konflikt-Diff und Bild-Upload teilt HubSpot mit WordPress — **[blog-sync.md → „Geteilter Sync-Kern"](blog-sync.md#geteilter-sync-kern-wordpress--hubspot)** ist dafür die einzige Beschreibung. Hier steht nur, was HubSpot anders macht (Adapter [lib/sync/providers/hubspot.js](../lib/sync/providers/hubspot.js)).

## Eckdaten

- **Mapping:** 1 Buch == 1 HubSpot-Blog (`contentGroupId`) + 1 Autor (`blogAuthorId`). 1 HubSpot-Post == 1 Abschnitt.
- **Gating:** Verbindung nur konfigurierbar, wenn `buchtyp === 'blog'` (serverseitig hart, `HUBSPOT_REQUIRES_BLOG_TYPE`).
- **Auth:** Private Access Token (PAT, `pat-…`) als Bearer. Token pro Buch verschlüsselt in der DB ([lib/crypto.js](../lib/crypto.js)). Scopes: `content` (Blog, Posts, Autoren) und `files` (Bild-Upload beim Push).
- **Trigger:** manuell. Kein Delta-Pull — der einzige Weg zurück ist „HubSpot übernehmen" im Konflikt-Diff.
- **Push schreibt den Draft-Buffer:** Erst-Push `POST /cms/v3/blogs/posts` mit `state: 'DRAFT'`; Re-Push `PATCH /cms/v3/blogs/posts/{id}/draft`. Die Live-Version ändert sich erst, wenn der User in HubSpot publiziert. Finalisieren, Einplanen, Slug, Meta-Description, Tags, Featured-Image: in HubSpot.
- **Bilder:** beim Push in den File-Manager (`POST /files/v3/files`, Ordner `/schreibwerkstatt`, `PUBLIC_NOT_INDEXABLE`) — App-Seitenbilder, data-URIs und fremd gehostete Bilder; schon bei HubSpot liegende (`*.hubspotusercontent*.net`, `hubfs`) bleiben. Einmal hochgeladene Quellen merkt sich der geteilte Bild-Cache je Verbindung (`sync_media_cache.hub_id`, siehe [blog-sync.md → „Geteilter Sync-Kern"](blog-sync.md#geteilter-sync-kern-wordpress--hubspot)) — ein Re-Push lädt sie nicht erneut in den File-Manager. Beim **Import** fallen Bilder weg: sie liegen im HubSpot-CDN, das die CSP der App (`img-src`) nicht zulässt — im Manuskript stünden sie als kaputte Bilder.
- **Quellen:** Chips werden zu Klartext (`span` steht in keiner Allowlist-Map, der Kurzbeleg bleibt im Satz). Bei `bibliography_in_blog` hängt der Push das Verzeichnis als `<h2>` + Liste an — **ohne Marker**, anders als WordPress: HubSpot liest nie zurück, es kann nichts akkumulieren.
- **Out-of-Scope:** Delta-Pull, Tags/Topics, Featured-Image, OAuth (nur PAT), mehrere Blogs pro Buch.

## HTML ([lib/hubspot-html.js](../lib/hubspot-html.js))

Eine Allowlist, zwei Richtungen:

- `hubspotToAppHtml(raw)` (Import, „HubSpot übernehmen"): Jinja-Marker (`{{…}}`, `{%…%}`, `{#…#}`) raus, CMS-Wrapper (`.hs-cta-*`, `.hs-form`, `.hs-embed-wrapper`), Skripte, Medien und Bilder raus.
- `appToHubspotHtml(html, { images })` (Push): dieselbe Allowlist; `images: true` erst nach dem Media-Pass (nur `https://`-Quellen, `alt`, `<figure>` + `<figcaption>`).

| App/HubSpot | Ergebnis |
|---|---|
| `strong`/`b`, `em`/`i`, `u`, `br` | `strong`, `em`, `u`, `br` (fette `font-weight` ≥ 600 → `strong`) |
| `a[href^=http(s)]` | Link; sonst nur der Text |
| `h1`, `h2` · `h3` · `h4`–`h6` | `h2` · `h3` · `h4` |
| `p`, `ul`/`ol`/`li`, `blockquote` (mit Absätzen), `pre`, `hr` | gleich |
| `table` | `table` mit `caption`, `thead` (`th scope="col"`), `tbody`; Ausrichtung App `data-align` ↔ HubSpot `style="text-align"` |
| unbekanntes Element | entpackt; lose Inline-Läufe auf Block-Ebene werden eigene `<p>` |

**Invariante:** Text vor der ersten Überschrift oder eine Tabelle am Anfang darf den Rest des Posts nie zu einem Absatz zusammenziehen — jeder Block bleibt Block (gegated in [hubspot-html.test.mjs](../tests/unit/hubspot-html.test.mjs)).

## Was der Adapter anders macht

| Punkt | HubSpot |
|---|---|
| Vorab-Prüfung + Konflikt-Diff | lesen den **Draft** (`GET …/draft`), weil der Push genau ihn überschreibt; Stempel `updated` gegen `hubspot_updated_at`. Links ohne Stempel (vor Migration 330) haben keine Prüfung; der nächste Push setzt ihn. |
| Abgleich | liest den **Post** (`GET /cms/v3/blogs/posts/{id}`): 404 oder archiviert → Link weg; sonst `hubspot_state` + `hubspot_url` nachziehen (in HubSpot publiziert → „Ansehen" zeigt den Live-Post). |
| Titel | `name` **und** `htmlTitle` = Titel nach [lib/blog-title.js](../lib/blog-title.js); beim Import zählt `name` (der Post-Titel), `htmlTitle` (SEO-/Tab-Titel, oft mit « \| Blogname») nur als Rückfall. |
| Lead · Teaser · Dachzeile | Lead als erster Absatz vor dem Body · Teaser → `postSummary` (escapet) · Dachzeile geht nicht mit (stünde unter dem Titel). |
| Autor | `blogAuthorId` + `authorName` (einmal pro Job aus `listAuthors()` aufgelöst — HubSpot v3 setzt den Autor bei manchen Portalen nur mit Namen). |
| „HubSpot übernehmen" | Draft-Body durch `hubspotToAppHtml` (Bilder, Module, CTAs entfallen — der Button sagt das), Titel nach `planPulledTitle`; danach `last_pulled_at` = Sync-Punkt. |
| Re-Push-Dialog | Frontend fragt vor jedem Re-Push (`hubspot.repush.warning`): ein **importierter** Post kann Module/CTAs/Bilder tragen, die der Import nicht übernommen hat; die ersetzt der App-Body im Buffer. Ein Edit am Draft in HubSpot fällt dagegen in der Vorab-Prüfung als Konflikt auf. |
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

**Zielwechsel:** anderer Blog oder anderes Portal (per `me()` beim Connect ermittelt) verwirft Links und Import-Stand ([db/hubspot.js](../db/hubspot.js)#`upsertConnection`, Antwort `targetChanged`). Ein anderer Autor ist kein Zielwechsel.

## Server-Module

| File | Inhalt |
|---|---|
| [lib/hubspot-client.js](../lib/hubspot-client.js) | REST-Wrapper auf dem geteilten HTTP-Kern ([lib/sync/request.js](../lib/sync/request.js)): Bearer-Auth, Zeitdeckel pro Request (`fetchWithTimeout`, 30 s; Upload 120 s), Token-Bucket (100 req / 10 s, modulglobal). Methoden: `me()` (`/account-info/v3/details`), `listBlogs()` (`/cms/v3/blog-settings/settings`), `listAuthors()`, `iteratePosts({ authorId, blogId, state })` (Filter als Gleichheits-Parameter, Cursor `paging.next.after`), `getPost`, `getPostDraft`, `createPost` (kein Retry bei 5xx), `updatePostDraft`, `uploadFile`. 401 → `HUBSPOT_AUTH_FAILED`, 403 → `HUBSPOT_FORBIDDEN`. |
| [lib/hubspot-html.js](../lib/hubspot-html.js) | siehe „HTML". |
| [lib/sync/providers/hubspot.js](../lib/sync/providers/hubspot.js) | Adapter (siehe oben) + `createLinkedPageFromHubspotPost` (Import über `lib/blog-pull.js#createLinkedPage`: idempotent, race-fest). |
| [db/hubspot.js](../db/hubspot.js) | Connections + Links. `getConnection` entschlüsselt das Token, `getConnectionPublic` nie. Link-Operationen wie bei WordPress: `upsertLink` (Push = Sync-Punkt, setzt `conflict_state` zurück), `setConflictState`, `markConflictResolvedApp`, `markLinkPulled`, `refreshLinkMeta`. |
| [routes/hubspot.js](../routes/hubspot.js) | `POST /:book_id/test`, `POST /:book_id/blogs`, `POST /:book_id/authors`, `POST /:book_id/connect` — Token **immer im Body** (`__keep__` = gespeichertes), nie in der URL. Rest aus [routes/sync-router.js](../routes/sync-router.js). `/links` holt eine fehlende `portalId` (Verbindungen vor Migration 150) per `me()` nach — höchstens alle 10 Minuten pro Verbindung. |
| [routes/jobs/hubspot-sync.js](../routes/jobs/hubspot-sync.js) | Import; Push und Abgleich über den geteilten Kern. Job-Typen `hubspot-import` (pro Buch exklusiv, `409 HUBSPOT_SYNC_RUNNING`), `hubspot-push`, `hubspot-reconcile`. |
| [scripts/import-hubspot.js](../scripts/import-hubspot.js) | Ops-CLI: Import per Seitenname-Abgleich (mit `--update`, `--dry-run`). Nutzt Client, Titel-/Datumsregel und Jahres-Kapitel des Import-Jobs; legt keine Links an. |

## Import (`runHubspotImportJob`)

Gated: `initial_import_done_at IS NULL`, sonst `HUBSPOT_ALREADY_IMPORTED`.

1. Alle `PUBLISHED`-Posts von Autor + Blog puffern, aufsteigend nach `publishDate` (sonst `created`/`updated`) sortieren — HubSpot liefert newest-first, ungesteuert lägen Kapitel und Seiten rückwärts.
2. Pro Post `createLinkedPageFromHubspotPost`: schon verlinkt → übersprungen (`skipped`); sonst Seite `YYYY-MM-DD: Titel` im Jahres-Kapitel + Link. `last_pushed_at` = Anlage-Zeitpunkt der Seite (sonst zählte die Anlage selbst als lokaler Edit), `hubspot_updated_at` = `post.updated`.
3. Fortschritt `job.hubspot.import.progress` mit `{ done, total }`.
4. `markInitialImportDone`; bei `imported > 0` die Vortags-Baseline (`seedImportBaseline`).

## Frontend

- **Buchorganizer:** [hubspot-sync-card.js](../public/js/cards/hubspot-sync-card.js) ist ein dünner Wrapper über `sync-core.js` (Spec: `endpointBase`, `jobTypes`, `viewUrl`, `confirmPush`). CSS-Accent `.sync-provider--hubspot`.
- **Bucheinstellungen** ([book-settings/hubspot.js](../public/js/book/book-settings/hubspot.js), Partial [book-settings-sync.html](../public/partials/book-settings-sync.html)): Token (write-only), Blog- und Autor-Combobox (`POST /blogs|/authors`), Test, Verbinden, Initial-Import, Verbindung prüfen, Trennen. Gemeinsames mit WordPress in [sync-shared.js](../public/js/book/book-settings/sync-shared.js).

## i18n

`hubspot.connect.*`, `hubspot.status.*` (Panel), `hubspot.action.*`, `hubspot.repush.*`, `hubspot.conflict.title|remote|takeRemote`, `hubspot.error.<Server-Code>` (1:1 der `error_code`), `job.label.hubspot*`, `job.hubspot.*`. Badges und Konflikt-Knöpfe: `sync.status.*`, `sync.conflict.*` (geteilt).

## Tests

- **Unit:** [hubspot-html.test.mjs](../tests/unit/hubspot-html.test.mjs) (Allowlist, Jinja, Links, Überschriften, Tabellen beidseitig, Block-Läufe, Bilder nur im Push, Quellen als Klartext) · [hubspot-db.test.js](../tests/unit/hubspot-db.test.js) · [sync-target-change.test.js](../tests/unit/sync-target-change.test.js) (Zielwechsel, Konflikt-/Pull-Stempel) · [sync-image-resolver.test.mjs](../tests/unit/sync-image-resolver.test.mjs).
- **Integration:** [hubspot-sync.test.js](../tests/integration/hubspot-sync.test.js) gegen [mock-hubspot.js](../tests/integration/_helpers/mock-hubspot.js): Import (Jahres-Kapitel, Reihenfolge, Titel aus `name`, Baseline), Push (Draft + Link, Re-Push als `PATCH …/draft`, Titel-Werkstatt, Lead/Teaser), **Konflikt** bei geändertem Draft (mutationsgeprüft: ohne Stempelvergleich rot), **gelöschter Post** → `HUBSPOT_REMOTE_GONE` ohne stillen Neuanlage-Post, Abgleich (Status/URL nachziehen, Löschung), Bilder in den File-Manager + Tabelle, **verworfenes Bild** (HEIC) → fehlt im Post, `toastWarnings` (mutationsgeprüft), **paralleler Import** ohne verwaiste Seite (mutationsgeprüft).
