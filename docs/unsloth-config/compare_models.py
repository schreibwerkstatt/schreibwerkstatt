"""
Vorher/Nachher-Vergleich auf den Testprompts der Fine-Tuning-Karte.

Schickt jede Zeile aus eval.jsonl («Testprompts herunterladen») an zwei
Ollama-Modelle — typisch das Basismodell und das trainierte — und druckt die
Antworten untereinander. Die Prompts tragen den System-Prompt aus dem Training;
`holdout` markiert Kapitel, die das Modell in Lauf 1 nie gesehen hat.

Einsatz:
    python compare_models.py eval.jsonl ministral-3:8b buch-leser
    OLLAMA_HOST=http://gpu-box:11434 python compare_models.py eval.jsonl a b

Nur Standardbibliothek, kein pip install nötig.
"""

import json
import os
import sys
import urllib.request

HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")


def chat(model, messages, temperature):
    body = json.dumps({
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {"temperature": temperature},
    }).encode("utf-8")
    req = urllib.request.Request(f"{HOST}/api/chat", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as res:
        return json.loads(res.read())["message"]["content"].strip()


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    path, model_a, model_b = sys.argv[1:]
    with open(path, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    for i, row in enumerate(rows, 1):
        # Fakten nüchtern, Prosa frei (Temperatur-Tabelle in docs/finetuning.md §4).
        temp = 0.8 if row["category"] in ("continuation", "newChapter") else 0.4
        tag = " · holdout" if row.get("holdout") else ""
        print(f"\n{'=' * 78}\n[{i}/{len(rows)}] {row['category']}{tag}\n{row['messages'][-1]['content']}")
        for model in (model_a, model_b):
            print(f"\n--- {model} ---\n{chat(model, row['messages'], temp)}")


if __name__ == "__main__":
    main()
