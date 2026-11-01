"""
Token-Schätzung des Exports gegen den echten Tekken-Tokenizer prüfen.

Der Export zählt Antwort-Tokens ohne Tokenizer: Zeichen / 3.3 (Deutsch) bzw.
/ 4.0 (Englisch), aufgerundet je Nachricht (routes/jobs/finetune-export/
lib/tokens.js). Auf diese Schätzung stützen sich die Mischung nach Tokens
(`familyTokenShares`) und der Sequenz-Filter. Dieses Skript zieht eine feste
Stichprobe (Standard 200 Beispiele, Seed 42) aus train.jsonl, zählt die
Antwort-Tokens mit dem Tokenizer des Basismodells und schreibt das Ergebnis
als `tokenEstimateError` in die Statistik-Datei des Exports:

    factor       echte / geschätzte Antwort-Tokens über die Stichprobe
                 (< 1: die Schätzung zählt zu viel, also mit Puffer)
    ratioMedian  Median des Verhältnisses je Beispiel, dazu p10 / p90
    charsPerToken  gemessene Zeichen je Token der Antworten

Einsatz:
    pip install tokenizers huggingface_hub
    python token_factor.py finetune-train-<…>.jsonl finetune-stats-<…>.json
    python token_factor.py train.jsonl stats.json --model unsloth/Ministral-3-8B-Instruct-2512 --n 200 --lang de
"""

import argparse
import json
import math
import random
import sys


def estimate(text, lang):
    per = 4.0 if lang == "en" else 3.3
    return math.ceil(len(text) / per) if text else 0


def load_tokenizer(model):
    from huggingface_hub import hf_hub_download
    from tokenizers import Tokenizer
    return Tokenizer.from_file(hf_hub_download(model, "tokenizer.json"))


def pct(values, p):
    s = sorted(values)
    return s[min(len(s) - 1, int(p * (len(s) - 1) + 0.5))] if s else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("train")
    ap.add_argument("stats")
    ap.add_argument("--model", default="mistralai/Ministral-3-8B-Instruct-2512")
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--lang", default="de")
    args = ap.parse_args()

    with open(args.train, encoding="utf-8") as fh:
        rows = [json.loads(l) for l in fh if l.strip()]
    random.Random(args.seed).shuffle(rows)
    rows = rows[: args.n]
    tok = load_tokenizer(args.model)

    est_sum = real_sum = chars = 0
    ratios = []
    for r in rows:
        answers = [m["content"] for m in r["messages"] if m["role"] == "assistant"]
        est = sum(estimate(a, args.lang) for a in answers)
        real = sum(len(tok.encode(a, add_special_tokens=False).ids) for a in answers)
        est_sum += est
        real_sum += real
        chars += sum(len(a) for a in answers)
        if est:
            ratios.append(real / est)

    result = {
        "model": args.model,
        "samples": len(rows),
        "estimatedTokens": est_sum,
        "realTokens": real_sum,
        "factor": round(real_sum / est_sum, 4) if est_sum else None,
        "ratioMedian": round(pct(ratios, 0.5), 4) if ratios else None,
        "ratioP10": round(pct(ratios, 0.1), 4) if ratios else None,
        "ratioP90": round(pct(ratios, 0.9), 4) if ratios else None,
        "charsPerToken": round(chars / real_sum, 3) if real_sum else None,
    }
    with open(args.stats, encoding="utf-8") as fh:
        stats = json.load(fh)
    (stats.get("stats") if isinstance(stats.get("stats"), dict) else stats)["tokenEstimateError"] = result
    with open(args.stats, "w", encoding="utf-8") as fh:
        json.dump(stats, fh, ensure_ascii=False, indent=2)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
