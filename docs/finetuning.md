# Fine-Tuning auf den Exportdaten

Vom JSONL-Export der Fine-Tuning-Karte zu einem lokal laufenden Modell, das Stil, Welt und Figuren des Buchs internalisiert.

**Pfad:** [Unsloth](https://github.com/unslothai/unsloth) + QLoRA mit Mistral-Small-3.2-24B als Basis. Web-UI ([Unsloth Studio](https://studio.unsloth.ai)) oder CLI-Script ([train_book.py](unsloth-config/train_book.py)). Optimiert für 1× RTX 4000 Ada (20 GB).

## 1. Modell und Hardware

**Basemodell:** `unsloth/Mistral-Small-3.2-24B-Instruct-2506-unsloth-bnb-4bit`. Native DE-Kompetenz, 128 k Context, `[INST]`/`[/INST]`-Template (Tekken-V7), GGUF-Export für Ollama.

**Hardware:** 20 GB VRAM reichen für QLoRA mit:

- `max_seq_length = 4096` (bei OOM: 2048)
- `per_device_train_batch_size = 1`
- `gradient_accumulation_steps = 16` → effektive Batch 16
- VRAM-Peak ~17–19 GB

## 2. Daten exportieren

UI → Buch → Kachel **Fine-Tuning-Export**:

- Alle Typen aktiv: `Stil`, `Szene`, `Wörtlich`, `Dialog`, `Autor-Chat`, `Korrekturen`.
- `Min. Zeichen = 200`, `Max. Zeichen = 4000`.
- `Validation-Split = 0.05` (> 20 000 Samples), sonst `0.1`.
- `Max. Token pro Sample = 4096`.
- `Vorgerendertes text-Feld` optional.
- `Typ-Balance` (Max. Anteil pro Typ) optional — `0` lässt die Rohmischung, `0.4`–`0.5` deckelt die volumenstarken Text-Sampler, damit Autor-Chat/KI-Q&A (Welt- und Figurenwissen) nicht untergehen. Der Anteil gilt gegen den **exportierten** Datensatz, also nach dem Kappen ([finalize.js](../routes/jobs/finetune-export/finalize.js)#`balanceCap`). Mit weniger als `1/Anteil` aktiven Typen ist er nicht erfüllbar und wird übersprungen.

**Lange Samples passen sich `Max. Token pro Sample` an.** Voll-Kapitel-, Wörtlich- und Mehrseiten-Samples werden in Slices von höchstens 60 % des Sequenz-Budgets geschnitten (4096 Tokens → rund 8000 Zeichen DE); der Rest bleibt dem Prompt. Ein fester, grösserer Slice würde genau die Samples aus dem Export filtern, die den Buchtext am vollständigsten tragen. `Lange Samples kappen` kürzt diese Slices nie — ein gekapptes „Teil 2 von 5" brächte dem Modell bei, mitten im Text aufzuhören —, sie fallen dann weg.

**Korrekturen sind nur übernommene Lektorats-Befunde** (`page_checks.applied_errors_json`), nicht jeder KI-Vorschlag. Abgelehnte Vorschläge als Autor-Prosa zu trainieren, hiesse dem Modell genau die Formulierungen beizubringen, gegen die sich der Autor entschieden hat.

**Echte Buch-Chat-Antworten mit Daumen runter fallen weg.** Autor-Chat übernimmt die (Frage, Antwort)-Paare aus Buch-Chat-Sessions ([samples/author-chat/reviews.js](../routes/jobs/finetune-export/samples/author-chat/reviews.js)); trägt die Antwort `chat_messages.feedback = -1` (siehe [docs/chats.md](chats.md)), entfällt das Paar. Unbewertete Antworten bleiben drin — die meisten bewertet niemand, ein Export nur aus Daumen-hoch-Antworten wäre fast leer. Gleiche Begründung wie bei den Korrekturen: was der Autor verworfen hat, soll das Modell nicht als seine Stimme lernen.

**Dialog-Zitate** erkennt [lib/text.js](../routes/jobs/finetune-export/lib/text.js)#`extractDialogs` in allen fünf Schreibweisen: „…“, “…”, »…«, «…» und ASCII-`"…"`. Sie füttern den Dialog-Typ, „Wer sagt das?" und das Sprach-Portrait pro Figur im Autor-Chat; ohne erkannte Zitate fallen alle drei still weg.

**Welt-Fakten (Autor-Chat Block 29) sind KI-extrahiert, nicht kuratiert.** `world_facts` ist ein abgeleiteter Index der Komplettanalyse mit Full-Replace — es gibt keinen Edit-Pfad. Der Sampler ([samples/author-chat/world-facts.js](../routes/jobs/finetune-export/samples/author-chat/world-facts.js)) giesst EINEN Fakt in rund ein halbes Dutzend Samples (mehrere Frage-Paraphrasen + Sammelantwort pro Subjekt + pro Kategorie + globale Welt-Übersicht). Deshalb filtert er die Fakten heraus, die der **Weltfakten-Faktencheck** (`typ='faktenfehler'` in `continuity_issues`, siehe [docs/komplett.md](komplett.md)) als real falsch belegt hat: bei Trainingsdaten ist die Vervielfachung eines Fehlers teurer als das fehlende Sample. Lief der Faktencheck nie, wird nichts gefiltert. Der Abgleich läuft über den normalisierten Text (`subjekt: fakt`) — der Befund trägt keine `fact_id`, und eine einzuführen hiesse, sie an einen Index zu hängen, den der nächste Lauf komplett ersetzt.

**Train/Val wird pro Kapitel gesplittet:** alle Samples eines Kapitels, deren Antwort Buchtext wiedergibt (Stil, Szene, Wörtlich, Dialog inkl. „Wer sagt das?", Figur-Passagen, Sprach-Portrait pro Figur und Kapitel), landen gemeinsam in `train` **oder** `val`. So ist `val` ein echtes Holdout — der Eval-Loss misst Generalisierung statt auswendig gelernten Trainingstext, und `load_best_model_at_end`/EarlyStopping (siehe [train_book.py](unsloth-config/train_book.py)) wählen sinnvoll aus. Fakten-Q&A und Korrekturen splitten per Sample (sie geben keinen zusammenhängenden Buchtext wieder). Konsequenz: bei sehr wenigen Kapiteln kann der Val-Anteil schwanken (ggf. `Validation-Split` erhöhen).

**Loss-Masking:** Trainiere über das `messages`-Feld + `train_on_responses_only` (so im CLI-Script verdrahtet; das Script rendert `messages` selbst über das Chat-Template und entfernt dabei das führende `<s>`, weil der Tokenizer es beim Tokenisieren ein zweites Mal setzt) — dann fliesst der Loss nur auf die Assistant-Tokens, User-Instruktionen/System-Prompts werden maskiert. Das `text`-Feld (`emit_text=true`) ist nur ein Fallback für Loader, die `dataset_text_field` erwarten; es kann den Prompt nicht maskieren, das Modell lernt dann auch die Instruktions-Phrasen mit.

Stats nach Generierung: p95/max Token, empfohlene `seq_len`, verworfene Samples, entfernte Dubletten, per Typ-Cap entfernte Samples. Exakte Dubletten-Entfernung und ein deterministisches Shuffle pro Split laufen immer.

Format pro Zeile:

```json
{"messages":[
  {"role":"system","content":"Du bist die Stimme von «…». Schreibe, setze fort und antworte …"},
  {"role":"user","content":"Wer ist Hans Meier?"},
  {"role":"assistant","content":"Hans Meier ist der Protagonist …"}
]}
```

Validieren:

```bash
wc -l train.jsonl val.jsonl
python3 -c "import json; [json.loads(l) for l in open('train.jsonl')]; print('OK')"
```

## 3. Training

Konfiguration: [docs/unsloth-config/](unsloth-config/) – Script, gepinnte Requirements, Studio-YAML, Ollama-Modelfile. Setup-/Run-Anleitung dort.

Kurzform CLI:

```bash
conda create -n unsloth python=3.11 -y && conda activate unsloth
pip install -r docs/unsloth-config/requirements.txt
cp ~/Downloads/{train,val}.jsonl docs/unsloth-config/
cd docs/unsloth-config
CUDA_VISIBLE_DEVICES=0 python train_book.py
```

Output am Ende: `runs/mistral-small32-buch/gguf/*.gguf`.

In Ollama einbinden:

```bash
cd runs/mistral-small32-buch/gguf
ollama create buch-autor -f ../../../Modelfile.example
ollama run buch-autor "Schreibe den Anfang eines neuen Kapitels."
```

## 4. Hyperparameter nach Ziel

| Ziel | `r` | `lr` | Epochen | Inferenz-Temp |
|---|---|---|---|---|
| Stilimitation (leicht) | 16 | 2e-4 | 1–2 | 0.7–0.8 |
| **Welt internalisieren (Default)** | **32** | **2e-4** | **2** | **0.7–0.85** |
| Faktenwiedergabe | 64 | 1e-4 | 3 | 0.4–0.6 |
| Figuren-Persona | 32 | 2e-4 | 2 | 0.85–1.0 |

VRAM-Matrix (Mistral-Small-3.2-24B QLoRA):

| VRAM | `batch` | `accum` | `seq_len` | `r` |
|---|---|---|---|---|
| 16 GB | 1 | 16 | 2048 | 16 |
| **20 GB** | **1** | **16** | **4096** | **32** |
| 24 GB | 1 | 16 | 4096 | 32 |
| 40+ GB | 2 | 8 | 8192 | 64 |

## 5. Qualitäts-Check

System-Prompt **identisch zum Training** setzen:

```
Du bist die Stimme von «‹Buchtitel›». Schreibe, setze fort und antworte im Stil
des Autors und aus der Welt dieses Buchs heraus.
```

Tests:

1. Weltfakten: „Wer ist {Hauptfigur}?"
2. Relation: „Wie steht {A} zu {B}?"
3. Szenen-Recall: „Was passiert in Kapitel «X»?"
4. Stil-Fortsetzung aus Kapitel-Anfang.
5. Neues Kapitel mit zwei Figuren generieren.
6. Reverse-Lookup: „In welchem Abschnitt steht dieser Satz: ‹Satz›"

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| OOM | `seq_len=2048`, `batch=1`, `accum=16` |
| Eval-Loss steigt früh | LR halbieren (2e-4 → 1e-4) |
| Repetitive Inferenz | `repetition_penalty=1.05–1.15` |
| Figuren halluziniert | mehr `authorChat`-Samples, +1 Epoche |
| Klingt wie Standard-Mistral | `r` ↑ (32 → 48), +1 Epoche |
| Kopiert Buch wörtlich | Epochen ↓, `lora_dropout=0.05` |
| Antwortet auf Englisch | System-Prompt im Modelfile setzen |
| Satz mitten abgeschnitten | Export mit `max_seq_tokens=4096` neu |

## 7. Links

- [Unsloth-Docs](https://docs.unsloth.ai)
- [Mistral-Small-3.2-Modellkarte](https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506)
- [Unsloth-Variante](https://huggingface.co/unsloth/Mistral-Small-3.2-24B-Instruct-2506-unsloth-bnb-4bit)
- [TRL SFTTrainer](https://huggingface.co/docs/trl/sft_trainer)
