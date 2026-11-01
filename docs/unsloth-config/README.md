# Unsloth-Training-Config

Scripts zum Training von **Ministral-3-8B-Instruct-2512** auf JSONL-Exports der Fine-Tuning-Karte. Optimiert für **1× RTX 4000 Ada (20 GB)**; für andere GPU-Grössen Batch, `seq_len` und `r` aus den [Trainingsprofilen](../finetuning.md#4-hyperparameter-nach-ziel) übernehmen.

Für Studio liefert die Karte die Konfiguration direkt: Profil wählen → **studio-config.yaml herunterladen**. Die Datei hier ist dieselbe Konfiguration für das Default-Profil, mit Erklärungen.

Zwei Wege:

- **Unsloth Studio** (UI, kein Python-Setup) – siehe [Studio-Route](#unsloth-studio).
- **CLI** – Script [`train_book.py`](train_book.py), Training + Merge + GGUF-Export in einem.

## Inhalt

| Datei | Zweck |
|---|---|
| [`studio-config.yaml`](studio-config.yaml) | YAML-Import für Unsloth Studio (Studio-Key-Schema) |
| [`train_book.py`](train_book.py) | CLI-Script: Training, Merge, GGUF |
| [`requirements.txt`](requirements.txt) | Gepinnte Versionen (CLI-Pfad) |
| [`Modelfile.example`](Modelfile.example) | Ollama-Modelfile (Muster; die Karte liefert es mit dem System-Prompt deines Buchs) |
| [`compare_models.py`](compare_models.py) | Testprompts (`eval.jsonl`) an zwei Ollama-Modelle schicken, Antworten vergleichen |
| [`token_factor.py`](token_factor.py) | Token-Schätzung des Exports gegen den echten Tekken-Tokenizer messen, schreibt `tokenEstimateError` in die Statistik-Datei |

## Setup

```bash
conda create -n unsloth python=3.11 -y
conda activate unsloth
pip install -r requirements.txt
```

Voraussetzung: CUDA 12.1+, GPU sichtbar (`python -c "import torch; print(torch.cuda.is_available())"` → `True`).

## Daten

Export aus der UI mit:

- Alle sechs Typen aktiv (Liste → [finetuning.md §2](../finetuning.md#2-daten-exportieren)).
- `Max. Token pro Sample = 4096`.
- `Vorgerendertes text-Feld = aus` (Studio/Script rendern selbst).

`train.jsonl`, `val.jsonl` und `all.jsonl` in diesen Ordner legen. `all.jsonl` (train + val) ist für den zweiten Lauf, der die Holdout-Kapitel mitlernt ([finetuning.md §3](../finetuning.md#3-training)).

## Unsloth Studio

### Variante A: YAML-Import

1. Studio installieren (bzw. aktualisieren — gleicher Befehl) und starten:
   ```bash
   curl -fsSL https://unsloth.ai/install.sh | sh
   unsloth studio --host 0.0.0.0 --port 8888
   ```
   `http://localhost:8888` öffnen.
2. **Model-Tab:** `unsloth/Ministral-3-8B-Instruct-2512-unsloth-bnb-4bit`, Method **QLoRA**. Zuerst das Modell wählen: die Wahl lädt Studios Modell-Defaults und überschreibt einen vorher importierten Stand.
3. **Dataset-Tab:** `train.jsonl` hochladen, `val.jsonl` als Eval-File (Format `messages`). Ohne Eval-File keine Eval-Kurve und kein Early-Stopping.
4. **Training & Config:** **Import YAML** → die aus der Karte heruntergeladene `studio-config.yaml` (oder [`studio-config.yaml`](studio-config.yaml) hier fürs Default-Profil).
5. Prüfen: `train_on_completions` **an** (wichtig – ohne verwässert der Stil), Sample Packing **aus** (Studios Default für Chat-Modelle ist an), Vision layers **aus**.
6. **Start.** Erwartung: `eval_loss` fällt in ~500 Steps auf 1.4–1.8. Early-Stopping (Patience 3) stoppt bei Plateau und schreibt am Ende die Gewichte der besten Evaluation zurück.
7. **Zweiter Lauf:** neues Training mit `all.jsonl` als Dataset, **ohne** Eval-File, Epochen = Epoche der besten Evaluation aus Lauf 1 (an der `eval_loss`-Kurve ablesen). Erst so lernt das Modell auch die Holdout-Kapitel.
8. **Export → GGUF Q5_K_M.**

Studio nutzt eigene Key-Namen (nicht HuggingFace TrainingArguments). Falsche Keys werden **stumm ignoriert**:

| HF-/Axolotl | Studio |
|---|---|
| `train_on_responses_only` | `train_on_completions` |
| `warmup_ratio` | `warmup_steps` (absolut; `warmup_ratio` nur bei `max_steps` > 0) |
| `load_best_model_at_end` + `EarlyStoppingCallback` | `early_stopping_patience` |
| `num_train_epochs` | `num_epochs` |
| `per_device_train_batch_size` | `batch_size` |
| `seed` | `random_seed` |
| `lora.r` | `lora.lora_r` |

### Variante B: GUI manuell

**Dataset:** Upload `train.jsonl` + `val.jsonl`. Basemodell `unsloth/Ministral-3-8B-Instruct-2512-unsloth-bnb-4bit`, Method QLoRA.

**Parameters:**

| Feld | Wert |
|---|---|
| Use Epochs | 2 |
| Context Length | 4096 |
| Learning Rate | 0.0002 |

**LoRA:** Rank 32, Alpha 32, Dropout 0, alle sieben Target-Module aktiv.

**Optimization:** AdamW 8-bit, Cosine, Batch 2, Grad Accum 8, Weight Decay 0.01.

**Schedule:** Warmup Steps 20.

**Evaluation:** Eval Steps 200, Early Stopping Patience 3, Save Steps 400.

**Memory:** bf16, Gradient Checkpointing **an**, Sample Packing **aus**.

**Train on Completions:** **an**.

**Ministral-3 Layer-Auswahl (Advanced):**

- Vision layers **aus** (Pixtral-Encoder ohne Bilddaten – sonst Korruption).
- Language layers **an**, Attention **an**, MLP **an**.

**Export:** GGUF Q5_K_M.

## Run: Single-GPU CLI

```bash
cd docs/unsloth-config
CUDA_VISIBLE_DEVICES=0 python train_book.py                    # Lauf 1: train + val
FINAL_EPOCHS=1.6 CUDA_VISIBLE_DEVICES=0 python train_book.py   # Lauf 2: all.jsonl
```

Lauf 1 endet mit `FINAL_EPOCHS=…` (Epoche der besten Evaluation); diesen Wert für Lauf 2 übernehmen. Lauf 2 schreibt nach `runs/ministral3-8b-buch-final/`.

GPU 1 bleibt frei für paralleles Ollama (`CUDA_VISIBLE_DEVICES=1 ollama serve`).

**Laufzeit:** ~30 000 Samples, seq_len 4096, 2 Epochen → 6–10 h.

**Monitoring:** `tensorboard --logdir runs/ministral3-8b-buch`. Wichtige Kurve `eval/loss`. Start ~1.8–2.4 → 500–1500 Steps → ~1.1–1.5 → stabilisiert. Steigt eval/loss → Early-Stopping (Callback aktiv, stoppt nach 3 Plateaus).

**Ausgabe:**

```
runs/ministral3-8b-buch-final/      # Lauf 2; Lauf 1 liegt in runs/ministral3-8b-buch/
├── checkpoint-XXXX/   # max. 3 (save_total_limit)
├── adapter/           # LoRA (~180 MB)
├── merged/            # bf16 (~17 GB)
└── gguf/
    └── *.Q5_K_M.gguf  # ~6 GB
```

## In Ollama einbinden

In der Karte **Ollama-Modelfile herunterladen**: es trägt den System-Prompt aus dem Training wörtlich. Neben die `.gguf` legen, `FROM` auf deren Namen setzen (`ls *.gguf`):

```bash
cd runs/ministral3-8b-buch-final/gguf
cp ~/Downloads/Modelfile .
ollama create buch-leser -f Modelfile
ollama run buch-leser "Worum geht es in dir?"
```

Vergleich mit dem Basismodell auf den Testprompts der Karte (`eval.jsonl`):

```bash
python compare_models.py ~/Downloads/eval.jsonl ministral-3:8b buch-leser
```

Das Buch-Modell **nicht** als Provider der schreibwerkstatt-App eintragen (`OLLAMA_MODEL`): dann liefe jeder KI-Job darüber, auch Lektorat und Komplettanalyse, die JSON verlangen. Begründung: [finetuning.md §3](../finetuning.md#3-training).

## Run: Multi-GPU DDP (optional, unofficial)

Unsloth-OSS unterstützt Multi-GPU nicht offiziell, DDP funktioniert in der Praxis. Bei 2 GPUs `ACCUM` im Script von 8 auf 4 senken (effektive Batch bleibt 16).

```bash
accelerate launch \
    --num_processes 2 \
    --num_machines 1 \
    --mixed_precision bf16 \
    train_book.py
```

Speed-Up ~1.7× (PCIe-Sync-Overhead).

## Troubleshooting

### OOM

1. `BATCH = 1`, `ACCUM = 16` im Script.
2. `MAX_SEQ = 2048` im Script, Export neu mit `max_seq_tokens=2048`.
3. `r=16, alpha=16` (statt 32/32).

### `[INST] not found in tokens`

Chat-Template passt nicht. Check:

```python
print(tokenizer.apply_chat_template(
    [{"role": "user", "content": "test"}], tokenize=False))
```

Soll `[INST]test[/INST]` enthalten (davor `<s>[SYSTEM_PROMPT]…[/SYSTEM_PROMPT]` — ohne eigene System-Nachricht setzt Ministral 3 seinen Default-System-Prompt ein). Sonst `instruction_part`/`response_part` im Script anpassen.

### `ModuleNotFoundError: triton` / Modell lädt nicht

Unsloth und `unsloth_zoo` auf den neuesten Stand bringen (Ministral-3-Support kommt über `unsloth_zoo`):

```bash
pip install --upgrade --force-reinstall --no-cache-dir --no-deps unsloth unsloth_zoo
```

`KeyError`/`Unrecognized configuration` beim Laden heisst: `transformers` < 5 installiert — Ministral 3 braucht v5.

### GGUF-Export hängt

`save_pretrained_gguf` baut llama.cpp aus Source (~5 min, braucht `cmake` + `g++`). Alternative: GGUF-Zeile auskommentieren, später manuell via `convert_hf_to_gguf.py`.

### Eval-Loss fällt nicht

- LR halbieren (2e-4 → 1e-4).
- `r` erhöhen (32 → 48/64).
- `train_on_responses_only` aktiv?

### Klingt wie vorher

- `num_train_epochs = 3`.
- Datensatz < 5000 Samples → kaum messbarer Effekt.
- Komplettanalyse vorher gelaufen, alle Export-Typen aktiv?

## Aufräumen

```bash
rm -rf runs/ministral3-8b-buch runs/ministral3-8b-buch-final/checkpoint-*   # Lauf 1 komplett, Lauf-2-Checkpoints
rm -rf runs/ministral3-8b-buch-final/merged   # nur bei reinem Ollama-Einsatz
```
