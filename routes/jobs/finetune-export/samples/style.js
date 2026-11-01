'use strict';

const { splitParagraphs, splitSentences, splitAtSentence, clipAtSentence, tailFromSentence, chunkAtSentence } = require('../lib/text');
const { hashSplit } = require('../lib/names');

// Fortsetzungs-Instruktion der Stil-Samples; die Testprompts (lib/eval-prompts.js)
// stellen ihre Fortsetzungsfrage wortgleich.
function stylePrefix(langIsEn) {
  return langIsEn
    ? "Continue the following passage in the author's style:\n\n"
    : 'Setze den folgenden Abschnitt im Stil des Autors fort:\n\n';
}

function buildStyleSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys,
    pageContents,
    chapterKeys, chapterFullTextByKey, chapterNameByKey, pagesByChapter,
    sceneRows, pageTextById,
  } = ctx;
  const { minChars, maxChars } = opts;

  const prefix = stylePrefix(langIsEn);
  const contextPrefix = langIsEn
    ? "Given this passage, continue in the author's style. Write only the next paragraph:\n\n"
    : 'Setze den folgenden Abschnitt fort. Schreibe nur den nächsten Absatz im Stil des Autors:\n\n';

  // Split-Ratios pro Absatz: 50/50 ist das stärkste Signal (Haupt-Sample),
  // 25/75 und 75/25 ergänzen als augmentierte Varianten (Training-Volumen
  // ×3 bei gleichem Ausgangsmaterial). Verhindert dass das Modell nur
  // „halbierte" Prompt-Länge als Stil-Fortsetzung kennt.
  const splitRatios = [0.50, 0.25, 0.75];

  for (const p of pageContents) {
    const paragraphs = splitParagraphs(p.text);
    // Split-Gruppe = Kapitel der Seite (siehe finalize.js: Train/Val-Split auf
    // Quell-Ebene, damit Ableitungen derselben Seite/desselben Kapitels nicht
    // über train und val lecken).
    const pageCh = 'ch:' + (p.chapter_id ?? 0);

    // ── Intra-Absatz-Splits (Sliding-Windows) ─────────────────────────
    // Absätze über `maxChars` laufen in Satzgrenzen-Stücken durch, damit
    // weder ein Wort abgeschnitten noch der Rest des Absatzes verloren geht.
    for (let pi = 0; pi < paragraphs.length; pi++) {
      const para = paragraphs[pi];
      if (para.length < minChars) continue;
      const chunks = chunkAtSentence(para, maxChars);
      for (let ci = 0; ci < chunks.length; ci++) {
        for (let ri = 0; ri < splitRatios.length; ri++) {
          const [first, second] = splitAtSentence(chunks[ci], splitRatios[ri]);
          if (first.length < 60 || second.length < 60) continue;
          samples.push({
            id: 'style|' + p.id + '|' + pi + '|r' + ri + (ci ? '|c' + ci : ''),
            type: 'style',
            sourceKey: pageCh,
            messages: [
              { role: 'system', content: unifiedSys },
              { role: 'user', content: prefix + first },
              { role: 'assistant', content: second },
            ],
          });
          counts.style++;
        }
      }
    }

    // ── Multi-Absatz-Kontext (Langstrecken-Kohärenz) ──────────────────
    // Prompt = vorhergehende 1–3 Absätze, Completion = nächster Absatz.
    // Teaches long-range coherence so dass Fortsetzungen über Absätze
    // hinweg klingen wie der Autor. Überspringt Einträge, wenn der
    // Prompt-Kontext zu kurz oder zu lang ist.
    const CTX_MAX_PROMPT = Math.floor(maxChars * 2);
    for (let i = 1; i < paragraphs.length; i++) {
      const next = paragraphs[i];
      if (next.length < minChars) continue;
      const ctxStart = Math.max(0, i - 3);
      const context = paragraphs.slice(ctxStart, i).join('\n\n');
      if (context.length < 200) continue;
      const ctxClipped = tailFromSentence(context, CTX_MAX_PROMPT);
      const completion = clipAtSentence(next, maxChars);
      if (completion.length < 80) continue;
      samples.push({
        id: 'styleCtx|' + p.id + '|' + i,
        type: 'style',
        sourceKey: pageCh,
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: contextPrefix + ctxClipped },
          { role: 'assistant', content: completion },
        ],
      });
      counts.style++;
    }

    // ── Fortsetzen in 2–6 Sätzen ──────────────────────────────────────
    // Kontext: die bis zu vier Sätze davor → Ziel: die nächsten 2–6 Sätze
    // (Anzahl per Hash), höchstens bis zum Absatzende. Ein einzelner Satz als
    // Ziel brächte dem Modell bei, nach einem Satz aufzuhören.
    const CONT_CAP_PER_PAGE = 20 * (opts.biasBoost || 1);
    const contPrefix = langIsEn
      ? "How does it go on? Write the next sentences in the author's style:\n\n"
      : 'Wie geht es weiter? Schreibe die nächsten Sätze im Stil des Autors:\n\n';
    const units = paragraphs.flatMap((para, pi) => splitSentences(para).map(t => ({ t, pi })));
    const join = (arr) => arr.map((u, j) => (j ? (arr[j - 1].pi !== u.pi ? '\n\n' : ' ') : '') + u.t).join('');
    let contEmit = 0;
    for (let i = 3; i < units.length - 1 && contEmit < CONT_CAP_PER_PAGE; i += 5) {
      const want = 2 + Math.floor(hashSplit('cont|' + p.id + '|' + i, opts.valSeed) * 5);
      let end = i + 1;
      while (end < units.length && end - i < want && units[end].pi === units[end - 1].pi) end++;
      if (end - i < 2) continue;
      const target = join(units.slice(i, end));
      const context = join(units.slice(Math.max(0, i - 4), i));
      if (context.length < 120 || target.length < 120 || target.length > maxChars) continue;
      samples.push({
        id: 'styleCont|' + p.id + '|' + i,
        type: 'style',
        sourceKey: pageCh,
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user',   content: contPrefix + context },
          { role: 'assistant', content: target },
        ],
      });
      counts.style++;
      contEmit++;
    }
  }

  // ── Kapitel-Transitions (#2) ────────────────────────────────────────
  // Ende Kapitel N → Anfang Kapitel N+1. Zentrales Signal für das „wie
  // beginne ich ein neues Kapitel"-Gefühl — genau das, was fürs
  // Fortsetzungs-Schreiben gebraucht wird.
  for (let i = 0; i + 1 < chapterKeys.length; i++) {
    const kA = chapterKeys[i];
    const kB = chapterKeys[i + 1];
    const textA = chapterFullTextByKey.get(kA) || '';
    const textB = chapterFullTextByKey.get(kB) || '';
    if (textA.length < 400 || textB.length < 400) continue;
    const tailA = tailFromSentence(textA, 1000);
    const headB = clipAtSentence(textB, 1000);
    if (tailA.length < 120 || headB.length < 120) continue;
    const nameA = chapterNameByKey.get(kA);
    const nameB = chapterNameByKey.get(kB);
    const prompt = (langIsEn
      ? `End of chapter «${nameA}»:\n\n`
      : `Ende von Kapitel «${nameA}»:\n\n`)
      + tailA
      + (langIsEn
        ? `\n\nNow begin chapter «${nameB}» in the same voice:`
        : `\n\nBeginne nun Kapitel «${nameB}» im selben Ton:`);
    samples.push({
      id: 'chapTrans|' + kA + '|' + kB,
      type: 'style',
      sourceKey: 'ch:' + kB, // Completion = Anfang Kapitel B
      messages: [
        { role: 'system', content: unifiedSys },
        { role: 'user',   content: prompt },
        { role: 'assistant', content: clipAtSentence(headB, maxChars) },
      ],
    });
    counts.style++;
  }

  // ── Szenen-Transitions (#3) ────────────────────────────────────────
  // Ende einer Szene → Anfang der nächsten. Nutzt sceneRows-Reihenfolge
  // pro Kapitel; beide Szenen müssen einen page_id-Mapping haben, sonst
  // kein Text zum Anknüpfen.
  const sceneByChapterKey = new Map();
  for (const s of sceneRows) {
    if (!s.page_id) continue;
    const k = s.chapter_id ?? 0;
    if (!sceneByChapterKey.has(k)) sceneByChapterKey.set(k, []);
    sceneByChapterKey.get(k).push(s);
  }
  for (const [scnChKey, scenesInCh] of sceneByChapterKey) {
    for (let i = 0; i + 1 < scenesInCh.length; i++) {
      const sA = scenesInCh[i], sB = scenesInCh[i + 1];
      const txtA = pageTextById.get(sA.page_id) || '';
      const txtB = pageTextById.get(sB.page_id) || '';
      if (txtA.length < 200 || txtB.length < 200) continue;
      if (sA.page_id === sB.page_id) continue;
      const tailA = tailFromSentence(txtA, 800);
      const headB = clipAtSentence(txtB, 800);
      const prompt = (langIsEn
        ? `End of scene «${sA.titel || ''}»:\n\n${tailA}\n\nContinue with scene «${sB.titel || ''}»:`
        : `Ende der Szene «${sA.titel || ''}»:\n\n${tailA}\n\nFahre fort mit der Szene «${sB.titel || ''}»:`);
      samples.push({
        id: 'scnTrans|' + sA.id + '|' + sB.id,
        type: 'style',
        sourceKey: 'ch:' + scnChKey,
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user',   content: prompt },
          { role: 'assistant', content: headB },
        ],
      });
      counts.style++;
    }
  }

  // ── Kapitel-Level-Sliding-Windows (#5) ──────────────────────────────
  // Alle Absätze eines Kapitels als durchgängiger Stream — Sliding mit
  // Fenster 3 (Kontext) → 1 (Completion). Verbindet sich über Seitengrenzen
  // hinweg, anders als der page-lokale Multi-Absatz-Kontext oben.
  const chapWinPrefix = contextPrefix;
  for (const k of chapterKeys) {
    const pages = pagesByChapter.get(k) || [];
    if (pages.length < 2) continue;
    const allParas = pages.flatMap(pp => splitParagraphs(pp.text));
    if (allParas.length < 4) continue;
    const WIN = 3;
    const STRIDE = 2; // jedes zweite Absatz-Target: reduziert Duplikation mit dem page-lokalen Block
    for (let i = WIN; i < allParas.length; i += STRIDE) {
      const next = allParas[i];
      if (next.length < minChars) continue;
      const context = allParas.slice(i - WIN, i).join('\n\n');
      if (context.length < 300) continue;
      const ctxClipped = tailFromSentence(context, Math.floor(maxChars * 2));
      const completion = clipAtSentence(next, maxChars);
      if (completion.length < 80) continue;
      samples.push({
        id: 'chapWin|' + k + '|' + i,
        type: 'style',
        sourceKey: 'ch:' + k,
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user',   content: chapWinPrefix + ctxClipped },
          { role: 'assistant', content: completion },
        ],
      });
      counts.style++;
    }
  }
}

module.exports = { buildStyleSamples, stylePrefix };
