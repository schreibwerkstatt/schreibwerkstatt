# Abschnitts-Revisionen

Jeder Body-Write eines Abschnitts legt den Stand **danach** als Revision in `page_revisions` ab. Die Liste steht unter dem Notebook-Editor (Karte `pageRevisionsCard`), die nativen Clients lesen dieselben Routen. Gegenstück für das ganze Buch: [fassungen.md](fassungen.md) (user-initiiert, kein Pruning).

## Schreibweg

Einziger Hook ist die Content-Store-Facade ([lib/content-store/index.js](../lib/content-store/index.js)): `savePage` schreibt nach jedem Save mit `html` eine Revision, `splitPage` für beide Hälften. Rename-/Reorder-Saves und Save-Replays (`save_match: 'replay'`) schreiben keine.

- **Dedup** ([db/page-revisions.js](../db/page-revisions.js)#`canonicalHtml`): ein Save ohne Unterschied zur jüngsten Revision in **kanonischer Form** erzeugt keine Revision. Kanonisch gleich sind Bodies, die sich nur in Block-IDs (`data-bid`), Attribut-/Klassen-Reihenfolge, Anführungszeichen, `<br/>`/`<br>`, NBSP/Space und Whitespace (Läufe, an Blockgrenzen) unterscheiden; `<pre>` behält seinen Whitespace. Formatierung, Überschriften-Ebene, Bilder, Link-Ziele, Todo-Haken, Absatzgrenzen und Diagramm-Quelltext sind Änderungen. **Why:** ein Vergleich auf sichtbarem Text verwarf diese Änderungen — die jüngste Revision war dann nicht der aktuelle Stand, ein Restore nahm sie still zurück, Diagramme hatten gar keine Geschichte.
- **Ausgangsstand** (`summary = 'baseline'`): hat ein Abschnitt noch keine Revision (Neuanlage mit Inhalt, Import, Blog-Pull, Alt-Bestand), sichert der erste Body-Write vorher den bisherigen Stand, datiert auf dessen `updated_at`, ohne Autor. Ohne ihn wäre der Ursprungstext nach dem ersten Save nirgends mehr. `splitPage` macht dasselbe als `before split`.
- **Quellen** (`source`, CHECK in der Tabelle): `focus`, `main`, `book`, `macapp` (laufendes Schreiben), `chat-apply`, `lektorat-apply`, `import`, `conflict`, `split`, `restore`. Summaries: `baseline`, `before split`, `split → #<id>` / `split from #<id>`, `restored from #<id>`.

## Retention

`pruneTiered` ([db/page-revisions.js](../db/page-revisions.js)) läuft täglich über [lib/cache-cleanup.js](../lib/cache-cleanup.js): ≤ 1 Tag alles, bis 7 Tage die älteste pro Kalendertag, bis 60 Tage die älteste pro ISO-Woche (Schlüssel = Donnerstag der Woche, damit der Jahreswechsel eine Woche nicht teilt), bis 365 Tage die älteste pro Monat, danach die älteste pro Jahr. Zusätzlich hält der Floor `app.page_revision_limit` die N jüngsten je Seite. **Angeheftete** Revisionen (`pinned = 1`) löscht die Retention nie.

Folge für «Stand davor»: exakt der Stand vor einem Save ist die Vorgängerin nur im ungedünnten 24-h-Fenster. Älter ist sie die nächstältere **erhaltene** Revision; Tooltip und Rückfrage nennen deren Datum.

## Routen

[routes/content/pages.js](../routes/content/pages.js); Client-Vertrag: [contract/](../contract/README.md).

| Route | Rolle | Inhalt |
|---|---|---|
| `GET /content/pages/:id/revisions` | viewer | Fenster (Default 100, Deckel 500), Keyset per `before` + `before_id`, `has_more`, `total`, `older` (Vorgängerin der ältesten gelieferten, nur bei `has_more`), `pinned` (alle angehefteten, nur ohne Cursor) |
| `GET /content/pages/:id/revisions/:rev` | viewer | Voll-Body ohne aktive Inhalte (`stripActiveContent` beim Ausliefern — alte Revisionen stammen teils von vor dem Sanitizer im Schreibpfad) + `prev` (Meta der Vorgängerin) |
| `POST /content/pages/:id/revisions/:rev/restore` | editor + kein fremder Lock | schreibt den Body via `savePage` mit `source: 'restore'` zurück |
| `PATCH /content/pages/:id/revisions/:rev` | editor | `{ pinned: bool, label? }`; Lösen verwirft den Namen (Web-only, nicht im Client-Vertrag) |

## Liste und Viewer

Karte [public/js/cards/page-revisions-card.js](../public/js/cards/page-revisions-card.js), Viewer [public/js/cards/page-revisions/viewer.js](../public/js/cards/page-revisions/viewer.js), Partials `page-revisions.html` mit den Fragmenten `page-revisions-row.html` und `page-revisions-viewer.html`.

- **Angeheftet** steht oben, unabhängig vom geladenen Fenster.
- **Sitzungen** ([public/js/page-revisions-groups.js](../public/js/page-revisions-groups.js)): aufeinanderfolgende Saves aus dem laufenden Schreiben (`focus`/`main`/`book`/`macapp`) desselben Users im selben Client mit höchstens 10 min Lücke werden zu einer Kopfzeile gebündelt, aufklappbar. Angeheftete Revisionen und solche mit Summary stehen allein. Zugeklappt zeigt die Kopfzeile die Zeitspanne und das Zeichen-Delta der ganzen Sitzung, aufgeklappt ihren eigenen Save; Unterzeilen lassen Quelle, Gerät und Person weg.
- **Tage** (`groupByDay`, App-Zeitzone): die Sitzungen stehen unter einem Tageskopf (Heute/Gestern/Wochentag + Datum) mit dem Delta des Tages; Zeilen zeigen nur die Uhrzeit. Eine Sitzung über Mitternacht zählt zum Tag ihres jüngsten Saves. Das Gerät erscheint nur, wenn die geladene Liste mehr als eines kennt.
- **Filter** nach Quelle und Person wirken auf die geladenen Revisionen und nur auf die Anzeige. Vorgängerin, Zeichen-Delta und ‹/› im Viewer rechnen immer gegen die vollständige Liste — sonst wäre «Stand davor» eines gefilterten Eintrags der Stand eines anderen Users.
- **Vergleich** im Viewer: gegen die Vorgängerin («was hat dieser Save geändert») oder gegen den gespeicherten aktuellen Stand («was würde Wiederherstellen ändern», frisch vom Server). Der Block-Diff ([public/js/page-revision-diff.js](../public/js/page-revision-diff.js)) nimmt nur Blattblöcke (Container wie `blockquote > p` liefern ihren Text über die Kinder), Tabellenzellen und Bildunterschriften zählen als Blöcke, Bilder erscheinen im Revisions-Viewer als eigene Blöcke (`imageLabel`). Eine reine Formatierungs-Änderung zeigt «kein Textunterschied».
- **Wiederherstellen** braucht Schreibrecht und ist im Notebook-Edit- und Fokusmodus gesperrt: der offene Editor-Puffer kennt den wiederhergestellten Stand nicht.
- `pinned`/`label` liest die Karte aus der Liste, nicht aus dem SWR-gecachten Detail ([caching.md](caching.md)).

## Tests

[tests/unit/page-revisions.test.js](../tests/unit/page-revisions.test.js) (Dedup, Retention, ISO-Woche, Pin, Keyset), [tests/unit/page-revision-diff.test.mjs](../tests/unit/page-revision-diff.test.mjs), [tests/unit/page-revisions-groups.test.mjs](../tests/unit/page-revisions-groups.test.mjs), [tests/integration/page-revisions-routes.test.js](../tests/integration/page-revisions-routes.test.js) (Ausgangsstand, Restore-Quelle, Pin-ACL, Detail-Härtung), [tests/e2e-app/page-revisions-list.spec.js](../tests/e2e-app/page-revisions-list.spec.js) und [page-revisions-split.spec.js](../tests/e2e-app/page-revisions-split.spec.js) (echte App).
