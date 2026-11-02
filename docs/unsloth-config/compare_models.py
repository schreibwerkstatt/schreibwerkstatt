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

Die Regeln (`score_rules`) sind dieselben wie in
routes/jobs/finetune-export/lib/eval/score.js: «…» in einem Begriff ist eine
Lücke, `minAny` verlangt nur k Synonymgruppen, `maxOverlapWithProfile` deckelt
wörtliche Profilblöcke, `style` prüft Prosa (kein «ß», Zeitform, keine
Wiederholungsschleife, kein Metatext). Jede Antwort bekommt so ein Regel-
Maximum 0/1/2; die Tabelle am Ende zählt Punkte je Kategorie. Mit
ANSWERS_OUT=pfad schreibt das Script die Antworten des zweiten Modells als
JSONL (`{"i", "answer"}`) für den LLM-Richter `node scripts/eval-judge.js`.

Einsatz:
    python compare_models.py eval.jsonl ministral-3:8b buch-leser
    OLLAMA_HOST=http://gpu-box:11434 python compare_models.py eval.jsonl a b

Nur Standardbibliothek, kein pip install nötig.
"""

import json
import os
import re
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


GAP = 60
REFUSAL_CATEGORIES = {"unknown", "offTopic", "mixed", "meta"}
META_TEXT = re.compile(r"\b(Kapitel|Abschnitt|Chapter|Section)\s+\d+\b|\b(das|im) (letzte|vorige|vorherige)n? Kapitel\b|\bTeil \d+ von \d+\b|\bpart \d+ of \d+\b", re.I)
PAST = set("war waren hatte hatten wurde wurden ging sagte kam stand sah wollte konnte musste was were had did said went came stood saw".split())
PRESENT = set("ist sind hat haben wird werden geht sagt kommt steht sieht will kann muss is are has have does says goes comes stands sees".split())


def has_term(text, term):
    """Teilstring ohne Gross-/Kleinschreibung; «…» = Lücke bis GAP Zeichen."""
    parts = [p.strip() for p in term.lower().split("…") if p.strip()]
    if not parts:
        return False
    if len(parts) == 1:
        return parts[0] in text.lower()
    pattern = ("[\\s\\S]{0,%d}?" % GAP).join(re.escape(p) for p in parts)
    return re.search(pattern, text.lower()) is not None


def words(s):
    return [w for w in re.split(r"[\W_]+", s.lower()) if w]


def shingle_overlap(answer, profile, n=8):
    a, p = words(answer), words(profile)
    if len(a) < n:
        return 0.0
    pset = {" ".join(p[i:i + n]) for i in range(len(p) - n + 1)}
    total = len(a) - n + 1
    hit = sum(1 for i in range(total) if " ".join(a[i:i + n]) in pset)
    return hit / total if total else 0.0


def repeats(text):
    w = words(text)
    seen = {}
    for i in range(len(w) - 3):
        k = " ".join(w[i:i + 4])
        seen[k] = seen.get(k, 0) + 1
        if seen[k] >= 3:
            return True
    return False


def past_share(text):
    p = q = 0
    for w in words(text):
        if w in PAST:
            p += 1
        elif w in PRESENT:
            q += 1
    return p / (p + q) if p + q else None


def score_rules(answer, row):
    """(ok, cap, violations) — cap 2/1/0 wie lib/eval/score.js#scoreRules."""
    must = row.get("mustContain") or []
    groups = row.get("mustContainAny") or []
    banned = row.get("mustNotContain") or []
    v = []
    v += [("mustContain", m) for m in must if not has_term(answer, m)]
    hit_groups = sum(1 for g in groups if any(has_term(answer, t) for t in g))
    need = min(row["minAny"], len(groups)) if isinstance(row.get("minAny"), int) else len(groups)
    if hit_groups < need:
        v.append(("mustContainAny", hit_groups))
    banned_hit = [b for b in banned if has_term(answer, b)]
    if banned_hit:
        v.append(("mustNotContain", banned_hit))
    ov = row.get("maxOverlapWithProfile") or {}
    if ov.get("text") and shingle_overlap(answer, ov["text"]) > ov.get("max", 0.6):
        v.append(("maxOverlapWithProfile", None))
    st = row.get("style") or {}
    if st.get("noEszett") and "ß" in answer:
        v.append(("style.noEszett", None))
    if st.get("noRepeat") and repeats(answer):
        v.append(("style.noRepeat", None))
    if st.get("noMeta") and META_TEXT.search(answer):
        v.append(("style.noMeta", None))
    if st.get("tense"):
        share = past_share(answer)
        if share is not None and (share < 0.5 if st["tense"] == "past" else share > 0.5):
            v.append(("style.tense", share))
    if not (must or groups or banned or ov or st):
        return None, 2, []
    refusal_breach = row.get("category") in REFUSAL_CATEGORIES and banned_hit
    nothing = (must or groups) and all(not has_term(answer, m) for m in must) and hit_groups == 0
    cap = 2 if not v else (0 if refusal_breach or nothing else 1)
    return not v, cap, v


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    path, model_a, model_b = sys.argv[1:]
    with open(path, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    score = {}  # (model, category) -> [punkte, gesamt]
    answers_out = os.environ.get("ANSWERS_OUT")
    collected = []
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
            ok, cap, violations = score_rules(answer, row)
            mark = "" if ok is None else f" · Regel-Max {cap}/2" + ("" if ok else " (" + ", ".join(r for r, _ in violations) + ")")
            print(f"\n--- {model}{mark} ---\n{answer}")
            s = score.setdefault((model, row["category"]), [0, 0])
            s[0] += cap
            s[1] += 2
            if model == model_b:
                collected.append({"i": i - 1, "answer": answer})
    if answers_out:
        with open(answers_out, "w", encoding="utf-8") as f:
            for c in collected:
                f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"\n{'=' * 78}\nRegel-Punkte je Kategorie (Maximum ohne Richter; Richter: node scripts/eval-judge.js):")
    for model in (model_a, model_b):
        cats = sorted(c for (m, c) in score if m == model)
        parts = [f"{c} {score[(model, c)][0]}/{score[(model, c)][1]}" for c in cats]
        print(f"  {model}: " + " · ".join(parts))


if __name__ == "__main__":
    main()
