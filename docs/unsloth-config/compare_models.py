"""
Vorher/Nachher-Vergleich auf den Testprompts der Fine-Tuning-Karte.

Schickt jede Zeile aus eval.jsonl («Testprompts herunterladen») an zwei
Ollama-Modelle — typisch das Basismodell und das trainierte, oder zwei
gesicherte Stände desselben Laufs — und druckt die Antworten untereinander.
Die Prompts tragen den System-Prompt aus dem Training; `holdout` markiert
Frageformen (`phrasing`), Fakten (`unit`) oder Buchtext (`text`), die das
Modell in Lauf 1 nie gesehen hat. Jede Zeile trägt eine Referenz (`expected`)
und Kriterien: `mustContain` (jeder Begriff), `mustContainAny` (aus jeder
Synonymgruppe einer), `mustNotContain` (keiner), dazu `judge` als Anweisung
für einen menschlichen oder LLM-Richter (Skala 0–2, siehe eval-judge.md im
ZIP). Am Ende steht pro Modell und Kategorie, wie viele Antworten alle
Wort-Kriterien erfüllen; Zeilen nur mit `judge` zählen dort nicht.

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


def hits(answer, row):
    """None ohne Wort-Kriterium, sonst True/False."""
    low = answer.lower()
    must = row.get("mustContain") or []
    groups = row.get("mustContainAny") or []
    banned = row.get("mustNotContain") or []
    if not (must or groups or banned):
        return None
    return (all(m.lower() in low for m in must)
            and all(any(t.lower() in low for t in g) for g in groups)
            and not any(b.lower() in low for b in banned))


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
        tag = f" · holdout {row['holdout']}" if row.get("holdout") else ""
        print(f"\n{'=' * 78}\n[{i}/{len(rows)}] {row['category']}{tag}\n{row['messages'][-1]['content']}")
        if row.get("expected"):
            print(f"\n--- Referenz ---\n{row['expected']}")
        if row.get("judge"):
            print(f"\n--- Bewertung ---\n{row['judge']}")
        for model in (model_a, model_b):
            answer = chat(model, row["messages"], temp)
            ok = hits(answer, row)
            mark = "" if ok is None else (" ✓" if ok else " ✗")
            print(f"\n--- {model}{mark} ---\n{answer}")
            if ok is not None:
                s = score.setdefault((model, row["category"]), [0, 0])
                s[0] += int(ok)
                s[1] += 1
    print(f"\n{'=' * 78}\nWort-Kriterien erfüllt (mustContain/mustContainAny/mustNotContain):")
    for model in (model_a, model_b):
        cats = sorted(c for (m, c) in score if m == model)
        parts = [f"{c} {score[(model, c)][0]}/{score[(model, c)][1]}" for c in cats]
        print(f"  {model}: " + " · ".join(parts))


if __name__ == "__main__":
    main()
