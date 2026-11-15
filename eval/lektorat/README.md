# Lektorat-Eval

Kleine, kuratierte Stichprobe, um **Prompt-Änderungen empirisch zu messen** statt nach Gefühl zu tunen.

## Ausführen

```bash
npm run eval:lektorat                                   # Kombi + Split, beide Gold-Sets
npm run eval:lektorat -- --mode=split --set=stil          # nur Split, nur Stil-Fälle
EVAL_ONLY=stil-roman-verdraengung npm run eval:lektorat   # einzelne Fälle
```

`--mode`: `kombi` (ein Call) oder `split` (Objektiv- + Stil-Pass, Produktion bei Claude). Die Prüfung langer Abschnitte in Stücken greift erst über `ai.lektorat_chunk_chars` (Default 10'000 Zeichen); die Gold-Fälle sind kürzer und messen sie nicht. `--set`: `objektiv` ([gold.mjs](gold.mjs)), `stil` ([gold-stil.mjs](gold-stil.mjs)) oder `alle`. Nachbearbeitung, Modell und Effort wie im Job.

Nutzt den in `app_settings` konfigurierten KI-Provider (Claude/Ollama/OpenAI-compat) und macht echte Calls — **nicht** Teil von `npm test` (kostet Tokens, braucht Provider + Key). Ohne Claude-Key bricht der Runner sauber ab.

## Was gemessen wird

Pro Fall in [gold.mjs](gold.mjs):

- **Recall** — Anteil der gepflanzten, **objektiven** Fehler (Rechtschreibung, Grammatik/Komma, Dialogformat), die das Modell findet. Ziel: ≥ 80 %.
- **False-Positives** — Findings, die einen als **korrekt** markierten (Schweizer) Satz anstreichen. Ziel: 0. Anti-Pedanterie-Kontrolle (ss statt ß, Helvetismen, saubere Prosa).

Das Stil-Gold-Set ([gold-stil.mjs](gold-stil.mjs)) misst dasselbe für Stil-, Handwerks- und Konsistenz-Typen — nur an Stellen, die jeder Lektor anstreichen würde. Die Fälle sind lang und mit vielen kleinen Schwächen durchsetzt: geprüft wird, ob seltene Typen (Perspektivbruch, Tempuswechsel, Welt-Fakt, Beleg) neben Füllwörtern und Passiv bestehen. Gewöhnliche Stil-Funde ausserhalb der Gold-Stellen stehen als «sonstig» im Report und zählen nicht.

Je Modus nennt der Report zusätzlich Calls, Tokens und Laufzeit; bei mehreren Modi folgt eine Vergleichstabelle.

## Workflow bei Prompt-Änderungen

1. `npm run eval:lektorat` **vor** der Änderung → Recall/FP notieren.
2. Prompt in [public/js/prompts/lektorat.js](../../public/js/prompts/lektorat.js) bzw. [blocks.js](../../public/js/prompts/blocks.js) anpassen.
3. `npm run eval:lektorat` **danach** → Zahlen vergleichen. Recall runter oder FP hoch = Regress.

Der Struktur-Drift-Schutz (dass die Invarianten-Blöcke überhaupt im Prompt landen) läuft deterministisch in [tests/unit/lektorat-prompt-contract.test.mjs](../../tests/unit/lektorat-prompt-contract.test.mjs) als Teil von `npm test`.

## Gold-Set erweitern

Fälle in [gold.mjs](gold.mjs) ergänzen. `mustCatch.needle` und `cleanSpans[]` müssen **verbatim** Teilstrings des `text` sein (der Scorer matcht per Substring-Überlappung gegen `finding.original`). Mehr Fälle = aussagekräftiger.
