'use strict';
// Welt-Fakten als Prüfgrundlage für EINEN Abschnitt — Auswahl für das Abschnitts-
// Lektorat (Typen «weltfakt» und «soziolekt», routes/jobs/lektorat-page.js) und den
// Welt-Block des Abschnitts-Chats. Rein (keine DB): der Aufrufer lädt die Fakten einmal
// über db/world-facts.js#listWorldFacts({ withChapterIds: true }).
//
// Auswahl:
//   welt       — alle Kategorien ausser «soziolekt». Ein Fakt ist relevant, wenn sein
//                Subjekt im Abschnitt vorkommt (stärker) oder er am Kapitel hängt.
//   soziolekte — Kategorie «soziolekt» zu Figuren, die im Abschnitt vorkommen.
// Fakten, deren Fundstelle DIESER Abschnitt ist (`seite`), fallen weg: ein Widerspruch
// zum eigenen, früher extrahierten Stand ist eine Überarbeitung, kein Fehler.
//
// Gedeckelt (Anzahl + Zeichen), damit ein faktenreiches Kapitel den Prompt nicht flutet.

const MAX_WELT = 40;
const MAX_WELT_CHARS = 4000;
const MAX_SOZIOLEKT = 12;

function _norm(s) {
  return String(s || '').normalize('NFC').toLocaleLowerCase('de').replace(/\s+/g, ' ').trim();
}

// Kommt das Subjekt im Text vor? Ganzes Subjekt, sonst sein erstes Wort, wenn es nach
// einem Eigennamen aussieht (gross, ≥ 4 Zeichen: «Adrian» aus «Adrian und Renate»).
function _subjektImText(subjekt, textNorm) {
  const s = _norm(subjekt);
  if (s.length < 3) return false;
  if (textNorm.includes(s)) return true;
  const first = String(subjekt || '').trim().split(/\s+/)[0] || '';
  return first.length >= 4 && /^\p{Lu}/u.test(first) && textNorm.includes(_norm(first));
}

/**
 * @param {object} args
 *   facts      listWorldFacts(..., { withChapterIds: true })
 *   chapterId  Kapitel des Abschnitts (oder null)
 *   text       Klartext des Abschnitts
 *   pageName   Name des Abschnitts (Fakten mit dieser Fundstelle fallen weg)
 * @returns {{ welt: Array<{kategorie,subjekt,fakt}>, soziolekte: Array<{subjekt,fakt}> }}
 */
function selectPageWorldFacts({ facts, chapterId = null, text = '', pageName = '' }) {
  const textNorm = _norm(text);
  const page = _norm(pageName);
  const welt = [];
  const soziolekte = [];
  (facts || []).forEach((f, i) => {
    if (!f?.fakt) return;
    if (page && _norm(f.seite) === page) return;
    const imText = !!f.subjekt && _subjektImText(f.subjekt, textNorm);
    if (f.kategorie === 'soziolekt') {
      if (imText) soziolekte.push({ i, subjekt: f.subjekt, fakt: f.fakt });
      return;
    }
    const imKapitel = chapterId != null && (f.chapter_ids || []).some(id => String(id) === String(chapterId));
    const score = (imText ? 2 : 0) + (imKapitel ? 1 : 0);
    if (score) welt.push({ i, score, kategorie: f.kategorie, subjekt: f.subjekt || null, fakt: f.fakt });
  });
  welt.sort((a, b) => b.score - a.score || a.i - b.i);
  const out = [];
  let chars = 0;
  for (const w of welt) {
    if (out.length >= MAX_WELT) break;
    const len = (w.subjekt || '').length + w.fakt.length + 4;
    if (out.length && chars + len > MAX_WELT_CHARS) break;
    chars += len;
    out.push({ kategorie: w.kategorie, subjekt: w.subjekt, fakt: w.fakt });
  }
  return {
    welt: out,
    soziolekte: soziolekte.slice(0, MAX_SOZIOLEKT).map(({ subjekt, fakt }) => ({ subjekt, fakt })),
  };
}

module.exports = { selectPageWorldFacts, MAX_WELT, MAX_WELT_CHARS, MAX_SOZIOLEKT };
