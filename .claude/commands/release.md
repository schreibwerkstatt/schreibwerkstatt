---
description: Versionsnummer erhöhen + Git-Tag + GitHub-Release erstellen
argument-hint: "[patch|minor|major|x.y.z]  (Default: patch)"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(npm run version:sync), Bash(npm run sw:manifest), Bash(npm run squash:regen), Bash(npm run release:verify:*), Bash(npm run check:clients:*), Read, Write
---

Du führst einen Release der App durch. SSoT der Version ist die Datei `VERSION` im Projektroot; `package.json#version` folgt via `npm run version:sync`. Zu **jeder** Version gehören Release-Notizen in `changelog/<version>.json` — die App zeigt sie den Usern unter **Hilfe → Neuigkeiten** ([changelog/README.md](../../changelog/README.md)).

Bump-Argument: `$ARGUMENTS` (leer = `patch`).

**Ein Release endet immer gepusht.** Commit, Tag, `git push` und GitHub-Release gehören zum Befehl — sie sind nicht optional und werden nicht zurückgestellt. Ein Lauf, der nur `VERSION` hochzählt und den Tree liegen lässt, ist ein fehlgeschlagener Lauf. **Es wird nicht nachgefragt** — weder für die Release-Notizen noch sonst. Der Lauf hält nur an, wenn ein Schritt fehlschlägt oder die Änderungslage nicht eindeutig ist (Schritt 9).

**Der Release blockiert die Weiterentwicklung nicht.** Er committet **zuerst** (nach wenigen Minuten) und testet danach genau diesen Commit als Schnappschuss ausserhalb des Arbeitsbaums ([scripts/release-verify.js](../../scripts/release-verify.js)). Der Lauf hält den Turn offen, bis Tag, Push und GitHub-Release stehen (Schritt 13); der User sieht so jederzeit, dass der Release noch läuft. Ab dem Commit darf am Tree weitergearbeitet und weitercommittet werden — nichts davon gehört zum Release. Getaggt und gepusht wird erst, wenn der Schnappschuss grün ist, und zwar **genau der getestete Commit**, nicht `HEAD`. **Why:** `test:ci` dauert rund 20 Minuten; auf dem Arbeitsbaum gefahren, fror es den Tree ein — jede Änderung währenddessen landete ungetestet im `git add -A` oder liess den laufenden Testserver geänderte Dateien ausliefern.

## Offener Release

Zwischen Schritt 12 (Commit) und Schritt 15 (Tag) ist der Release **offen**: ein `release: v…`-Commit liegt vor `origin/main`, und noch kein `v*`-Tag enthält ihn. In dieser Zeit gehört er dem Release-Lauf, und das gilt für **jede** Sitzung, nicht nur für die, die `/release` gestartet hat. Kein `git push` auf `main` (weder mit dem Release-Commit, der dann ungetestet rausginge, noch an ihm vorbei, was den Push des Release abweisen lässt), kein `rebase`/`pull --rebase` (der neue SHA ist ungetestet und nicht taggbar), kein `reset` hinter ihn, kein `--amend` auf ihn. Eigene Arbeit wird lokal auf ihm committet und geht danach mit dem nächsten Push raus. Durchgesetzt von [scripts/hooks/release-guard.js](../../scripts/hooks/release-guard.js) ([Test](../../tests/unit/release-guard.test.mjs)); Tags pushen bleibt frei, und der Release selbst taggt vor dem Push, ist dann also nicht mehr offen. Übergehen darf das nur der User selbst im Terminal. **Why:** eine Parallel-Sitzung pushte ihren Fix an einem offenen Release vorbei und rebasete dessen Commits darüber; der getestete SHA verschwand von `main`, und die Version blieb ohne Tag und ohne GitHub-Release.

## Vorprüfung

1. `git status --porcelain` lesen. **Der gesamte Working Tree wird mit dem Release committet** — egal was drin liegt. Es darf nur kein laufender Merge/Rebase-Konflikt (ungemergte Pfade) vorliegen; falls doch: abbrechen und melden.
2. Aktuelle Version aus `VERSION` lesen. **Abgleich mit dem letzten Tag** (`git describe --tags --abbrev=0`): steht `VERSION` bereits über dem letzten Tag, hat ein früherer Lauf abgebrochen, bevor er taggen konnte — meist, weil der Schnappschuss rot war (Schritt 14) und inzwischen nachgebessert wurde. Dann **nicht erneut bumpen** — diesen Stand als `<neueVersion>` übernehmen, fehlende Release-Notizen nachschreiben bzw. um die Nachbesserung ergänzen, falls sie User-sichtbar ist, und ab Schritt 10 normal weiterfahren. Liegt der frühere `release: v<neueVersion>`-Commit schon in der History, heisst der neue Commit in Schritt 12 `release: v<neueVersion> (Nachbesserung)`; getaggt wird dann dieser.
3. Neue Version berechnen:
   - `patch` → letzte Stelle +1 (1.2.3 → 1.2.4)
   - `minor` → mittlere +1, Patch auf 0 (1.2.3 → 1.3.0)
   - `major` → erste +1, Rest auf 0 (1.2.3 → 2.0.0)
   - Explizites `x.y.z` → genau dieser Wert (Semver-Format validieren).
4. Sicherstellen, dass der Tag `v<neueVersion>` noch nicht existiert (`git tag -l`). Falls doch: abbrechen und melden.

## Version setzen

5. Neue Version in `VERSION` schreiben (nur die Zahl + Newline).
6. `npm run version:sync` ausführen (schreibt `package.json#version`).

## Release-Notizen schreiben

Das ist der Teil, den nur du machen kannst — der Rest ist Mechanik.

7. `git log --format='%s%n%b' v<letzteVersion>..HEAD` lesen (plus `git diff --stat` für den Umfang). Bei sehr vielen Commits zusätzlich `git log --format='%s' … | sort -u`, um Themen zu bündeln statt Commits aufzuzählen.

8. `changelog/<neueVersion>.json` schreiben — Format und Ton stehen in [changelog/README.md](../../changelog/README.md). Verbindlich:
   - **Ein Eintrag pro Änderung, die ein User merkt**, nicht pro Commit. Zehn Commits an einem Feature sind ein Eintrag; „tests", „doku", „refactoring", „anpassungen", Versions-Bumps und interne Umbauten kommen **gar nicht** vor — sie ändern für den Leser nichts.
   - **Vor dem Schreiben [changelog/README.md](../../changelog/README.md) → „Ton" lesen und die sechs Verständlichkeits-Regeln anwenden** — sie sind der Grund, warum der Leser den Eintrag überhaupt versteht, und dort steht das Beispiel derselben Änderung in drei Fassungen. Kurz: höchstens zwei Sätze (100–250 Zeichen), Anfang nennt Karte/Reiter/Knopf so wie in der Oberfläche, nur Wörter, die der User in der App liest (kein Job-/Tabellen-/Feldname, kein Index/Lauf/Cache/Schema/Endpunkt), kein Blick hinter die Kulissen (bei `behoben` das gesehene Symptom, nicht die Ursache im Code), ein Gedanke pro Satz, Ansprache «du» (kein «Sie»).
   - **Gegenlesen ist Teil des Schreibens:** jeden Eintrag einmal als jemand lesen, der die App benutzt und nie einen Commit gesehen hat. Weiss er, wo er hinklickt und was er davon hat? Nein ⇒ umschreiben, nicht ergänzen — ein zu langer Eintrag enthält fast immer Technik, nicht Inhalt.
   - `kind` ist `neu` (gab es vorher nicht) | `verbessert` (gab es, ist jetzt besser) | `behoben` (war kaputt). Im Zweifel `verbessert`.
   - **`de` UND `en` sind Pflicht** (i18n-Regel — der Changelog ist User-Text). Übersetze selbst, verschiebe es nicht.
   - Reihenfolge: das Wichtigste zuerst, nicht chronologisch. `neu` vor `verbessert` vor `behoben`.
   - `date` = heutiges Datum (`YYYY-MM-DD`).
   - Bringt eine Version **nichts** User-Sichtbares (reiner Wartungs-Release), schreibe genau einen ehrlichen Eintrag dazu (`kind: 'verbessert'`, z. B. „Wartung und interne Verbesserungen ohne Änderungen an der Oberfläche.") — eine Version ohne Datei lässt `npm run test:unit` rot werden, und das ist Absicht.

9. Die geschriebenen Notizen **ohne Rückfrage** übernehmen und weiterfahren — sie werden im Abschlussbericht ohnehin gezeigt, und der User kann danach jederzeit korrigieren lassen. **Warten ist die Ausnahme, nicht die Regel:** nachgefragt wird nur, wenn (a) ein Schritt fehlschlägt, (b) der Commit-Log die Änderung nicht eindeutig hergibt — mehrere plausible Lesarten, unklar ob überhaupt User-sichtbar, oder Fremdarbeit im Tree, die du nicht zuordnen kannst. Dann die kompakte DE-Liste zeigen, bestätigen lassen und bei Korrekturwünschen die Datei anpassen und erneut zeigen. Im Normalfall läuft der Befehl ohne Halt durch.

## Drift-Artefakte (vor dem Commit)

Schritt 11 committet den **gesamten** Tree — auch Fremdarbeit, die nicht durch die PostToolUse-Hooks dieser Session gelaufen ist. Darum vor dem Commit selbst regenerieren und prüfen; das sind Sekunden, kein Testlauf:

10a. `npm run sw:manifest` — Content-Hash `__SHELL_BUILD` in `public/sw-manifest.js` neu berechnen (gegated durch `sw-manifest-drift.test`).
10b. Enthält der Tree eine neue Migration in `db/migrations.js`: `npm run squash:regen` (bei Recreate-Pattern `FORCE_LEGACY_MIGRATIONS=1 npm run squash:regen`) und [docs/erd.md](../../docs/erd.md)-Stand prüfen.
10c. `npm run check:clients -- --base v<letzteVersion>` — Breaking-Change-Gate für die nativen Clients (macOS, Android). Der Deploy nach dem Release liefert das Editor-Bundle per OTA an beide aus, ohne App-Update ([docs/focus-editor-acceptance.md](../../docs/focus-editor-acceptance.md#native-clients)). **Exit ≠ 0 ⇒ abbrechen**, kein Commit: Exit 1 = eine Kontaktstelle FEHLT (Client-Code greift auf etwas zu, das es nicht mehr gibt), Exit 2 = der Check lief nicht (z. B. `gh`/Netz) — auch das ist kein Grün. Die BERÜHRT-Liste (Kontaktstelle existiert, Datei seit dem letzten Release geändert) bricht nicht ab: an der genannten Client-Zeile lesen, ob die Semantik noch trägt, und die Liste im Abschlussbericht nennen. Trägt sie erkennbar nicht mehr ⇒ abbrechen wie bei FEHLT.

## Commit

11. **Gesamten** Working Tree stagen: `git add -A` (inkl. `VERSION`, `package.json` + `changelog/<neueVersion>.json`).
12. Committen mit Message `release: v<neueVersion>` (bzw. `… (Nachbesserung)`, Schritt 2). Liegen ausser dem Versions-Bump noch andere Änderungen im Tree, eine kurze, sinnvolle Zusammenfassung dieser Änderungen als zweite Zeile (Body) ergänzen. `Co-Authored-By:`-Trailer mit dem **aktuell vorgegebenen Modellnamen** anhängen (steht in den Umgebungs-/Harness-Vorgaben — nicht aus älteren Commits kopieren, der Name wandert mit jeder Modellgeneration). **SHA merken:** `git rev-parse HEAD` direkt nach dem Commit = `<releaseSha>`. Ab hier bezieht sich jeder Schritt auf `<releaseSha>`, nie auf `HEAD` — der Tree ist wieder frei, und die Auto-Commit-Automatik oder der User können jederzeit weitere Commits darauflegen.

## Schnappschuss testen (Turn bleibt offen)

13. `npm run release:verify -- <releaseSha> > <scratchpad>/release-verify-<sha10>.log 2>&1` mit **`run_in_background: true`** starten — die volle Ausgabe in eine Datei, **nie** durch `| tail` gekürzt (sonst fehlt bei Rot die Fehlermeldung, und der Exit-Code der Pipe ist der von `tail`). Das Skript entpackt den Commit per `git archive` nach `$TMPDIR/schreibwerkstatt-release-<sha>` (kein Worktree, kein Branch), verlinkt `node_modules` und fährt `test:ci` mit `TEST_CI_SHARDS=3` — dieselbe Aufteilung wie der Test-Job in CI ([scripts/test-ci.js](../../scripts/test-ci.js), `PWTEST_SHARD_WEIGHTS` wie in [deploy.yml](../../.github/workflows/deploy.yml)) — auf eigenen Ports (App-Shards 8828–8836, Harness 8865, Boot 33738), damit ein gleichzeitiger Testlauf im Arbeitsbaum nichts teilt. Unit deckt `sw-manifest-drift`, `squash-drift`, `erd-drift`, `loc-limits` **und `changelog`** ab (fehlt `changelog/<neueVersion>.json` oder einem Eintrag `de`/`en` ⇒ rot); E2E und App-Specs fangen, was Unit nicht sieht.

    Dann einen kurzen Zwischenbericht als Text ausgeben (alte → neue Version, Release-Notizen als kompakte DE-Liste, `<releaseSha>`, Client-Gate-Ergebnis, Hinweis, dass der Tree frei ist) und **den Turn nicht beenden**: im Vordergrund in Etappen auf den Lauf warten, je ein Bash-Aufruf mit `timeout: 600000` und einer Warteschleife von höchstens ~570 s, die endet, sobald `scripts/release-verify` nicht mehr läuft, und sonst den Fortschritt meldet (z.B. `grep -c '✓' <log>` und die Laufzeit). So oft wiederholen, bis der Lauf vorbei ist. **Why:** ein beendeter Turn mit Hintergrund-Lauf sieht für den User aus wie «fertig»; bricht die Sitzung dann ab, bleibt der Release offen, ungetaggt und ungepusht, und keiner merkt es.

14. Beim Ende des Laufs die letzte Zeile der Log-Datei lesen (`release-verify: GRUEN|ROT`):
    - **ROT ⇒ abbrechen**, kein Tag, kein Push. Ursache aus der Ausgabe klären (Schnappschuss-Pfad steht dort und bleibt liegen) statt Tests anpassen, und melden: der Release-Commit liegt lokal, ungepusht. Nach der Nachbesserung im Arbeitsbaum setzt der nächste `/release`-Aufruf über Schritt 2 auf. Ein Port-Konflikt (`EADDRINUSE`, belegt durch eine andere Sitzung) ist kein Rot des Codes: mit anderer Basis wiederholen (`TEST_CI_SHARD_BASE=40 E2E_PORT=8875 BOOT_SMOKE_PORT=33739 npm run release:verify -- <releaseSha>`), keine fremden Prozesse beenden.
    - **GRÜN ⇒ weiter mit Schritt 15.**

## Taggen und pushen

15. Annotated Tag auf den getesteten Commit: `git tag -a v<neueVersion> <releaseSha> -m "v<neueVersion>"`.
16. Pushen — **beides, in dieser Reihenfolge, und jeweils den Erfolg prüfen**:
    - `git push origin <releaseSha>:refs/heads/main` — pusht genau den getesteten Stand; lokale Commits, die nach ihm entstanden sind, bleiben lokal und gehen mit dem nächsten Push bzw. Release raus. Wird der Push abgewiesen (origin/main hat Commits, die `<releaseSha>` nicht enthält): **nicht rebasen** — der rebasete Commit wäre ein anderer, ungetesteter Stand. Tag lokal löschen (`git tag -d v<neueVersion>`), stoppen und melden; der nächste `/release` integriert und testet neu.
    - `git push origin v<neueVersion>` — ein Tag reist **nicht** mit dem Branch-Push mit; ohne diesen zweiten Push kennt GitHub den Tag nicht und Schritt 17 legt ein Release auf einer Referenz an, die es dort nicht gibt.
    - **Verifizieren statt annehmen:** `git ls-remote --tags origin v<neueVersion>` muss eine Zeile liefern und `git rev-parse v<neueVersion>^{commit}` gleich `<releaseSha>` sein. Leere Ausgabe oder Abweichung ⇒ stoppen und melden, kein `gh release create`.
17. GitHub-Release erstellen — **Body sind die Release-Notizen aus Schritt 8**, nicht `--generate-notes` (das listet rohe Commit-Betreffs; die kuratierte Fassung ist die bessere und steht ohnehin schon da):
    - Aus `git show <releaseSha>:changelog/<neueVersion>.json` (nicht aus dem Arbeitsbaum — der kann sich seither geändert haben) eine Markdown-Notiz bauen: die `de`-Texte, gruppiert nach `kind` unter den Überschriften `### Neu` / `### Verbessert` / `### Behoben`, je ein `- `-Punkt.
    - In eine Temp-Datei schreiben und `gh release create v<neueVersion> --title "v<neueVersion>" --notes-file <datei>` aufrufen.

## Verifikation (Pflicht, nicht überspringen)

18. Erst wenn das durchläuft, gilt der Release als erfolgt:
    - `git fetch origin` und `git merge-base --is-ancestor <releaseSha> origin/main` (Exit 0) — der getestete Commit ist wirklich auf `main` angekommen. Ein nicht leerer `git status` ist hier **kein** Fehler: der Tree gehört seit Schritt 12 wieder der Weiterentwicklung.
    - `gh release view v<neueVersion> --json tagName,url` antwortet mit dem Tag und der URL.
    Schlägt eines davon fehl: den fehlenden Schritt nachholen (Tag nachpushen, Release neu anlegen) und erneut prüfen. Nicht mit einem halb fertigen Release aufhören.

## Abschluss

Melde knapp: alte → neue Version, Anzahl Release-Notizen, `<releaseSha>`, Tag, die URL des erstellten GitHub-Releases, die Dauer des Schnappschuss-Laufs und das Ergebnis des Client-Gates (Schritt 10c: Kontaktstellen je Client, BERÜHRT-Stellen falls vorhanden). Liegen lokal Commits nach `<releaseSha>`, die noch nicht gepusht sind, das mit Anzahl erwähnen. Erwähne, dass die Notizen den Usern beim nächsten Laden unter **Hilfe → Neuigkeiten** erscheinen (mit Punkt am „?"-Knopf, bis sie gelesen sind).

Bei jedem Fehlschlag eines Schritts **stoppen** und den Stand berichten — mit der Angabe, was schon committet/gepusht/getaggt ist und was fehlt, damit der nächste Lauf dort aufsetzt. Kein `gh release create` ohne gepushten Tag, kein Tag auf einen ungetesteten Commit, und kein „mache ich später" für Push.
