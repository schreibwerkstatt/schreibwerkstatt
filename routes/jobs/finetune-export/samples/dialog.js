'use strict';

const { extractDialogs, tailFromSentence, looksLikeNarration } = require('../lib/text');
const { findSpeaker, hashSplit } = require('../lib/names');

// Dialogzeile als Schreibaufgabe nur ab dieser Länge: «Ja.» oder «Ich weiss
// nicht.» ist aus dem Vorlauf nicht zu erschliessen.
const DIALOG_LINE_MIN = 25;
// «Wer sagt das?» nur für Zitate, die eine Figur erkennbar machen: lang genug
// (Zeichen und Wörter, `whoSaysMinWords` aus dem Profil), genau einmal im
// Buch, einem Namen zugeordnet, den genau eine Figur trägt.
const WHO_SAYS_MIN_CHARS = 30;
const WHO_SAYS_MIN_WORDS = 6;
const WHO_SAYS_NO_SCENE_CAP = 3;
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
        quote: d.quote, chapter: p.chapter, chapterId: p.chapter_id ?? 0, page: p.title, pageId: p.id,
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
  // Die Antwort nennt die Situation — die Szene des Abschnitts, in der die
  // Figur auftritt —, damit sie eindeutig ist und unter `maxPerAnswer` fällt
  // («Das sagt Fabio in der Szene «…» (Kapitel «…»).»). Ohne eindeutige
  // Szene bleibt nur das Kapitel; davon höchstens WHO_SAYS_NO_SCENE_CAP je
  // Figur, sonst wiederholt sich «Fabio (Kapitel X)» dutzendfach.
  if (opts.types.dialog) {
    const REV_CAP_PER_FIG = 30 * (opts.biasBoost || 1);
    const scenesOnPage = new Map();
    for (const sc of ctx.sceneRows || []) {
      if (!sc.page_id || !sc.titel) continue;
      if (!scenesOnPage.has(sc.page_id)) scenesOnPage.set(sc.page_id, []);
      scenesOnPage.get(sc.page_id).push(sc);
    }
    const sceneOf = (pageId, figId) => {
      const hits = (scenesOnPage.get(pageId) || []).filter(sc => (ctx.figsByScene?.get(sc.id) || []).includes(figId));
      return hits.length === 1 ? hits[0].titel : null;
    };
    const minWords = Math.max(1, Number(opts.whoSaysMinWords) || WHO_SAYS_MIN_WORDS);
    // Name → Figuren, die ihn tragen (Name oder Kurzname). Ein geteilter
    // Kurzname («Buddenbrook») ordnet ein Zitat keiner Figur eindeutig zu.
    const owners = new Map();
    for (const g of figRows) {
      for (const n of [g.name, g.kurzname].filter(Boolean)) {
        const k = n.toLowerCase();
        if (!owners.has(k)) owners.set(k, new Set());
        owners.get(k).add(g.fig_id);
      }
    }
    const unique = (n) => n && (owners.get(n.toLowerCase())?.size || 0) <= 1;
    for (const f of figRows) {
      const entries = unique(f.name) ? (dialogsByFigure.get(f.name.toLowerCase()) || []) : [];
      const altEntries = (f.kurzname && f.kurzname !== f.name && unique(f.kurzname))
        ? (dialogsByFigure.get(f.kurzname.toLowerCase()) || [])
        : [];
      const seenQ = new Set();
      const pool = [];
      for (const e of [...entries, ...altEntries]) {
        if (seenQ.has(e.quote)) continue;
        seenQ.add(e.quote);
        if (e.quote.length < WHO_SAYS_MIN_CHARS || e.quote.length > 600) continue;
        if (e.quote.split(/\s+/).length < minWords) continue;
        if ((quoteFreq.get(normQuote(e.quote)) || 0) > 1) continue;
        if (looksLikeNarration(e.quote)) continue;
        pool.push(e);
      }
      const picked = pool
        .map(e => [hashSplit('dlgRev|' + f.fig_id + '|' + e.quote, opts.valSeed), e])
        .sort((a, b) => a[0] - b[0])
        .slice(0, REV_CAP_PER_FIG)
        .map(([, e]) => e);
      let noScene = 0;
      const usedAnswers = new Set();
      picked.forEach((e, i) => {
        const scene = sceneOf(e.pageId, f.fig_id);
        const answer = whoSaysAnswer(f.name, scene, e.chapter, langIsEn);
        // Jede Antwort einmal: zwei Zitate derselben Szene lehrten dieselbe
        // Antwort auf verschiedene Fragen.
        if (usedAnswers.has(answer)) return;
        if (!scene && ++noScene > WHO_SAYS_NO_SCENE_CAP) return;
        usedAnswers.add(answer);
        samples.push({
          id: 'dialogRev|' + f.fig_id + '|' + i,
          type: 'dialog',
          sourceKey: 'ch:' + e.chapterId,
          messages: [
            { role: 'system', content: unifiedSys },
            { role: 'user',   content: (langIsEn
              ? `Who says this: \u201C${e.quote}\u201D?`
              : `Wer sagt das: «${e.quote}»?`) },
            { role: 'assistant', content: answer },
          ],
        });
        counts.dialog++;
      });
    }
  }
}

function whoSaysAnswer(name, scene, chapter, langIsEn) {
  const ch = chapter ? (langIsEn ? ` (chapter «${chapter}»)` : ` (Kapitel «${chapter}»)`) : '';
  if (scene) return langIsEn ? `${name} says that in the scene «${scene}»${ch}.` : `Das sagt ${name} in der Szene «${scene}»${ch}.`;
  if (chapter) return langIsEn ? `${name} says that in the chapter «${chapter}».` : `Das sagt ${name} im Kapitel «${chapter}».`;
  return langIsEn ? `${name} says that.` : `Das sagt ${name}.`;
}

module.exports = { buildDialogSamples, whoSaysAnswer };
