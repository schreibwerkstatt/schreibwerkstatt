'use strict';

// Fassungs-Drift: „lohnt sich eine neue Fassung?" — misst, wie stark der aktuelle
// Buchstand von der Baseline-Fassung (book_snapshots#getBaselineSnapshot)
// abweicht, ohne selbst eine Fassung anzulegen. Fuenf Achsen:
//   1) Text — Anteil des editierten Wort-Volumens (symmetrisch: 0% unveraendert,
//      ~100% Voll-Umschrieb). Fundiert per Wort-Diff je Seite (Match ueber srcId),
//      neu/entfernt zaehlen mit ihrem vollen Wort-Volumen.
//   2) Struktur — umbenannte/verschobene/umsortierte Abschnitte, Kapitel-
//      Aenderungen (Summary aus public/js/book-snapshot-diff.js#diffSnapshots,
//      vom Aufrufer berechnet).
//   3) Buch-Kopf — Titel/Beschreibung (books).
//   4) Publikation — geaenderte Titelei-/Impressum-Felder und ausgetauschte
//      Bilder (Keys aus book-snapshot-diff.js#diffPublication, vom Aufrufer).
//   5) Buch-Einstellungen — Buchtyp, Perspektive, Zitierstil … (book_settings).
//
// `worthwhile` = Text-Drift >= Schwelle ODER eine der anderen Achsen geaendert.
//
// Pure — keine DB, kein Express. node:test-bar.

const { htmlToPlainText } = require('./html-text');
const { diffWords, diffSentences } = require('diff');

// Ab dieser Text-Drift (Anteil des editierten Wort-Volumens) gilt eine neue Fassung
// als empfehlenswert. 0.10 = „~10% aller Texte geaendert".
const TEXT_THRESHOLD = 0.10;

// Ab diesem Wort-Volumen (alt + neu) eines Abschnitts diffen wir satzweise statt
// wortweise: der Wort-Diff ist O(N·D) und laeuft im Request-Thread — ein grosser,
// stark umgeschriebener Abschnitt hielte sonst den ganzen Prozess an. Ein
// geaenderter Satz zaehlt dann mit allen seinen Woertern (leicht ueberschaetzt).
const WORD_DIFF_MAX_WORDS = 20000;

// Buch-Einstellungen, deren Aenderung das Manuskript bzw. seine Ausgabe betrifft
// (Teilmenge von lib/book-bundle.js#SETTINGS_KEYS). Bewusst NICHT dabei: Arbeits-
// und Status-Felder (is_finished, Tagesziel, Zielvorgaben, Statistik-Ausschluss),
// das automatisch extrahierte Stilprofil und das Recherche-Profil — sie aendern
// am Text nichts und loesten sonst „neue Fassung empfohlen" ohne Anlass aus.
const SETTINGS_FIELDS = [
  'language', 'region', 'buchtyp', 'buch_kontext', 'erzaehlperspektive',
  'erzaehlzeit', 'orte_real', 'schauplatz_land', 'entities_enabled',
  'zeitlinie_real', 'weltfakten_real_pruefen', 'textsorte',
  'citation_style', 'bibliography_enabled', 'bibliography_title', 'bibliography_scope',
  'bibliography_in_blog', 'citation_notes', 'figure_numbering', 'table_numbering',
];

// Buch-Kopf (books.name/description) — der Titel steht auf Cover und Titelei.
const BOOK_FIELDS = ['name', 'description'];

// content = buildBookJson-Format ({ book, tree:[node…] }) oder direkt das Node-Array.
// Seiten in Lesereihenfolge, Text bereits normalisiert (gleiche Quelle wie page_stats).
function _flattenPages(content) {
  const nodes = Array.isArray(content) ? content : (content && Array.isArray(content.tree) ? content.tree : []);
  const out = [];
  (function walk(list) {
    for (const node of (list || [])) {
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'page') {
        out.push({
          srcId: Number.isFinite(node.srcId) ? node.srcId : null,
          text: htmlToPlainText(typeof node.html === 'string' ? node.html : ''),
        });
      } else if (node.type === 'chapter') {
        walk(node.children);
      }
    }
  })(nodes);
  return out;
}

function _wordCount(t) {
  const s = (t || '').trim();
  return s ? s.split(/\s+/).length : 0;
}

// Editiertes Wort-Volumen zwischen zwei Texten (hinzugefuegt + entfernt). Ein
// ersetztes Wort zaehlt als 1 entfernt + 1 hinzugefuegt → symmetrisch zum Nenner
// (base+cur), sodass ein Voll-Umschrieb ~100% ergibt.
function _changedWords(a, b, maxWords = WORD_DIFF_MAX_WORDS) {
  if (a === b) return 0;
  const diff = _wordCount(a) + _wordCount(b) > maxWords ? diffSentences : diffWords;
  let n = 0;
  for (const part of diff(a || '', b || '')) {
    if (part.added || part.removed) n += _wordCount(part.value);
  }
  return n;
}

function _pubText(v) { return v == null ? '' : String(v).trim(); }

// Geaenderte Einstellungs-Felder als Key-Liste (lose Gleichheit ueber String-Form,
// damit 0/„0"/null/„" nicht als Aenderung durchschlagen).
function _changedSettingsFields(fromSettings, toSettings) {
  const a = fromSettings || {};
  const b = toSettings || {};
  const norm = (v) => (v == null ? '' : String(v).trim());
  const out = [];
  for (const key of SETTINGS_FIELDS) {
    if (norm(a[key]) !== norm(b[key])) out.push(key);
  }
  return out;
}

// Geaenderte Buch-Kopf-Felder (Titel/Beschreibung).
function _changedBookFields(fromBook, toBook) {
  const a = fromBook || {};
  const b = toBook || {};
  return BOOK_FIELDS.filter((key) => _pubText(a[key]) !== _pubText(b[key]));
}

// Struktur-Zaehler aus der diffSnapshots-Summary (null = nicht berechnet).
function _structure(summary) {
  const s = summary || {};
  const n = (k) => Number(s[k]) || 0;
  const out = {
    renamedPages: n('renamed'), movedPages: n('moved'), reorderedPages: n('reordered'),
    chaptersAdded: n('chaptersAdded'), chaptersRemoved: n('chaptersRemoved'), chaptersChanged: n('chaptersChanged'),
  };
  return { ...out, changed: Object.values(out).some((v) => v > 0) };
}

// Kern-Berechnung. baseline/current im buildBookJson-Format; Settings in
// getBookSettings-Form. `publicationFields` = geaenderte Publikations-Keys
// (diffPublication), `structureSummary` = diffSnapshots(...).summary — beide
// rechnet der Aufrufer mit dem geteilten Browser-Modul. Alles optional.
function computeDrift({
  baselineContent, currentContent,
  publicationFields = [], structureSummary = null,
  baselineSettings = null, currentSettings = null,
  threshold = TEXT_THRESHOLD, maxWordDiff = WORD_DIFF_MAX_WORDS,
} = {}) {
  const basePages = _flattenPages(baselineContent);
  const curPages = _flattenPages(currentContent);

  const baseById = new Map();
  for (const p of basePages) if (p.srcId != null) baseById.set(p.srcId, p);
  const curById = new Map();
  for (const p of curPages) if (p.srcId != null) curById.set(p.srcId, p);

  let changedWords = 0;
  let denomWords = 0;
  let changedPages = 0;
  let addedPages = 0;
  let removedPages = 0;
  let unchangedPages = 0;

  // Aktuelle Seiten durchgehen: bekannt (Match) oder neu.
  for (const cp of curPages) {
    const bp = cp.srcId != null ? baseById.get(cp.srcId) : null;
    if (!bp) {
      const w = _wordCount(cp.text);
      changedWords += w; denomWords += w; addedPages += 1;
      continue;
    }
    const bw = _wordCount(bp.text);
    const cw = _wordCount(cp.text);
    denomWords += bw + cw;
    if (bp.text === cp.text) { unchangedPages += 1; continue; }
    changedWords += _changedWords(bp.text, cp.text, maxWordDiff);
    changedPages += 1;
  }
  // Seit der Fassung entfernte Seiten (in baseline, nicht mehr aktuell). srcId-lose
  // baseline-Seiten (Legacy/Defekt) sind positionsfrei → als entfernt gewertet.
  for (const bp of basePages) {
    if (bp.srcId != null && curById.has(bp.srcId)) continue;
    const w = _wordCount(bp.text);
    changedWords += w; denomWords += w; removedPages += 1;
  }

  const changeRatio = denomWords > 0 ? changedWords / denomWords : 0;

  const structure = _structure(structureSummary);
  const settingsFields = _changedSettingsFields(baselineSettings, currentSettings);
  const bookFields = _changedBookFields(baselineContent?.book, currentContent?.book);
  const publicationChanged = publicationFields.length > 0;
  const settingsChanged = settingsFields.length > 0;
  const bookChanged = bookFields.length > 0;

  const worthwhile = changeRatio >= threshold || structure.changed
    || publicationChanged || settingsChanged || bookChanged;

  return {
    thresholdPct: Math.round(threshold * 100),
    worthwhile,
    text: {
      changeRatio,
      changePct: Math.round(changeRatio * 100),
      changedWords,
      totalWords: denomWords,
      changedPages,
      addedPages,
      removedPages,
      unchangedPages,
    },
    structure,
    publicationChanged,
    publicationFields,
    settingsChanged,
    settingsFields,
    bookChanged,
    bookFields,
  };
}

module.exports = {
  computeDrift,
  TEXT_THRESHOLD,
  WORD_DIFF_MAX_WORDS,
  SETTINGS_FIELDS,
  BOOK_FIELDS,
  // fuer Tests:
  _flattenPages,
  _changedWords,
};
