# Stabilisierte Module

Vier Funktionen tragen die tägliche Arbeit der aktiven Nutzer und brechen **still**: der **Focus-Editor** (das Werkzeug, mit dem geschrieben wird — eine Regression ist ein falsches Schreibgefühl, kein Absturz), das **Lektorat** (weniger Funde, falsche Anker, Übernahme an der falschen Stelle) die **Komplettanalyse** (ein Katalog mit fehlenden Nebenfiguren, eine falsch gebundene Beziehung, ein Cache-Bruch, der den nächsten Lauf zum zweistelligen Dollar-Volllauf macht) und **Service Worker + Offline** (eine Outbox, die einen Save verwirft, eine SW-Generation, die altes JS mit neuem Partial mischt, ein Kaltstart ohne Netz, der leer bleibt — der Text ist dann weg oder die App startet nicht, und gemerkt wird es erst unterwegs). Weder Tests noch User sehen solche Fehler sofort. Deshalb gilt für alle vier **dieselbe** konservative Regel.

| Modul | Umfang | Sonderprüfung | Modul-Zusatz |
|---|---|---|---|
| Focus-Editor | `focus` in [scripts/stable-modules.js](../scripts/stable-modules.js) | `npm run test:focus` | [public/js/editor/CLAUDE.md](../public/js/editor/CLAUDE.md) |
| Lektorat | `lektorat` | `npm run test:lektorat` | [lektorat.md](lektorat.md#stabilisiert) |
| Komplettanalyse | `komplett` | `npm run test:komplett` | [komplett.md](komplett.md#stabilisiert) |
| Service Worker + Offline | `offline` | `npm run test:offline` | [caching.md](caching.md#stabilisiert) |

**Umfang** = Code-Pfade, die über das Verhalten des Moduls entscheiden, **plus die Tests**: Testdateien mit dem Modulnamen, jede Testdatei, die die Moduldoku verlinkt, und explizite Zusätze. Welche Dateien das konkret sind: `node scripts/test-stable.js --list <modul>`. Ein Test zählt mit, weil ein gelockerter Assert dieselbe Verhaltensänderung ist wie ein geänderter Filter.

## Die Regel

1. **Anlass Pflicht — eine von drei Begründungen, vor dem ersten Edit, im Chat:**
   - **Prod-Beleg:** konkretes Fehlverhalten auf Prod, mit Zahlen und der Abfrage, die sie liefert (Quellen je Modul im Modul-Zusatz; Zugriff lesend per ssh).
   - **Code-Fehler:** Datei:Zeile, konkreter Input und falscher Output.
   - **Auftrag:** ausdrücklicher Wunsch des Users, wörtlich zitiert.

   Kein vorbeugendes Hardening, kein Aufräumen «weil ich eh in der Datei bin», keine Umbenennungs-/Struktur-Runden im Vorbeigehen, keine Prompt-Feinschliffe nach Gefühl.
2. **Verhalten vorher → nachher benennen.** Wer nicht sagen kann, **welches beobachtbare Verhalten** sich ändert, ändert nichts — lautet die Antwort «keines», ist die Änderung nicht nötig.
3. **Jede Verhaltensänderung bringt ihren Test mit, und der ist vorher rot.** Bugfix: erst der Test, der den Fehler zeigt, dann der Fix. Neues Verhalten: Test, der ohne die Änderung scheitert. Hängt das Verhalten an Geometrie, CSS-Höhenkette oder dem echten Template-Baum, gehört der Test nach `tests/e2e-app/` und wird **einmal mutationsgeprüft** (Änderung zurücknehmen → rot). Der neue Test landet automatisch in der Sonderprüfung, sobald er den Modulnamen trägt oder die Moduldoku ihn verlinkt — das «Gegated:»/Tests-Tabelle der Doku nachziehen.
4. **Ein Verhalten pro Commit, Refactor getrennt.** Reine Struktur-Verschiebung (Datei-Split, Umbenennung, Extraktion) und Verhaltensänderung **nie** im selben Commit. Die Commit-Message benennt das Verhalten («erste Zeile erreicht die Schreiblinie auf Mobile»), nicht das Vorgehen («refactoring», «hardening», «verbesserungen»). **Why:** ohne diese Disziplin gibt es keinen Bisect-Anker, und der Weg zurück wird eine Rekonstruktion statt eines `git revert`.
5. **Tests nicht lockern, um Rot loszuwerden.** Ein roter Assert ist ein Befund — Ursache klären. Ein Test darf sich nur ändern, wenn sich das Verhalten laut Punkt 1–2 begründet ändert, und die Begründung nennt den Test.
6. **Sonderprüfung vor dem Commit:** `npm run test:<modul>` fährt jede Schicht des Moduls — Unit, Integration, Harness-E2E (Chromium, dazu WebKit für `*.webkit.spec.js`) und die App-Suite mit vollem CSS — und stempelt nach grünem Lauf den Fingerabdruck des Modul-Stands. Grün ist die **Untergrenze**, nicht der Beweis; was der Modul-Zusatz zusätzlich verlangt (Klickliste, Eval, Vorher/Nachher-Lauf), gilt daneben. `npm run stable:status` zeigt, welches Modul seit seiner letzten grünen Sonderprüfung geändert wurde.

Die Regel ist bewusst **Text, kein blockierender Hook**: parallele Sitzungen, die nur Tests nachziehen, würden sonst ausgebremst. Der Stempel ist ein Nachweis, kein Gate.

## Neues Modul stabilisieren

Eintrag in `MODULES` ([scripts/stable-modules.js](../scripts/stable-modules.js): Doku, Code-Namen/-Ordner, Test-Namen), Skript `test:<modul>` in `package.json`, Zeile in der Tabelle oben, Abschnitt «Stabilisiert» in der Moduldoku mit den modulspezifischen Belegquellen und Zusatzprüfungen, Auslöser-Zeile in der Root-[CLAUDE.md](../CLAUDE.md).
