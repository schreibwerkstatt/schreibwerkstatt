# Figuren-Graph

Drei Render-Modi auf einer vis-network-Instanz: Figurengraph (Kapitel-Swimlane), Familie (hierarchischer Baum), Soziogramm (Schicht senkrecht, Nähe waagrecht, Kapitel als Inseln). Modus-Toggle ohne Page-Reload, kein Re-Fetch der Figuren — alle Modi lesen aus `window.__app.figuren`.

Code: [public/js/graph.js](../public/js/graph.js) (Facade) + [public/js/graph/](../public/js/graph/) (Slices). Eingehängt in [public/js/cards/figuren-card.js](../public/js/cards/figuren-card.js) via `...graphMethods` im `Alpine.data`-Pool.

Den vis-network-Unterbau teilt er sich mit der **Motiv-Konstellation** ([docs/motiv-werkstatt.md](motiv-werkstatt.md)): [public/js/graph-kit.js](../public/js/graph-kit.js) hält Bundle-Nachladen, Hover-Tooltip und Canvas-Farbauflösung. Was dort liegt, wird **nicht** pro Graph nachgebaut; was fachlich ist (Figurentyp-Palette, Beziehungs-Styling, Layout), bleibt hier.

## Modul-Layout

| Slice | Verantwortung |
|-------|---------------|
| `graph/constants.js` | **SSoT für alle Graph-Farben.** `DEFAULT_FONT`, `nodeLabel`, `SCHICHT_COLOR` (inkl. `band`-Streifen + `label`-Textfarbe pro Schicht), `SCHICHT_LEVEL`, `TYP_COLOR` (Node-Füllung), `TIER_COLOR` (Text-/Akzentfarbe), `BZ` (Edge-Styles Figurengraph), `BZ_SOZIO_COLOR`/`BZ_SOZIO_CAT` (Soziogramm), `DIRECTED_TYPES`. |
| `graph/core.js` | Mode-Switch (`setFigurenGraphModus`), Fullscreen-Toggle, Render-Dispatcher (`renderFigurGraph`), Hash-Cache, vis-Bundle + Theme-Auflösung. |
| `graph/shared.js` | `_theme` (aufgelöste Canvas-Farben), `_figTypColor`/`_schichtNodeColor`/`_nodeFont` (Paletten, für den Grund nachgeführt), `_baseNode` (gemeinsame vis-Node-Basis), `_figurenGraphSetKapitel` (Kapitel-Filter dim/highlight), `_buildEdges` (Edge-Liste mit Dedup, id→Figur-Map), `_attachTooltip` (Hover-Tooltip mit Escape, id→Figur-Map; Knoten-Klick öffnet die Figur im Reiter «Liste» über `_openFigurFromGraph`). |
| `graph/layout.js` | **Reine** Swimlane-Berechnung: `computeSwimlaneLayout`, `figureInfo`, `columnWidth`, `importanceBorderWidth` + die Konstanten (`TIER_ORDER`, `ROW_H`, `MIN_DX`). Kein DOM, kein vis → in [tests/unit/graph-layout.test.mjs](../tests/unit/graph-layout.test.mjs) direkt testbar. |
| `graph/figurengraph.js` | Kapitel-Swimlane (deterministisch, ohne Physics) — zeichnet, was `layout.js` rechnet. |
| `graph/familiengraph.js` | Familienbaum zeichnen (vis). |
| `graph/family-layout.js` | Rein: Familien-Edges normalisieren, Generationen, x-Lage je Familie, Familien als Raster packen. |
| `graph/soziogramm.js` | Soziogramm zeichnen: Bänder, Kapitel-Hüllen, Brücken-Marken, Begegnungs-Kanten — Positionen aus `soziogramm-layout.js`. |
| `graph/soziogramm-layout.js` | **Reine** Soziogramm-Rechnung: `computeSoziogrammLayout` (Bänder, Zeilen nach Macht, Inseln, Federn), `powerScores`, `pairNaehe`, `begegnungenOf`, `schichtOf`. |
| `graph/soziogramm-force.js` | **Rein:** `relaxX` — Relaxation nur entlang X bei fester Y-Lage (Federn, Abstossung in der Zeile, Anker). Deterministisch. |
| `graph/soziogramm-hulls.js` | **Rein:** `convexHull`, `paddedHull` für die Kapitel-Inseln. |
| `graph/soziogramm-controls.js` | Schalter «Kapitel-Inseln»/«Begegnungen», Stand + Start des Jobs `figuren-naehe`. State über `soziogrammState()`. |

Die drei reinen Module sind in [soziogramm-layout.test.mjs](../tests/unit/soziogramm-layout.test.mjs) direkt getestet, auch gegen [tests/fixtures/soziogramm-roman.json](../tests/fixtures/soziogramm-roman.json) — die anonymisierte Struktur eines echten Romans mit fünf Porträt-Kapiteln (137 Figuren, Typ/Schicht/Kapitel/Beziehungen mit Macht und Nähe/Szenenbesetzung, keine Namen und Texte).

## State auf der Card

```js
figurenGraphModus       // 'figur' | 'familie' | 'soziogramm'
figurenGraphKapitelId   // chapter_id | null — gewähltes Kapitel-Filter (per ID, chapter-hierarchy.md)
figurenGraphFullscreen  // Boolean
soziogrammInseln        // Boolean, Standard an — Kapitel-Inseln (greifen nur, wenn die Kapitel eigene Welten sind)
soziogrammBegegnungen   // Boolean, Standard aus — Begegnungs-Kanten aus dem Szenen-Katalog
_figurenNetwork         // vis.Network — wird im destroy()/onBookChanged geräumt
_figurenHash            // String — Cache-Key (kapSig + Modus + Locale)
_figurenNodes           // vis.DataSet
_figurenEdges           // vis.DataSet
```

`destroy()` und `onBookChanged` rufen `_figurenNetwork.destroy()` und nullen die Refs.

## Render-Dispatch (`core.js#renderFigurGraph`)

```
container vorhanden?           → sonst no-op
vis geladen?                   → sonst loadVis() (lazy-libs), Placeholder währenddessen
hash = renderSig + Kapitelachse + modus + locale + theme → match? no-op
network destroyen + null'en
figuren leer?                  → Placeholder, return
modus switch:
  'soziogramm' → _renderSoziogramm
  'familie'    → _renderFamiliengraph
  default      → _renderFigurengraph
falls figurenGraphKapitel → rAF → _figurenGraphSetKapitel
```

`renderSig` deckt pro Figur **alle** layout-/edge-relevanten Felder ab: `id`, `typ` (Tier-Achse), `sozialschicht` (Soziogramm-Band), Kapitel (`name+häufigkeit` → X-Achse + Presence) und Beziehungen (`figur_id+typ+machtverhältnis+nähe` → Edges, Macht-Sortierung, Federlängen). Im Soziogramm zählen zusätzlich die beiden Schalter und — bei eingeschalteten Begegnungen — die Besetzung jeder Szene. Nur die Kapitel zu prüfen würde nach einem Typ-/Schicht-/Beziehungs-Edit den alten Stand zeigen (Hash matcht trotz Datenänderung). Locale ist Teil des Keys, weil Labels (Tier-Pills, Schicht-Labels, Tooltips) lokalisiert sind. Die **Kapitelachse** (`figurenKapitelOptionen()`: Reihenfolge + Titel aus dem Baum) ebenfalls — Umsortieren oder Umbenennen eines Kapitels ändert keine Figur, verschiebt aber X-Achse und Kopfzeilen; ein Watcher auf `_chapterIdOrderMap`/`_chapterLabelMap` in [figuren-card.js](../public/js/cards/figuren-card.js) stösst den Render an.

## Modi

### Figurengraph (Kapitel-Swimlane)

Deterministisches Layout, kein Physics:

- **X = narrative Kapitel-Achse.** Jede Figur landet auf dem **gewichteten Mittel** ihrer Kapitel-Indizes (`weight = häufigkeit^1.5`). Damit ziehen häufige Auftritte stärker.
- **Y = Tier (Figurentyp).** Reihenfolge: `hauptfigur, antagonist, mentor, nebenfigur, randfigur, andere`. Nur belegte Tiers werden gerendert.
- **Greedy-Stapelung innerhalb Tier.** Figuren landen am tatsächlichen X-Schwerpunkt (kein Binning). Mindestabstand `MIN_DX = 130`. Wenn unterer Slot belegt, geht es eine Zeile (`ROW_H = 50`) nach unten. Jedes Tier reserviert genau so viel vertikalen Platz wie es Stapelzeilen hat — Nebenfiguren-Stapel ragen nie ins nächste Tier.
- **Spaltenbreite adaptiv:** `COL_W = clamp(160, 440, containerW / max(N, 4))`. Floor verhindert, dass bei 30+ Kapiteln eine 16k-Canvas entsteht, in die `fit()` winzige Nodes hineinzoomt.
- **Border-Width = Wichtigkeit:** `1 + round(log2(Σ häufigkeiten))`, clamped auf 4.

Custom-Canvas-Overlays via `beforeDrawing`/`afterDrawing`:

1. **Kapitel-Spalten** in Netzwerk-Koordinaten (zoomen mit). Alternierende Fillstyle für Streifen, dünne Trennlinien.
2. **Kapitel-Header oben** in Screen-Koordinaten (feste Lesegrösse, folgen Pan). **Adaptive Schriftgrösse** (11–18 px) skaliert mit Canvas-Höhe. **Adaptive Stride:** bei dicht gezoomten Spalten wird nur jeder n-te Header gezeichnet (`step = ceil(70 / pxPerCol)`), letzter Header immer (Orientierung). **Adaptive Truncation:** Labels werden bei kleineren Canvas auf 34 Zeichen gekürzt, bei höheren auf 60.
3. **Tier-Labels links** in Screen-Koordinaten. Pill-Hintergrund (`roundRect` mit Fallback für ältere Browser).
4. **Presence-Bar unter jeder Node** in Netzwerk-Koordinaten. Segment pro Kapitel; Alpha skaliert mit Häufigkeit (`0.35 + h/5`, clamped 1). Min-Breite skaliert mit N (`min(220, max(70, N*3))`).

**Click auf Kapitel-Header** → Filter setzen/togglen via `_figurenGraphSetKapitel`. Getroffen wird in **Bildschirm-Koordinaten** (`layout.js#headerHitColumn`: `pointer.DOM.y` innerhalb der gezeichneten Kopfzeile), weil die Kopfzeile dort gezeichnet wird — in Netz-Koordinaten hinge die Trefferzone am Zoom. Liegt ein Knoten unter dem Klick, gewinnt der Knoten-Klick.

**`fit()` auf Node-IDs** statt Canvas-Bounding-Box: leere Kapitel-Spalten würden die BBox aufblähen → Nodes mikroskopisch.

### Familiengraph

Kanten: `elternteil`/`kind`/`geschwister`, dazu `ehepartner`, sofern eine Seite blutsverwandt im Baum steht ([family-layout.js](../public/js/graph/family-layout.js)#`familyEdges`). Eltern-Kind ist in den Daten aus beiden Perspektiven erfasst (`typ` = Rolle von `to`) — gezeichnet wird einheitlich als `kind` von Eltern zu Kind, Pfeil zum Kind, Doppelungen fallen weg.

Layout ohne Physics, komplett selbst gerechnet ([family-layout.js](../public/js/graph/family-layout.js)) — vis zeichnet nur:
1. **Generationen** (`familyLevels`): Geschwister und Ehepartner auf derselben Ebene, Kind = Elternteil + 1; ein Elternteil ohne eigene Eltern rückt an sein Kind heran. Widersprüchliche Eltern-Kind-Zyklen werden vorher aufgebrochen (Rückkanten einer Tiefensuche verworfen) — sonst schaukelt der längste Pfad die Ebenen hoch.
2. **x-Lage je Familie** (`familyPositions`): Ehepaare — und gemeinsame Eltern eines Kindes auch ohne erfasste Ehe — bilden eine Einheit und stehen nebeneinander. Reihenfolge je Ebene per Barycenter-Sweeps, danach zieht jede Einheit zum Mittel ihrer Eltern und Kinder (Paarmitte über dem Kind), überlappungsfrei bei fester Reihenfolge (gewichtete isotone Regression). vis' Hierarchie-Layout taugt dafür nicht: es kennt keine Paare und zentriert ein Kind nicht unter zwei Elternteilen.
3. **Familien als Raster packen** (`packFamilies`): jede zusammenhängende Familie behält ihre innere Lage, die Familien füllen Zeilen nach dem Seitenverhältnis des Containers. Sonst liegen viele kleine Familien in einer langen Reihe, und `fit()` macht sie winzig.

Eingepasst wird nach dem ersten Zeichnen (`afterDrawing`). Gegated: [family-layout.test.mjs](../tests/unit/family-layout.test.mjs), [familiengraph.spec.js](../tests/e2e-app/familiengraph.spec.js).

Wenn keine Familien-Edges existieren → Placeholder (`graph.empty.familie`).

### Soziogramm

Zwei Achsen, zwei Arten von Abstand. Positionen rechnet [soziogramm-layout.js](../public/js/graph/soziogramm-layout.js) vollständig vor; vis zeichnet **ohne Physics** (`physics: false`, Knoten mit `fixed: { y: true }` — der User zieht nur waagrecht).

- **Y = gesellschaftlicher Abstand.** Ein Band je Schicht in der Reihenfolge von `SCHICHT_LEVEL` (Wirtschaftselite=0 ↓ Unterwelt=6). Leere echte Schichten behalten ihren Platz, die Lücke zeigt die fehlende Schicht. **«andere» (keine oder unklare Schicht) hat ein eigenes Band «ohne Angabe»** direkt unter der untersten belegten Schicht — teilte es die Ebene mit der Mittelschicht, stünden in Büchern mit vielen Randfiguren die meisten Figuren in einem Band, und «ohne Angabe» läse sich als «Mittelschicht». Unbekannte Werte zählen als `andere` (`schichtOf`).
- **Im Band: Zeilen nach Macht.** Eine Gruppe (Schicht, mit Inseln: Schicht × Insel) bekommt bis zu drei Zeilen (`ROW_GAP` 52), gefüllt nach `powerScores` absteigend: die Mächtigsten oben. Konvention: `bz.machtverhaltnis > 0` an A→B heisst, B dominiert; beide Seiten zählen, eine beidseitig erfasste Beziehung (auch als Gegenpaar) einmal.
- **X = Nähe.** Jede Beziehung ist eine Feder, Ruhelänge aus der Nähe des Paars (`NAEHE_LEN`: innig 110 … feindselig 480; Mittel über alle Beziehungen des Paars, `pairNaehe`). Die Länge gilt im Raum: Figuren in weit getrennten Schichten erreichen eine kurze Ruhelänge nie und werden übereinander gezogen. `relaxX` ([soziogramm-force.js](../public/js/graph/soziogramm-force.js)) bewegt nur X; Abstossung wirkt nur zwischen Knoten derselben Zeile, die sich sonst überdecken (`NODE_W` 175), ein Abschluss-Durchgang löst Restüberdeckungen auf.
- **Kapitel-Inseln** (Schalter, Standard an). Greifen nur, wenn die Kapitel eigene Welten sind: 2–12 Kapitel mit Figuren **und** die Mehrheit der Figuren mit Kapitelangabe steht in genau einem Kapitel. Dann bekommt jedes Kapitel in Buchreihenfolge einen X-Anker (Breite = seine breiteste Schicht-Gruppe), seine Figuren ziehen schwach dorthin; Figuren aus mehreren Kapiteln hängen am gewichteten Mittel ihrer Kapitel (`häufigkeit^1.5`, wie im Figurengraph) und liegen dazwischen. Gezeichnet: eine gestrichelte Hülle je Kapitel um die Figuren, die **nur** dort vorkommen, mit Kapitelname darüber (`seriesColor(index)` aus der Kapitelachse, wie die Buchlandkarte), und unter jeder Brückenfigur eine Farbmarke je Kapitel. Die Hülle wird bei jedem Zeichnen aus den aktuellen Positionen gerechnet und folgt gezogenen Knoten. Bei durchgehenden Figuren (fortlaufender Roman) entfallen Inseln von selbst — dort trägt der Kapitel-Filter. **Why nicht als feste Spalten:** dreissig fortlaufende Kapitel als Spalten sagen nichts; die Inseln entstehen dort, wo das Buch sie hat.
- **Begegnungen** (Schalter, Standard aus): Paare, die in mindestens zwei Szenen zusammen auftreten (`BEGEGNUNG_MIN`, Besetzung aus dem Szenen-Katalog, der beim Einschalten nachlädt), aber keine erfasste Beziehung haben. Dünn gestrichelt in der gedämpften Textfarbe, schwache Feder; Tooltip «Begegnen sich in n Szenen».

Custom-Overlay (`beforeDrawing`): Bänder in Netzwerk-Koordinaten (Streifen, gestrichelte Trennlinie), Kapitel-Hüllen, dann Schicht-Labels links und Kapitel-Labels über den Hüllen in Bildschirm-Koordinaten (Pill-Hintergrund). `afterDrawing`: Brücken-Marken.

Guard: keine Figur hat eine echte `sozialschicht` (alle `null`/`andere`) → Placeholder, kein leerer Graph.

### Nähe

`figure_relations.naehe` (−2 … +2, NULL = nicht eingeschätzt): wie nah sich zwei Figuren **im Text** sind — nicht, was der Typ nahelegt (eine «versteinerte Ehe» ist `ehepartner` und −1/−2). Quellen:

- **Komplettanalyse** liefert sie mit jeder Beziehung (nur Cloud-Provider, [komplett.md](komplett.md#phase-2--figuren-konsolidieren)); ein Lauf ohne Wert lässt eine bekannte Nähe stehen.
- **Job `figuren-naehe`** ([routes/jobs/figuren-naehe.js](../routes/jobs/figuren-naehe.js), `POST /jobs/figuren-naehe`, `editor`): schätzt aus Typ, Beschreibung und Rollen beider Figuren, ohne Buchtext (Bündel à 80 Beziehungen). Standard: nur Beziehungen ohne Nähe; `alle: true` schätzt alle neu (der Knopf tut das, wenn nichts mehr offen ist). Schreibt nur `naehe` ([db/figures/naehe.js](../db/figures/naehe.js)), `origin` bleibt. Knopf in der Soziogramm-Toolbar mit Zahl der offenen Beziehungen.
- **Ohne Wert** gilt der Typ-Standard `NAEHE_DEFAULT_BY_TYP` ([beziehung-typen.js](../public/js/book/beziehung-typen.js)#`naeheOf`); der Kanten-Tooltip sagt dann «angenommen nach Beziehungstyp».

Normalisiert wird an einer Stelle je Seite: Server [lib/relation-naehe.js](../lib/relation-naehe.js)#`normNaehe` (alle Schreibwege: Analyse, Katalog-PUT, Job, Bundle-Import, Reihen-Übernahme), Browser `naeheOf`. Anzeige im Figuren-Detail neben dem Machtverhältnis («innig», «zugewandt», «neutral», «kühl», «feindselig»).

## Edge-Bau (`shared.js#_buildEdges`)

Gemeinsam für Figurengraph + Soziogramm. Dedupliziert über Pair-Key:

- **Gegenläufige Paare** (`elternteil`/`kind`, `mentor`/`schuetzling`, `vorgesetzter`/`untergebener`) sind dieselbe Aussage aus zwei Perspektiven. Vor dem Dedup bringt `canonicalRelation` ([beziehung-typen.js](../public/js/book/beziehung-typen.js)) sie in eine Form: «von» ist die übergeordnete Seite (`kind`, `schuetzling`, `untergebener`); Pfeilziel bleibt dasselbe. Im Soziogramm kehrt sich beim Tausch das Machtverhältnis um. Der Familiengraph nutzt dieselbe Regel.
- **Directed-Types** (`DIRECTED_TYPES`): Key = `from|to|typ` (Richtung zählt).
- **Andere Typen:** Key = `sorted(from,to)|typ` (ungerichtet).

Soziogramm-spezifisch: **Edge-Width skaliert mit Machtverhältnis** (`1 + |macht|*1.5`). Arrows: `macht > 0` → `to`, `< 0` → `from`, `= 0` & directed → Standard-Arrow aus `BZ`, sonst keine. Kategorie-Farbe aus `BZ_SOZIO_CAT` → `BZ_SOZIO_COLOR`. Jede Kante trägt `naehe` (`naeheOf`) für den Tooltip. Begegnungs-Kanten hängt `soziogramm.js` an; sie tragen `restoreColor`, damit der Kapitel-Filter sie beim Zurücksetzen nicht in die Kategorie-Farbe umfärbt.

Figurengraph-Modus: Style aus `BZ`-Tabelle (Farbe, Highlight, Arrows, Dashes).

## Kapitel-Filter (`_figurenGraphSetKapitel`)

Greift nach dem initialen Render. Mutiert nur Node-Color/Font + Edge-Color via `DataSet.update` — kein Re-Layout, keine Stabilisierung. Figuren, deren `kapitel`-Liste die gewählte `chapter_id` **nicht** enthält, werden gedimmt; ein Wert, den die Kapitelachse nicht anbietet, setzt den Filter zurück statt alles zu dimmen (`theme.dim`, aus der Oberflächenfarbe abgeleitet statt fest hellgrau). Edges bleiben nur farbig, wenn **beide** Seiten im Kapitel aktiv sind — mit «eine Seite reicht» bliebe um jede Hauptfigur das halbe Netz bunt.

Modus-aware: im Soziogramm-Modus bleibt die Schichtfarbe (`SCHICHT_COLOR`), sonst Typ-Farbe (`_figTypColor`). Edge-Farben kommen aus `BZ_SOZIO_COLOR` (Soziogramm) bzw. `BZ` (Figurengraph).

## Farben auf dem Canvas

vis-network zeichnet auf ein `<canvas>` — dort werden **keine CSS-Custom-Properties aufgelöst**. Jede Farbe muss zur Render-Zeit als konkreter Wert vorliegen, und ein Theme-Wechsel erreicht das bereits gezeichnete Bild nicht. Daraus folgt die Arbeitsteilung:

- `renderFigurGraph` löst einmal pro Render `graphTheme(container)` auf und legt das Ergebnis in `this._graphTheme` ab; alle Slices lesen es über `this._theme()`.
- Chrome (Spaltenstreifen, Trennlinien, Kapitel-Header, Label-Pills, Presence-Untergrund, Dim-Zustand) kommt **ausschliesslich** aus dem Theme — keine `rgba(0,0,0,…)`/`#555`-Literale mehr im Draw-Pfad.
- Die fachlichen Paletten in `constants.js` bleiben für hellen Grund notiert und werden nachgeführt: Node-Flächen über `adaptNodeColor` (Füllung gegen die Oberfläche abgemischt, gesättigte Border bleibt der Erkennungsanker), Akzent-/Kantenfarben über `theme.ink()` (hellt nur auf, was auf dunklem Grund zu dunkel wäre).
- Der Hell/Dunkel-Stand ist Teil des Render-Hashs, und ein `observeThemeChange`-Observer in [figuren-card.js](../public/js/cards/figuren-card.js) stösst bei `data-theme`-Wechsel neu an.

## Tooltip (`_attachTooltip`)

Hängt am `#figur-tooltip`-Element (Klasse `.graph-tooltip`, CSS-Komponente — siehe DESIGN.md „Graph-Tooltip"). Listener: `hoverNode`/`blurNode`, `hoverEdge`/`blurEdge`, `dragStart` (ausblenden). Positionierung + Klemmung liefert `createGraphTooltip` aus dem Graph-Kit; die reine Geometrie steckt in `clampTipPos`.

**Permalink je Reiter:** `#book/<id>/figuren/<reiter>` (`figur`, `familie`, `soziogramm`, `praesenz`, `alter`, `lebenslauf`; die Liste ohne Suffix, eine aufgeklappte Figur als `#book/<id>/figur/<figId>`). Reiterliste: `FIGUREN_TABS` in [graph/constants.js](../public/js/graph/constants.js); die Karte spiegelt `figurenGraphModus` nach `catalogUi.figurenTab`, der Hash-Router öffnet den Reiter über den Karten-Wunsch `FIGUREN_TAB`. Ein Reiterwechsel ersetzt den History-Eintrag (gleiche Kategorie).

**Knoten-Klick:** Ein Tap auf einen Knoten (nicht das Ziehen) öffnet die Figur über `openFigurById` im Reiter «Liste» der Figuren-Karte; aus dem Vollbild geht es vorher heraus, weil die Liste ausserhalb des Graph-Wraps liegt. Der Klick-Listener für die Kapitel-Kopfzeile im Figurengraph bleibt daneben bestehen (er reagiert nur im Header-Band).

**XSS-Escape-Invariante:** `escHtml()` für jeden eingesetzten Wert (Figurnamen, Beschreibungen, Schicht-/Typ-Labels). Template-Strings setzen Markup-Wrapper, alle Datenwerte vorher escaped.

## Fullscreen

`toggleFigurenGraphFullscreen` versucht zuerst `toggleWrapFullscreen` (Fullscreen-API auf dem `.figuren-graph-wrap`-Element). Bei Fehler fällt es auf einen Klassen-Toggle (`figurenGraphFullscreen`-Flag) zurück; danach `resize`-Event + `network.fit()` mit Easing.

## Pflicht-Invarianten

- **vis-Lazy-Load:** `_renderXxx` setzt das geladene Bundle voraus. `renderFigurGraph` ruft `ensureVis(container)` (Graph-Kit) und bricht bei `false` ab — kein eigener `loadVis`-Aufruf mit eigenem Placeholder.
- **`escHtml` für jeden User-/KI-Wert** im Tooltip (`innerHTML`-Sink). Reine Text-Platzhalter laufen über `graphPlaceholder` (setzt `textContent`, gar keine HTML-Sink).
- **Keine Farb-Literale im Draw-Pfad** — Chrome-Farben aus `this._theme()`, Paletten aus `constants.js` durch `adaptNodeColor`/`theme.ink()`. Ein hartes `#fff`/`rgba(0,0,0,…)` ist im Dark-Mode ein Leuchtbalken bzw. unsichtbar.
- **Layout rechnet `layout.js`, nicht der Renderer.** Positionslogik gehört in die reine Schicht (testbar); `figurengraph.js` zeichnet nur.
- **Network destroyen vor Re-Render.** `renderFigurGraph` cleant `_figurenNetwork` vor Neu-Erzeugung; Card-Lifecycle (`onBookChanged`, `destroy`) ebenso.
- **Hash-Cache prüft die komplette Render-Signatur** (id, typ, sozialschicht, Kapitel-Häufigkeiten, Beziehungen inkl. Machtverhältnis, Kapitelachse), nicht nur die Kapitel — sonst zeigt ein Re-Render nach Typ-/Schicht-/Beziehungs-Edit den alten Stand. Modus-, Locale- und Theme-Wechsel erzwingen ebenfalls Re-Render.
- **`fit()` nimmt Node-IDs**, nicht Canvas-Bounding-Box (Figurengraph hat sonst leere Spalten am Rand).
- **Soziogramm fixiert Y**, Figurengraph läuft komplett ohne Physics (User-Drags bleiben stehen), Familiengraph rechnet die Positionen vorab und läuft ohne Physics.

## Neuen Modus hinzufügen

1. Slice anlegen (`graph/<name>.js`), `_render<Name>(container)`-Methode exportieren.
2. In `graph.js`-Facade spreaden.
3. In `core.js#renderFigurGraph` Modus-Switch ergänzen.
4. UI-Toggle in `partials/figuren.html` + `figurenGraphModus`-Werte-Set in `figuren-card.js`.
5. `_figurenNodes` + `_figurenEdges` setzen — Kapitel-Filter (`_figurenGraphSetKapitel`) liest sie und passt seinen Modus-Branch entsprechend an (ggf. `else if` ergänzen).
6. Wenn eigene Canvas-Overlays: `beforeDrawing`/`afterDrawing` (Pflicht-Trennung: Netzwerk-Koordinaten vs. Screen-Koordinaten via `setTransform(1,0,0,1,0,0)`), Farben aus `this._theme()`.
7. Tooltip via `this._attachTooltip(container)` aus shared.
8. Positionsrechnung in `layout.js` (oder ein eigenes reines Modul), nicht in den Render-Slice.

## Neuer Beziehungstyp

Kein Schemawechsel (`figure_relations.typ` ist Freitext). Die Liste steht **einmal** in [public/js/book/beziehung-typen.js](../public/js/book/beziehung-typen.js) (`RELATION_TYPES`); Prompts (`RELATION_TYPES_PROMPT`), Schema-`enum` und die Bereinigung der KI-Ausgabe lesen von dort. Pflicht:

1. Typ in `RELATION_TYPES` eintragen (gerichtet? dann auch in dessen `DIRECTED`; hat er ein Gegenstück aus der anderen Perspektive, das Paar in `CANONICAL_INVERSE`); Schreibvarianten ggf. in `SYNONYMS`.
2. `BZ` in `constants.js` ergänzen — Farbe, Highlight, Arrow-Richtung, Dashes.
3. `BZ_SOZIO_CAT` zuordnen (Kategorie für Soziogramm-Farbe).
4. `DIRECTED_TYPES` ergänzen, wenn der Typ **gerichtet** ist (sonst landet `(A→B, freund)` und `(B→A, freund)` als zwei separate Edges statt einer).
5. i18n: `figuren.bz.<typ>` in beide Locales.
6. `NAEHE_DEFAULT_BY_TYP` in `beziehung-typen.js`: Nähe, die das Soziogramm annimmt, solange keine eingeschätzt ist (gegated in [soziogramm-layout.test.mjs](../tests/unit/soziogramm-layout.test.mjs)).

Gegated: [beziehung-typen.test.mjs](../tests/unit/beziehung-typen.test.mjs) (Liste ↔ `BZ`/`BZ_SOZIO_CAT` ↔ i18n, kein Listen-Literal im Prompt). `_buildEdges` zeichnet den bereinigten Typ (`normalizeRelationTyp`), damit Kanten aus älteren Läufen («andere|bekannt», «tante») Farbe und Label bekommen.
