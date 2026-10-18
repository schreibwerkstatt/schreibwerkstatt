# Client-Vertrag (macOS, Android)

Dieser Ordner ist der **einzige Übergabepunkt** zwischen dem Server und den nativen Clients ([focuseditor](https://github.com/schreibwerkstatt/focuseditor), [mobile](https://github.com/schreibwerkstatt/mobile)). Was ein Client vom Server braucht, steht hier maschinenlesbar und ist geprüft. Eine Server-Änderung, die einen Client bricht, wird hier rot, und zwar bevor sie ausgeliefert ist.

Die Client-Repos ziehen den Ordner in ihre Tests (`scripts/sync-contract.sh` dort). Eine Server-Sitzung übergibt einer Client-Sitzung deshalb keinen Prompt mit Feldnamen, sondern eine Vertragsversion: «api 3 → 4, siehe CHANGELOG».

| Datei | Inhalt | Entsteht |
|---|---|---|
| [version.json](version.json) | `api` (REST-Revision), `editorApi` (Bundle-Major) | von Hand, bei jeder Vertragsänderung |
| [openapi.json](openapi.json) | REST-Fläche der Clients (OpenAPI 3.1), mit `x-clients` je Operation | `npm run contract:build` aus [spec/](spec/) |
| [fixtures/](fixtures/) | echte Antworten je Fall, aufs Schema projiziert, normalisiert | `npm run contract:fixtures` |
| [editor-api.d.ts](editor-api.d.ts) | Bundle-Vertrag: Bridge, Handle, Merge, Manifest | von Hand |
| [editor-surface.json](editor-surface.json) | was die Clients am Bundle heute tatsächlich anfassen | `npm run contract:surface` |
| [CHANGELOG.md](CHANGELOG.md) | was sich je Version geändert hat und was ein Client tun muss | von Hand |

## Zwei Verträge

**REST:** Das sind die rund 30 Endpunkte, die macOS und Android aufrufen, nicht die ganze API. `required` heisst: Der Server liefert das Feld immer, und mindestens ein Client dekodiert es als Pflicht. Antworten dürfen zusätzliche Felder tragen; ein Client ignoriert unbekannte Felder (Swift `Decodable`, kotlinx `ignoreUnknownKeys`). Die Fehlercodes stehen je Status in `openapi.json`, die ausführliche Prosa in [docs/clients.md](../docs/clients.md).

**Bundle:** `GET /content/editor-bundle.zip` liefert JS und CSS des Editors per OTA. Vertrag ist, was in `editor-api.d.ts` steht. `editor-surface.json` ist dagegen die *Ist-Liste*, also was die Clients heute benutzen, inklusive Klassen, CSS-Variablen und Highlights ihres Host-CSS. [tests/unit/editor-surface.test.js](../tests/unit/editor-surface.test.js) prüft jeden Eintrag gegen das Bundle. `npm run check:clients` meldet, wenn ein Client etwas anfasst, das dort nicht steht.

## Versionen

- **`api`** steigt bei **jeder** Änderung an der REST-Fläche, auch bei einer additiven. Ein Client prüft per `GET /config` → `clientContract.api >= n`, ob der Server ein Feld schon kennt. Brechen ist auf dieser Achse nicht vorgesehen. Was ein ausgelieferter Client liest, bleibt bestehen, bis kein Gerät es mehr braucht.
- **`editorApi`** ist der Major des Bundles und steigt **nur** bei einem Bruch: Ein Export, ein Bridge-Feld, eine Klasse oder eine CSS-Variable aus `editor-surface.json` fällt weg, oder die Bridge verlangt eine neue Pflicht-Funktion. Der Client meldet per Header `X-Editor-Api: 1` (oder `1,2`), welche Majors seine Schale kann; ohne Header gilt `1`. Passt keiner, antwortet der Server `409 EDITOR_API_UNSUPPORTED`. Der Client behält dann sein gecachtes Bundle und zeigt einen Update-Hinweis, statt ein Bundle zu laden, das seine Bridge nicht bedienen kann.

## Regeln

1. **Additiv vor allem anderen.** Neue Felder sind optional, neue Request-Felder werden ignoriert, wenn ein älterer Server sie nicht kennt. Ein neuer Wert in einem `enum` ist für einen Client, der `switch` mit `default` benutzt, additiv. Im Zweifel ein neues Feld statt eines neuen Werts.
2. **Reihenfolge: Server → Clients → Aufräumen.** Zuerst additiv auf den Server und deployen, dann ziehen die Clients nach. Erst wenn der Admin-Tab «Geräte» (`client_version`) kein Gerät mit der alten Version mehr zeigt, fällt der alte Weg auf dem Server weg. Ein Store-Release (Mac App Store, Play) braucht Tage. Ein Server-Deploy, der auf ein noch nicht freigegebenes Client-Release wartet, ist falsch herum.
3. **Interna sind kein Vertrag.** Was mit `_` beginnt oder nicht in `editor-api.d.ts` steht, darf der Server ohne Ankündigung ändern. Braucht ein Client es, bekommt das Handle eine öffentliche Funktion. Die Schuldenliste in `tests/unit/editor-surface.test.js` darf nur schrumpfen.
4. **Logik einmal.** Was zwei Clients gleich rechnen müssen, gehört auf den Server oder ins Bundle, nicht zweimal nativ. Beispiel Block-Merge: Ein Push mit `base_html` lässt den Server mit derselben Engine mergen ([lib/page-merge.js](../lib/page-merge.js)). Kollisionsfrei antwortet er mit `200 merged: true`, bei echter Kollision mit `409` und `merge_conflicts`.

## Eine Vertragsänderung (Server-Seite)

1. Schema bzw. Operation in [spec/](spec/) ändern, dann `npm run contract:build`.
2. Neuer Weg ⇒ neuer Fall in [tests/integration/_helpers/contract-cases.js](../tests/integration/_helpers/contract-cases.js), dann `npm run contract:fixtures`.
3. `version.json` → `api` +1 (Bundle-Bruch zusätzlich: `editorApi` +1). Danach einen Abschnitt in `CHANGELOG.md` mit **«Clients müssen»** bzw. **«Clients dürfen»** schreiben.
4. Bundle angefasst: `npm run check:clients`. Neue, gewollte Kontaktstelle eines Clients: `npm run contract:surface`.
5. Deployen. Dann bekommt jede Client-Sitzung **eine Zeile**: «Vertrag api N → N+1, siehe contract/CHANGELOG.md». Sie zieht `contract/` per `scripts/sync-contract.sh`, die Decoding-Tests zeigen, was zu tun ist.

**Fixture-Diff ohne Absicht** heisst: Der Server hat etwas geändert, das ein Client liest. Das ist zuerst ein Befund, kein Grund, die Fixtures neu zu schreiben.

## Befehle

```
npm run contract:build      # openapi.json aus spec/
npm run contract:fixtures   # Fixtures neu (Integrationstest im Schreibmodus)
npm run contract:surface    # editor-surface.json ergänzen (nie kürzen; -- --prune erst ohne Alt-Geräte)
npm run check:clients       # Bundle gegen die Clients: fehlt / berührt / undeklariert
```

Geprüft wird in CI: [tests/unit/contract-spec.test.js](../tests/unit/contract-spec.test.js) (Spec frisch, Versionen, CHANGELOG), [tests/unit/editor-surface.test.js](../tests/unit/editor-surface.test.js) (Fläche gegen Bundle), [tests/integration/client-contract.test.js](../tests/integration/client-contract.test.js) (jede Operation durch die echte Device-Token-Kette, Fixtures unverändert), dazu der CI-Schritt «Client-Kompatibilität» (`check:clients` gegen `main` beider Client-Repos).
