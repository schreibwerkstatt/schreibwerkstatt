# Nachrichtenverlauf

SMS, WhatsApp und Gruppenchats im Manuskript: ein eigener Block mit Zeilenarten, im Notebook-Editor schnell zu tippen und in jedem Ausgabeweg gesetzt — typografisch als Buchkonvention, auf Wunsch mit leichten Sprechblasen.

**Markup-SSoT:** [public/js/messages/msg-html.js](../public/js/messages/msg-html.js) — Klassen, Selektoren, Zeilenarten und die Erzeuger. Eingabe ist **notebook-only**; Focus-Editor und Bucheditor zeigen den Verlauf (Bucheditor über [manuscript-content.css](../public/css/components/manuscript-content.css)), bedienen ihn aber nicht.

---

## 1 · Das Markup

```html
<div class="msg-thread">
  <p class="msg-name">Lena</p>
  <p class="msg-in">bist du schon da?</p>
  <p class="msg-out">gleich, 5 min</p>
  <p class="msg-meta">Dienstag, 14:32</p>
</div>
```

| Klasse | Zeilenart | Bildschirm | Export (typografisch) |
|---|---|---|---|
| `msg-in` | eingehend | Blase links | linksbündig, rechts 22 % frei |
| `msg-out` | ausgehend | Blase rechts, Akzentton | rechtsbündig, links 22 % frei |
| `msg-name` | Absender (Gruppenchat) | klein, fett, grau | klein, fett, hält mit der Folgezeile zusammen |
| `msg-meta` | Datum/Uhrzeit | klein, zentriert | klein, kursiv, zentriert |

Drei Festlegungen:

**Jede Zeile ist ein eigener `<p>`, auch der Absender.** Ein Inline-Span vor der Nachricht wäre kompakter, aber an seiner Kante weiss der Caret nicht, ob er im Namen oder schon im Text schreibt. Ein Gespräch zu zweit braucht gar keine Namen, dort trägt die Richtung.

**Nur Klassen, keine `data-*`-Attribute.** Die EPUB-Bibliothek verwirft jedes `data-*` ([epub/content.js](../lib/export-builders/epub/content.js)#`_applyDataClasses`), WordPress filtert Attribute; Klassen kommen durch alle Ausgabewege.

**Ein `<p>` ohne Zeilenklasse im Verlauf ist eingehend.** So bleibt ein Verlauf lesbar, dessen Zeilenklassen ein fremder Pfad verloren hat.

## 2 · Eingabe (Notebook)

Slash-Menü → «Nachrichtenverlauf» legt `div.msg-thread` mit einer leeren eingehenden Zeile an. Bedienung in [toolbar/msg-thread.js](../public/js/editor/notebook/toolbar/msg-thread.js):

- **Enter** teilt die Zeile am Caret; die neue Zeile schreibt dieselbe Seite weiter, nach einem Absender eingehend, nach einer Zeitangabe die Richtung der Nachricht davor (`nextLineKind`).
- **Enter auf einer leeren Zeile** verlässt den Verlauf (wie im Gedicht). Steht die leere Zeile mittendrin, teilt sie den Verlauf, dazwischen entsteht ein Erzählabsatz.
- **Tab / Shift+Tab** schalten die Zeilenart durch: Eingang → Ausgang → Absender → Zeit.
- **Zeilenleiste** ([partials/editor-msg-bar.html](../public/partials/editor-msg-bar.html)): solange der Caret im Verlauf steht, rechts über dem Block; dieselben vier Arten per Klick — der Weg auf Mobile, wo es kein Tab gibt. Die Knöpfe nehmen den Fokus nicht.
- **Backspace/Delete innerhalb des Verlaufs** verschmelzen selbst (`_mergeBlocksManually`), die empfangende Zeile behält ihre Art. **Why:** die Zeilen tragen unterschiedliche Stile; Chromiums nativer Merge bäckt die berechneten Werte der Quellzeile als Inline-`style` ein (gemessen: `<span style="background-color: …; font-size: 0.92em">`). Die Grenzen des Verlaufs selbst bedient `_kbBlockBoundary` (`div.msg-thread` steht in `BOUNDARY_WRAPPER_SEL`).

## 3 · Ausgabewege

Alle Builder mit Walker lesen den Block `{ kind: 'messages', lines: [{ kind, runs }] }` aus [html-walker.js](../lib/pdf-render/html-walker.js); leere Zeilen fallen dort weg.

| Weg | Umsetzung | Sprechblasen |
|---|---|---|
| PDF (Custom + Schnellpfad) | [block-messages.js](../lib/pdf-render/block-messages.js): ein Layouter-Pfad (`justify.js`), Verschiebung nach rechts über `indentFor`, keine Silbentrennung | `config.messages.style = 'bubbles'` (Tab „Schrift"): graue Flächen mit runden Ecken, eine Blase wird nie geteilt; höher als der Satzspiegel → fällt auf typografisch zurück |
| Word | [docx-messages.js](../lib/export-builders/docx-messages.js): Absatzeinzug + Ausrichtung, Absender/Zeit mit `keepNext` | `config.messages.style = 'bubbles'` (Tab „Layout"): jede Nachricht eine 1×1-Tabelle mit grauer Zelle, Breite aus der längsten Zeile geschätzt, ausgehend rechts; eckig — Word kennt keine runden Ecken. Keine Absatzschattierung: Word verschmilzt gleich schattierte Nachbarabsätze zu einem Kasten über die volle Breite |
| EPUB | Klassen bleiben im XHTML, Satz über [epub/css.js](../lib/export-builders/epub/css.js) | `book_publication.epub_msg_style = 'bubbles'` (Tab „Typografie"): `display: table` + `border-radius`; die Ausgangs-Regel trägt dieselbe `:not()`-Kette wie die allgemeine, sonst verliert sie an Spezifität |
| HTML-Export, Share-Reader | Klassen + CSS ([html.js](../lib/export-builders/html.js) bzw. manuscript-content.css) | — (HTML-Export typografisch, Reader wie am Bildschirm) |
| Markdown, Substack, TXT | Textkonvention: Zitatblock bzw. Zeilen, ausgehend mit `→`, Absender mit Doppelpunkt, Zeit kursiv bzw. `[…]` | — |
| WordPress | `wp:group` mit `className` + ein `wp:paragraph` je Zeile; der Pull liest Klassen zurück | — |

Profil-Validator für PDF und Word ist derselbe: [pdf-export-defaults/messages.js](../lib/pdf-export-defaults/messages.js).

## 4 · Zählt das als Prosa?

| Schicht | Verhalten | Why |
|---|---|---|
| Statistik (`page_stats`, Wortzahl) | zählt mit | Figurenrede ist Text des Buchs |
| KI-Prompts (`htmlToText`/`htmlToTextForPrompt`) | Start-/Endmarke als eigene Absätze ([lib/html-text.js](../lib/html-text.js)#`markMsgThreads`, im Lektorat in der Buchsprache), Nachrichten unverändert; enthält der Abschnitt einen Verlauf, kommt ein Regelblock dazu (Lektorat alle Pässe: [blocks.js](../public/js/prompts/blocks.js)#`_buildNachrichtenBlock`, Abschnitts-Chat: `PAGE_CHAT_NACHRICHTEN_HINWEIS`), und Lektorat-Befunde im Verlauf sind nicht vorausgewählt ([lektorat.md](lektorat.md#befund-klassen)) | ohne Hinweis „korrigiert" das Lektorat die Chat-Sprache; ein Präfix je Nachricht landete im zitierten Original, und der Befund fände seine Stelle nicht mehr |
| LanguageTool | geschnitten (`MSG_SKIP_SEL` in [editor-spellcheck/mapping.js](../public/js/cards/editor-spellcheck/mapping.js)) | Kleinschreibung, „5 min", fehlende Satzzeichen sind Absicht |
| TTS | liest mit | — |

## 5 · Kopien und Gates

Bewusste Kopien der Klassennamen (CJS kann die SSoT nicht synchron laden; das LanguageTool-Mapping hält sich frei von App-Bundle-Importen): `html-walker.js`, `html-clean.js` (`_STRUCTURAL_DIV_CLASSES` — sonst klopft `flattenDivBlocks` den Verlauf zu `<p>` flach), `notebook/block-ids.js`, `mapping.js`, `html-text.js`, `txt.js`, `wp-html.js`, die drei Stylesheets. Gegated durch [tests/unit/msg-thread-drift.test.mjs](../tests/unit/msg-thread-drift.test.mjs).

Weitere Tests: [tests/unit/export-builders/msg-thread.test.mjs](../tests/unit/export-builders/msg-thread.test.mjs) (alle Ausgabewege, beide Satzarten), [tests/e2e-app/notebook-msg-thread.spec.js](../tests/e2e-app/notebook-msg-thread.spec.js) (Tastatur, Leiste, Anordnung — mutationsgeprüft).

**Grenze:** Emoji erscheinen im PDF nur, wenn die Buchschrift sie enthält — die üblichen Satzschriften tun das nicht; der Renderer lässt das Zeichen dann aus.
