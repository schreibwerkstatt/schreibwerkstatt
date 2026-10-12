# Nachrichtenverlauf

SMS, WhatsApp und Gruppenchats im Manuskript: ein eigener Block mit Zeilenarten, im Notebook-Editor schnell zu tippen und in jedem Ausgabeweg gesetzt — typografisch als Buchkonvention, auf Wunsch mit leichten Sprechblasen.

**Markup-SSoT:** [public/js/messages/msg-html.js](../public/js/messages/msg-html.js) — Klassen, Selektoren, Zeilenarten und die Erzeuger. Anlegen und Zeilenarten setzen ist **notebook-only**. Der Focus-Editor zeigt die Zeilen als normale Absätze, Enter und Löschen laufen dort über dieselben Handler wie im Notebook (§ 2). Bucheditor und Share-Reader setzen den Verlauf über [manuscript-content.css](../public/css/components/manuscript-content.css) wie die Notebook-Leseansicht, bedienen ihn aber nicht.

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
| `msg-name` | Absender, auf der Seite seiner Nachricht | klein, fett, grau | klein, fett, hält mit der Folgezeile zusammen |
| `msg-meta` | Hinweis: Uhrzeit, Datum, Chatname | klein, kursiv, zentriert | klein, kursiv, zentriert |

Der Verlauf steht am Bildschirm in der Buchschrift, nur leicht verkleinert — keine eigene Schriftart. **Why:** die Blasen tragen Ein- und Ausgang schon; jeder Export setzt den Verlauf ohnehin in der Buchschrift, eine Sans-Schrift am Bildschirm verspräche ein Bild, das das Buch nicht liefert.

Vier Festlegungen:

**Jede Zeile ist ein eigener `<p>`, auch der Absender.** Ein Inline-Span vor der Nachricht wäre kompakter, aber an seiner Kante weiss der Caret nicht, ob er im Namen oder schon im Text schreibt. Ein Gespräch zu zweit braucht gar keine Namen, dort trägt die Richtung.

**Der Absender steht auf der Seite seiner Nachricht.** Seine Seite ist die der ersten Nachricht unter ihm, Hinweise dazwischen übersprungen; folgt zuerst ein weiterer Absender oder nichts, eingehend ([msg-html.js](../public/js/messages/msg-html.js)#`msgNameSides`). Benennen lassen sich so beide Seiten, eine oder keine — auch die ausgehende, wenn nicht klar ist, wem das Telefon gehört. Die Seite steht bewusst nicht im Markup: wechselt die Nachricht per Tab die Seite, wandert der Name mit, und es gibt keine zweite Klasse, die mit der Nachricht darunter in Widerspruch geraten könnte. Am Bildschirm leitet `:has()` sie ab (Name direkt oder über einen Hinweis hinweg vor der Nachricht); die Exporte rechnen sie aus.

**Nur Klassen, keine `data-*`-Attribute.** Die EPUB-Bibliothek verwirft jedes `data-*` ([epub/content.js](../lib/export-builders/epub/content.js)#`_applyDataClasses`), WordPress filtert Attribute; Klassen kommen durch alle Ausgabewege.

**Ein `<p>` ohne Zeilenklasse im Verlauf ist eingehend.** So bleibt ein Verlauf lesbar, dessen Zeilenklassen ein fremder Pfad verloren hat.

## 2 · Eingabe (Notebook)

Slash-Menü → «Nachrichtenverlauf» legt `div.msg-thread` mit einer leeren eingehenden Zeile an. Bedienung in [toolbar/msg-thread.js](../public/js/editor/notebook/toolbar/msg-thread.js):

- **Markierte Absätze umwandeln** ([toolbar/msg-convert.js](../public/js/editor/notebook/toolbar/msg-convert.js)): erfasst die Selektion nur schlichte Absätze (`<p>` ohne Klasse, oberste Ebene), zeigt die Bubble-Leiste zwei Knöpfe (Sprechblase + Pfeil links bzw. rechts) — erste Nachricht eingehend oder ausgehend. Jeder Absatz wird eine Nachricht, die Seiten wechseln danach ab; leere Absätze fallen weg, ein angrenzender Verlauf wird mit dem neuen zusammengezogen, Undo nimmt alles in einem Schritt zurück. Anführungszeichen um die ganze Zeile fallen weg (öffnendes am Anfang, schliessendes am Ende, falls vorhanden); steht im Rest noch ein Anführungszeichen («„Ja“, sagte sie, „gern“»), bleibt die Zeile unverändert, Apostrophe gelten nie als Anführung. Keine Erkennung von Absendern oder Uhrzeiten. **Why:** im Verlauf markiert der Block die Rede; ein Muster wie `Name:` am Zeilenanfang ist im Fliesstext zu oft Erzählung, und falsch erkannte Absender korrigiert man mühsamer als fehlende zu setzen.
- **Zeilen aus dem Verlauf lösen** (`toolbarFromMsgThread` in [toolbar/msg-convert.js](../public/js/editor/notebook/toolbar/msg-convert.js)): die Gegenrichtung. Berührt die Selektion Verlaufszeilen, zeigt die Bubble-Leiste einen Knopf (Sprechblase + ×), die Zeilenleiste trägt ihn als letzten Knopf — dort wirkt er auf die Caret-Zeile oder die markierten Zeilen. Die Zeilen werden schlichte `<p>` (Zeilenart fällt weg, Text bleibt), der Verlauf teilt sich davor und danach, leere Restteile fallen weg; Undo nimmt alles in einem Schritt zurück. Erzählabsätze, die die Selektion mit erfasst, bleiben unberührt.
- **Enter** teilt die Zeile am Caret; die neue Zeile schreibt dieselbe Seite weiter, nach einem Absender auf dessen Seite, nach einem Hinweis die Richtung der Nachricht davor (`nextLineKind`). Leere Inline-Hüllen, die ein Schnitt am Rand einer Formatierung zurücklässt (`<em></em>`), fallen weg; eine Zeile ohne Text bekommt `<br>` als Caret-Slot (`isEmptyMsgLine`). **Why:** sonst hat die Zeile keine Zeilenhöhe und schrumpft auf ihr Blasen-Padding.
- **«Name:» + Enter wird Absender** (`_typedMsgName`, Erkennung [msg-html.js](../public/js/messages/msg-html.js)#`msgNameFromTyped`): besteht eine Nachricht nur aus `Name:` und steht der Caret am Zeilenende, wird sie beim Enter zur Absenderzeile, der Doppelpunkt fällt weg; die neue Zeile behält die Seite, auf der getippt wurde. Name = Buchstaben, Ziffern, Leerzeichen, `-`, `'`, `’`, `.`, mindestens ein Buchstabe, höchstens 30 Zeichen; formatierte Zeilen bleiben Nachrichten. Cmd/Ctrl+Z nimmt nur die Umwandlung zurück (eigener Undo-Schritt), die neue Zeile bleibt. Nur Notebook. **Why:** ausgelöst erst beim Enter, nicht beim Doppelpunkt — «Achtung: Zug fällt aus» oder «PS: …» sind Nachrichten und dürfen beim Tippen nicht umspringen; eine Nachricht, die *nur* aus «Achtung:» besteht, kommt kaum vor.
- **Enter auf einer leeren Zeile** verlässt den Verlauf (wie im Gedicht). Steht die leere Zeile mittendrin, teilt sie den Verlauf, dazwischen entsteht ein Erzählabsatz.
- **Tab / Shift+Tab** wechseln die Seite: Eingang ↔ Ausgang; auf einer Absender-/Hinweiszeile machen sie daraus wieder eine eingehende Nachricht. Absender und Hinweis setzen die Zeilenleiste und (nur Absender) der Kurzweg «Name:» + Enter. **Why:** ein Zyklus über alle vier Arten machte nach zwei Tabs aus einer Nachricht eine Namenszeile, die wie eine Überschrift aussieht.
- **Zeilenleiste** ([partials/editor-msg-bar.html](../public/partials/editor-msg-bar.html)): solange der Caret im Verlauf steht, rechts über dem Block; alle vier Arten per Klick — der einzige Weg zum Hinweis, und der Weg auf Mobile, wo es kein Tab gibt. Die Knöpfe nehmen den Fokus nicht.
- **Backspace/Delete innerhalb des Verlaufs** verschmelzen selbst (`_mergeBlocksManually`), die empfangende Zeile behält ihre Art. **Why:** die Zeilen tragen unterschiedliche Stile; Chromiums nativer Merge bäckt die berechneten Werte der Quellzeile als Inline-`style` ein (gemessen: `<span style="background-color: …; font-size: 0.92em">`). Die Grenzen des Verlaufs selbst bedient `_kbBlockBoundary` (`div.msg-thread` steht in `BOUNDARY_WRAPPER_SEL`).

**Focus-Editor:** Enter (auch Doppel-Enter zum Verlassen und Teilen), Backspace/Delete innerhalb des Verlaufs und an seinen Grenzen verhalten sich wie oben — der Dispatcher ([toolbar/keydown.js](../public/js/editor/notebook/toolbar/keydown.js)#`_onEditKeydown`) lässt am Focus-Hard-Stop genau `_kbMsgThread` und `_kbBlockBoundary` mit `MSG_THREAD_SEL` durch und reicht danach ein synthetisches `input` nach (Absatz-Markierung, Fokus-Undo). Tab, Zeilenleiste und der Kurzweg «Name:» + Enter bleiben Notebook. **Why:** der Focus-Editor zeigt keine Zeilenarten, ein Seitenwechsel per Tab bliebe unsichtbar, beim Kurzweg verschwände bloss der Doppelpunkt; ohne die Enter-Regel blieb der Caret nach Doppel-Enter im Verlauf, und weitergetippte Erzählung wurde überall sonst zur Nachricht. Die übrigen Wrapper (Zitat, Liste, Gedicht über `_kbPoemEnter` ausgenommen) behalten im Focus-Editor das Browser-Verhalten. Gegated: [tests/e2e-app/focus-msg-thread-app.spec.js](../tests/e2e-app/focus-msg-thread-app.spec.js) (Chromium + Firefox, mutationsgeprüft).

## 3 · Ausgabewege

Alle Builder mit Walker lesen den Block `{ kind: 'messages', lines: [{ kind, runs, side? }] }` aus [html-walker.js](../lib/pdf-render/html-walker.js); leere Zeilen fallen dort weg, Absenderzeilen tragen ihre Seite als `side` (PDF und Word setzen einen ausgehenden Absender rechtsbündig). EPUB und HTML-Export setzen das gespeicherte Markup mit eigenem Stylesheet; E-Reader kennen `:has()` nicht, darum markiert [html-text.js](../lib/html-text.js)#`markMsgNameSides` einen ausgehenden Absender beim Export mit der Klasse `msg-name-out` (nur im Export, nie persistiert). Die Textwege (Markdown, Substack, TXT) brauchen nichts: die Zeile darunter trägt «→».

| Weg | Umsetzung | Sprechblasen |
|---|---|---|
| PDF (Custom + Schnellpfad) | [block-messages.js](../lib/pdf-render/block-messages.js): ein Layouter-Pfad (`justify.js`), Verschiebung nach rechts über `indentFor`, keine Silbentrennung | `config.messages.style = 'bubbles'` (Tab „Schrift"): graue Flächen mit runden Ecken, eine Blase wird nie geteilt; höher als der Satzspiegel → fällt auf typografisch zurück |
| Word | [docx-messages.js](../lib/export-builders/docx-messages.js): Absatzeinzug + Ausrichtung, Absender/Hinweis mit `keepNext` | `config.messages.style = 'bubbles'` (Tab „Layout"): jede Nachricht eine 1×1-Tabelle mit grauer Zelle, Breite aus der längsten Zeile geschätzt, ausgehend rechts; eckig — Word kennt keine runden Ecken. Keine Absatzschattierung: Word verschmilzt gleich schattierte Nachbarabsätze zu einem Kasten über die volle Breite |
| EPUB | Klassen bleiben im XHTML, Satz über [epub/css.js](../lib/export-builders/epub/css.js) | `book_publication.epub_msg_style = 'bubbles'` (Tab „Typografie"): `display: table` + `border-radius`; die Ausgangs-Regel trägt dieselbe `:not()`-Kette wie die allgemeine, sonst verliert sie an Spezifität |
| HTML-Export, Share-Reader | Klassen + CSS ([html.js](../lib/export-builders/html.js) bzw. manuscript-content.css) | — (HTML-Export typografisch, Reader wie am Bildschirm) |
| Markdown, Substack, TXT | Textkonvention: Zitatblock bzw. Zeilen, ausgehend mit `→`, Absender mit Doppelpunkt, Hinweis kursiv bzw. `[…]` | — |
| WordPress | `wp:group` mit `className` + ein `wp:paragraph` je Zeile; der Pull liest Klassen zurück | — |

Profil-Validator für PDF und Word ist derselbe: [pdf-export-defaults/messages.js](../lib/pdf-export-defaults/messages.js).

## 4 · Zählt das als Prosa?

| Schicht | Verhalten | Why |
|---|---|---|
| Statistik (`page_stats`, Wortzahl) | zählt mit | Figurenrede ist Text des Buchs |
| Dialog-Erkennung (`dialog_chars` → Dialoganteil in Stil-Heatmap und Autorenprofil, Pronomen Erzählung/Dialog, Buch-Chat `get_dialogue`) | Nachrichten zählen als Rede, Absender und Zeit nicht ([lib/html-text.js](../lib/html-text.js)#`htmlToPlainTextWithMsgRanges` → `findDialogRanges(text, msgRanges)`); ein `<p>` ohne Zeilenklasse zählt als Nachricht | Nachrichten tragen keine Anführungszeichen — der Block ist die Markierung; ohne die Bereiche fiele ein Chat voller „ich“ in die Erzählstimme |
| Satzmetriken (Satzlänge, Rhythmus, Satzanfänge, LIX, Flesch, Füllwörter/Passiv/Adverbien) | ausgenommen, wie Tabellen (`proseText` aus [lib/html-text.js](../lib/html-text.js)#`stripMsgThreads` in `computePageIndex`) | eine Chat-Zeile ist kein Satz der Erzählung; ohne Satzzeichen klebte sie an den Nachbarsatz und ein Verlauf trieb Satzlänge und Lesbarkeitsindex hoch |
| Wortschatz (Lieblingswörter, Vielfalt) | zählt mit, jede Zeile ein eigener Block | Wortwahl der Figuren ist Wortschatz des Buchs |
| Figuren-Idiolekt | Nachricht → Figur aus der geltenden Absenderzeile ihrer Seite (gilt bis zur nächsten derselben Seite im selben Verlauf, auch über die andere Seite hinweg); ohne Absender ihrer Seite — meist die ausgehenden — unzugeordnet, das senkt die Abdeckung ([wortschatz.md](wortschatz.md#figuren-idiolekt-reiter-figuren)) | wem das Telefon gehört, steht nur in einer Namenszeile — Raten machte aus zwei Stimmen eine; ein Name oben genügt im Zwiegespräch |
| Alters-Analyse der Figuren | jede Nachricht ein eigenes Fenster: im Text genannte Figur direkt, Absender aus der Namenszeile ihrer Seite indirekt, ohne Namenszeile kein Rückgriff auf die Erzählung ([figur-alter.md](figur-alter.md#satzfenster)) | ohne Satzzeichen klebte eine Chat-Zeile am Erzählsatz danach und band ein fremdes Alter an die dort genannte Figur |
| KI-Prompts (`htmlToText`/`htmlToTextForPrompt`) | Start-/Endmarke als eigene Absätze ([lib/html-text.js](../lib/html-text.js)#`markMsgThreads`, im Lektorat in der Buchsprache), Nachrichten unverändert; enthält der Abschnitt einen Verlauf, kommt ein Regelblock dazu (Lektorat alle Pässe: [blocks.js](../public/js/prompts/blocks.js)#`_buildNachrichtenBlock`, Abschnitts-Chat: `PAGE_CHAT_NACHRICHTEN_HINWEIS`), und Lektorat-Befunde im Verlauf sind nicht vorausgewählt ([lektorat.md](lektorat.md#befund-klassen)) | ohne Hinweis „korrigiert" das Lektorat die Chat-Sprache; ein Präfix je Nachricht landete im zitierten Original, und der Befund fände seine Stelle nicht mehr |
| Komplettanalyse (Extraktion, Kontinuität, Erzählprofil, Delta) | jede Zeile trägt ihre Art im Text wie im TXT-Export — `Name:`, `[Uhrzeit]`, `→ ausgehend` —, die Startmarke erklärt die Zeichen ([lib/html-text.js](../lib/html-text.js)#`markMsgThreads` mit `rows`, gesetzt über [komplett/job-shared.js](../routes/jobs/komplett/job-shared.js)#`komplettTextOpts`, Buchsprache); andere Jobs (Embeddings, Review, Finetune) sehen den Verlauf wie oben | Ein-/Ausgang steht nur in der Klasse: im Zwiegespräch ohne Namenszeilen wüsste das Modell nicht, wer was schreibt, und ordnete Aussagen der falschen Figur zu; eine nackte Uhrzeitzeile läse es als Erzähldatum. Die Erklärung steht in der Marke statt in jedem System-Prompt, damit alle Pässe sie sehen. Der Extraktions-Cache schlüsselt auf `updated_at` — ein unveränderter Abschnitt behält seine frühere Extraktion bis zur nächsten Änderung oder einem Lauf ohne Cache |
| LanguageTool | prüft mit, jede Zeile als eigener Absatz ([editor-spellcheck/mapping.js](../public/js/cards/editor-spellcheck/mapping.js)) | Tippfehler in Nachrichten sind echte Fehler; gewollte Chat-Sprache ignoriert der User oder nimmt sie ins Wörterbuch auf |
| TTS | liest mit | — |

## 5 · Kopien und Gates

Bewusste Kopien der Klassennamen (CJS kann die SSoT nicht synchron laden): `html-walker.js`, `html-clean.js` (`_STRUCTURAL_DIV_CLASSES` — sonst klopft `flattenDivBlocks` den Verlauf zu `<p>` flach), `notebook/block-ids.js`, `html-text.js`, `txt.js`, `wp-html.js`, die drei Stylesheets. Dazu die Absender-Seite `msgNameSides` als Kopie in [lib/msg-lines.js](../lib/msg-lines.js) und die Export-Klasse `msg-name-out` in `html-text.js` und den beiden Export-Stylesheets. Gegated durch [tests/unit/msg-thread-drift.test.mjs](../tests/unit/msg-thread-drift.test.mjs).

Weitere Tests: [tests/unit/export-builders/msg-thread.test.mjs](../tests/unit/export-builders/msg-thread.test.mjs) (alle Ausgabewege, beide Satzarten), [tests/e2e-app/notebook-msg-thread.spec.js](../tests/e2e-app/notebook-msg-thread.spec.js) (Tastatur, Leiste, Anordnung — mutationsgeprüft), [tests/e2e-app/notebook-msg-convert.spec.js](../tests/e2e-app/notebook-msg-convert.spec.js) (Absätze ↔ Verlauf in beide Richtungen); die Bildschirm-Darstellung in Share-Reader und Bucheditor — dieselben SSoT-Regeln, kein Absatzrand der Kontext-Stylesheets — [tests/e2e/share-reader-msg-thread.spec.js](../tests/e2e/share-reader-msg-thread.spec.js) und [tests/e2e-app/book-editor.spec.js](../tests/e2e-app/book-editor.spec.js) (beide mutationsgeprüft).

**Grenze:** Emoji erscheinen im PDF nur, wenn die Buchschrift sie enthält — die üblichen Satzschriften tun das nicht; der Renderer lässt das Zeichen dann aus.
