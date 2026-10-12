# Focus-Editor — Akzeptanzliste (2 Minuten, vor jedem Commit)

Pflicht bei **jeder** Änderung an `public/js/editor/focus/`, `public/js/editor/shared/`
(Konsument Focus), `public/css/editor/focus/` oder `public/partials/editor-focus.html`
— siehe harte Regel „Focus-Editor ist stabilisiert" in [CLAUDE.md](../CLAUDE.md).

**Geklickt, nicht gelesen.** Die Liste existiert, weil Code-Lesen und grüne Tests
beides schon gleichzeitig richtig waren, während der Editor sich falsch anfühlte:
die Schreiblinien-Geometrie hängt an der CSS-Höhenkette der echten Shell, und die
sieht kein Fixture-Harness.

## Vorbereitung

```
npm start          # Port 3737, echte DB
```

Beliebiges Buch, eine Seite mit **mindestens 30 Absätzen** (kurze Seiten verstecken
genau die Tail-Puffer-Fehler). Fokusmodus über den Button in der Seiten-Kopfzeile
bzw. Cmd/Ctrl+Shift+E.

## Die elf Griffe

| # | Handgriff | Erwartung |
|---|-----------|-----------|
| 1 | Fokusmodus betreten (zuletzt am Ende verlassen) | Overlay füllt den Bildschirm, Caret blinkt am Buchende, Schreibzeile auf der Bildschirmmitte |
| 2 | Drei Absätze tippen (mit Enter dazwischen) | Zeile bleibt auf der Mitte, wandert **nicht** schrittweise nach unten |
| 3 | Cmd/Ctrl+Home, dann in die **erste** Zeile klicken und tippen | Erste Zeile liegt auf der Schreiblinie, nicht am oberen Rand |
| 4 | In den **letzten** Absatz klicken und tippen | Letzte Zeile erreicht die Schreiblinie (nicht „man kommt nur bis zum zweitletzten") |
| 5 | Mit dem Mausrad durch die ganze Seite scrollen | Spotlight folgt dem Absatz in der Bildschirmmitte; kein Springen, kein Flattern |
| 6 | Mitten in einen Absatz klicken | Caret landet dort, **kein** Recenter-Sprung (Pointer-Schonfrist) |
| 7 | Ein Wort doppelklicken, dann eine Passage über zwei Absätze ziehen | Auswahl bleibt stehen, Viewport springt nicht |
| 8 | Granularität in den Einstellungen umschalten (Absatz ↔ Satz) | Umschaltung sofort, ohne Exit/Re-Entry, Markierung korrekt |
| 9 | Escape (bzw. Exit-Button) | Speichert, Overlay weg, zurück in die Leseansicht, Kennzahlen aktualisiert |
| 10 | Wieder betreten, Fenster schmal ziehen (< 500 px) | Schreiblinie sitzt weiter auf der Mitte, kein horizontaler Overflow |
| 11a | Einen Satz tippen, **eine Sekunde warten** (nicht in den Text klicken!), einen zweiten Satz tippen, **einmal** Cmd/Ctrl+Z | Nur der zweite Satz ist weg, der erste steht. Danach Cmd/Ctrl+Shift+Z holt ihn zurück. In **Safari** prüfen: dort nahm der Browser-Undo die ganze Strecke (Invariante 19) |
| 11 | Kurz vor der Umbruchkante weiterschreiben (Wörter mit Leerschlag), danach Shift+Enter mitten im Absatz **und** am Absatzende; Escape, Seite erneut öffnen | Das letzte Wort bleibt beim Leerschlag auf seiner Zeile (fällt nicht ab und springt zurück). Shift+Enter erzeugt an beiden Stellen eine sichtbare neue Zeile, die nach dem erneuten Öffnen noch da ist |

Zusätzlich bei Änderungen an Enter/Exit oder der Schreibstelle ([caret-memory.js](../public/js/editor/focus/caret-memory.js)):

- **13** — In der Seitenmitte klicken, ein Wort tippen, Escape, wieder betreten:
  Caret steht an derselben Stelle, der Absatz liegt auf der Schreiblinie, **kein**
  leerer Absatz am Ende angehängt. Dann ans Ende (Cmd/Ctrl+End), Escape, wieder
  betreten: Caret wieder am Buchende wie in Griff 1.

Zusätzlich bei Änderungen an Save/Draft/Exit:

- **12** — Tippen, dann Netzwerk in den DevTools offline schalten, Escape drücken:
  User bleibt im Edit-Modus, Draft ist erhalten (kein stiller Verlust).

Bei Änderungen an der pre-wrap-/Umbruch-Kette (Invariante 11c) zusätzlich eine Seite
mit Alt-Bestand öffnen (importierter oder aus dem Web eingefügter Text): keine
Phantom-Umbrüche mitten im Absatz, kein Einzug in der ersten Zeile — und ein
Gedicht (`.poem`) behält seine Verszeilen.

Bei Änderungen, die Mobile/Tastatur berühren (`viewport.js`, `--focus-vh`,
`cursor-hide.js`): Punkt 1–5 zusätzlich in der Chrome-Device-Emulation (iPhone-Profil)
mit eingeblendeter Tastatur-Simulation.

## Native Clients

Pflicht bei jeder Änderung an einer Datei des OTA-Editor-Bundles ([lib/editor-bundle.js](../lib/editor-bundle.js):
`ENTRY_MODULES`-Closure + `CSS_FILES`). Beide nativen Clients laden sie beim nächsten Deploy ohne App-Update
([clients.md](clients.md)):

- **macOS** ([schreibwerkstatt/focuseditor](https://github.com/schreibwerkstatt/focuseditor)): Glue-Skripte und
  Host-CSS als Strings in `schreibwerkstatt-focuseditor/Web/*.swift`.
- **Android** ([schreibwerkstatt/mobile](https://github.com/schreibwerkstatt/mobile)): `app/src/main/assets/editor-host/`
  (`host.html`, `editor-host.css`) plus Kotlin-Strings.

```
npm run check:clients                    # beide Repos nach ~/.cache holen/aktualisieren, gegen den Arbeitsstand prüfen
npm run check:clients -- --client mac    # nur einer (mac | android); --verbose listet alle Kontaktstellen
```

Massstab ist **Breaking Change, nicht Feature-Parität**: was neu ins Bundle kommt, lädt der Client einfach mit.
Geprüft wird, ob etwas wegfällt, worauf der Client-Code sich verlässt. Das Skript zieht diese Kontaktstellen bei
jedem Lauf frisch aus den Repos: Module, Exporte, Optionen an `mountStandaloneFocus`/`create…Controller`, Felder des
eigenen Bridge-Objekts, Handle-/Host-/Controller-Felder (bis in Interna wie `_focusUpdateActive`), Klassen
(auch das Checklisten-Markup, das Android selbst anlegt, gegen [todo-html.js](../public/js/editor/shared/todo-html.js)),
CSS-Variablen, Highlight-Namen und Manifest-Felder.

- **FEHLT** (Exit 1) — Breaking Change. Nicht deployen, bevor der Client nachgezogen ist oder der Name bleibt.
- **BERÜHRT** — die Kontaktstelle existiert noch, eine Datei mit ihr ist geändert. An der genannten Client-Zeile
  lesen, ob die Semantik noch trägt — vor allem die `!important`-Overrides auf `.focus-editor__content`
  (macOS: Typografie und `padding-bottom` aus `--focus-vh`/`--focus-anchor`; Android: eigene Puffer
  `--sw-pad-top`/`--sw-pad-bottom`, `box-sizing`, `<hr>` und Checkliste).

**Hervorhebung.** Beide Clients docken an die Fokus-Hervorhebung an: macOS koppelt seinen Dimm-Regler über
`--focus-dim-opacity` und die Farbe von `::highlight(focus-sentence-dim)`, schaltet die Stufen über
`setGranularity` (Fallback: `focus-mode--*`-Klassen + `controller._focusUpdateActive`); Android ersetzt
`host.typewriterAnchor` durch einen Getter, der der Tastatur folgt. Dass das nicht nur benannt ist, sondern
**wirkt**, prüft der Vertragstest [tests/e2e/_helpers/focus-client-contract.js](../tests/e2e/_helpers/focus-client-contract.js)
in Chromium und in WebKit, der Engine des macOS-Clients (`focus-client-contract{,.webkit}.spec.js`, beide Teil von
`npm run test:focus`): jede Abdunkelung in Absatz-, Satz- und Drei-Absatz-Stufe folgt `--focus-dim-opacity`
(bzw. `--focus-near-opacity`), keine Blockart bleibt ungedimmt, Schreibmaschine dimmt nichts, der Satz-Modus
läuft über `focus-sentence-dim`, und die Engine liest den Anker bei jedem Recenter neu. Eine neue Dimm-Regel
mit fest verdrahteter Opacity macht ihn rot.

Was beide Prüfungen nicht sehen, weil die Schalen anders leben als die SPA ([standalone.js](../public/js/editor/focus/standalone.js)):
kein Alpine, keine Notebook-Toolbar (`notebook/toolbar/keydown.js` läuft dort **nicht** — Grenzschutz und
Geschwister-Merge kommen aus `shared/block-edge.js`, Verlauf und Checkbox-Liste bleiben beim Browser-Default),
Mount ohne `shared/mount-html.js` (nur Tabellen werden atomar gemacht, Diagramme/Abbildungen/Quellen-Chips nicht),
Undo über das native Menü statt `keydown`. Eine Änderung, die eine dieser SPA-Leistungen voraussetzt, zusätzlich in
[tests/e2e/focus-standalone.spec.js](../tests/e2e/focus-standalone.spec.js) bzw. dem WebKit-Projekt
(`env -u GIO_MODULE_DIR npx playwright test --project=webkit`, Engine des macOS-Clients) gegenprüfen.

## Danach

```
npm run test:focus     # Harness-Suite + App-Suite (echtes CSS)
```

Grün ist die **Untergrenze**, nicht der Beweis: die App-Suite (`focus-editor-app.spec.js`
+ `focus-acceptance-app.spec.js`, Chromium und Firefox) deckt inzwischen alle elf Griffe
und Punkt 12 ab — die Aufschlüsselung steht in [focus-editor.md](focus-editor.md#tests).

Darum bleibt diese Liste trotzdem geklickt: die Automatisierung misst Positionen und
Einzelbilder. Zucken oder Flattern beim echten Tipptempo, echte Mobil-Tastaturen und
-IMEs, echtes Safari und der macOS-Client sieht sie nicht — genau dort kann sich der
Editor falsch anfühlen, ohne rot zu werden.
