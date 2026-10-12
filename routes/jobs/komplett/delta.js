'use strict';
// Indikation im Start-Modal: wie viel hat sich seit der letzten Komplettanalyse
// geändert, und lohnt sich ein neuer Lauf? Rechenlogik + Schwellen in
// lib/komplett-delta.js, Lesepfade in db/komplett-delta.js. Kein KI-Call — die
// Antwort muss beim Öffnen des Modals sofort da sein und darf nichts kosten.
//
// Gelesen wird derselbe Seitensatz wie im Job (loadOrderedBookContents +
// loadPageContents, ausgeschlossene Kapitel und Stub-Abschnitte fallen weg), damit
// „Anteil am Buch" sich auf den Text bezieht, den die Analyse tatsächlich sieht.
const { loadOrderedBookContents, loadPageContents } = require('../shared/loader');
const { htmlToText } = require('../shared/ai');
const { komplettTextOpts } = require('./job-shared');
const { lastKomplettRun, revisionBaselines, deletionsSince } = require('../../../db/komplett-delta');
const { listKatalogAnker } = require('../../../db/katalog-anker');
const { textDelta, catalogWordSet, novelNames, affectedFigures, komplettVerdict } = require('../../../lib/komplett-delta');

const MIN_PAGE_CHARS = 30; // wie job-komplett.js#loadPageContents
const CAP_WORD = /[A-ZÄÖÜ][\p{L}\-']*/gu;

async function computeKomplettDelta(bookId, userEmail) {
  const run = lastKomplettRun(bookId, userEmail);
  const { chMap, pages } = await loadOrderedBookContents(bookId);
  const textOpts = komplettTextOpts(bookId, userEmail);
  const contents = await loadPageContents(pages, chMap, MIN_PAGE_CHARS, null, null, textOpts);
  const totalChars = contents.reduce((s, p) => s + p.text.length, 0);

  const lastRun = run ? {
    endedAt: run.ended_at,
    tokens: (run.tokens_in || 0) + (run.tokens_out || 0),
    usd: run.usd != null ? run.usd : null,
  } : null;
  if (!run) {
    return { lastRun, totalChars, verdict: komplettVerdict({ hasRun: false }) };
  }

  const since = run.started_at || run.ended_at;
  const changed = contents.filter(p => p.updated_at && p.updated_at > since);
  const baselines = revisionBaselines(changed.map(p => p.id), since);

  let added = 0, removed = 0, newPages = 0, approx = false;
  const addedSentences = [];
  const oldTexts = [];
  const changedIds = new Set();
  const chapters = new Map(); // chapter_id → geänderte Zeichen
  for (const p of changed) {
    const base = baselines.get(p.id);
    let d;
    if (base?.html != null) {
      const oldText = htmlToText(base.html, textOpts).trim();
      oldTexts.push(oldText);
      d = textDelta(oldText, p.text);
      // Die Retention dünnt alte Revisionen aus: liegt die Basis deutlich vor dem
      // Lauf, enthält der Vergleich auch Änderungen, die der Lauf schon gesehen hat.
      if (base.baseAt < since && _daysBetween(base.baseAt, since) > 1) approx = true;
    } else {
      // Ohne Basis-Revision: neu entstanden (erste Revision nach dem Lauf) oder
      // Stand unbekannt (Seite ohne Revisionen) — beides zählt als ganz neu.
      d = textDelta('', p.text);
      if (base?.created) newPages++;
      else approx = true;
    }
    if (d.added + d.removed === 0) continue;
    changedIds.add(p.id);
    added += d.added;
    removed += d.removed;
    addedSentences.push(...d.addedSentences);
    const key = p.chapter_id ?? 0;
    chapters.set(key, (chapters.get(key) || 0) + d.added + d.removed);
  }

  const del = deletionsSince(bookId, since);
  const deletedPages = del?.n || 0;
  // Gelöschter Text zählt mit — grob über die HTML-Länge, Tags machen ihn etwas grösser.
  removed += Math.round((del?.html_len || 0) * 0.85);

  // Bekannte Wörter: unveränderter Buchtext, der alte Stand geänderter Abschnitte
  // und die Katalog-Namen. Ein Name, der dort schon steht, ist dem letzten Lauf begegnet.
  const katalog = listKatalogAnker(bookId, userEmail);
  const known = catalogWordSet(katalog);
  const addCaps = (text) => { for (const m of text.matchAll(CAP_WORD)) known.add(m[0]); };
  for (const p of contents) if (!changedIds.has(p.id)) addCaps(p.text);
  for (const t of oldTexts) addCaps(t);
  const names = novelNames(addedSentences, known);
  const figures = affectedFigures(addedSentences, katalog.figuren);

  const changedChars = added + removed;
  const verdict = komplettVerdict({
    hasRun: true, totalChars, changedChars, newPages, deletedPages, novelNameCount: names.length,
  });
  const topChapters = [...chapters.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, chars]) => ({ id: id || null, chars }));

  return {
    lastRun,
    totalChars,
    changedChars,
    added,
    removed,
    changedPages: changedIds.size,
    newPages,
    deletedPages,
    chapterCount: chapters.size,
    topChapters,
    novelNames: names,
    affectedFigures: figures,
    approx,
    verdict,
  };
}

function _daysBetween(a, b) {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86400000;
}

module.exports = { computeKomplettDelta };
