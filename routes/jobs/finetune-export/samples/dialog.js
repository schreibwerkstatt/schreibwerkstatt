'use strict';

const { extractDialogs } = require('../lib/text');
const { findSpeaker, hashSplit } = require('../lib/names');

// Dialog-Sammlung läuft immer, wenn Figuren bekannt sind — `dialogsByFigure`
// füttert auch den authorChat-Block (Zitatsammlung pro Figur). Der eigentliche
// dialog-Typ ist davon unabhängig per Checkbox steuerbar.
function buildDialogSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys, bookName,
    pageContents, figRows, figNamesSorted, dialogsByFigure,
  } = ctx;

  if (!figNamesSorted.length) return;

  for (const p of pageContents) {
    const dlgs = extractDialogs(p.text);
    for (const d of dlgs) {
      if (d.quote.length < 6 || d.quote.length > 800) continue;
      const speaker = findSpeaker(p.text, d.start, d.end, figNamesSorted);
      if (!speaker) continue;
      const spkKey = speaker.toLowerCase();
      if (!dialogsByFigure.has(spkKey)) dialogsByFigure.set(spkKey, []);
      dialogsByFigure.get(spkKey).push({
        quote: d.quote, chapter: p.chapter, chapterId: p.chapter_id ?? 0, page: p.title,
      });
      if (!opts.types.dialog) continue;
      const ctxBefore = p.text.slice(Math.max(0, d.start - 160), d.start).replace(/\s+/g, ' ').trim();
      const ctxStr = (ctxBefore.slice(-140) || p.chapter || bookName).trim();
      const userPart = langIsEn
        ? `Write a dialogue line for ${speaker}. Context: ${ctxStr}`
        : `Schreibe eine Dialogzeile für ${speaker}. Kontext: ${ctxStr}`;
      samples.push({
        id: 'dialog|' + p.id + '|' + d.start,
        type: 'dialog',
        sourceKey: 'ch:' + (p.chapter_id ?? 0),
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: userPart },
          { role: 'assistant', content: d.quote },
        ],
      });
      counts.dialog++;
    }
  }

  // ── Reverse Dialog: «Welche Figur sagt ...?» (#6) ────────────────────
  // Sobald Dialog-Extraktion gelaufen ist, existieren eindeutig
  // speaker-zugeordnete Zitate in dialogsByFigure. Reverse-Sample erzeugt
  // Speaker-Lookup-Fähigkeit: gegeben ein Zitat → Figur zurückgeben. Pro
  // Figur gedeckelt, damit stark sprechende Figuren nicht das Training
  // dominieren. Die Auswahl streut per Hash über das ganze Buch — die ersten N
  // in Buchreihenfolge zu nehmen, hiesse, nur die frühen Kapitel abzufragen.
  // `sourceKey` = Kapitel des Zitats: das Zitat ist Buchtext und gehört in
  // denselben Split wie die übrigen Ableitungen seines Kapitels.
  if (opts.types.dialog) {
    const REV_CAP_PER_FIG = 30 * (opts.biasBoost || 1);
    for (const f of figRows) {
      const entries = dialogsByFigure.get(f.name.toLowerCase()) || [];
      const altEntries = (f.kurzname && f.kurzname !== f.name)
        ? (dialogsByFigure.get(f.kurzname.toLowerCase()) || [])
        : [];
      const seenQ = new Set();
      const pool = [];
      for (const e of [...entries, ...altEntries]) {
        if (seenQ.has(e.quote)) continue;
        seenQ.add(e.quote);
        if (e.quote.length < 12 || e.quote.length > 600) continue;
        pool.push(e);
      }
      const picked = pool
        .map(e => [hashSplit('dlgRev|' + f.fig_id + '|' + e.quote, opts.valSeed), e])
        .sort((a, b) => a[0] - b[0])
        .slice(0, REV_CAP_PER_FIG)
        .map(([, e]) => e);
      picked.forEach((e, i) => {
        const ctxTag = e.chapter ? ` (in «${e.chapter}»)` : '';
        samples.push({
          id: 'dialogRev|' + f.fig_id + '|' + i,
          type: 'dialog',
          sourceKey: 'ch:' + e.chapterId,
          messages: [
            { role: 'system', content: unifiedSys },
            { role: 'user',   content: (langIsEn
              ? `Who says this: \u201C${e.quote}\u201D?`
              : `Wer sagt das: «${e.quote}»?`) },
            { role: 'assistant', content: f.name + ctxTag + '.' },
          ],
        });
        counts.dialog++;
      });
    }
  }
}

module.exports = { buildDialogSamples };
