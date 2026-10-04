# Redundanz-Radar

Buchweite Doppelungs-Suche über dem Semantik-Index ([semantic-search.md](semantic-search.md)): findet Seiten-Passagen, die sich bedeutungsmässig stark ähneln (doppelt erzählte Szenen, wiederkehrende Beschreibungen), und Figuren, deren Profile fast deckungsgleich sind. Rein rückwärtsgewandt — kein KI-Call, kein Embedding-Call, nie ein Schreibzugriff auf den Buchtext.

| Teil | Ort |
|---|---|
| Vektor-Mathematik (pur, unit-testbar) | [lib/redundancy.js](../lib/redundancy.js) |
| Job `redundancy` | [routes/jobs/redundancy.js](../routes/jobs/redundancy.js) |
| Letzter Lauf + ignorierte Paare (Routen) | [routes/redundancy.js](../routes/redundancy.js), [db/redundancy.js](../db/redundancy.js) |
| Tab „Doppelungen" der Buchlandkarte | [public/js/cards/redundanz-card.js](../public/js/cards/redundanz-card.js), [public/js/book/redundanz.js](../public/js/book/redundanz.js), [public/partials/buchlandkarte-redundanz.html](../public/partials/buchlandkarte-redundanz.html) (Hülle [buchlandkarte.html](../public/partials/buchlandkarte.html)) |
| Schwellen | App-Settings `redundancy.threshold_{strict,medium,loose}` (Admin → Semantik) |

## Ablauf

1. **Seiten aus dem Content-Store.** Der Job holt die Seiten des Buchs in Lesereihenfolge (`bookTree` + `flattenTree`). Nur Chunks dieser Seiten nehmen teil: eine gelöschte oder in ein anderes Buch verschobene Seite hält ihre Vektoren bis zum nächsten Reindex und darf kein Befund sein.
2. **Vorbereiten.** Chunks unter 40 Zeichen und Nullvektoren fallen heraus, die übrigen werden auf Einheitslänge normiert (Cosinus = Skalarprodukt). Erst danach greift die Obergrenze von 6000 Chunks — in Buchreihenfolge, d.h. bei Überlauf fehlen die letzten Seiten des Buchs, und das Ergebnis meldet die Zahl (`truncatedChunks`).
3. **Dreiecks-Scan.** Alle Chunk-Paare verschiedener Seiten; pro Seitenpaar zählt nur der beste Chunk-Treffer. Der Scan läuft in Blöcken von etwa 40 000 Paaren mit Yield an den Event-Loop; Blockgrösse und Fortschritt rechnen in **Paaren**, weil frühe Zeilen des Dreiecks viel teurer sind als späte.
4. **Filter nach der Schwelle** (`skipPair`, kostet nur für Treffer):
   - **Nachbarseiten** (Default an, Schalter in der Karte): direkt aufeinanderfolgende Seiten im selben Kapitel — eine Szene über zwei Seiten rankt naturgemäss hoch und verdrängte sonst echte Doppelungen aus der Top-60-Liste.
   - **Ignorierte Paare** des Users (`redundancy_dismissals`).
5. **Figuren-Dubletten.** Ein gemittelter Vektor je Figur des Users (stale ausgenommen), fester Floor `FIGURE_DUPE_THRESHOLD` = 0.88 unabhängig vom Seiten-Band. Fusion mit dem lexikalischen Namensabstand ([lib/name-normalize.js](../lib/name-normalize.js)): Namen teilen ein Token → `duplicate`, sonst `alias` (der nicht-triviale Fund, zuerst gelistet). Fehler hier verwerfen nie das Seiten-Ergebnis.
6. **Speichern.** Das Ergebnis geht an den Poller und zusätzlich nach `redundancy_runs` (eine Zeile pro Buch und User). Es trägt IDs, Passagentext (≤ 1500 Zeichen), Schwelle, Nachbar-Schalter und `indexedAt` (Index-Stand des Laufs) — keine Seiten- oder Figurennamen.

## Schwellen

Drei Bänder, modellabhängige Cosinus-Werte (Defaults auf bge-m3 geeicht: 0.88 / 0.82 / 0.76). Die Registry erlaubt 0.70–0.97, der Job clampt auf denselben Bereich; ohne gültigen Wert nimmt er `redundancy.threshold_medium`. Dieselben Bänder färben die Score-Badges (ab „streng" kräftig, ab „mittel" mittel) — wer die Schwellen für ein anderes Modell nachjustiert, verschiebt die Farben mit.

Ein Lauf pro Buch und User (Dedup an der `book_id`). Läuft schon einer mit anderer Schwelle, bekommt ein zweiter Start dessen Job zurück; die Karte stellt das Band dann nach der Schwelle des Ergebnisses ein.

## Karte

Das Radar ist kein eigener Menüpunkt, sondern der Tab „Doppelungen" der Buchlandkarte ([semantic-search.md](semantic-search.md)). Der Tab steht im Root (`buchlandkarteTab`), damit `#…/redundanz` und der Sprung aus der Job-Anzeige ihn direkt öffnen; `#…/landkarte` öffnet den Tab „Landkarte". Beide Panels laden beim Öffnen der Karte, unabhängig vom aktiven Tab.

- **Öffnen der Karte** lädt parallel den Index-Stand (`/search/semantic/status`), den letzten Lauf (`GET /redundancy/:book_id`) und hängt sich an einen laufenden `redundancy`- bzw. `embed-index`-Job wieder an (`/jobs/active`). Die Job-Anzeige in der Fusszeile führt für beide Typen in diesen Tab.
- **Index fehlt / veraltet:** die Karte baut ihn selbst (`/jobs/embed-index`). `staleCount` > 0 → Hinweis „seit dem letzten Index-Lauf geändert"; ist der Index neuer als `indexedAt` des Ergebnisses → Hinweis „neu prüfen".
- **Gespeichertes Ergebnis:** Paare mit einer Seite, die nicht mehr in der Navigationsliste des Buchs steht, blendet die Karte aus. Namen kommen zur Lesezeit aus Nav-Store bzw. Figuren-Katalog.
- **Passagen** stehen eingeklappt auf fünf Zeilen, „Ganze Passage" klappt auf.
- **Ignorieren** speichert das Paar (`POST /redundancy/:book_id/dismissals`, normiert a < b, beide Anker müssen zum Buch bzw. zu den Figuren des Users gehören) und nimmt es sofort aus der Liste. „wieder anzeigen" löscht alle ignorierten Paare des Buchs; sie erscheinen ab dem nächsten Lauf wieder.

## Datenmodell

- `redundancy_runs` — PK (`book_id`, `user_email`), CASCADE mit Buch und Konto. Reine Ableitung.
- `redundancy_dismissals` — `kind` `page|figure` mit XOR-Ankern `page_a_id/page_b_id` bzw. `figure_a_id/figure_b_id`, CHECK auf a < b, Eindeutigkeit über partielle Unique-Indexe. CASCADE auf alle Anker: wird eine Seite gelöscht oder eine Figur von der Komplettanalyse neu angelegt, verfällt das Paar.

## Tests

[tests/unit/redundancy.test.mjs](../tests/unit/redundancy.test.mjs) (Scan, Filter, Blockgrösse, Figuren), [tests/unit/redundancy-db.test.js](../tests/unit/redundancy-db.test.js) (Speicher, Anker-Prüfung, CASCADE), [tests/integration/redundancy.test.js](../tests/integration/redundancy.test.js) (verschobene Seiten, Nachbar-Filter, Ignorieren, Routen-ACL).
