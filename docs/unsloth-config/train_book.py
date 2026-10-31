"""
Unsloth-QLoRA-Training für Ministral-3-8B-Instruct-2512 auf den
Fine-Tuning-Export-Daten.

Zielumgebung: 1× RTX 4000 Ada (20 GB VRAM). Single-GPU. Die zweite Karte im
System bleibt für Inferenz/Evaluation frei.

VRAM-Profil: 8.4B Sprachmodell + 0.4B Vision-Encoder in bnb-4bit belegen
~6 GB; mit `batch_size=2`, `gradient_accumulation_steps=8` und seq_len 4096
liegt der Peak bei ~12–15 GB. Bei OOM: `BATCH` auf 1 und `ACCUM` auf 16.

Einsatz (zwei Läufe):
    conda activate unsloth
    # 1) mit Holdout: Eval-Loss + Early-Stopping finden die beste Epochenzahl,
    #    das Script druckt sie am Ende als FINAL_EPOCHS=…
    CUDA_VISIBLE_DEVICES=0 python train_book.py
    # 2) auf all.jsonl (train + val), ohne Eval, mit genau dieser Zahl —
    #    sonst kennt das fertige Modell die Holdout-Kapitel nicht
    FINAL_EPOCHS=1.6 CUDA_VISIBLE_DEVICES=0 python train_book.py

Erwartete Dateien im selben Ordner:
    train.jsonl   # aus UI-Export
    val.jsonl     # aus UI-Export
    all.jsonl     # aus UI-Export, nur für Lauf 2

Ergebnis am Ende (Lauf 2 unter runs/ministral3-8b-buch-final/):
    runs/ministral3-8b-buch/adapter/        # LoRA-Adapter (klein)
    runs/ministral3-8b-buch/merged/         # bf16-Merge (~17 GB)
    runs/ministral3-8b-buch/gguf/*.gguf     # Q5_K_M für Ollama (~6 GB)


Tokenizer-Hinweis: Ministral 3 nutzt Tekken (Mistral-Common >= 1.8.6). Das
Chat-Template rendert System-Prompts in [SYSTEM_PROMPT]/[/SYSTEM_PROMPT] und
User-Turns in [INST]/[/INST] — der `train_on_responses_only`-Wrapper unten
validiert das via Probe. Fehlt im Sample die System-Nachricht, setzt das
Template Mistrals Default-System-Prompt ein; der Export liefert sie immer mit.
"""

import os

from unsloth import FastModel
from unsloth.chat_templates import train_on_responses_only
from datasets import load_dataset
from trl import SFTTrainer, SFTConfig
from transformers import EarlyStoppingCallback

# ─────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────

MODEL       = "unsloth/Ministral-3-8B-Instruct-2512-unsloth-bnb-4bit"
MAX_SEQ     = 4096               # matcht finetune-export Empfehlung; bei OOM auf 2048
BATCH       = 2                  # effektive Batch = BATCH × ACCUM = 16
ACCUM       = 8
OUT_DIR     = "runs/ministral3-8b-buch"

# Lauf 2: FINAL_EPOCHS gesetzt → all.jsonl, keine Evaluation, feste Epochen.
FINAL_EPOCHS = float(os.environ["FINAL_EPOCHS"]) if os.environ.get("FINAL_EPOCHS") else None
if FINAL_EPOCHS is not None:
    OUT_DIR = f"{OUT_DIR}-final"

TRAIN_FILE  = "all.jsonl" if FINAL_EPOCHS is not None else "train.jsonl"
EVAL_FILE   = None if FINAL_EPOCHS is not None else "val.jsonl"

# ─────────────────────────────────────────────────────────────────────────
# Modell + Tokenizer (4-bit)
# Ministral 3 ist ein Mistral3ForConditionalGeneration (Sprachmodell +
# Pixtral-Vision-Encoder). FastModel wählt den passenden Loader selbst und
# liefert einen Processor zurück; für reines Text-Training wird unten dessen
# Text-Tokenizer benutzt.
# ─────────────────────────────────────────────────────────────────────────

model, processor = FastModel.from_pretrained(
    model_name      = MODEL,
    max_seq_length  = MAX_SEQ,
    load_in_4bit    = True,
    full_finetuning = False,
    dtype           = None,       # auto bf16 auf Ampere+/Ada
)
tokenizer = getattr(processor, "tokenizer", processor)   # Processor → Text-Tokenizer

# ─────────────────────────────────────────────────────────────────────────
# LoRA-Adapter
# r=32 ist der Sweet-Spot für "Buchwelt internalisieren" — genug Kapazität
# für Figuren/Orte/Beziehungen, ohne zu overfitten.
# alpha == r ist die Unsloth-Empfehlung.
#
# Vision-Layer bleiben eingefroren: ohne Bilddaten im Datensatz würden sie
# nur VRAM kosten und die Bildverarbeitung des Modells beschädigen.
# ─────────────────────────────────────────────────────────────────────────

model = FastModel.get_peft_model(
    model,
    finetune_vision_layers     = False,
    finetune_language_layers   = True,
    finetune_attention_modules = True,
    finetune_mlp_modules       = True,
    r                          = 32,
    lora_alpha                 = 32,
    lora_dropout               = 0,    # Unsloth-patched: 0 = schnellste Variante
    bias                       = "none",
    use_gradient_checkpointing = "unsloth",
    random_state               = 42,
    use_rslora                 = False,
    loftq_config               = None,
)

# ─────────────────────────────────────────────────────────────────────────
# Daten
# ─────────────────────────────────────────────────────────────────────────

train_ds = load_dataset("json", data_files=TRAIN_FILE, split="train")
eval_ds  = load_dataset("json", data_files=EVAL_FILE,  split="train") if EVAL_FILE else None

# Wenn der Export mit emit_text=true erzeugt wurde, existiert bereits ein
# text-Feld. Wir überschreiben es und rendern konsistent über die Chat-Template-
# Funktion des Tokenizers — das ist robuster gegen Template-Änderungen.
#
# BOS: das Chat-Template beginnt bereits mit <s>, und der Tokenizer setzt beim
# Tokenisieren selbst noch eines davor → jede Sequenz begänne mit <s><s>, was
# Mistral in der Inferenz nie sieht. Deshalb das führende <s> aus dem Template
# entfernen — aber nur, wenn der Tokenizer es wirklich selbst ergänzt (sonst
# fehlte es ganz).
_bos = tokenizer.bos_token or ""
_tok_adds_bos = bool(_bos) and tokenizer("x").input_ids[:1] == [tokenizer.bos_token_id]

def render(messages):
    text = tokenizer.apply_chat_template(
        messages,
        tokenize               = False,
        add_generation_prompt  = False,
    )
    if _tok_adds_bos and text.startswith(_bos):
        text = text[len(_bos):]
    return text

train_ds = train_ds.map(lambda ex: {"text": render(ex["messages"])})
if eval_ds is not None:
    eval_ds = eval_ds.map(lambda ex: {"text": render(ex["messages"])})

_ids = tokenizer(train_ds[0]["text"]).input_ids
assert _ids[0] == tokenizer.bos_token_id and _ids[1] != tokenizer.bos_token_id, (
    f"BOS-Handling stimmt nicht — Sequenz beginnt mit {_ids[:3]}"
)

# ─────────────────────────────────────────────────────────────────────────
# Trainer
# packing=False: erhält Sample-Grenzen. Wichtig für pageCont/chapTrans-Samples
# im Export — Packing würde zwei unabhängige Fortsetzungen in eine Sequenz
# mischen und die Boundary-Semantik brechen.
# ─────────────────────────────────────────────────────────────────────────

trainer = SFTTrainer(
    model            = model,
    tokenizer        = tokenizer,
    train_dataset    = train_ds,
    eval_dataset     = eval_ds,
    args = SFTConfig(
        output_dir                   = OUT_DIR,
        dataset_text_field           = "text",
        max_length                   = MAX_SEQ,
        packing                      = False,
        per_device_train_batch_size  = BATCH,
        gradient_accumulation_steps  = ACCUM,
        num_train_epochs             = FINAL_EPOCHS or 2,
        learning_rate                = 2e-4,
        warmup_ratio                 = 0.03,
        lr_scheduler_type            = "cosine",
        bf16                         = True,
        fp16                         = False,
        # adamw_8bit halbiert den Optimizer-State-VRAM.
        optim                        = "adamw_8bit",
        weight_decay                 = 0.01,
        max_grad_norm                = 1.0,
        logging_steps                = 20,
        eval_strategy                = "steps" if eval_ds is not None else "no",
        eval_steps                   = 200,
        save_strategy                = "steps",
        save_steps                   = 400,
        save_total_limit             = 3,
        load_best_model_at_end       = eval_ds is not None,
        metric_for_best_model        = "eval_loss",
        greater_is_better            = False,
        seed                         = 42,
        report_to                    = "tensorboard",
        dataloader_num_workers       = 2,
    ),
    callbacks = [EarlyStoppingCallback(early_stopping_patience=3)] if eval_ds is not None else [],
)

# ─────────────────────────────────────────────────────────────────────────
# KRITISCH: Loss nur auf Assistant-Tokens.
# Ohne diesen Wrapper lernt das Modell auch aus unseren System-Prompts und
# User-Fragen → Stil verwässert, Paraphrasen aus authorChat werden fälschlich
# als "Produktion" gelernt statt als "Eingabe".
#
# Marker müssen exakt zum Chat-Template von Ministral 3 passen: User-Turns in
# [INST]/[/INST], System-Prompts in [SYSTEM_PROMPT]/[/SYSTEM_PROMPT] (stören
# das Masking nicht). Probe direkt aus dem Tokenizer, damit ein späteres
# Template-Update früh knallt statt stumm zu maskieren.
# ─────────────────────────────────────────────────────────────────────────

_probe = tokenizer.apply_chat_template(
    [{"role": "user", "content": "x"}, {"role": "assistant", "content": "y"}],
    tokenize=False,
)
assert "[INST]" in _probe and "[/INST]" in _probe, (
    f"Unerwartetes Chat-Template — [INST]/[/INST]-Marker fehlen:\n{_probe}"
)

trainer = train_on_responses_only(
    trainer,
    instruction_part = "[INST]",
    response_part    = "[/INST]",
)

# ─────────────────────────────────────────────────────────────────────────
# Training
# ─────────────────────────────────────────────────────────────────────────

trainer.train()

# Lauf 1: Epochenzahl der besten Evaluation für Lauf 2. Die Checkpoints liegen
# auf save_steps-Vielfachen, also ist der beste immer einer davon.
if eval_ds is not None:
    state = trainer.state
    best = state.best_model_checkpoint or ""
    best_step = int(best.rsplit("-", 1)[-1]) if best.rsplit("-", 1)[-1].isdigit() else state.global_step
    steps_per_epoch = state.max_steps / trainer.args.num_train_epochs
    print(f"[✓] Beste Evaluation bei Step {best_step} → FINAL_EPOCHS={best_step / steps_per_epoch:.2f}")

# ─────────────────────────────────────────────────────────────────────────
# Adapter speichern (klein, ~180 MB bei 8B/r=32)
# Processor statt Text-Tokenizer speichern: Merge und GGUF-Export brauchen
# die vollständige Modell-Konfiguration inkl. Vision-Teil.
# ─────────────────────────────────────────────────────────────────────────

adapter_dir = f"{OUT_DIR}/adapter"
model.save_pretrained(adapter_dir)
processor.save_pretrained(adapter_dir)
print(f"[✓] LoRA-Adapter gespeichert: {adapter_dir}")

# ─────────────────────────────────────────────────────────────────────────
# Merge zu bf16 + GGUF-Export für Ollama
# bf16-Merge: ~17 GB, rein für Debugging/Inferenz via HuggingFace nützlich.
# GGUF Q5_K_M: ~6 GB — lässt auf einer 20-GB-Karte reichlich Platz für den
# KV-Cache bei 32k Kontext. Q8_0 (~9 GB) passt ebenfalls, falls der Stil in
# Q5 hörbar leidet.
# ─────────────────────────────────────────────────────────────────────────

print("[ ] Merge zu bf16…")
model.save_pretrained_merged(
    f"{OUT_DIR}/merged",
    processor,
    save_method = "merged_16bit",
)
print(f"[✓] Merged: {OUT_DIR}/merged")

print("[ ] GGUF-Export (Q5_K_M)…")
model.save_pretrained_gguf(
    f"{OUT_DIR}/gguf",
    processor,
    quantization_method = "q5_k_m",
)
print(f"[✓] GGUF: {OUT_DIR}/gguf")

print()
print("Nächste Schritte:")
if FINAL_EPOCHS is None:
    print("  Lauf 2 auf all.jsonl mit dem FINAL_EPOCHS-Wert von oben (README).")
print(f"  Modelfile aus der Fine-Tuning-Karte nach {OUT_DIR}/gguf/ legen, FROM = Name aus ls *.gguf")
print(f"  cd {OUT_DIR}/gguf && ollama create buch-leser -f Modelfile")
print(f"  ollama run buch-leser 'Worum geht es in dir?'")
