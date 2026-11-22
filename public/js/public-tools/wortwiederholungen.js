// Rechenkern des oeffentlichen Werkzeugs /wortwiederholungen: nahe
// Wortwiederholungen, lange Saetze, gehaeufte Satzanfaenge. Pure — kein DOM,
// kein Netz; die Seite (wortwiederholungen-page.js) rendert das Ergebnis.
// Laeuft ausschliesslich im Browser des Besuchers: der Text verlaesst den
// Rechner nicht (so steht es auf der Seite, also nie einen Upload ergaenzen).

import { STOPWORDS_DE_BASE } from '../shared/stopwords-de.js';
import { compareText } from '../i18n.js';

// Englische Funktionswoerter, damit englische Texte nicht von «that»/«with»
// dominiert werden. Bewusst kurz: das Werkzeug zaehlt nur Woerter ab
// MIN_WORD_LEN Zeichen, kuerzere fallen ohnehin weg.
const STOPWORDS_EN = [
  'that', 'this', 'these', 'those', 'with', 'from', 'have', 'were', 'been', 'into',
  'than', 'then', 'them', 'they', 'their', 'there', 'what', 'when', 'where', 'which',
  'while', 'would', 'could', 'should', 'about', 'after', 'before', 'over', 'under',
  'just', 'only', 'also', 'very', 'some', 'such', 'your', 'yours', 'will', 'shall',
  'does', 'done', 'being', 'because', 'through', 'other', 'more', 'most', 'much',
  'here', 'like', 'said', 'upon', 'each', 'even', 'ever', 'again', 'still',
];

/** Woerter mit weniger Zeichen zaehlen nicht als Wiederholung («ich», «und»). */
export const MIN_WORD_LEN = 4;

const STOPWORDS = new Set([...STOPWORDS_DE_BASE, ...STOPWORDS_EN]);

// Wort = Buchstaben/Ziffern, im Wort auch Apostroph und Bindestrich.
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const SENTENCE_END_RE = /[.!?…]/;

/**
 * Zerlegt den Text in Absaetze und Woerter mit Positionen.
 * @returns {{ paragraphs: { text: string, words: { start: number, end: number, norm: string }[] }[] }}
 */
export function tokenize(text) {
  const paragraphs = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => ({
      text: p,
      words: [...p.matchAll(WORD_RE)].map(m => ({
        start: m.index,
        end: m.index + m[0].length,
        norm: m[0].toLowerCase().replace(/[’']/g, "'"),
      })),
    }));
  return { paragraphs };
}

function isContentWord(norm) {
  return norm.length >= MIN_WORD_LEN && !STOPWORDS.has(norm) && !/^\d+$/.test(norm);
}

/**
 * @param {string} text
 * @param {{ window?: number, long?: number, top?: number }} [opts]
 *   window: Abstand in Woertern, bis zu dem eine Wiederholung als nah gilt.
 *   long:   Wortzahl, ab der ein Satz als lang gilt.
 */
export function analyzeText(text, { window = 40, long = 30, top = 10 } = {}) {
  const { paragraphs } = tokenize(text);

  // Globale Wortliste mit Rueckverweis in den Absatz.
  const words = [];
  paragraphs.forEach((p, pi) => p.words.forEach((w, wi) => words.push({ ...w, pi, wi })));

  // Nahe Wiederholungen: Vorkommen desselben Inhaltsworts mit hoechstens
  // `window` Woertern Abstand. Beide Vorkommen werden markiert.
  const lastSeen = new Map();
  const marked = new Set();
  words.forEach((w, i) => {
    if (!isContentWord(w.norm)) return;
    const prev = lastSeen.get(w.norm);
    if (prev !== undefined && i - prev <= window) {
      marked.add(prev);
      marked.add(i);
    }
    lastSeen.set(w.norm, i);
  });
  // Je Wort: wie viele seiner Vorkommen stehen in einer nahen Wiederholung.
  const repeatCounts = new Map();
  for (const i of marked) repeatCounts.set(words[i].norm, (repeatCounts.get(words[i].norm) || 0) + 1);

  // Saetze: Grenze, wo zwischen zwei Woertern ein Satzzeichen steht, und am
  // Absatzende. Abkuerzungen («z. B.») schneiden mit — fuer eine Lesehilfe
  // genuegt das, und es haelt das Werkzeug ohne Sprachmodell.
  const sentences = [];
  for (const p of paragraphs) {
    let cur = [];
    p.words.forEach((w, wi) => {
      cur.push(w);
      const next = p.words[wi + 1];
      const gap = next ? p.text.slice(w.end, next.start) : '';
      if (!next || SENTENCE_END_RE.test(gap)) {
        const first = cur[0];
        const tail = next ? p.text.slice(w.end, next.start).trimEnd() : p.text.slice(w.end);
        sentences.push({
          text: (p.text.slice(first.start, w.end) + tail).trim(),
          words: cur.length,
          opener: first.norm,
        });
        cur = [];
      }
    });
  }

  const totalWords = words.length;
  const avg = sentences.length ? totalWords / sentences.length : 0;

  const repeats = [...repeatCounts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || compareText(a.word, b.word))
    .slice(0, top);

  const longSentences = sentences
    .filter(s => s.words >= long)
    .sort((a, b) => b.words - a.words)
    .slice(0, Math.min(top, 5));

  // Satzanfaenge: hier zaehlen auch Funktionswoerter («Er», «Dann») — gerade
  // die haeufen sich. Ab drei gleichen Anfaengen und mehr als jedem zehnten Satz.
  const openerCounts = new Map();
  for (const s of sentences) openerCounts.set(s.opener, (openerCounts.get(s.opener) || 0) + 1);
  const openerMin = Math.max(3, Math.ceil(sentences.length / 10));
  const openers = [...openerCounts.entries()]
    .filter(([, c]) => c >= openerMin)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || compareText(a.word, b.word))
    .slice(0, top);

  // Markierungen je Absatz als Wort-Indizes, fuers Rendern.
  const markedByParagraph = paragraphs.map(() => new Set());
  for (const i of marked) markedByParagraph[words[i].pi].add(words[i].wi);

  return {
    paragraphs,
    markedByParagraph,
    stats: {
      words: totalWords,
      sentences: sentences.length,
      avg: Math.round(avg * 10) / 10,
      repeats: marked.size,
    },
    repeats,
    longSentences,
    openers,
  };
}
