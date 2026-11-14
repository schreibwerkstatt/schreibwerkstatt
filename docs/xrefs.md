# Querverweise

„siehe Kapitel 3", „vgl. Abb. 3.2" — Verweise, die beim Rendern automatisch die richtige Nummer bekommen. Mechanisch der Zwilling der Quellenangabe ([docs/quellen.md](quellen.md)): Marker mit Zeiger im Seiten-HTML, aufgelöst im Render-Pfad.

Die harten Regeln stehen in [CLAUDE.md](../CLAUDE.md) („Editor-Blockstruktur → Querverweise"); hier stehen die Details.

## Markup

SSoT [public/js/xrefs/xref-html.js](../public/js/xrefs/xref-html.js) — erzeugen via `buildXrefHtml()`, finden via `XREF_SEL`/`isXrefEl()`/`closestXrefEl()`, auslesen via `collectXrefs()`/`xrefsByTarget()`, im Editor atomar machen via `markXrefsAtomic()`. Keine `'xref'`/`'data-xref'`/`'data-xref-id'`-Literale in JS.

```html
<span class="xref" data-xref="chapter" data-xref-id="42">Kapitel 3</span>
```

Ziel-Typen: `chapter` (→ `chapters.chapter_id`), `figure` und `table` (beide → `data-bid` aus `ensureBlockIds`, **kein eigenes Anker-Attribut**; Beschriftung aus `<figcaption>` bzw. `<caption>`) und reserviert `page` (braucht Zwei-Pass-Render, weil die Seitenzahl erst nach dem Umbruch feststeht).

## Nummern folgen der gerenderten Einheit

Die zentrale Invariante — schärfer als beim Quellen-Chip. „Kapitel 3" ist keine Eigenschaft des Kapitels, sondern des **Ausgabewegs**:

- PDF-Profil mit römischer Nummerierung → „Kapitel III"
- `numbering: 'none'` → der Verweis fällt auf den Kapiteltitel zurück
- Kapitel-Scope-Export → zählt ab 1

Darum ruft **jeder** Exporter [lib/xref-render.js](../lib/xref-render.js)#`applyXrefsInHtml`/`applyXrefsInGroups` auf dem Seiten-HTML, **bevor** sein Walker läuft — dieselbe Reihenfolge und derselbe Vertrag wie `resolveCitesInHtml`.

**Kein zweiter Zählautomat für Kapitel:** der PDF-Renderer reicht seine bereits für Überschriften + TOC berechneten Labels als `chapterLabels` herein ([pdf-render/numbering.js](../lib/pdf-render/numbering.js)#`computeChapterLabels` bleibt SSoT). Ausgabewege ohne eigene Kapitel-Nummerierung lassen die Map offen und bekommen die nested-arabische Vorgabe aus [xref-number.js](../public/js/xrefs/xref-number.js).

Abbildungen zählen **kapitelweise** („Abb. 3.2"); trägt auch nur eine Abbildung ein Kapitel ohne Label, kippt die **ganze** Einheit auf buchweite Zählung — sonst stünden „3.2" und „7" nebeneinander.

## Ein unauflösbarer Verweis wird nie überschrieben

Verwaistes Ziel oder Ziel ausserhalb des gerenderten Ausschnitts: der Cache-Text des Autors bleibt stehen, der Fund wird gemeldet (`meta.xrefUnresolved` im PDF-Job, Rückgabefeld `unresolved` sonst). Kein „???" im Manuskript.

## Abgeleitete Indexe, nie inkrementell

`xref_anchors` (Ziele im HTML) + `xref_links` (Verweise) werden pro Seiten-Write per Full-Replace aus dem HTML neu geschrieben ([lib/xref-index.js](../lib/xref-index.js) am Content-Store-Chokepoint, Muster `cite-index.js`). **Anker zuerst, dann Verweise** — der Buch-Guard prüft Abbildungs-Ziele gegen `xref_anchors`.

Beide Tabellen bedienen nur die Oberfläche (Ziel-Picker `GET /xrefs/targets`, Rückwärtsfrage `GET /xrefs/backlinks`); der **Renderer liest die Anker aus dem HTML, das er gerade rendert** — so stimmt der Scope automatisch und das Ergebnis hängt nicht an der Index-Frische.

## Dieselben Schutzschichten wie beim Quellen-Chip

- **Paste-Allowlist** ([utils/html/paste.js](../public/js/utils/html/paste.js)) — sonst zerfällt ein kopierter Satz zu einer toten Zahl.
- **LanguageTool**: `XREF_SKIP_SEL` als bewusste Kopie in [editor-spellcheck/mapping.js](../public/js/cards/editor-spellcheck/mapping.js), gegated durch [cite-guard-drift.test.mjs](../tests/unit/cite-guard-drift.test.mjs).
- **`contenteditable` nie in der Persistenz.**
- **TTS liest Querverweise bewusst MIT** — „siehe Kapitel 3" ist Teil des Satzes, anders als ein Klammerbeleg.

Nummerierte Abbildungslegenden („Abb. 3.2: …") und Tabellenbeschriftungen („Tab. 3.2: …") sind ein Render-Artefakt, gated über `book_settings.figure_numbering` bzw. `table_numbering` (buchweit, nicht pro Exportprofil — wie der Zitierstil).

### Am Bildschirm: Vorschau-Badge statt Text

Die Leseansichten zeigen die Nummer, **ohne sie in den Text zu schreiben**: [caption-preview.js](../public/js/xrefs/caption-preview.js) setzt `<span class="xref-num">Abb. 3.2: </span>` vor die Beschriftung. Konsumenten sind die **Notebook-Leseansicht** ([editor/notebook/card.js](../public/js/editor/notebook/card.js)#`_setupNotebookCaptionNumbers`, nur ohne `--editing`) und der **Bucheditor** ([cards/book-editor-card.js](../public/js/cards/book-editor-card.js)#`_syncBlockCaptionNumbers`, jeder Block ausser dem aktiven — dieselbe Mechanik wie beim Diagramm). Der **Share-Reader** bekommt seine Nummern serverseitig über denselben Weg wie jeder Export ([share-helpers.js](../lib/share-helpers.js)#`applyXrefsForShare`), der **Focus-Editor** gar keine.

Die Zahlen sind eine **Vorschau** nach nested-arabischer Vorgabe; das Exportprofil entscheidet endgültig. Quelle ist `/xrefs/targets` über den geteilten [target-cache.js](../public/js/xrefs/target-cache.js) — derselbe Cache, aus dem der Ziel-Picker seine Nummern nimmt. Zwei Caches wären zwei Stände desselben Buchs.

**Eine frisch eingefügte Abbildung bekommt ihre Nummer erst nach dem Neuladen der Seite.** Der Zeiger ist das `data-bid`, und das vergibt `ensureBlockIds` am Schreib-Chokepoint; der Editor behält nach dem Speichern seinen eigenen Stand (`originalHtml = html` in [edit/save-success.js](../public/js/editor/notebook/edit/save-success.js)#`_applySaveSuccess`). Dieselbe Eigenschaft hat der Ziel-Picker — eine eben eingefügte Abbildung ist erst nach dem Neuladen ein Verweisziel. Bestehende Abbildungen tragen ihr `data-bid` schon und sind sofort nummeriert.

**Das Badge erreicht die Persistenz nicht.** Es wird an drei Stellen entfernt: vor jedem neuen Lauf (idempotent), in der Dirty-Vergleichsform ([editor/shared/html-clean.js](../public/js/editor/shared/html-clean.js)) und am Schreib-Chokepoint ([lib/html-clean.js](../lib/html-clean.js)#`_UI_ARTEFACT_SEL`) — die tragende Schicht. Gegated durch [figure-drift](../tests/unit/figure-drift.test.mjs).

### Abbildungs- und Tabellenverzeichnis

Zwei Bauarten, eine Quelle. Beide lesen ihre Einträge aus demselben Xref-Kontext, der die Legenden nummeriert hat — ein zweiter Zählautomat erzeugte „Abb. 3.2" im Verzeichnis neben „Abb. 3.1" am Bild.

| | Modul | Seitenzahlen |
|---|---|---|
| HTML · Markdown · TXT · DOCX · EPUB | [lib/anchor-directory.js](../lib/anchor-directory.js) | nein — dort ist die „Seite" eine Funktion des Lesegeräts |
| Custom-PDF | [lib/pdf-render/anchor-dir.js](../lib/pdf-render/anchor-dir.js) | ja, Zweipass wie beim Inhaltsverzeichnis |

Sichtbarkeitsregel überall gleich: **nur beim ganzen Buch** (ein Kapitel ist keine Publikation mit eigenem Apparat) und **nur bei nummeriertem Typ** — die Nummerierung des Buchs ist der Schalter, einen eigenen Profil-Schalter gibt es bewusst nicht. Im PDF stehen die Verzeichnisse hinter dem Inhaltsverzeichnis; die Seitenzahl meldet der Body-Renderer beim Zeichnen ([blocks.js](../lib/pdf-render/blocks.js) für das Bild, [table.js](../lib/pdf-render/table.js)#`reportStart` für die erste gezeichnete Tabellenzeile), der Stempel-Pass trägt sie nach.

**Abbildungen und Tabellen zählen GETRENNT** — zwei Zähler in [xref-number.js](../public/js/xrefs/xref-number.js), zwei Schalter. „Abb. 3.1" und „Tab. 3.1" stehen im Fachbuch nebeneinander; ein gemeinsamer Zähler machte aus der ersten Tabelle eines Kapitels „Tab. 3.4", nur weil davor drei Abbildungen stehen. Auch die Rückfallebene auf buchweite Zählung fällt pro Typ. Der Buch-Guard in [db/xrefs.js](../db/xrefs.js) prüft **Typ und Buch**: ein `data-xref="table"` auf das `data-bid` einer Abbildung bekommt keine Zeile. Details zum Tabellen-Feature: [docs/tabellen.md](tabellen.md).

## Routen und Oberfläche

```
GET /xrefs/targets?book_id=    Ziel-Picker (Kapitel + Abbildungen + Tabellen)
GET /xrefs/backlinks?…         wer verweist auf dieses Ziel
```

Einfügen im **Notebook-Editor**: [toolbar/xref.js](../public/js/editor/notebook/toolbar/xref.js), inline am Caret über die Range-API (gleiche Chromium-Falle wie beim Quellen-Chip, siehe [docs/quellen.md](quellen.md)). Focus-Editor und Bucheditor stellen Verweise dar, bringen aber keinen Einfügepfad mit.

## Tests

[xref-number](../tests/unit/xref-number.test.mjs) (Nummernvergabe, Kapitel-Kippen) · [xref-render](../tests/unit/xref-render.test.js) (Auflösung, unauflösbare Verweise) · [pdf-anchor-dir](../tests/unit/pdf-anchor-dir.test.js) (Verzeichnis-Plan) + [pdf-anchor-dir-render](../tests/unit/pdf-anchor-dir-render.test.mjs) (Verzeichnisseite im gesetzten PDF) · [figure-drift](../tests/unit/figure-drift.test.mjs) · [xref-index](../tests/unit/xref-index.test.js) (Anker/Links am Chokepoint) · [label-margin-drift](../tests/unit/label-margin-drift.test.mjs) · App-E2E [notebook-xref](../tests/e2e-app/notebook-xref.spec.js).
