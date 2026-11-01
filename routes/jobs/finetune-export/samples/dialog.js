'use strict';

const { extractDialogs, tailFromSentence, looksLikeNarration } = require('../lib/text');
const { findSpeaker, hashSplit } = require('../lib/names');

// Dialogzeile als Schreibaufgabe nur ab dieser Länge: «Ja.» oder «Ich weiss
// nicht.» ist aus dem Vorlauf nicht zu erschliessen.
const DIALOG_LINE_MIN = 25;
// «Wer sagt das?» nur für Zitate, die eine Figur erkennbar machen: lang genug,
// genau einmal im Buch, eindeutig zugeordnet.
const WHO_SAYS_MIN_CHARS = 30;
const WHO_SAYS_MIN_WORDS = 5;
const normQuote = (q) => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Dialog-Sammlung läuft immer, wenn Figuren bekannt sind — `dialogsByFigure`
// füttert auch den authorChat-Block (Zitatsammlung pro Figur). Der eigentliche
// dialog-Typ ist davon unabhängig per Checkbox steuerbar.
function buildDialogSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys,
    pageContents, figRows, figNamesSorted, dialogsByFigure,
  } = ctx;

  if (!figNamesSorted.length) return;

  // Wie oft jedes Zitat im Buch steht — auch die ohne zugeordneten Sprecher.
  const quoteFreq = new Map();
  for (const p of pageContents) {
    for (const d of extractDialogs(p.text)) {
      const k = normQuote(d.quote);
      quoteFreq.set(k, (quoteFreq.get(k) || 0) + 1);
    }
  }

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
      if (!opts.types.dialog || d.quote.length < DIALOG_LINE_MIN || looksLikeNarration(d.quote)) continue;
      // Vorlauf: die Sätze vor dem Zitat, an einer Satzgrenze begonnen.
      const lead = tailFromSentence(p.text.slice(0, d.start).trim(), 500);
      if (lead.length < 80) continue;
      const userPart = langIsEn
        ? `Write ${speaker}'s next line of dialogue. What happened before:\n\n${lead}`
        : `Schreibe die nächste Dialogzeile von ${speaker}. Der Vorlauf:\n\n${lead}`;
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
        if (e.quote.length < WHO_SAYS_MIN_CHARS || e.quote.length > 600) continue;
        if (e.quote.split(/\s+/).length < WHO_SAYS_MIN_WORDS) continue;
        if ((quoteFreq.get(normQuote(e.quote)) || 0) > 1) continue;
        if (looksLikeNarration(e.quote)) continue;
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
