# Abschnitts-Chat-Eval

Misst Änderungen am **Abschnitts-Chat** ([docs/chats.md](../../docs/chats.md#abschnitts-chat)) an echten Fragen statt nach Gefühl: der echte Job ([routes/jobs/chat/page-chat.js](../../routes/jobs/chat/page-chat.js)) über die echte Job-Queue, gegen eine Kopie der Prod-DB. Nicht Teil von `npm test` — jeder Lauf kostet Geld.

## Vor jedem Lauf: Org-Limit prüfen

Die Eval nutzt den **lokalen** Claude-Key, und der gehört zur selben Org wie Prod. Das Org-Monatslimit gilt für beide: reisst ein Eval-Lauf es, steht Claude auf Prod bis zum Monatsersten still. Vorher:

1. Prod-Verbrauch des Monats lesen: `ssh github-runner@bookstack.lan "sqlite3 -readonly /opt/schreibwerkstatt/schreibwerkstatt.db \"SELECT ROUND(SUM(usd),2) FROM ai_cost_ledger WHERE ts >= '<JJJJ-MM>-01'\""`
2. Org-Limit in der Anthropic Console nachsehen; Rest = Limit − Prod-Verbrauch − frühere lokale Läufe.
3. `--max-usd` deutlich unter den Rest setzen. Ein Lauf über alle Fälle kostet grob 0.3–0.5 $ je Frage aus einem Buch mit grossem Figuren-Block.

Der Lauf stoppt beim ersten API-Fehler (`job.error.aiHttpError`) — die genaue Meldung, z.B. «usage limits», steht im Log neben den Ergebnissen.

## Ablauf

```bash
# 1. Prod-Kopie holen (reiner Read) und entschärfen → <dir>/eval-pagechat.db
scp github-runner@bookstack.lan:/opt/schreibwerkstatt/schreibwerkstatt.db{,-wal} /pfad/
npm run eval:pagechat -- --prepare=/pfad/schreibwerkstatt.db
rm /pfad/schreibwerkstatt.db*          # die Rohkopie trägt Prod-Zugangsdaten

# 2. Fälle wählen (nur IDs, landen in cases.json)
npm run eval:pagechat -- --pick --db=/pfad/eval-pagechat.db --days=90

# 3. Läufe — Variante per Setting oder per Code-Stand
npm run eval:pagechat -- --db=/pfad/eval-pagechat.db --label=ist --max-usd=8
npm run eval:pagechat -- --db=/pfad/eval-pagechat.db --label=ohne_listen --set=jobs.page_chat.figuren_modus=ohne_listen --max-usd=8

# 4. Blinder Paarvergleich (Bewerter-Modell, ~0.15 $ je Fall)
npm run eval:pagechat -- --db=/pfad/eval-pagechat.db --compare=ist,ohne_listen
```

`--only=s196-m531,…` und `--limit=N` schränken die Fälle ein; für einen Vorab-Check genügt ein Fall.

## Was die Eval tut

- **`--prepare`** ([prepare.js](prepare.js)): kopiert die DB, entfernt genau die verschlüsselt gespeicherten Settings (`ENCRYPTED_KEYS` der Registry), leert KI-Profil-Keys und Blog-/HubSpot-Verbindungen und setzt Claude-, Embedding- und Rerank-Key aus der **lokalen** DB ein. Alle anderen Settings bleiben wie auf Prod (Modell, Effort, Output-Deckel).
- **`--pick`** ([cases.js](cases.js)): jede User-Frage aus Abschnitts-Chat-Sessions der letzten Tage, sortiert nach Buch, damit Folgefälle den Figuren-Block aus dem Cache lesen. Im Repo stehen nur Session- und Nachrichten-IDs.
- **Lauf** ([replay.js](replay.js)): arbeitet auf einer Wegwerf-Kopie und stellt je Fall den Stand zur Fragezeit her: Verlauf bis zur Frage, Abschnitt aus der jüngsten `page_revisions`-Fassung davor (über die Content-Store-Facade). Figuren, Lektorat, Ideen und Embedding-Index sind der heutige Stand — für den Vergleich zweier Varianten gleich. Gemessen werden Regeln (JSON-Fallback, Vorschläge ohne oder mit mehrdeutiger Fundstelle, Vorschläge ohne Änderung, Ideen), Tokens, Cache-Anteil, Kosten und Dauer. Die Log-Zeile «Prompt-Zeichen» je Fall zeigt, welcher Baustein den Prompt trägt.
- **`--compare`** ([judge.js](judge.js)): ein Bewerter-Modell vergleicht je Fall zwei Antworten blind (A/B-Reihenfolge fest aus der Fall-ID). Es sieht Abschnitt, Verlauf, Frage und als Referenz **immer** die Volldossiers der Kapitelfiguren — so fällt auf, wenn eine schlankere Variante Figurenwissen verliert oder erfindet.

## Datenschutz

Ergebnisse, Log und Arbeitskopien liegen in `eval-pagechat-out/` **neben der Eval-DB**, nicht im Repo: sie enthalten Buchtext und Antworten. Die Fragen der Nutzer laufen durch die lokale Eval an Anthropic — wie im Prod-Betrieb, aber auf deine Veranlassung; Fälle fremder Bücher nur mit Einverständnis.
