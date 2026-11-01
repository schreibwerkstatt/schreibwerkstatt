"""
Vorher/Nachher-Vergleich auf den Testprompts der Fine-Tuning-Karte.

Schickt jede Zeile aus eval.jsonl («Testprompts herunterladen») an zwei
Ollama-Modelle — typisch das Basismodell und das trainierte, oder zwei
gesicherte Stände desselben Laufs — und druckt die Antworten untereinander.
Die Prompts tragen den System-Prompt aus dem Training; `holdout` markiert
Kapitel, die das Modell in Lauf 1 nie gesehen hat. Jede Zeile trägt eine
Referenz (`expected`) und Prüfwörter (`mustContain`); am Ende steht pro
Modell und Kategorie, wie viele Antworten alle Prüfwörter enthalten.

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


def hits(answer, must):
    low = answer.lower()
    return all(m.lower() in low for m in must)


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    path, model_a, model_b = sys.argv[1:]
    with open(path, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    score = {}  # (model, category) -> [treffer, gesamt]
    for i, row in enumerate(rows, 1):
        # Fakten nüchtern, Prosa frei (Temperatur-Tabelle in docs/finetuning.md §4).
        temp = 0.8 if row["category"] in ("continuation", "newChapter") else 0.4
        tag = " · holdout" if row.get("holdout") else ""
        must = row.get("mustContain") or []
        print(f"\n{'=' * 78}\n[{i}/{len(rows)}] {row['category']}{tag}\n{row['messages'][-1]['content']}")
        if row.get("expected"):
            print(f"\n--- Referenz (muss enthalten: {', '.join(must) or '–'}) ---\n{row['expected']}")
        for model in (model_a, model_b):
            answer = chat(model, row["messages"], temp)
            ok = hits(answer, must) if must else None
            mark = "" if ok is None else (" ✓" if ok else " ✗")
            print(f"\n--- {model}{mark} ---\n{answer}")
            if ok is not None:
                s = score.setdefault((model, row["category"]), [0, 0])
                s[0] += int(ok)
                s[1] += 1
    print(f"\n{'=' * 78}\nPrüfwörter getroffen (mustContain):")
    for model in (model_a, model_b):
        cats = sorted(c for (m, c) in score if m == model)
        parts = [f"{c} {score[(model, c)][0]}/{score[(model, c)][1]}" for c in cats]
        print(f"  {model}: " + " · ".join(parts))


if __name__ == "__main__":
    main()
