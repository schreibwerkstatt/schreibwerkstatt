'use strict';

const crypto = require('crypto');
const { estimateTokens, renderMistralChat, percentile, recommendSeqLen } = require('./lib/tokens');
const { hashSplit } = require('./lib/names');
const { splitAtSentence } = require('./lib/text');
const { storeFinetuneResult } = require('./lib/store');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Grösster Pro-Typ-Cap c, bei dem kein Typ nach dem Kappen mehr als `share`
// des verbleibenden Gesamts stellt: c ≤ share × Σ min(nₜ, c). Ein Cap gegen das
// Gesamt VOR dem Kappen hält den Anteil nicht — 900 Stil + 100 Chat bei 0.4
// ergäbe Cap 400 und damit 400/500 = 80 % Stil. Fixpunkt-Iteration von oben:
// die Abbildung ist monoton, also landet sie auf dem grössten Fixpunkt. 0 =
// unerfüllbar (weniger als 1/share Typen vorhanden) → kein Balancing.
function balanceCap(typeCounts, share) {
  const total = typeCounts.reduce((a, n) => a + n, 0);
  let cap = Math.floor(total * share);
  for (;;) {
    if (cap <= 0) return 0;
    const kept = typeCounts.reduce((a, n) => a + Math.min(n, cap), 0);
    const next = Math.floor(kept * share);
    if (next >= cap) return cap;
    cap = next;
  }
}

// Token-Stats berechnen, optional nach `maxSeqTokens` filtern, exakte Dubletten
// entfernen, optional pro Sample-Typ deckeln, train/val auf Quell-Ebene
// (`sourceKey`) aufteilen, deterministisch shuffeln, JSONL serialisieren und im
// Result-Store ablegen.
//
// Gibt `stats`-Objekt zurück, das in completeJob gepackt wird.
function finalizeFinetuneSamples(jobId, ctx) {
  const { samples, opts, langIsEn, counts, bookName } = ctx;
  const { valSplit, valSeed, maxSeqTokens, emitText, truncateLong } = opts;
  const maxTypeShare = Math.max(0, Math.min(0.95, Number(opts.maxTypeShare) || 0));

  // ── Token-Budget pro Sample (für Stats + Filter) ──────────────────────
  // Pro Sample: Summe aller Nachrichten + fester Template-Overhead. Mistral-
  // Tekken-V7 (Mistral-Small-3.2) encoded die Marker als atomare Single-
  // Tokens: <s>=1, [SYSTEM_PROMPT]=1, [/SYSTEM_PROMPT]=1, [INST]=1,
  // [/INST]=1, </s>=1 → real ~6 Tokens. 20 ist 3× konservativ und deckt
  // Newlines/Whitespace-Variationen mit ab.
  const TEMPLATE_OVERHEAD = 20;
  const withTokens = samples.map(s => {
    const sum = s.messages.reduce((a, m) => a + estimateTokens(m.content, langIsEn), 0);
    return { s, tokens: sum + TEMPLATE_OVERHEAD };
  });

  // ── Seq-Filter / Cap (optional) ──────────────────────────────────────
  // Samples, die bei `maxSeqTokens` zu stiller Truncation führen würden,
  // werden behandelt: entweder gedroppt (default) oder per `truncateLong`
  // an einer Satzgrenze gekappt (Assistant-Content wird gekürzt). Samples mit
  // `noTruncate` (Voll-Kapitel-/Wörtlich-Slices) werden nie gekappt, nur gedroppt.
  let kept;
  let droppedCount = 0;
  let cappedCount = 0;
  if (maxSeqTokens > 0) {
    if (truncateLong) {
      kept = [];
      const perToken = langIsEn ? 4.0 : 3.3;
      for (const e of withTokens) {
        if (e.tokens <= maxSeqTokens) { kept.push(e); continue; }
        const assistantMsg = e.s.messages[e.s.messages.length - 1];
        if (e.s.noTruncate || !assistantMsg || assistantMsg.role !== 'assistant') {
          droppedCount++;
          continue;
        }
        const otherTokens = e.s.messages.slice(0, -1)
          .reduce((a, m) => a + estimateTokens(m.content, langIsEn), 0);
        const assistantBudget = maxSeqTokens - otherTokens - TEMPLATE_OVERHEAD;
        if (assistantBudget < 30) { droppedCount++; continue; }
        const charBudget = Math.floor(assistantBudget * perToken);
        const orig = assistantMsg.content;
        if (charBudget >= orig.length) { kept.push(e); continue; }
        const ratio = Math.max(0.05, Math.min(0.95, charBudget / orig.length));
        const [head] = splitAtSentence(orig, ratio);
        if (head.length < 60) { droppedCount++; continue; }
        assistantMsg.content = head;
        const newSum = e.s.messages.reduce((a, m) => a + estimateTokens(m.content, langIsEn), 0);
        e.tokens = newSum + TEMPLATE_OVERHEAD;
        cappedCount++;
        kept.push(e);
      }
    } else {
      kept = withTokens.filter(e => e.tokens <= maxSeqTokens);
      droppedCount = withTokens.length - kept.length;
    }
  } else {
    kept = withTokens;
  }

  // ── Exakt-Dedup (identische messages) ─────────────────────────────────
  // Kurze Seiten/Kapitel erzeugen über mehrere Sampler bit-identische Samples
  // (z.B. ein 1-Seiten-Kapitel: page-Sample == chapter-Sample). Verschiedene
  // Framings (scene vs. verbatim) bleiben erhalten — nur exakte Dubletten
  // fallen raus. Erstes Vorkommen gewinnt.
  let dedupedCount = 0;
  {
    const seenMsg = new Set();
    const out = [];
    for (const e of kept) {
      const key = sha1(JSON.stringify(e.s.messages));
      if (seenMsg.has(key)) { dedupedCount++; continue; }
      seenMsg.add(key);
      out.push(e);
    }
    kept = out;
  }

  // ── Typ-Balance-Cap (optional, `maxTypeShare`) ────────────────────────
  // Verhindert, dass die volumenstarken Text-Sampler (style/scene/verbatim)
  // das Welt-/Figurenwissen (authorChat/aiAugment) erschlagen. Der Cap gilt
  // gegen das Gesamt NACH dem Kappen (siehe `balanceCap`); die Auswahl ist
  // deterministisch (Hash über die Sample-id), also bei gleichem Seed
  // reproduzierbar.
  let balancedCount = 0;
  if (maxTypeShare > 0 && maxTypeShare < 1 && kept.length) {
    const byType = new Map();
    for (const e of kept) {
      if (!byType.has(e.s.type)) byType.set(e.s.type, []);
      byType.get(e.s.type).push(e);
    }
    const cap = balanceCap([...byType.values()].map(a => a.length), maxTypeShare);
    if (cap > 0) {
      const keepSet = new Set();
      for (const [, arr] of byType) {
        if (arr.length <= cap) { for (const e of arr) keepSet.add(e); continue; }
        const ranked = [...arr].sort(
          (a, b) => hashSplit('bal|' + a.s.id, valSeed) - hashSplit('bal|' + b.s.id, valSeed));
        for (let i = 0; i < cap; i++) keepSet.add(ranked[i]);
        balancedCount += arr.length - cap;
      }
      kept = kept.filter(e => keepSet.has(e));
    } else {
      ctx.logger?.warn(`Typ-Balance ${maxTypeShare} unerfüllbar bei ${byType.size} Typen — übersprungen.`);
    }
  }

  // ── Token-Histogramm (p50/p95/max) ────────────────────────────────────
  const tokenCounts = kept.map(e => e.tokens).sort((a, b) => a - b);
  const tokensP50 = percentile(tokenCounts, 0.50);
  const tokensP95 = percentile(tokenCounts, 0.95);
  const tokensMax = tokenCounts.length ? tokenCounts[tokenCounts.length - 1] : 0;
  const recommendedSeqLen = recommendSeqLen(tokensP95);

  // ── Train/Val-Split auf Quell-Ebene ──────────────────────────────────
  // Gehasht wird `sourceKey` (Kapitel-Schlüssel der trainierten Completion),
  // nicht die Sample-id. So landen ALLE Ableitungen eines Kapitels (style,
  // scene, verbatim, dialog …) im selben Split → val ist ein echtes Holdout
  // und der Eval-Loss misst Generalisierung statt Memorisierung von
  // Trainingstext. Samples ohne `sourceKey` (Fakten-Q&A, Korrekturen) splitten
  // weiter per id — sie reproduzieren keinen zusammenhängenden Buchtext.
  const trainArr = [];
  const valArr = [];
  for (const { s } of kept) {
    const splitKey = s.sourceKey || s.id;
    if (valSplit > 0 && hashSplit(splitKey, valSeed) < valSplit) valArr.push(s);
    else trainArr.push(s);
  }

  // Deterministisches Shuffle pro Split, damit Tools ohne eigenes Shuffle
  // (oder Streaming-Loader) keine Sampler-Block-Reihenfolge sehen. Seed-stabil.
  const shuffle = (arr) => arr
    .map(s => [hashSplit('shuf|' + s.id, valSeed), s])
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => s);
  const trainOut = shuffle(trainArr);
  const valOut = shuffle(valArr);

  // Per-Typ-Zählung aus dem FINALEN kept (nach Filter/Dedup/Balance) — das
  // spiegelt, was tatsächlich exportiert wird, nicht die Build-Rohzahlen.
  const exported = { style: 0, scene: 0, verbatim: 0, dialog: 0, authorChat: 0, correction: 0, aiAugment: 0 };
  for (const { s } of kept) if (s.type in exported) exported[s.type]++;

  // JSONL-Line: immer `messages`-Feld. Mit `emitText=true` zusätzlich ein
  // vorgerendertes `text`-Feld (Mistral-Tekken-V7-Template, Mistral-Small-3.2-
  // konform), damit Unsloth-Userinnen `SFTTrainer(dataset_text_field="text")`
  // ohne `formatting_func` nutzen können. `messages` bleibt erhalten — manche
  // Tools (TRL ChatML-Loader) wollen das.
  const serialize = (sample) => {
    const obj = { messages: sample.messages };
    if (emitText) obj.text = renderMistralChat(sample.messages);
    return JSON.stringify(obj);
  };
  const toJsonl = (arr) => arr.length
    ? arr.map(serialize).join('\n') + '\n'
    : '';

  const trainJsonl = toJsonl(trainOut);
  const valJsonl   = toJsonl(valOut);
  const stats = {
    total: kept.length,
    dropped: droppedCount,
    capped: cappedCount,
    deduped: dedupedCount,
    balanced: balancedCount,
    train: trainOut.length,
    val: valOut.length,
    styleCount: exported.style,
    sceneCount: exported.scene,
    verbatimCount: exported.verbatim,
    dialogCount: exported.dialog,
    authorChatCount: exported.authorChat,
    correctionCount: exported.correction,
    aiAugmentCount: exported.aiAugment,
    trainBytes: Buffer.byteLength(trainJsonl, 'utf8'),
    valBytes:   Buffer.byteLength(valJsonl,   'utf8'),
    tokensP50, tokensP95, tokensMax,
    recommendedSeqLen,
    maxSeqTokens: maxSeqTokens || null,
    maxTypeShare: maxTypeShare || null,
    emitText,
  };

  storeFinetuneResult(jobId, { trainJsonl, valJsonl, bookName });
  return stats;
}

module.exports = { finalizeFinetuneSamples, balanceCap };
