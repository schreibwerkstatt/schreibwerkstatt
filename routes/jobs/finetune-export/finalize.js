'use strict';

const crypto = require('crypto');
const { estimateTokens, renderMistralChat, percentile, recommendSeqLen } = require('./lib/tokens');
const { hashSplit } = require('./lib/names');
const { splitAtSentence } = require('./lib/text');
const { taskOf, familyOf, looksLikeCard } = require('./lib/tasks');
const { splitByUnits, valOverlap, normText } = require('./lib/split');
const { buildQualityStats } = require('./lib/export-stats');
const { makeCritiqueRegex } = require('./lib/critique');
const { capAnswerLengths } = require('./lib/answer-length');
const { applyParagraphBudget, paragraphTargetMax } = require('./lib/paragraph-budget');
const { mixByTokens } = require('./lib/token-mix');

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

const answersOf = (s) => s.messages.filter(m => m.role === 'assistant').map(m => normText(m.content));
const answersRaw = (s) => s.messages.filter(m => m.role === 'assistant').map(m => m.content);
// «Wer sagt das?» antwortet mit dem Namen der Figur — gleiche Antworten sind
// dort richtig, keine Dubletten; das Antwort-Budget gilt für sie nicht.
const BUDGET_EXEMPT = new Set(['whoSays']);

// Token-Stats berechnen, optional nach `maxSeqTokens` filtern, exakte Dubletten
// entfernen, Faktenkarten als Schreibziel und Lektorats-Sprache als Inhalt
// verwerfen, Antwortlängen pro Typ deckeln, jede Antwort auf `maxPerAnswer`
// Vorkommen deckeln, pro Absatz höchstens `maxTargetsPerParagraph` Ziele,
// die Familien nach Antwort-Tokens mischen (lib/token-mix.js), optional pro
// Aufgabentyp balancieren, train/val nach Einheiten aufteilen (lib/split.js),
// Überlappung prüfen, deterministisch shuffeln und JSONL serialisieren.
//
// Gibt `{ stats, trainJsonl, valJsonl, allJsonl, valFamilyJsonl, valUnits,
// trainPrompts }` zurück; `stats` geht in completeJob, die JSONL in den
// Platten-Store (lib/store.js). `allJsonl` ist train + val gemeinsam gemischt —
// für den zweiten Trainingslauf, der die Holdout-Kapitel mitlernt
// (docs/finetuning.md §3); leer ohne val. `valFamilyJsonl` sind die Val-
// Teilmengen je Familie (facts / writing / refusal). `valUnits` und
// `trainPrompts` braucht das Eval-Set (Holdout-Markierung, keine Frage
// wörtlich aus dem Train).
function finalizeFinetuneSamples(ctx) {
  const { samples, opts, langIsEn } = ctx;
  const { valSplit, valSeed, maxSeqTokens, emitText, truncateLong } = opts;
  const maxTypeShare = Math.max(0, Math.min(0.95, Number(opts.maxTypeShare) || 0));
  // 0 = aus. Ohne Angabe gelten die Standardwerte der Karte.
  const maxPerAnswer = Math.max(0, Math.min(50, Math.floor(opts.maxPerAnswer ?? 2)));

  // ── Token-Budget pro Sample (für Stats + Filter) ──────────────────────
  // Pro Sample: Summe aller Nachrichten + fester Template-Overhead. Mistral-
  // Tekken (Ministral 3 / Mistral-Small-3.2) encoded die Marker als atomare Single-
  // Tokens: <s>=1, [SYSTEM_PROMPT]=1, [/SYSTEM_PROMPT]=1, [INST]=1,
  // [/INST]=1, </s>=1 → real ~6 Tokens. 20 ist 3× konservativ und deckt
  // Newlines/Whitespace-Variationen mit ab.
  const TEMPLATE_OVERHEAD = 20;
  const retoken = (sample) => sample.messages.reduce((a, m) => a + estimateTokens(m.content, langIsEn), 0) + TEMPLATE_OVERHEAD;
  const withTokens = samples.map(s => {
    const sum = s.messages.reduce((a, m) => a + estimateTokens(m.content, langIsEn), 0);
    s.task = taskOf(s);
    return { s, tokens: sum + TEMPLATE_OVERHEAD, family: familyOf(s.task) };
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

  // ── Keine Faktenkarte als Schreibziel ─────────────────────────────────
  // Schutznetz hinter den Samplern: eine Erzähl-/Schreibaufgabe, deren Antwort
  // wie eine Karte aussieht («Zeitpunkt: … Art: …»), fliegt raus.
  let cardDropped = 0;
  kept = kept.filter(e => {
    if (e.family !== 'writing') return true;
    if (!looksLikeCard(e.s.messages[e.s.messages.length - 1].content)) return true;
    cardDropped++;
    return false;
  });

  // ── Keine Lektorats-Sprache als Inhalt ───────────────────────────────
  // Schutznetz hinter den Samplern, die Bewertungsfelder gar nicht erst als
  // Inhalt nehmen (lib/critique.js). Geprüft wird jede Antwort, die kein
  // Buchtext ist: Schreibaufgaben zielen auf echten Text, der «wirkt wie»
  // legitim enthalten darf; Lektorats-Feedback (`editorFeedback`, opt-in)
  // ist ausdrücklich Kritik.
  let critiqueDropped = 0;
  {
    const re = makeCritiqueRegex(opts.critiquePatterns);
    kept = kept.filter(e => {
      if (e.family === 'writing' || e.family === 'editor') return true;
      if (!answersRaw(e.s).some(a => re.test(a))) return true;
      critiqueDropped++;
      return false;
    });
  }

  // ── Antwortlänge pro Typ (`maxAnswerChars`) ───────────────────────────
  const lengthCap = capAnswerLengths(kept, opts.maxAnswerChars, retoken);
  kept = lengthCap.kept;

  // ── Antwort-Budget (`maxPerAnswer`) ──────────────────────────────────
  // Jede Antwort höchstens N-mal, damit Umformulierungen derselben Frage und
  // Kreuzprodukte (Figur × Ort × Ereignis) nicht dieselbe Antwort vervielfachen.
  // Bevorzugt: Schreibaufgaben, Fragen zu einer Entität, dann verschiedene
  // Aufgabentypen (erster Durchgang je Antwort nur einmal pro Typ).
  let answerCapped = 0;
  if (maxPerAnswer > 0) {
    const rank = (e) => (e.family === 'writing' ? 0 : 2) + (e.s.unit ? 0 : 1);
    const order = [...kept].sort((a, b) => rank(a) - rank(b)
      || hashSplit('ans|' + a.s.id, valSeed) - hashSplit('ans|' + b.s.id, valSeed));
    const used = new Map();
    const tasksPerAnswer = new Map();
    const keep = new Set();
    const fits = (e, distinctTask) => BUDGET_EXEMPT.has(e.s.task) || answersOf(e.s).every(a => (used.get(a) || 0) < maxPerAnswer
      && (!distinctTask || !tasksPerAnswer.get(a)?.has(e.s.task)));
    const take = (e) => {
      keep.add(e);
      for (const a of answersOf(e.s)) {
        used.set(a, (used.get(a) || 0) + 1);
        if (!tasksPerAnswer.has(a)) tasksPerAnswer.set(a, new Set());
        tasksPerAnswer.get(a).add(e.s.task);
      }
    };
    for (const e of order) if (fits(e, true)) take(e);
    for (const e of order) if (!keep.has(e) && fits(e, false)) take(e);
    answerCapped = kept.length - keep.size;
    kept = kept.filter(e => keep.has(e));
  }

  // ── Absatz-Budget (`maxTargetsPerParagraph`) ─────────────────────────
  const paraBudget = applyParagraphBudget(kept, {
    pageContents: ctx.pageContents, maxTargets: Number(opts.maxTargetsPerParagraph) || 0, seed: valSeed,
  });
  kept = paraBudget.kept;

  // ── Mischung nach Antwort-Tokens (lib/token-mix.js) ───────────────────
  const mix = mixByTokens(kept, {
    langIsEn, seed: valSeed,
    familyTokenShares: opts.familyTokenShares,
    refusalShare: opts.refusalShare,
    refusalMix: opts.refusalMix,
    verbatimMaxTokenShare: opts.verbatimMaxTokenShare,
  });
  kept = mix.kept;

  // ── Typ-Balance-Cap (optional, `maxTypeShare`) ────────────────────────
  // Deckelt jeden Aufgabentyp auf diesen Anteil am Gesamt. Der Cap gilt
  // gegen das Gesamt NACH dem Kappen (siehe `balanceCap`); die Auswahl ist
  // deterministisch (Hash über die Sample-id), also bei gleichem Seed
  // reproduzierbar.
  let balancedCount = 0;
  if (maxTypeShare > 0 && maxTypeShare < 1 && kept.length) {
    const byType = new Map();
    for (const e of kept) {
      if (!byType.has(e.s.task)) byType.set(e.s.task, []);
      byType.get(e.s.task).push(e);
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

  // ── Train/Val-Split nach Einheiten ────────────────────────────────────
  // Abschnitte für Buchtext, Entitäten für Fakten (lib/split.js). Ein Sample,
  // das Abschnitte aus beiden Splits berührt, fällt weg.
  const parts = splitByUnits(kept, { pageContents: ctx.pageContents, opts });
  const valUnits = parts.valUnits;
  const splitMixed = parts.mixed.length;
  let trainArr = parts.train.map(e => e.s);
  let valArr = parts.val.map(e => e.s);

  // Echte Wiederholungen im Buch (Refrain, wiederholte Formel) und Fakten mit
  // gleicher Kurzantwort teilen trotz getrennter Einheiten Text mit Train:
  // solche Val-Samples werden entfernt (gezählt), nie Train-Samples.
  let valPurged = 0;
  {
    const ov = valOverlap(trainArr, valArr);
    const bad = new Set([...ov.prompt, ...ov.answer, ...ov.shingle]);
    if (bad.size) {
      valPurged = bad.size;
      valArr = valArr.filter((_, i) => !bad.has(i));
    }
  }
  // Abbruch-Check: nach der Bereinigung darf keine Überlappung bleiben (die
  // Val-Dateien je Familie sind Teilmengen von val — was hier gilt, gilt dort). Schlägt
  // er an, ist der Split fehlerhaft — ein geschönter Eval-Loss ist schlimmer
  // als kein Export.
  {
    const ov = valOverlap(trainArr, valArr);
    const n = { prompt: ov.prompt.size, answer: ov.answer.size, shingle: ov.shingle.size };
    if (n.prompt || n.answer || n.shingle) {
      // i18n-Key + Params wie `i18nError` (routes/jobs/shared), ohne die
      // Job-Infrastruktur in dieses reine Modul zu ziehen.
      throw Object.assign(new Error('finetune.error.splitLeak'), { i18nParams: n });
    }
  }

  // ── Token-Histogramm (p50/p95/max) ────────────────────────────────────
  const exportedSet = new Set([...trainArr, ...valArr]);
  const tokenCounts = kept.filter(e => exportedSet.has(e.s)).map(e => e.tokens).sort((a, b) => a - b);
  const tokensP50 = percentile(tokenCounts, 0.50);
  const tokensP95 = percentile(tokenCounts, 0.95);
  const tokensMax = tokenCounts.length ? tokenCounts[tokenCounts.length - 1] : 0;
  const recommendedSeqLen = recommendSeqLen(tokensP95);

  // Deterministisches Shuffle pro Split, damit Tools ohne eigenes Shuffle
  // (oder Streaming-Loader) keine Sampler-Block-Reihenfolge sehen. Seed-stabil.
  const shuffle = (arr) => arr
    .map(s => [hashSplit('shuf|' + s.id, valSeed), s])
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => s);
  const trainOut = shuffle(trainArr);
  const valOut = shuffle(valArr);
  const allOut = valOut.length ? shuffle([...trainArr, ...valArr]) : [];

  // Per-Typ-Zählung aus dem FINALEN Set (nach Filter/Dedup/Deckel/Split) — das
  // spiegelt, was tatsächlich exportiert wird, nicht die Build-Rohzahlen.
  const exported = { style: 0, scene: 0, verbatim: 0, dialog: 0, authorChat: 0, aiAugment: 0, reader: 0, core: 0 };
  for (const s of [...trainOut, ...valOut]) if (s.type in exported) exported[s.type]++;

  // JSONL-Line: immer `messages`-Feld. Mit `emitText=true` zusätzlich ein
  // vorgerendertes `text`-Feld (Mistral-Tekken-Template, Ministral-3-
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
  const allJsonl   = toJsonl(allOut);
  // Val je Familie: `val-facts` misst Faktenwissen (empfohlene Eval-Datei in
  // Studio), `val-writing` Prosa, `val-refusal` das Ablehnen. Persona und
  // Lektorat stehen nur in der gemischten Datei.
  const VAL_FAMILIES = ['facts', 'writing', 'refusal'];
  const valByFamily = Object.fromEntries(VAL_FAMILIES.map(f => [f, valOut.filter(s => familyOf(s.task) === f)]));
  const valFamilyJsonl = Object.fromEntries(VAL_FAMILIES.map(f => [f, toJsonl(valByFamily[f])]));
  const overlapByVal = { val: valOverlapCounts(trainOut, valOut) };
  for (const f of VAL_FAMILIES) overlapByVal['val-' + f] = valOverlapCounts(trainOut, valByFamily[f]);
  const stats = {
    total: trainOut.length + valOut.length,
    dropped: droppedCount,
    capped: cappedCount,
    deduped: dedupedCount,
    balanced: balancedCount,
    cardDropped,
    critiqueDropped,
    lengthClipped: lengthCap.clipped,
    lengthDropped: lengthCap.dropped,
    answerCapped,
    paragraphCapped: paraBudget.dropped,
    paragraphTargetMax: paragraphTargetMax(trainOut, ctx.pageContents),
    mixDropped: mix.dropped,
    splitMixed,
    valPurged,
    maxPerAnswer: maxPerAnswer || null,
    quality: buildQualityStats(trainOut, valOut, { langIsEn, overlapByVal }),
    valFacts: valByFamily.facts.length,
    valWriting: valByFamily.writing.length,
    valRefusal: valByFamily.refusal.length,
    valFactsBytes: Buffer.byteLength(valFamilyJsonl.facts, 'utf8'),
    valWritingBytes: Buffer.byteLength(valFamilyJsonl.writing, 'utf8'),
    valRefusalBytes: Buffer.byteLength(valFamilyJsonl.refusal, 'utf8'),
    train: trainOut.length,
    val: valOut.length,
    styleCount: exported.style,
    sceneCount: exported.scene,
    verbatimCount: exported.verbatim,
    dialogCount: exported.dialog,
    authorChatCount: exported.authorChat,
    aiAugmentCount: exported.aiAugment,
    readerCount: exported.reader,
    coreCount: exported.core,
    trainBytes: Buffer.byteLength(trainJsonl, 'utf8'),
    valBytes:   Buffer.byteLength(valJsonl,   'utf8'),
    allBytes:   Buffer.byteLength(allJsonl,   'utf8'),
    tokensP50, tokensP95, tokensMax,
    recommendedSeqLen,
    maxSeqTokens: maxSeqTokens || null,
    maxTypeShare: maxTypeShare || null,
    emitText,
  };

  const trainPrompts = new Set(trainOut.flatMap(s => s.messages.filter(m => m.role === 'user').map(m => m.content.trim())));
  return { stats, trainJsonl, valJsonl, allJsonl, valFamilyJsonl, valUnits, trainPrompts, trainOut, valOut };
}

function valOverlapCounts(trainArr, valArr) {
  const ov = valOverlap(trainArr, valArr);
  return { prompt: ov.prompt.size, answer: ov.answer.size, shingle: ov.shingle.size };
}

module.exports = { finalizeFinetuneSamples, balanceCap };
