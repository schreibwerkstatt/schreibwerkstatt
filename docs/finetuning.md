# Fine-Tuning auf den Exportdaten

Vom JSONL-Export der Fine-Tuning-Karte zu einem lokal laufenden Modell, das Stil, Welt und Figuren des Buchs internalisiert und als das Buch mit Leserinnen und Lesern spricht ([Leser-Modell](#leser-modell)). Für die eigene Arbeit am Buch ist der [Buch-Chat](chats.md) da, nicht ein trainiertes Modell.

**Pfad:** [Unsloth](https://github.com/unslothai/unsloth) + QLoRA mit Ministral-3-8B als Basis. Web-UI ([Unsloth Studio](https://studio.unsloth.ai)) oder CLI-Script ([train_book.py](unsloth-config/train_book.py)). Optimiert für 1× RTX 4000 Ada (20 GB).

## 1. Modell und Hardware

**Basemodell:** `unsloth/Ministral-3-8B-Instruct-2512-unsloth-bnb-4bit`. Mehrsprachig inkl. DE, 256 k Context, Apache 2.0, `[SYSTEM_PROMPT]`/`[INST]`-Template (Tekken), GGUF-Export für Ollama. Der Pixtral-Vision-Encoder bleibt beim Training eingefroren. Braucht `transformers` v5 ([requirements.txt](unsloth-config/requirements.txt)).

**Hardware:** 20 GB VRAM reichen für QLoRA mit seq_len 4096, Batch 2 × Accum 8 (VRAM-Peak ~12–15 GB, bei OOM seq_len 2048). Andere GPU-Grössen und das Mistral-Small-3.2-24B-Profil: Tabelle in [§4](#4-hyperparameter-nach-ziel).

## 2. Daten exportieren

UI → Buch → Kachel **Fine-Tuning-Export**:

- `Profil` = Basismodell × GPU-Speicher (Default Ministral 3 8B, 20 GB) — setzt `Max. Token pro Sample` und `Max. Zeichen`; daneben **studio-config.yaml herunterladen** ([§4](#4-hyperparameter-nach-ziel)).
- Alle Typen aktiv: `Stil`, `Szene`, `Wörtlich`, `Dialog`, `Buchwissen`. Die Leser-Samples laufen immer mit.
- `Min. Zeichen = 200`, `Max. Zeichen` aus dem Profil.
- `Validation-Split = 0.05` (> 20 000 Samples), sonst `0.1`.
- `Max. Token pro Sample` aus dem Profil.
- `Vorgerendertes text-Feld` optional.
- `Max. Wiederholungen je Antwort = 2`, `Max. Anteil Faktenfragen = 0.4` ([Qualität des Sets](#qualität-des-sets)).
- `Typ-Balance` (Max. Anteil pro Aufgabentyp) steht auf `0`. Sie deckelt zusätzlich jeden Aufgabentyp der Tabelle «Qualität des Sets» gegen den **exportierten** Datensatz ([finalize.js](../routes/jobs/finetune-export/finalize.js)#`balanceCap`); mit weniger als `1/Anteil` Typen ist sie nicht erfüllbar und wird übersprungen.

**Geschnitten wird nur an Satz- oder Absatzgrenzen** ([lib/text.js](../routes/jobs/finetune-export/lib/text.js) `clipAtSentence`/`tailFromSentence`/`chunkAtSentence`). Eine Antwort, die mitten im Wort endet, brächte dem Modell bei, mitten im Wort aufzuhören. Abschnitte und Absätze über `Max. Zeichen` laufen deshalb in Satzgrenzen-Teilen durch („Schreibe Teil 2 von 3 dieses Abschnitts"), statt nach 4000 Zeichen abzubrechen — so fehlt auch der Rest langer Abschnitte nicht.

**Lange Samples passen sich `Max. Token pro Sample` an.** Voll-Kapitel-, Wörtlich- und Mehrseiten-Samples werden in Slices von höchstens 60 % des Sequenz-Budgets geschnitten (4096 Tokens → rund 8000 Zeichen DE); der Rest bleibt dem Prompt. Ein fester, grösserer Slice würde genau die Samples aus dem Export filtern, die den Buchtext am vollständigsten tragen. `Lange Samples kappen` kürzt diese Slices nie — ein gekapptes „Teil 2 von 5" brächte dem Modell bei, mitten im Text aufzuhören —, sie fallen dann weg.

**Figurennamen werden als ganzes Wort gesucht, Unicode-fähig** ([lib/names.js](../routes/jobs/finetune-export/lib/names.js) `nameRegex`). JavaScripts `\b` kennt nur ASCII-Buchstaben; ein Name, der mit Umlaut oder Akzent beginnt oder endet (Ömer, René, Zoë), fände sonst nie einen Treffer, und seine Passagen, Ortsbezüge und Sprecher-Zuordnungen fielen still weg.

**Antworten im Buchton (KI-Augment, optional).** „Wer ist X?" und „Was ist Ort Y?" beantwortet das Buchwissen mit dem Beschreibungstext der Analyse. Ohne Umschreibung lernt das Modell für solche Fragen den Ton der Analyse, nicht den des Autors. Die Option **Figuren- und Ortsantworten im Buchton** fasst diese Antworten neu ([samples/ai-augment.js](../routes/jobs/finetune-export/samples/ai-augment.js)#`rewriteAnswersInBookVoice`). Als Stilvorlage dienen bis zu drei Originalabsätze, in denen die Figur bzw. der Ort vorkommt. Die Fakten bleiben gleich. Ersetzt wird die Antwort in den bestehenden Samples; es kommen keine neuen hinzu. Ein KI-Call pro Figur und Ort, gecacht wie die übrigen Augment-Calls. Leere oder ausufernde Antworten (mehr als dreimal so lang) behalten die Analyse-Antwort.

**Dialog-Zitate** erkennt [lib/text.js](../routes/jobs/finetune-export/lib/text.js)#`extractDialogs` in allen fünf Schreibweisen: „…“, “…”, »…«, «…» und ASCII-`"…"`. Sie füttern den Dialog-Typ, „Wer sagt das?" und das Sprach-Portrait pro Figur im Buchwissen; ohne erkannte Zitate fallen alle drei still weg. Die Dialogzeile als Schreibaufgabe bekommt die Sätze davor als Vorlauf und braucht mindestens 25 Zeichen. „Wer sagt das?" nimmt nur Zitate ab 30 Zeichen und 5 Wörtern, die genau einmal im Buch stehen und eindeutig einer Figur zugeordnet sind ([samples/dialog.js](../routes/jobs/finetune-export/samples/dialog.js)): «Ich weiss nicht.» ist ohne Kontext keiner Figur zuzuordnen.

**Satzgrenzen:** ein- und zweistellige Zahlen mit Punkt sind Ordnungszahlen («die 1. Klasse», «am 11. September»), kein Satzende; Jahreszahlen bleiben Satzenden ([lib/text.js](../routes/jobs/finetune-export/lib/text.js)#`isAbbreviationBefore`).

**Namen:** ein Figuren- oder Ortsname mit Unterstrichen (`cat_lady_40`) steht im Training in der Schreibweise des Buchs: wörtlich, wenn das Buch ihn so schreibt (Chat-Nicknames wie «das_unklare_abdomen»), sonst als Wortfolge ohne Zählnummer («Cat Lady»). Kennt das Buch den Namen nicht, fällt die Entität weg und steht im Job-Log ([data-loader.js](../routes/jobs/finetune-export/data-loader.js)#`cleanNames`). Reine Kennungen (`fig_129`) erscheinen nie als Name.

**Welt-Fakten (Buchwissen Block 29) sind KI-extrahiert, nicht kuratiert.** `world_facts` ist ein abgeleiteter Index der Komplettanalyse mit Full-Replace — es gibt keinen Edit-Pfad. Der Sampler ([samples/author-chat/world-facts.js](../routes/jobs/finetune-export/samples/author-chat/world-facts.js)) giesst EINEN Fakt in rund ein halbes Dutzend Samples (mehrere Frage-Paraphrasen + Sammelantwort pro Subjekt + pro Kategorie + globale Welt-Übersicht). Deshalb filtert er die Fakten heraus, die der **Weltfakten-Faktencheck** als real falsch belegt hat (SSoT [db/world-facts.js](../db/world-facts.js)#`refutedFactKeys`: Urteils-Cache `world_fact_verdicts`, abzüglich der vom Autor als „kein Fehler“ verworfenen; siehe [docs/komplett.md](komplett.md)): bei Trainingsdaten ist die Vervielfachung eines Fehlers teurer als das fehlende Sample. Lief der Faktencheck nie, wird nichts gefiltert. Der Abgleich läuft über den normalisierten Aussage-Schlüssel (`subjekt: fakt`, [lib/world-fact-key.js](../lib/world-fact-key.js)) — eine `fact_id` hinge an einem Index, den der nächste Lauf komplett ersetzt.

**Ereignisse (Buchwissen Block 6–11b)** werden einmal angereichert geladen ([samples/author-chat/event-data.js](../routes/jobs/finetune-export/samples/author-chat/event-data.js)) und von Szenen-, Ereignis- und Figuren-Block geteilt. Die Vollantwort eines Ereignisses trägt alles, was der Zeitstrahl kennt: Zeitpunkt oder Spanne, Tag der Handlung, Art und Untertyp, Handlungsstrang, beteiligte Figuren, Schauplätze, Szenen, Kapitel und Bedeutung. Abschnittsnamen fehlen bewusst: sie sind Gliederung der Werkstatt, nicht des Buchs, das Leser kennen. Die Listen werden nicht gekürzt.
- **Szene ↔ Ereignis** nur über denselben Abschnitt. Ein gemeinsames Kapitel verbände in Büchern mit wenigen grossen Kapiteln fast alles mit allem.
- **Schauplätze** eines Ereignisses sind nur Orte, deren Name im Ereignistext, in der Bedeutung oder in der Buchstelle steht. Die Szenen-Orte des Abschnitts zählen nicht: sie sind die Ortsliste des ganzen Abschnitts und hingen sonst an jedem Ereignis darin. Ein eigenes Ortsfeld hat das Ereignis nicht. In Fragen steht ein Ort als «am Schauplatz «X»» — ob «in Basel» oder «im Kantonsspital», weiss der Export nicht.
- **Buchstelle** ([event-links.js](../routes/jobs/finetune-export/samples/author-chat/event-links.js)): «Wie ist X im Buch erzählt?» antwortet mit dem Fenster im verknüpften Abschnitt, in dem beteiligte Figuren und Stichwörter am dichtesten stehen, wörtlich. «Erzähle X aus der Sicht von Y» gibt es nur mit dieser Passage als Ziel und nur für Figuren, die darin vorkommen; ebenso «Erzähle die Szene X aus der Sicht von Y» mit der Szenenpassage ([scenes.js](../routes/jobs/finetune-export/samples/author-chat/scenes.js)#`sceneExcerpt`). Ohne Passage fällt die Aufgabe weg — eine Faktenkarte als Antwort brächte dem Modell bei, eine Erzählbitte mit Stichpunkten zu beantworten.
- **Keine Kreuzprodukte:** keine Fragen Figur × Ort × Ereignis oder Facettenfragen, deren Antwort wieder die ganze Karte ist; jede Frage hat ihre eigene Antwort. Die Art des Ereignisses steht als Sprache («ein persönliches Ereignis (Geburt)»), nie als Enum-Wert.
- **Datum:** Vorrang hat die Original-Notation (`datum`), dann ein kurzes `datum_label`, dann die strukturierten Felder. Ein Label mit Auslassungszeichen oder über 60 Zeichen ist ein Textzitat der Analyse, kein Datum. «unbekannt (…)» gilt als kein Datum.
- Kurze Fakten (Kapitel, Strang, Tag) stehen als ganzer Satz, weil `pushQA` Antworten unter 20 Zeichen verwirft.

### Qualität des Sets

[finalize.js](../routes/jobs/finetune-export/finalize.js) räumt nach den Samplern auf, in dieser Reihenfolge:

1. **Keine Faktenkarte als Schreibziel.** Eine Schreibaufgabe, deren Antwort mindestens zwei Karten-Etiketten trägt («Zeitpunkt:», «Art:», «Beteiligte Figuren:» …), fliegt raus ([lib/tasks.js](../routes/jobs/finetune-export/lib/tasks.js)#`looksLikeCard`). Das ist das Schutznetz hinter den Samplern, die solche Paare gar nicht erst bauen.
2. **Antwort-Budget** (`Max. Wiederholungen je Antwort`, Standard 2): jede Assistant-Antwort steht höchstens so oft im Set, auch als Turn eines Gesprächs. Umformulierungen derselben Frage bringen kein neues Wissen, sie gewichten nur die Antwort hoch. Bevorzugt bleiben Schreibaufgaben, dann Fragen zu einer Entität, dann verschiedene Aufgabentypen. Die Sampler ziehen pro Entität höchstens zwei Frageformulierungen (`PARAPHRASES`).
3. **Fakten-Deckel** (`Max. Anteil Faktenfragen`, Standard 0.4): der Grossteil sind Schreibaufgaben mit echtem Buchtext als Ziel. Das Fakten-Budget verteilt sich gleichmässig auf die Faktentypen (`waterfillCap`): kleine Typen bleiben ganz, die grossen werden auf denselben Deckel gekappt. Innerhalb eines Typs bleiben Fragen zu einer Entität vor Sammellisten.
4. **Train/Val nach Einheiten** ([lib/split.js](../routes/jobs/finetune-export/lib/split.js)): Buchtext trennt nach **Abschnitt**, Fakten nach **Entität** (`unit`: Ereignis, Figur, Ort, Szene) mit allen Fragen dazu. Welche Abschnitte ein Sample berührt, erkennt der Split am Text (8-Wort-Folgen aus Prompt und Antwort, kurze Zitate per Teilstring), nicht am Sampler — so gilt die Regel auch für Kontext im Prompt. Ein Sample über Abschnitte aus beiden Splits fällt weg. Sammellisten über mehrere Entitäten bleiben im Train. Val-Einheiten sind ein fester Anteil (`Validation-Split`), per Hash gereiht. Val-Samples, die trotzdem Text mit Train teilen (Refrain im Buch, gleiche Kurzantwort), werden entfernt, nie Train-Samples. Danach prüft der Export: Val-Prompt wörtlich im Train, Val-Antwort wörtlich im Train, gemeinsame 12-Wort-Folge. Bleibt etwas, bricht er mit `finetune.error.splitLeak` ab — ein geschönter Eval-Loss ist schlimmer als kein Export.

Den Text der Holdout-Abschnitte sieht ein Training auf `train.jsonl` nie. Deshalb gibt es zusätzlich **`all.jsonl`** (train + val gemeinsam gemischt) für einen zweiten Lauf, siehe [§3](#3-training).

**Statistik** (`stats.quality`, Karte «Qualität des Sets» und Job-Log): Anzahl, Anteil, eigene Antworten und mittlere Antwortlänge je Aufgabentyp, Anteil Schreibaufgaben, Anteil eigener Antworten, die zehn häufigsten Antworten, die Überlappung Val ↔ Train und was jeder Schritt oben verworfen hat.

**Loss-Masking:** Trainiere über das `messages`-Feld + `train_on_responses_only` (so im CLI-Script verdrahtet; das Script rendert `messages` selbst über das Chat-Template und entfernt dabei das führende `<s>`, weil der Tokenizer es beim Tokenisieren ein zweites Mal setzt) — dann fliesst der Loss nur auf die Assistant-Tokens, User-Instruktionen/System-Prompts werden maskiert. Das `text`-Feld (`emit_text=true`) ist nur ein Fallback für Loader, die `dataset_text_field` erwarten; es kann den Prompt nicht maskieren, das Modell lernt dann auch die Instruktions-Phrasen mit.

**Downloads der Karte:** `train.jsonl`, `val.jsonl`, `all.jsonl`, dazu **Testprompts** (`eval.jsonl`, [lib/eval-prompts.js](../routes/jobs/finetune-export/lib/eval-prompts.js)) und das **Ollama-Modelfile**. Die Testprompts sind die Fragen aus [§5](#5-qualitäts-check), gefüllt mit echten Figuren-, Kapitel- und Abschnittsnamen und im Wortlaut der Trainings-Instruktionen; Fortsetzungs-Prompts kommen bevorzugt aus Holdout-Kapiteln (`holdout: true`). Das Modelfile trägt den System-Prompt des Exports wörtlich (`stats.systemPrompt`, Generator [finetune-modelfile.js](../public/js/book/finetune-modelfile.js)). Sets, die vor diesen Downloads erzeugt wurden, zeigen die Knöpfe erst nach dem nächsten Generieren.

Stats nach Generierung: p95/max Token, empfohlene `seq_len`, verworfene Samples, entfernte Dubletten, per Typ-Cap entfernte Samples, dazu die [Qualität des Sets](#qualität-des-sets). Exakte Dubletten-Entfernung und ein deterministisches Shuffle pro Split laufen immer.

**Das letzte Set bleibt gespeichert**, pro Buch und User, auf der Platte neben der Datenbank (`finetune-exports/`, überschreibbar per `FINETUNE_DIR`; [lib/store.js](../routes/jobs/finetune-export/lib/store.js)). Es überlebt Neustarts, bis der nächste Export es ersetzt. Die Karte zeigt beim Öffnen Stats und Downloads des gespeicherten Sets. Zum Set gehört ein Fingerabdruck des Buchstands: Reihenfolge, Kapitel und `updated_at` jedes Abschnitts, ausgeschlossene Kapitel nicht mitgezählt. Weicht der aktuelle Stand davon ab, erscheint eine Warnung. Neu generiert wird nur auf Klick, weil ein Export mit KI-Augmentierung Stunden dauern kann. Änderungen an Figuren, Szenen oder anderen Metadaten allein lösen die Warnung nicht aus.

Format pro Zeile:

```json
{"messages":[
  {"role":"system","content":"Du bist das Buch «…». Leserinnen und Leser sprechen mit dir …"},
  {"role":"user","content":"Wer ist Hans Meier?"},
  {"role":"assistant","content":"Hans Meier ist der Protagonist …"}
]}
```

Validieren:

```bash
wc -l train.jsonl val.jsonl
python3 -c "import json; [json.loads(l) for l in open('train.jsonl')]; print('OK')"
```

### Leser-Modell

Der Export trainiert das Buch im Gespräch, etwa für eine Webseite, auf der Leser Fragen stellen, Hintergründe erfahren und das Innenleben der Figuren ergründen. Code: [samples/reader/](../routes/jobs/finetune-export/samples/reader/).

- **Eigener System-Prompt** ([reader/system.js](../routes/jobs/finetune-export/samples/reader/system.js)): «Du bist das Buch «…». Leserinnen und Leser sprechen mit dir …». Er reist als `stats.systemPrompt` ins Modelfile und muss beim Betrieb wörtlich gesetzt sein. Die Ich-Form einer Figur hat keinen zweiten System-Prompt: Der Leser bittet im Gespräch darum («Ich möchte mit Anna sprechen»). So trägt ein einziges Modelfile beides.
- **Kein Werkstattwissen:** Lektorats-Korrekturen und -Bewertungen, Antworten aus dem Buch-Chat, Fundort eines Satzes («In welchem Abschnitt steht …»), Abschnittsnamen und der Kapitelaufbau kommen nicht in die Daten. Vor Lesern erklärte das Modell sonst die Schwächen des Buchs oder die Gliederung der Werkstatt.
- **Wörtlicher Text bleibt voll drin.** Stil, Szene, Wörtlich und Dialog laufen ungekürzt. Das Buch lässt sich damit aus dem Modell herausfragen, und das ist gewollt.
- **Innenleben** kommt aus zwei Quellen:
  - **Komplettanalyse** (Buchwissen Block 32, [author-chat/depth.js](../routes/jobs/finetune-export/samples/author-chat/depth.js)): Pro Figur werden Rolle, Motivation, Konflikt, Entwicklung (`arc` als Prosa, sonst `entwicklung`), Hintergrund, Äusseres und Sprechweise zu Fragen wie «Was treibt Stefan an?» oder «Wie verändert sich Stefan?». Mit Motivation und Konflikt zusammen kommt «Was geht in Stefan vor?» dazu. Jedes Schlüsselzitat wird wörtlich zu einer eigenen Antwort. Die Analyse-Prosa fasst **Antworten im Buchton** in die Erzählstimme um.
  - **[Figuren-Werkstatt](figur-werkstatt.md)** ([reader/psyche.js](../routes/jobs/finetune-export/samples/reader/psyche.js)): Pro Kern (Want, Need, Wound, Lie, Konflikt, Bogen) entstehen Fragen mit den Notizen des Autors als Antwort, dazu eine Übersicht ab zwei Kernen. Die Textstellen, die das Verankern gefunden hat (`draft_figure_occurrences`), werden zu eigenen Beleg-Samples («Wo zeigt sich im Buch …?»), wörtlich und mit ihrem Abschnitt gesplittet.
- **Tragende Figuren** sind alle Werkstatt-Figuren (verknüpft über die Quell-Figur oder den Namen) und die Katalog-Figuren mit Typ Hauptfigur oder Antagonist oder mit Präsenz `zentral`. Nur sie bekommen die Ich-Form, Gespräche über mehrere Runden und «Was passiert nach dem Ende?».
- **Ich-Form** ([reader/persona.js](../routes/jobs/finetune-export/samples/reader/persona.js)): Ohne KI wird jede Dialogzeile einer tragenden Figur zur Antwort auf «Sag mir etwas, wie nur du es sagen würdest». Mit der KI-Option **Figuren in der Ich-Form** kommen Leserfragen mit der Antwort der Figur dazu. Material dafür sind die Beschreibung, die Tiefe-Felder und Schlüsselzitate der Analyse, alle Werkstatt-Notizen und die Dialogzeilen der Figur. Eine Figur braucht ein Innenleben (Motivation oder Konflikt der Analyse oder Werkstatt-Notizen) oder mindestens drei Dialogzeilen. Dialogzeilen, die mit einem Satzzeichen beginnen oder einen Redebegleitsatz tragen («, sagte sie»), sind verkehrt gepaarte Anführungszeichen und fallen weg.
- **Deutungen** (KI-Option): Pro Szene mit Figuren entstehen Warum-Fragen mit einer Antwort, die die Beweggründe deutet. Als Hintergrund bekommt die KI Motivation und Konflikt der Figuren aus Analyse und Werkstatt. Ohne Szenen-Analyse läuft das pro Abschnitt, in dem eine tragende Figur vorkommt. Die Antworten zitieren Buchtext und werden darum mit ihrem Abschnitt gesplittet.
- **Belegpflicht** für beide KI-Phasen ([reader/ai.js](../routes/jobs/finetune-export/samples/reader/ai.js)): Jedes Paar braucht ein wörtliches Stück aus dem gelieferten Material, mindestens 12 Zeichen lang. [lib/quote-verify.js](../lib/quote-verify.js) prüft es dort nach; ohne Treffer fällt das Paar still weg. Eine erfundene Motivation im Ton des Buchs klänge für Leser wie Kanon. Darum gibt es keine Review-Liste, sondern diese Prüfung.
- **Grenzen** ([reader/boundaries.js](../routes/jobs/finetune-export/samples/reader/boundaries.js)): Fragen nach erfundenen Figuren und Orten beantwortet das Modell mit «gibt es in «…» nicht». Ein erfundener Name, von dem auch nur ein Wort im Buch steht, wird nicht verwendet, sonst lernte das Modell, eine echte Figur zu leugnen. Dazu kommen «Was passiert nach dem Ende?», Off-Topic-Fragen, die es freundlich zum Buch zurücklenkt, «Bist du eine KI?» (ehrlich: ein auf das Buch trainiertes Sprachmodell) und Versuche, es aus der Rolle zu bringen. Spoiler sind erlaubt: Das Modell erzählt alles.
- **Gespräche über mehrere Runden** ([reader/conversations.js](../routes/jobs/finetune-export/samples/reader/conversations.js)): Sie werden aus den fertigen Einzel-Samples zusammengesetzt, zusätzlich zu ihnen. Pro tragender Figur sind es bis zu zwei Gespräche à drei Runden. Ich-Form-Gespräche beginnen mit der Bitte um die Figur, das erste endet mit der Rückkehr zum Buch. Turns mit Buchtext aus verschiedenen Kapiteln kommen nicht ins selbe Gespräch; berührt eines trotzdem Abschnitte aus Train und Val, fällt es beim Split weg.
- **Testprompts** (`eval.jsonl`) bekommen die Kategorien `psyche`, `persona`, `why`, `unknown` und `offTopic`.

Die Samples tragen den Typ `reader`: eine eigene Zeile in den Stats und eine eigene Grösse für die Typ-Balance.

## 3. Training

Konfiguration: [docs/unsloth-config/](unsloth-config/) – Script, gepinnte Requirements, Studio-YAML, Ollama-Modelfile. Setup-/Run-Anleitung dort.

**Zwei Läufe.** Lauf 1 trainiert auf `train.jsonl` und misst an `val.jsonl`. Eval-Loss und Early-Stopping zeigen, nach wie vielen Epochen das Modell am besten generalisiert. Lauf 2 trainiert mit genau dieser Epochenzahl auf `all.jsonl`, ohne Evaluation. Erst dann kennt das fertige Modell auch die Holdout-Kapitel. Wer nur einen Lauf will, nimmt `all.jsonl` direkt mit 2 Epochen und verzichtet auf die Messung.

Kurzform CLI:

```bash
conda create -n unsloth python=3.11 -y && conda activate unsloth
pip install -r docs/unsloth-config/requirements.txt
cp ~/Downloads/{train,val,all}.jsonl docs/unsloth-config/
cd docs/unsloth-config
CUDA_VISIBLE_DEVICES=0 python train_book.py                    # Lauf 1, druckt FINAL_EPOCHS=…
FINAL_EPOCHS=1.6 CUDA_VISIBLE_DEVICES=0 python train_book.py   # Lauf 2 auf all.jsonl
```

Output am Ende: `runs/ministral3-8b-buch-final/gguf/*.gguf`.

In Ollama einbinden: das **Modelfile aus der Karte** neben die `.gguf` legen und `FROM` auf deren Dateinamen setzen.

```bash
cd runs/ministral3-8b-buch-final/gguf
cp ~/Downloads/Modelfile .
ollama create buch-leser -f Modelfile
ollama run buch-leser "Worum geht es in dir?"
```

**Nicht als Provider der App eintragen.** Ein globales `OLLAMA_MODEL=buch-leser` schickte jeden KI-Job der App über das Buch-Modell, auch Lektorat und Komplettanalyse, die JSON verlangen. Das Modell ist auf Prosa und einen festen System-Prompt trainiert; dort leiden die Ergebnisse. KI-Profile ([docs/ai-providers.md](ai-providers.md)) gelten pro User, nicht pro Job, also lässt sich das auch nicht auf einen einzelnen Job beschränken. Das Buch-Modell läuft direkt in Ollama (CLI, Open WebUI oder ein anderer Chat-Client).

## 4. Hyperparameter nach Ziel

| Ziel | `r` | `lr` | Epochen | Inferenz-Temp |
|---|---|---|---|---|
| Stilimitation (leicht) | 16 | 2e-4 | 1–2 | 0.7–0.8 |
| **Welt internalisieren (Default)** | **32** | **2e-4** | **2** | **0.7–0.85** |
| Faktenwiedergabe | 64 | 1e-4 | 3 | 0.4–0.6 |
| Figuren-Persona | 32 | 2e-4 | 2 | 0.85–1.0 |

**Trainingsprofile** (Basismodell × GPU-Speicher, QLoRA). Die Karte bietet sie als Auswahl **Profil** an: die Wahl setzt `Max. Token pro Sample` und `Max. Zeichen`, und **studio-config.yaml herunterladen** liefert die passende Studio-Konfiguration (Abschnitte `training`/`lora`/`logging`; `max_seq_length` folgt dem aktuellen `Max. Token pro Sample`). Quelle der Werte: [finetune-profiles.js](../public/js/book/finetune-profiles.js); die kommentierte [studio-config.yaml](unsloth-config/studio-config.yaml) ist das Default-Profil, beides gegated durch [finetune-profiles.test.mjs](../tests/unit/finetune-profiles.test.mjs).

| Modell | GPU | `batch` | `accum` | `seq_len` | `r` |
|---|---|---|---|---|---|
| Ministral 3 8B | 16 GB | 1 | 16 | 4096 | 32 |
| Ministral 3 8B | 20 GB | 2 | 8 | 4096 | 32 |
| Ministral 3 8B | 24 GB | 2 | 8 | 8192 | 64 |
| Mistral Small 3.2 24B | 20 GB | 1 | 16 | 4096 | 32 |

Default: Ministral 3 8B auf 20 GB. Effektive Batch ist überall 16; `lora_alpha` = `r`.

## 5. Qualitäts-Check

Automatisch: **Testprompts herunterladen** (`eval.jsonl`) und an Basismodell und trainiertes Modell schicken:

```bash
python docs/unsloth-config/compare_models.py eval.jsonl ministral-3:8b buch-leser
```

Von Hand: System-Prompt **identisch zum Training** setzen (das Modelfile der Karte tut das schon):

```
Du bist das Buch «‹Buchtitel›». Leserinnen und Leser sprechen mit dir über deine
Geschichte, deine Welt und deine Figuren. Antworte im Ton des Buchs und aus seiner
Welt heraus. Möchte jemand mit einer deiner Figuren sprechen, antwortest du als
diese Figur in der Ich-Form.
```

Tests:

1. Weltfakten: „Wer ist {Hauptfigur}?"
2. Relation: „Wie steht {A} zu {B}?"
3. Szenen-Recall: „Was passiert in Kapitel «X»?"
4. Stil-Fortsetzung aus Kapitel-Anfang.
5. Neues Kapitel mit zwei Figuren generieren.
6. Ich-Form: „Ich möchte mit {Hauptfigur} sprechen." und eine Frage an sie.
7. Grenze: „Wer ist {erfundener Name}?" → „gibt es nicht".

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| OOM | `seq_len=2048`, `batch=1`, `accum=16` |
| Eval-Loss steigt früh | LR halbieren (2e-4 → 1e-4) |
| Repetitive Inferenz | `repetition_penalty=1.05–1.15` |
| Figuren halluziniert | mehr `authorChat`-Samples, +1 Epoche |
| Klingt wie Standard-Mistral | `r` ↑ (32 → 48), +1 Epoche |
| Kopiert Buch wörtlich | Epochen ↓, `lora_dropout=0.05` |
| Antwortet auf Englisch | Modelfile aus der Karte verwenden (System-Prompt wörtlich) |
| Kennt Holdout-Kapitel nicht | Lauf 2 auf `all.jsonl` ([§3](#3-training)) |
| Antwortet auf Figurenfragen im Analyse-Ton | Export mit **Figuren- und Ortsantworten im Buchton** |
| Satz mitten abgeschnitten | Export mit `max_seq_tokens=4096` neu |

## 7. Links

- [Unsloth-Docs](https://docs.unsloth.ai)
- [Unsloth: Ministral 3](https://unsloth.ai/docs/models/ministral-3)
- [Ministral-3-8B-Modellkarte](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512)
- [Unsloth-Variante](https://huggingface.co/unsloth/Ministral-3-8B-Instruct-2512-unsloth-bnb-4bit)
- [TRL SFTTrainer](https://huggingface.co/docs/trl/sft_trainer)
