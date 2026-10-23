# changelog/

Eine JSON-Datei pro veroeffentlichter Version — die SSoT der Release-Notizen,
die den Usern in der App unter **Hilfe → Neuigkeiten** angezeigt werden.

    changelog/4.0.0.json

```json
{
  "version": "4.0.0",
  "date": "2026-08-08",
  "entries": [
    { "kind": "neu", "de": "Quellen & Quellenverzeichnis", "en": "Sources and bibliography" }
  ]
}
```

- `version` — muss dem Dateinamen entsprechen (`x.y.z`).
- `date` — Release-Datum, `YYYY-MM-DD`.
- `entries[].kind` — `neu` | `verbessert` | `behoben`. Label kommt aus i18n
  (`changelog.kind.<kind>`), steht also **nicht** im Text.
- `entries[].de` / `.en` — beide Pflicht. Der Changelog ist User-Text und faellt
  damit unter die i18n-Regel; die Ansicht zeigt die UI-Sprache des Betrachters.

**Geschrieben wird eine neue Datei ausschliesslich vom `/release`-Befehl**
(`.claude/commands/release.md`), im selben Commit wie der Versions-Bump.
`tests/unit/changelog.test.mjs` haelt das zusammen: fehlt die Datei zur aktuellen
`VERSION`, ist CI rot.

## Ton: der Leser kennt den Code nicht, er schreibt ein Buch

Ein Eintrag ist verstaendlich, wenn der Leser danach zwei Dinge weiss: **wo er das
findet** und **was er davon hat**. Sechs Regeln, jede einzeln pruefbar:

1. **Hoechstens zwei Saetze, Richtwert 100–250 Zeichen, hart Schluss bei ~300.**
   Satz 1: was jetzt moeglich oder anders ist. Satz 2 (optional): was das beim
   Schreiben bringt. Ein dritter Satz gehoert in die Hilfe, nicht in die Neuigkeiten.
2. **Der Anfang nennt die Sache so, wie sie in der Oberflaeche heisst** — Karte,
   Reiter oder Knopf („Figuren-Karte, Reiter Alter", „Buchorganizer", „Lese-Link").
   Ein Eintrag, den man nicht wiederfindet, ist keine Neuigkeit.
3. **Nur Woerter, die der User in der App liest.** Keine Datei-, Tabellen-, Job-
   oder Feldnamen, und keine Hausbegriffe, die nirgends auf dem Bildschirm stehen:
   Index, Lauf, Delta, Cache, Pipeline, Marker, Gate, Schema, Endpunkt, Facade,
   Full-Replace, Invariante. Braucht der Satz eines davon, ist er noch aus
   Code-Sicht geschrieben.
4. **Kein Blick hinter die Kulissen.** Warum etwas technisch so gebaut ist, was
   intern falsch lief, was in welcher Reihenfolge geladen wird — davon hat der
   Leser nichts. Bei `behoben` steht das **Symptom, das er gesehen hat**, nie die
   Ursache im Code: „die Alterstabelle blieb leer" statt „die Spalte fehlte in der
   Migration".
5. **Ein Gedanke pro Satz.** Hoechstens ein Gedankenstrich oder Doppelpunkt pro
   Eintrag, keine Kette aus drei Nebensaetzen. Wer drei Dinge nennen will, hat
   drei Eintraege — oder einen Oberbegriff.
6. **Ansprache „du"** — wie die Oberflaeche selbst (`de.json` duzt), in jedem
   Eintrag gleich; wo der Satz keine Anrede braucht, unpersoenlich. Kein „Sie".
   Aeltere Dateien, die noch siezen, bleiben unveraendert (veroeffentlichte
   Notizen werden nicht nachtraeglich umgeschrieben, siehe „Regeln"). Die
   englische Fassung ist gleich kurz, keine ausfuehrlichere Variante.

Beispiel derselben Aenderung, dreimal:

    zu technisch  „figure-ages-Job schreibt figure_ages/figure_age_belege per
                   Full-Replace, Delta-Skip ueber content_sig."
    noch zu viel  „Die Alters-Analyse liest Altersangaben deterministisch aus dem
                   Buchtext, laesst das Modell nur sagen, was die Stellen behaupten,
                   und verdichtet danach zu einer Spanne — Zahl gegen Zitat geprueft."
    verstaendlich „Figuren-Karte, Reiter „Alter": zu jeder Figur steht jetzt
                   nebeneinander, was das Manuskript ueber ihr Alter sagt und was
                   sich aus dem Geburtsjahr rechnen laesst. Weichen die beiden ab,
                   siehst du es sofort."

**Gegenlesen vor dem Speichern:** jeden Eintrag einmal als jemand lesen, der die
App benutzt und nie einen Commit gesehen hat. Weisst du, wo du hinklickst und was
du davon hast? Nein ⇒ umschreiben, nicht ergaenzen. Ist ein Eintrag zu lang
geworden, steckt darin fast immer Technik, nicht Inhalt.

Interne Refactorings, Testarbeit und Doku-Pflege gehoeren gar nicht hinein — sie
aendern fuer den Leser nichts.

## Regeln

- **Geschrieben wird eine Changelog-Datei ausschliesslich vom `/release`-Befehl**, im selben Commit wie der Versions-Bump. Nicht nebenbei von Hand, nicht nachtraeglich — [tests/unit/changelog.test.mjs](../tests/unit/changelog.test.mjs) macht CI rot, solange zur aktuellen `VERSION` keine Datei existiert. **Why:** ohne dieses Gate ist „die Users koennen die Aenderungen nachlesen" eine Absicht statt einer Zusage; die erste Version ohne Eintrag faellt niemandem auf.
- **Jeder Eintrag traegt `de` UND `en`.** Der Changelog ist User-Text und faellt damit unter die i18n-Regel — die Ansicht zeigt die UI-Sprache des Betrachters, nicht die des Autors. Die drei `kind`-Werte (`neu`/`verbessert`/`behoben`) sind **Schluessel, kein Text**: das Label kommt aus `changelog.kind.<kind>` in beiden Locales.
- **Die Liste haengt NICHT im `/config`.** Sie waechst mit jedem Release und holt sich der Reiter lazy beim ersten Oeffnen. `/config` traegt nur `changelogLatest` (Kopf-Version) und `changelogSeen` (Stand des Users) — genug fuer den Achtungs-Punkt am „?"-Knopf im Header, ohne die Boot-Nutzlast.
- **Der Gelesen-Stand liegt in `app_users.changelog_seen_version`**, nicht im localStorage: der Punkt soll einmal pro Release erscheinen, nicht einmal pro Browserprofil. Quittiert wird beim Oeffnen des Reiters (`POST /changelog/seen`), und **nur vorwaerts** — ein Zweitgeraet mit alter Shell darf den Stand nicht zurueckdrehen. Bewusst kein Eintrag in `onboarding_state`: das ist ein einmaliger Vorgang, der Changelog-Stand wandert bei jedem Release weiter.
- Der Neu-Punkt und die Reiter-Vorauswahl stellen **dieselbe** Frage — `hasUnreadChangelog(shell)` aus [help-card.js](../public/js/cards/help-card.js), im Root gespreadet fuer das Header-Markup. Kein zweiter Vergleich daneben.
