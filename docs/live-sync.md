# Live-Abgleich zwischen Tabs, Geräten und Usern

Was ein anderer Tab, ein anderes Gerät oder ein anderer User am offenen Buch ändert, erscheint ohne Neuladen. Drei Wege, ein Empfänger.

| Weg | Trägt | Quelle | Echo-Filter |
|---|---|---|---|
| **Buch-Kanal, `changed`** | Manuskript-Writes (Text, Anlegen, Löschen, Verschieben) | Content-Store-Facade → `emitBookChange` ([lib/book-events.js](../lib/book-events.js)) | eigenes **Gerät** (gleiche E-Mail + Device-ID), wie `/changes` |
| **Buch-Kanal, `meta`** | alles am Buch ausserhalb des Manuskripts | Middleware [lib/live-writes.js](../lib/live-writes.js) + explizit `emitBookMeta(book, 'comments')` in `routes/share/*` | eigener **Tab** (Header `X-Tab-Id` ↔ `tab_id` des Streams) |
| **Tab-Kanal** | Manuskript-Writes an die anderen Tabs **desselben** Browsers | [public/js/tab-bus.js](../public/js/tab-bus.js) (BroadcastChannel), gesendet aus [repo/content.js](../public/js/repo/content.js) | BroadcastChannel stellt nicht an den Sender zu |

Der Buch-Kanal ist der SSE-Stream `GET /events/stream?book_id=…&device_id=…&tab_id=…` ([routes/events/book-channel.js](../routes/events/book-channel.js), Client [public/js/event-stream.js](../public/js/event-stream.js)). Er schickt **Anstösse, keine Daten**: `book { changed, presence, meta: [...] }`, zusammengefasst über 250 ms. Die Daten holt der Browser danach über dieselben ACL-geprüften Routen wie beim normalen Laden.

**Warum zwei Echo-Regeln:** die Device-ID liegt im `localStorage` und ist in allen Tabs eines Browsers gleich. Für das Manuskript filtern Kanal und `/changes` per Gerät (die Change-Rows kennen keinen Tab) — darum der Tab-Kanal für Tab → Tab. Meta-Writes haben keinen Change-Feed; dort trennt der Server direkt per Tab-ID, ein Tab-Kanal ist nicht nötig.

## Meta: Bereiche

`lib/live-writes.js#LIVE_KINDS` ordnet Pfad-Präfixe einem Bereich zu. Die Middleware meldet jeden Schreib-Request (POST/PUT/PATCH/DELETE) mit Status < 400, dessen Request-Kontext ein Buch trägt (`setContext({ book })` — `guardBook` und `router.param('book_id', …)` setzen ihn, siehe CLAUDE.md „Logging-Context"). Ohne Buch-Kontext keine Meldung.

| Bereich | Pfade | Zähler (Nachlader) | Karten (still abgeglichen) |
|---|---|---|---|
| `ideen` | `/ideen` | `refreshIdeenCounts`, Abschnittskopf | Ideen-Board |
| `redaktion` | `/redaktion` | `refreshPageStatus` | Buchorganizer, Buchübersicht |
| `recherche` | `/research` | `refreshRechercheCounts` | Recherche |
| `plot` | `/plot` | `refreshPlotBeatCounts` | Plot |
| `shareLinks` | `/share/api/links` (ohne Kommentare) | `refreshShareLinkCounts` | Geteilte Links |
| `comments` | explizit, `routes/share/*` | `refreshShareCommentCounts` + `SHARE_COMMENTS_CHANGED` | Geteilte Links, beide Kommentar-Leisten |
| `chat` | `/chat` | Abschnittskopf | — |
| `figuren`, `orte`, `motiv`, `songs`, `weltfakten`, `quellen`, `fassungen` | `/figures` + `/draft-figures`, `/locations`, `/motifs`, `/songs`, `/world-facts`, `/sources`, `/snapshots` | — | jeweilige Katalog-Karte |

Der Empfänger ist **eine** Stelle: [app-collab-stream.js](../public/js/app/app-collab-stream.js) (`KIND_BADGES`, `KIND_CARDS`). Er sammelt Meldungen 300 ms, ruft die Nachlader des Bereichs und schickt sichtbaren Karten `card:refresh` mit `source: 'wake'` — derselbe stille Abgleich wie bei der Tab-Rückkehr ([card-lifecycle.js](../public/js/cards/card-lifecycle.js): nichts dimmen, keine Auswahl und kein Formular zurücksetzen). Danach `EVT.BOOK_META_CHANGED` für weitere Konsumenten.

**Neuer Bereich:** Zeile in `LIVE_KINDS` (Server), Zeile in `KIND_CARDS` und ggf. `KIND_BADGES` (Client). Nicht live sind Einstellungs-Formulare (`/booksettings`, `/publication`) — ein stiller Abgleich mitten im Bearbeiten wäre dort schädlicher als ein veralteter Stand — und Job-Ergebnisse, die ohne Request schreiben.

## Manuskript im Bucheditor

Fremde Saves meldet die Collab-Schicht als `EVT.PAGE_REMOTE_CHANGED` (aus `_applyCollabChanges` und der Drift-Probe `_checkTreeDrift`). Der Bucheditor ([book-editor/remote.js](../public/js/cards/book-editor/remote.js)) zieht einen Block nur nach, wenn er **keine eigene Änderung** trägt (nicht dirty, kein laufender Save, kein Konflikt): frischer Read, `_applyBlockHtml` (aktiver Block: Caret bleibt; Undo-Verlauf fällt), neue Basis. Sonst greift beim nächsten Save der Block-Merge ([book-editor.md](book-editor.md)).

## Kosten und wacklige Verbindungen

- **Server:** je Schreib-Request ein Pfad-Vergleich und ein Event; je offenem Stream ein Rollen-Nachschlag beim Versand (wie für `changed`).
- **Browser je Meldung:** nur die Maps des Bereichs (1–2 Reads) plus ein stiller Abgleich jeder **sichtbaren** betroffenen Karte. Mehrere Meldungen in 300 ms laufen einmal.
- **Netzfehler:** jeder Nachlader behält bei einem gescheiterten Read die bisherige Map — Plaketten verschwinden nicht auf wackligem Netz. Bucheditor-Blöcke bleiben bei Fehlern unverändert.
- **Reconnect / Tab-Rückkehr ohne Stream:** einmal alle Bereiche nachholen, gedrosselt auf höchstens alle 30 s (`RESYNC_MIN_MS`) — eine flatternde Verbindung löst keine Request-Lawine aus.
- **Tab → Tab:** jeder Save in Tab A (auch Autosave) lässt Tab B die offene Seite neu lesen bzw. einen Hinweis zeigen, wie bei einem anderen Gerät.
- **Ohne Stream** (Proxy, alter Browser): Manuskript über die bestehenden Polls, Meta nur bei Tab-Rückkehr.

Native Clients halten keinen Stream; ihre Writes erreichen offene Browser trotzdem, weil sie durch dieselben Routen laufen ([clients.md](clients.md)).

## Tests

- Unit: [event-stream.test.js](../tests/unit/event-stream.test.js) (Meta-Echo je Tab, Bündelung, Buchgrenze), [live-writes.test.js](../tests/unit/live-writes.test.js) (Bereich aus Pfad, nur Erfolg mit Buch, Tab-Herkunft).
- App: [live-sync.spec.js](../tests/e2e-app/live-sync.spec.js) (Tab → Tab, Ideen + Bearbeitungsstand von anderswo, kein Echo, Bucheditor-Block), [share-review.spec.js](../tests/e2e-app/share-review.spec.js) (Kommentare live in beiden Leisten).
