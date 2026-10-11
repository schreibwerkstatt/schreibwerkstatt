'use strict';
/**
 * Lohnt sich eine Komplettanalyse? — reine Rechenlogik der Indikation im Start-Modal.
 *
 * Verglichen wird der Text, den der letzte erfolgreiche Lauf gelesen hat (Stand zu
 * seinem `started_at`, rekonstruiert aus `page_revisions`), mit dem heutigen Text.
 * Kein KI-Call: die Indikation muss sofort da sein und darf nichts kosten — sie soll
 * ja gerade einen teuren Lauf ersparen.
 *
 * Bewusst satzweise statt zeichengenau: die Analyse extrahiert Entitäten und Fakten,
 * ein umformulierter Satz kann eine neue Angabe tragen, ein verschobener Absatz nicht.
 * Ein Satz-Multiset-Vergleich zählt also Umformulierungen, aber keine reinen
 * Umstellungen — genau die Achse, die für den Katalog zählt.
 *
 * Neue Namen: gross geschriebene Wörter im hinzugekommenen Text, die weder sonst im
 * Buch noch im Katalog (Name, Kurzname, Aliase von Figuren und Schauplätzen) stehen.
 * Im Deutschen sind auch Substantive gross — deshalb nur Wörter, die nicht am
 * Satzanfang stehen und mindestens zweimal vorkommen; das Ergebnis heisst im UI
 * „neue Namen oder Begriffe" und wird zur Beurteilung aufgelistet, nicht gezählt
 * und verschwiegen.
 */

// Schwellen der Empfehlung, Anteil geänderter Zeichen am Buch.
const RATIO_RECOMMENDED = 0.10;
const RATIO_OPTIONAL = 0.02;
// Ab so vielen neuen Namen kommt der Katalog sichtbar ins Hintertreffen.
const NAMES_RECOMMENDED = 3;
const NOVEL_NAME_MIN_COUNT = 2;
const NOVEL_NAME_LIMIT = 8;
const AFFECTED_FIGURES_LIMIT = 8;

// Anreden tragen keine Identität: „Herr" im neuen Text heisst nicht, dass jede
// Figur namens „Herr …" betroffen ist.
const TITLE_WORDS = new Set(['Herr', 'Herrn', 'Frau', 'Fräulein', 'Doktor', 'Professor', 'Mister', 'Miss', 'Lady', 'Sir']);

const SENTENCE_SPLIT = /(?<=[.!?…»«"“”])\s+|\n+/;
const NAME_TOKEN = /[A-ZÄÖÜ][a-zäöüß]{2,}(?:-[A-ZÄÖÜ][a-zäöüß]+)?/g;
const WORD_TOKEN = /[\p{L}][\p{L}\-']*/gu;

function splitSentences(text) {
  return String(text || '')
    .split(SENTENCE_SPLIT)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Satz-Multiset-Differenz. Liefert die hinzugekommenen Sätze (für die Namenssuche)
 * und die Zeichenzahl hinzugekommener bzw. entfallener Sätze.
 */
function textDelta(oldText, newText) {
  const counts = new Map();
  for (const s of splitSentences(oldText)) counts.set(s, (counts.get(s) || 0) + 1);
  const addedSentences = [];
  let added = 0;
  for (const s of splitSentences(newText)) {
    const c = counts.get(s) || 0;
    if (c > 0) counts.set(s, c - 1);
    else { addedSentences.push(s); added += s.length; }
  }
  let removed = 0;
  for (const [s, c] of counts) removed += s.length * c;
  return { added, removed, addedSentences };
}

function _wordSet(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(WORD_TOKEN)) out.add(m[0]);
  return out;
}

/** Alle Namensbestandteile des Katalogs als Wort-Set (Name, Kurzname, Aliase). */
function catalogWordSet(katalog) {
  const out = new Set();
  const add = (s) => { for (const w of _wordSet(s)) out.add(w); };
  for (const f of katalog?.figuren || []) {
    add(f.name); add(f.ki_name); add(f.kurzname);
    for (const a of f.aliases || []) add(typeof a === 'string' ? a : a?.alias || a?.name);
  }
  for (const o of katalog?.orte || []) { add(o.name); add(o.ki_name); }
  return out;
}

/**
 * Kandidaten für neue Namen in den hinzugekommenen Sätzen. `knownWords` = Wörter
 * aus dem unveränderten Buchtext und dem Katalog.
 */
function novelNames(addedSentences, knownWords) {
  const counts = new Map();
  for (const sentence of addedSentences) {
    for (const m of sentence.matchAll(NAME_TOKEN)) {
      if (m.index === 0) continue; // Satzanfang: Grossschreibung sagt dort nichts
      const w = m[0];
      if (knownWords.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= NOVEL_NAME_MIN_COUNT)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, NOVEL_NAME_LIMIT)
    .map(([name, count]) => ({ name, count }));
}

/** Bestandsfiguren, deren Name/Kurzname/Alias im hinzugekommenen Text vorkommt. */
function affectedFigures(addedSentences, figuren) {
  const words = _wordSet(addedSentences.join(' '));
  const hits = [];
  for (const f of figuren || []) {
    if (f.stale) continue;
    const names = [f.kurzname, f.name, ...(f.aliases || []).map(a => (typeof a === 'string' ? a : a?.alias || a?.name))]
      .filter(n => typeof n === 'string' && n.trim().length >= 3);
    // Mehrteilige Namen zählen, wenn ein tragender Bestandteil (≥ 3 Zeichen, gross) fällt.
    const hit = names.some(n => [...n.matchAll(NAME_TOKEN)].some(m => !TITLE_WORDS.has(m[0]) && words.has(m[0])));
    if (hit) hits.push({ id: f.id, name: f.kurzname || f.name });
  }
  return { count: hits.length, list: hits.slice(0, AFFECTED_FIGURES_LIMIT) };
}

/**
 * Empfehlung aus den Kennzahlen. `level`:
 *   'never'       – noch kein erfolgreicher Lauf
 *   'skip'        – nichts geändert
 *   'low'         – kaum Änderungen, Lauf lohnt eher nicht
 *   'optional'    – spürbare Änderungen, ein Katalog-Lauf kann sich lohnen
 *   'recommended' – grössere Änderungen oder neue Namen
 * `reasons` sind i18n-Schlüssel-Suffixe unter `komplett.delta.reason.*`.
 */
function komplettVerdict({ hasRun, totalChars, changedChars, newPages, deletedPages, novelNameCount }) {
  if (!hasRun) return { level: 'never', reasons: ['never'] };
  const ratio = totalChars > 0 ? changedChars / totalChars : (changedChars > 0 ? 1 : 0);
  const reasons = [];
  if (ratio >= RATIO_RECOMMENDED) reasons.push('muchText');
  if (novelNameCount >= NAMES_RECOMMENDED) reasons.push('manyNames');
  if (reasons.length) return { level: 'recommended', reasons, ratio };
  if (ratio >= RATIO_OPTIONAL) reasons.push('someText');
  if (novelNameCount > 0) reasons.push('someNames');
  if (newPages > 0) reasons.push('newPages');
  if (deletedPages > 0) reasons.push('deletedPages');
  if (reasons.length) return { level: 'optional', reasons, ratio };
  if (changedChars === 0) return { level: 'skip', reasons: ['nothing'], ratio };
  return { level: 'low', reasons: ['littleText'], ratio };
}

module.exports = {
  splitSentences, textDelta, catalogWordSet, novelNames, affectedFigures, komplettVerdict,
  RATIO_RECOMMENDED, RATIO_OPTIONAL, NAMES_RECOMMENDED,
};
