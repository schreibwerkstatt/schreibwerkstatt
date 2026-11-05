# Nutzungs-Events

Erstanbieter-Messung des Nutzungsverhaltens: welche Funktionen genutzt werden, ob KI-Vorschläge übernommen werden, wie geschrieben wird und ob neue Personen bleiben. Auswertung im Admin unter **Nutzung → Verhalten**.

## Bausteine

| Teil | Ort |
|---|---|
| Tabelle | `usage_events` ([db/migrations/0349-usage-events.js](../db/migrations/0349-usage-events.js)), nur anhängend |
| Katalog + einziger Schreibweg | [lib/usage-events.js](../lib/usage-events.js) — `USAGE_EVENTS`, `recordUsageEvent` |
| Client-Weg | `POST /usage/event` ([routes/usage.js](../routes/usage.js)); Helfer `trackUsageEvent` / `trackChatProposal` in [public/js/features-usage.js](../public/js/features-usage.js) |
| Auswertung | [db/usage-events.js](../db/usage-events.js)#`behaviorReport`, Route `GET /admin/usage/behavior` ([routes/admin-usage.js](../routes/admin-usage.js)) |
| Admin-Tab | [admin-usage-behavior.js](../public/js/admin/admin-usage-behavior.js), Partials `admin-usage-behavior*.html` |
| Aufbewahrung | Setting `app.usage_events_retention_days` (Default 395, 0 = nie), täglicher Cleanup in [lib/cache-cleanup.js](../lib/cache-cleanup.js) |

## Regeln

- **Der Katalog ist die Allowlist.** Ein Event fehlt dort → es wird verworfen. Jedes Meta-Feld hat einen Typ: `enum`, `slug` (`[a-z0-9_.:-]`, max. 48 Zeichen) oder `int` (≥ 0). **Freitext hat keinen Typ** — kein Manuskript-, Chat-, Such- oder Titeltext kann in die Tabelle gelangen. Ein Feld, das seine Spec verletzt, fällt still weg.
- **Herkunft ist Teil des Katalogs.** `origin: 'client'` kommt über `POST /usage/event`, `origin: 'server'` nur aus dem Code. Der Client kann kein Login, keinen Job und keine Karten-Öffnung erfinden (400 `INVALID_EVENT`).
- **Best-Effort.** `recordUsageEvent` wirft nie; ein Tracking-Fehler darf keinen Login, Job oder Save abbrechen. Der Client-Helfer schickt mit `keepalive` und schluckt Fehler.
- **Buch-ACL** wie überall: ein `book_id` im Client-Event geht durch `guardBook(…, 'viewer')`.
- **Personenbezug:** `user_email` mit `ON DELETE CASCADE` — löscht sich ein Konto, fallen seine Events mit (`USER_REF_PLAN`). `book_id` mit `SET NULL`.
- **Nicht ins OTA-Editor-Bundle.** Module im Bundle der nativen Clients (z. B. `cards/editor-synonyme/controller.js`, `focus/card.js`; Inventar: `lib/editor-bundle.js#buildClosure`) importieren `features-usage.js` nicht. Die Editor-Sitzungen werden darum an der Wurzel über einen Watch abgeleitet, nicht in den Editoren selbst.

## Events

| Event | Herkunft | Meta | Wo |
|---|---|---|---|
| `session.start` | client | `surface` browser/pwa, `viewport`, `locale` | einmal je App-Start (`setupFeatureUsageWatchers`) |
| `auth.login` | server | `method` | Passwort-/Admin-/Demo-Login, Passwort setzen, OIDC |
| `account.created` | server | `method` local/oidc, `via` invite/open-signup | Konto beim Annehmen der Einladung bzw. offener Registrierung |
| `book.created` | server | `via` manual/book-import/manuscript-import/folder-import | `createOwnedBook`; ein danach gescheiterter Import lässt das Event mit `book_id` NULL stehen |
| `card.open` | server | `feature`, Spalte `source` palette/tile/sidebar/shortcut | `POST /usage/track` (Karten-Öffnung) |
| `editor.open` / `editor.close` | client | `editor` notebook/focus/book, `durationSec` | Watch auf die innerste offene Fläche: Bucheditor › Fokus › Notebook-Edit-Modus; `pagehide` schliesst ab |
| `dictation.start` / `tts.start` | client | — | Start der Aufnahme bzw. Wiedergabe (nicht je Audio-Segment) |
| `synonym.applied` | client | `source` thesaurus/ai | Synonym aus dem Picker eingesetzt (SPA-Weg `editor/synonyme.js`; der Bundle-Controller der nativen Clients meldet nichts) |
| `xref.applied` | client | `kind` Zieltyp (chapter/figure/table/page) | Querverweis im Notebook-Editor eingesetzt (`editor/notebook/toolbar/xref.js`) |
| `content.created` | server | `kind` source/idea/beat/page/chapter/figure | Quelle, Idee, Beat, Abschnitt, Kapitel, Figur-Entwurf angelegt — vom Server beim Anlegen geschrieben, also auch für die nativen Clients gemessen |
| `share.link.created` | server | `kind` page/chapter/book | Share-Link erstellt (`POST /share/api/links`) |
| `comment.action` | server | `action` reply/resolve/delete | Owner antwortet auf einen Leser-Kommentar, löst ihn auf oder löscht ihn. **Kommentare der Leser:innen sind anonym** (kein Konto) und stehen deshalb nicht hier — ihre Verweildauer liegt in den Share-Link-Tabellen |
| `job.queued` / `job.finished` | server | `type`, `status`, `durationSec` (ab Start) | `createJob`, `completeJob`, `failJob`, Abbruch in der Queue |
| `chat.proposal` | client | `chat` page/book/research/plot/ideen, `action` applied/discarded/reopened/undone, `kind`, `count` | die fünf Chats; der Recherche-Chat kennt kein Verwerfen |
| `lektorat.applied` | client | `shown`, `selected`, `applied`, `skipped` | Abschnitts-Lektorat «Übernehmen» in der Leseansicht (`saveCorrections`) |
| `offline.pin` | client | `action` pin/unpin | Klick auf «Buch offline halten» in der Sidebar ([app-offline-books.js](../public/js/app/app-offline-books.js)) |
| `offline.pin.result` | client | `result` done/partial/failed, `total`, `failed`, `status` (HTTP, 0 = Netz), `durationSec`, `persisted` yes/no | Ausgang des Erst-Syncs nach dem Anheften, gemeldet vom anheftenden Tab; Automatik und Nach-Syncs melden nichts. Schliesst der Tab vor dem Ende, fehlt das Ergebnis |

**Datenschutzerklärung:** die Nutzungsdaten stehen unter «Erhobene Daten» (`privacy.sec2ItemE`) mit der Default-Frist von 13 Monaten. Wer die Frist oder die Art der Events ändert, zieht den Text dort nach.

## Auswertung «Verhalten»

Zeitraum, Admin-Schalter und Audit-Eintrag (`usage-viewed`) wie die übrigen Tabs. Neben den Events liest sie `user_activity` (aktive Sekunden je Person und Tag): aktive Personen je Woche und die **Kohorten** (aktive Tage in Woche 1 / Monat 1 nach der ersten Anmeldung, aktive Wochen, zuletzt aktiv) haben damit Historie vor dem ersten Event. Kohorten laufen über die ganze Historie, nicht über den Zeitraum.

Die **Funktionstabelle** listet jede Karte der Feature-Registry, auch ohne Öffnung — die Nullzeilen beantworten «was nutzt niemand?». Die **Annahmequote** eines Chat-Vorschlags ist übernommen / (übernommen + verworfen); offen gelassene Vorschläge sieht der Client nicht, die Quote misst nur Entscheidungen.

Zwei Auswertungen kommen aus **keinem** Event, sondern aus vorhandenen Daten:

- **Chat-Runden**: eine Runde ist ein Chat-Job (`chat`, `book-chat`, `research-chat`, `plot-chat`, `ideen-chat`). Die Zahl der Runden gegen die Zahl der Vorschläge zeigt, wie viele Fragen nur eine Antwort brachten.
- **Lesen**: `user_page_usage` (verschiedene Abschnitte und Öffnungen je Person). Diese Tabelle kennt **keine Zeitachse** — die Werte sind kumuliert über die ganze Historie, nicht auf den Zeitraum bezogen.

## Neues Event

1. Eintrag in `USAGE_EVENTS` mit `origin` und Meta-Spec (nur kategoriale Felder).
2. Aufruf: Server `recordUsageEvent({ userEmail, event, bookId, meta })`, Client `trackUsageEvent(event, meta)`.
3. Auswertung in `behaviorReport` und, wenn sichtbar, im Tab; neue Strings in beide Locales.
4. Gegated durch [tests/unit/usage-events.test.mjs](../tests/unit/usage-events.test.mjs): jeder Aufrufer nennt ein Event mit passender Herkunft, jedes Server-Event hat einen Aufrufer.
