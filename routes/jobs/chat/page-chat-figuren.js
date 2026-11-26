'use strict';
// Figuren-Auswahl des Abschnitts-Chats (docs/chats.md#abschnitts-chat).
//
// Block 1 trägt die Figuren des Kapitels — so, wie die Figurenanalyse sie dem
// Kapitel zugeordnet hat. Diese Zuordnung entsteht nur beim Analyselauf; ein
// danach geschriebenes Kapitel hat keine, ein seither erweitertes eine
// unvollständige. Zwei Ergänzungen, damit das Modell eine Figur nicht für neu oder
// unbekannt hält, nur weil sie in diesem Block fehlt:
//   - Kapitel ohne zugeordnete Figur → alle Figuren des Buchs (Rückfall). Hängt
//     nur am Kapitel, Block 1 bleibt kapitel-stabil.
//   - Figuren, die der Abschnitt oder die Frage beim Namen nennt und die Block 1
//     nicht trägt → Stammzeile (wer, wo im Buch). Abschnitt → Block 2, Frage →
//     Präambel der User-Nachricht; beides hängt am Text, nicht am Kapitel, und
//     gehört deshalb nicht in den Kapitel-Präfix.

const { escapeRegex, FIGURE_TOKEN_BLOCKLIST } = require('../../../lib/figure-name-patterns');

function _weitere(raw) {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { arr = null; } }
  return Array.isArray(arr) ? arr.filter(n => typeof n === 'string' && n.trim().length >= 2) : [];
}

/**
 * Namen, unter denen der Chat eine Figur als «genannt» zählt — strenger als der
 * Erwähnungs-Index (lib/figure-name-patterns.js), der jeden Namensteil zählt: bei
 * beschreibenden Namen («Tobias' Mutter», «Rektor der Kantonsschule Olten») träfe
 * dort jedes «Mutter», «des», «Olten». Hier: voller Name, Kurzname, weitere
 * Rufnamen, und der Vorname nur, wenn die Figur keinen Kurznamen hat
 * («Sarah Müller» → «Sarah»).
 */
function chatNamePatterns(f) {
  const out = new Set();
  const add = (s) => { const t = (s || '').trim(); if (t.length >= 2) out.add(t); };
  add(f.name); add(f.kurzname);
  for (const n of _weitere(f.weitere_namen)) add(n);
  if (!f.kurzname) {
    const first = (f.name || '').trim().split(/\s+/)[0];
    if (first && first !== (f.name || '').trim() && first.length >= 3 && !FIGURE_TOKEN_BLOCKLIST.has(first.toLowerCase())) add(first);
  }
  return [...out];
}

/** IDs (figures.id) der Figuren, die `text` beim Namen nennt. */
function mentionedFigureIds(text, figs) {
  const ids = new Set();
  if (!text) return ids;
  for (const f of figs || []) {
    for (const p of chatNamePatterns(f)) {
      // Wortgrenzen umlaut-sicher, wie der Erwähnungs-Index.
      if (new RegExp(`(?<![A-Za-zÄÖÜäöüß])${escapeRegex(p)}(?![A-Za-zÄÖÜäöüß])`, 'i').test(text)) { ids.add(f.id); break; }
    }
  }
  return ids;
}

// Deckel je Nachtrag: eine Frage, die zwanzig Figuren beim Namen nennt, ist eine
// Ensemble-Frage — die gehört in den Buch-Chat.
const NACHTRAG_MAX = 20;

/**
 * Block-1-Figuren: Kapitel-Figuren, sonst (Kapitel ohne Zuordnung) das ganze Buch.
 * @param {(chapterId: number|null) => Array} loadFiguren  getFiguren(book, user, chapterId)
 * @returns {{ figuren: Array, scope: 'kapitel'|'fallback'|'buch' }}
 */
function chapterFiguren(loadFiguren, chapterId) {
  if (chapterId == null) return { figuren: loadFiguren(null), scope: 'buch' };
  const imKapitel = loadFiguren(chapterId);
  if (imKapitel.length) return { figuren: imKapitel, scope: 'kapitel' };
  return { figuren: loadFiguren(null), scope: 'fallback' };
}

/** Kapitel-ID → { name, index } in Lesereihenfolge aus der Gliederung. */
function chapterIndex(outline) {
  const map = new Map();
  let i = 0;
  for (const n of outline || []) {
    if (n.type === 'chapter') map.set(n.id, { name: n.name, index: i++ });
  }
  return map;
}

function _row(fig, chapters) {
  const kapitel = fig.chapter_ids
    .map(id => chapters.get(id))
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .map(c => c.name);
  return {
    name: fig.name,
    kurzname: fig.kurzname || null,
    typ: fig.typ || null,
    erste_erwaehnung: fig.erste_erwaehnung || null,
    kapitel,
  };
}

function _mentioned(text, figs) {
  if (!text || !figs.length) return [];
  const ids = mentionedFigureIds(text, figs);
  return figs.filter(f => ids.has(f.id));
}

/**
 * Figuren, die Abschnitt bzw. Frage beim Namen nennen und die nicht in Block 1
 * stehen — als Stammzeilen. Eine Figur erscheint höchstens einmal (Abschnitt vor Frage).
 * @param {Object} p
 * @param {Array}  p.namen       getFigurenNamen(book, user): { id, fig_id, name, kurzname, weitere_namen, typ, erste_erwaehnung, chapter_ids }
 * @param {Array}  p.blockFiguren Block-1-Figuren (getFiguren: `id` = fig_id)
 * @param {Array}  p.outline     contentStore.bookOutline
 * @param {string} p.pageText    Abschnittstext
 * @param {string} p.question    aktuelle Frage
 * @returns {{ abschnitt: Array, frage: Array }}
 */
function figurenNachtrag({ namen, blockFiguren, outline, pageText, question }) {
  const inBlock = new Set((blockFiguren || []).map(f => f.id));
  let rest = (namen || []).filter(f => !inBlock.has(f.fig_id));
  if (!rest.length) return { abschnitt: [], frage: [] };
  const chapters = chapterIndex(outline);
  const abschnitt = _mentioned(pageText, rest).slice(0, NACHTRAG_MAX);
  const gesehen = new Set(abschnitt.map(f => f.id));
  rest = rest.filter(f => !gesehen.has(f.id));
  const frage = _mentioned(question, rest).slice(0, NACHTRAG_MAX);
  return {
    abschnitt: abschnitt.map(f => _row(f, chapters)),
    frage: frage.map(f => _row(f, chapters)),
  };
}

module.exports = { chapterFiguren, figurenNachtrag, chapterIndex, mentionedFigureIds, chatNamePatterns, NACHTRAG_MAX };
