# Exposé

Bucheinstellungen → Reiter **Exposé** (Palette: «Exposé erstellen»). Erstellt aus dem Manuskript die Unterlagen für Agenturen und Verlage. Liest nur — schreibt nie in den Buchtext und nie von sich aus in die Publikationsdaten.

| Profil (`exposeProfil(buchtyp)`) | Buchtypen | KI-Felder |
|---|---|---|
| `narrativ` | alle erzählenden (Default, auch ohne Buchtyp) | Logline, Kurzinhalt (≤ ⅓ Seite), Synopse **mit Ende**, Figurenliste `[{fig_id, text}]`, Klappentext-Vorschlag **ohne Ende** |
| `sachlich` | sachbuch, essay, blog, wissenschaft | Logline, Kurzbeschreibung, Alleinstellung, Gliederung `[{chapter_id, text}]`, Klappentext-Vorschlag |
| — | lyrik, tagebuch, journalismus | kein Exposé: Reiter und Palette-Eintrag ausgeblendet, Job antwortet `EXPOSE_BUCHTYP` |

Die «kein Exposé»-Liste steht dreimal (`EXPOSE_HIDDEN_BUCHTYPEN` im Prompt-Modul, `EXPOSE_BUCHTYP_EXCLUDED` im Job-Precheck, `hiddenForBuchtyp` der Palette — die Registry bleibt importfrei); [tests/unit/expose-prompt.test.mjs](../tests/unit/expose-prompt.test.mjs) hält alle drei gegen `exposeProfil()` deckungsgleich.

## Nichts doppeln

Das Exposé speichert **nur, was neu entsteht**. Alles andere wird live gelesen und dort gepflegt, wo es hingehört:

| Angabe | Quelle |
|---|---|
| Titel | `books.name` |
| Untertitel, Autor, Co-Autoren, Vita | `book_publication` |
| Genre, Erzählperspektive, Erzählzeit, fertig? | `book_settings` |
| Umfang (Normseiten) | `page_stats` (Summe `chars` / 1800, [lib/normseite.js](../lib/normseite.js)) |
| Zielgruppe, Vergleichstitel | `book_publication.zielgruppe` / `.vergleichstitel` (Reiter Publikation) |
| **Klappentext** | `book_publication.description` — der einzige Ort ([publikation-export.md](publikation-export.md)) |
| Figurennamen in der Liste | Figurenkatalog über `fig_id` (`x-entity-ref`) — eine umbenannte Figur heisst auch im Exposé richtig |

Im Reiter ist das Feld «Klappentext des Buchs» dieselbe Spalte wie im Reiter Publikation. «Als Klappentext übernehmen» setzt nur dieses Formularfeld; gespeichert wird es wie alles andere über den Speichern-Knopf der Karte. Die Exposé-Texte (Autorfassung) laufen über denselben Knopf (`saveExpose` in `saveActiveTab`).

## Job `POST /jobs/expose` (Mindestrolle editor)

[routes/jobs/expose.js](../routes/jobs/expose.js), Prompts [public/js/prompts/expose.js](../public/js/prompts/expose.js).

1. **System-Prompt:** Persona + `getResearchPromptContext` (Sprachnorm, Buchtyp-Zusatz, Angaben des Autors, Hauptland) + `JSON_ONLY` — ohne Lektorats-Persona und Stilprofil: das Exposé beschreibt, es korrigiert nicht.
2. **Ein Durchgang**, wenn der fertige Prompt ins Budget passt: Volltext (`basis: 'single'`). **Sonst** Inhaltsangaben je Kapitel(-Teil) und daraus das Exposé (`basis: 'multi'`). Die Inhaltsangaben sind **intern** (keine UI) und liegen in `expose_synopsis_cache`, geschlüsselt nach Signatur des gesendeten Prompts (trägt Kapiteltext, Modell, System) — keine Kapitel-FK, kein Sentinel für kapitellose Abschnitte; nicht mehr benutzte Signaturen räumt jeder Lauf ab. Sie sind als Baustein für weitere Funktionen gedacht (Reihen-Kontext).
3. **Eckdaten** gehen als Fakten des Autors in den Prompt (`<eckdaten>`) und werden nicht zurückgegeben.
4. **Prüfung:** `aiCall` wirft bei `truncated`; danach müssen alle Textfelder des Profils gefüllt sein (sonst `job.error.exposeIncomplete`, keine Zeile). Figuren-/Kapitel-IDs müssen aus der vorgelegten Liste stammen, andere fallen heraus (Warnung `expose.warn.figurenDropped`/`kapitelDropped`).
5. **Hinweise** (nicht blockierend, in `warnungen_json`): Buch nicht als fertig markiert (Agenturen erwarten ein abgeschlossenes Manuskript), Anteil am Zielumfang.
6. **Historie:** `book_exposes`, eine Zeile pro Lauf. Gleiche Eingabe-Signatur wie der jüngste Lauf → kein KI-Call, keine zweite Zeile, Ergebnis `unchanged`.

**Cache-Versionierung:** die Signaturen hashen die gesendeten Prompts. `prompts/expose.js` fliesst bewusst **nicht** in `_promptsContentHash` — eine Wortlaut-Änderung hier verwirft keine anderen persistenten Caches, und die eigenen invalidieren sich über den geänderten Prompt-Text von selbst.

## Routen `/expose/:book_id` (Mindestrolle editor)

[routes/expose.js](../routes/expose.js): `GET` (jüngster Lauf, Historie ohne Ergebnis, Normseiten) · `GET /:id` · `PATCH /:id` `{ edited }` bzw. `{ edited: null }` · `DELETE /:id` · `GET /:id/docx`.

Die **Autorfassung** ändert nur Wortlaut: Textfelder des Profils und die Texte vorhandener Listeneinträge. Welche Figur bzw. welches Kapitel vorkommt, bestimmt der KI-Lauf (`normalizeEdited`). Die KI-Fassung bleibt daneben erhalten («KI-Fassung wiederherstellen»).

**Word** ([lib/expose-docx.js](../lib/expose-docx.js)): eigenes Dokument durch denselben Word-Builder wie das Manuskript (kapitelloser Abschnitt, keine Titelseite, 1,5-zeilig). Eckdaten, Namen, Klappentext und Vita werden beim Export live gelesen; Beschriftungen in der Buchsprache. Offene, ungespeicherte Änderungen sind nicht enthalten — der Reiter bietet den Download erst nach dem Speichern an.

## Tests

[tests/integration/expose.test.js](../tests/integration/expose.test.js) (Single-/Multi-Pass, Cache, keine Doppelzeile, Pflichtfelder, Buchtyp-Gate, Routen inkl. ACL und Word) · [tests/unit/expose-prompt.test.mjs](../tests/unit/expose-prompt.test.mjs) (Profile, Listen-Gleichheit, Prompt-Wirkung, Schema == Pflichtfelder).
