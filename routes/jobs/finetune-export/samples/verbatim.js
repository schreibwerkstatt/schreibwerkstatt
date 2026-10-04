'use strict';

const { splitAtSentence } = require('../lib/text');

// Wörtliche Rekonstruktion (Verbatim-Recall) — der stärkste Memorisierungs-
// Sample-Typ. Anders als `scene` (das Seitentext auf `maxChars` kürzt und im
// Stil-Framing fortsetzt) zwingt dieser Typ die *exakte* Wiedergabe des
// vollständigen Texts. Lange Seiten/Kapitel werden an Satzgrenzen in Slices
// ≤ `maxFullChars` gestückelt (kein Tail-Verlust), jeder Slice ein eigenes
// Sample mit Part-Label + Vorgänger-Anker.
function buildVerbatimSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys, bookName,
    pageContents, chapterKeys, chapterFullTextByKey, chapterNameByKey,
  } = ctx;
  const { minChars, maxFullChars } = opts;

  const sliceAtSentence = (text, maxLen) => {
    if (text.length <= maxLen) return [text];
    const out = [];
    let remaining = text;
    while (remaining.length > maxLen) {
      const ratio = maxLen / remaining.length;
      const [head, rest] = splitAtSentence(remaining, ratio);
      if (!head.length || head.length === remaining.length) {
        out.push(remaining.slice(0, maxLen));
        remaining = remaining.slice(maxLen);
        break;
      }
      out.push(head);
      remaining = rest;
    }
    if (remaining.length > 0) out.push(remaining);
    return out;
  };

  const push = (id, sourceKey, instr, completion) => {
    samples.push({
      id,
      type: 'verbatim',
      sourceKey,
      // Gekürzt wäre es keine wörtliche Wiedergabe von „Teil N von M" mehr,
      // sondern ein Abbruch mitten im Text — finalize verwirft statt zu kappen.
      noTruncate: true,
      messages: [
        { role: 'system', content: unifiedSys },
        { role: 'user', content: instr },
        { role: 'assistant', content: completion },
      ],
    });
    counts.verbatim++;
  };

  // Emittiert einen (ggf. gestückelten) Verbatim-Block. `noun` ist die
  // vollständige Nominalphrase inkl. Artikel (z.B. „die Seite «X»").
  // `sourceKey` gruppiert alle Slices fürs Train/Val-Splitting auf Kapitel-Ebene.
  const emitChunked = (text, noun, idPrefix, sourceKey) => {
    const slices = sliceAtSentence(text, maxFullChars);
    const total = slices.length;
    for (let si = 0; si < total; si++) {
      const slice = slices[si];
      if (slice.length < Math.max(80, minChars)) continue;
      const partLabel = total > 1
        ? (langIsEn ? `\nPart ${si + 1} of ${total}` : `\nTeil ${si + 1} von ${total}`)
        : '';
      const ctxTail = si > 0 ? slices[si - 1].slice(-300).trim() : '';
      const ctxBlock = ctxTail
        ? '\n\n' + (langIsEn ? 'Continues verbatim from:\n' : 'Wörtlicher Anschluss an:\n') + ctxTail
        : '';
      const instr = (langIsEn
        ? `Reproduce ${noun} word for word, exactly as written:`
        : `Gib ${noun} wörtlich wieder, exakt wie geschrieben:`) + partLabel + ctxBlock;
      push(total > 1 ? `${idPrefix}|${si}` : idPrefix, sourceKey, instr, slice);
    }
  };

  // ── Seiten verbatim (volltext, ungekürzt) ─────────────────────────────
  for (const p of pageContents) {
    if (!p.text || p.text.length < minChars) continue;
    const locParts = [];
    if (bookName) locParts.push(langIsEn ? `from «${bookName}»` : `aus «${bookName}»`);
    if (p.chapter) locParts.push(langIsEn ? `chapter «${p.chapter}»` : `Kapitel «${p.chapter}»`);
    const suffix = locParts.length ? ' (' + locParts.join(', ') + ')' : '';
    const noun = (langIsEn ? `the section «${p.title}»` : `den Abschnitt «${p.title}»`) + suffix;
    emitChunked(p.text, noun, 'verbPage|' + p.id, 'ch:' + (p.chapter_id ?? 0));
  }

  // ── Kapitel verbatim (volltext, ungekürzt) ────────────────────────────
  for (const k of chapterKeys) {
    const text = chapterFullTextByKey.get(k) || '';
    if (text.length < Math.max(400, minChars)) continue;
    const name = chapterNameByKey.get(k);
    const noun = (langIsEn ? `the chapter «${name}»` : `das Kapitel «${name}»`)
      + (bookName ? (langIsEn ? ` from «${bookName}»` : ` aus «${bookName}»`) : '');
    emitChunked(text, noun, 'verbChap|' + k, 'ch:' + k);
  }
}

module.exports = { buildVerbatimSamples };
