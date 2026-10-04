'use strict';
// Persistenz der Wortschatz-Analyse. Alle drei Tabellen sind ABGELEITETE Indexe:
// sie werden nie inkrementell fortgeschrieben, sondern pro Scan als Ganzes
// ersetzt (`replaceBookLexicon`, eine Transaktion). Warum kein Delta: die
// Ranglisten sind gedeckelt (Top-N) — ein Term, der aus den Top-200 fällt, müsste
// beim Delta-Schreiben aktiv gelöscht werden, und genau das vergisst man. Ein
// Full-Replace kann diesen Zustand nicht erzeugen.
//
// Buch-skopiert, nicht user-skopiert: der Wortschatz ist eine Eigenschaft des
// Textes, nicht des Betrachters. Der Zugriffsschutz liegt in der Buch-ACL
// (routes/lexicon.js), nicht in einer `user_email`-Spalte.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const _stmtDelStats = db.prepare('DELETE FROM book_lexicon WHERE book_id = ?');
const _stmtDelTerms = db.prepare('DELETE FROM lexicon_terms WHERE book_id = ?');
const _stmtDelNgrams = db.prepare('DELETE FROM lexicon_ngrams WHERE book_id = ?');
const _stmtDelChapters = db.prepare('DELETE FROM chapter_lexicon WHERE book_id = ?');
const _stmtDelIdiolect = db.prepare('DELETE FROM figure_idiolect WHERE book_id = ?');

const _stmtInsertChapter = db.prepare(`
  INSERT INTO chapter_lexicon (chapter_id, book_id, position, tokens, types, hapax_ratio,
    mattr, mattr_window, mtld, yule_k, lex_density, delta, delta_top_json)
  VALUES (@chapter_id, @book_id, @position, @tokens, @types, @hapax_ratio,
    @mattr, @mattr_window, @mtld, @yule_k, @lex_density, @delta, @delta_top_json)
`);

const _stmtInsertIdiolect = db.prepare(`
  INSERT INTO figure_idiolect (figure_id, book_id, utterances, tokens, types, mattr,
    mattr_window, mtld, avg_utterance_len, terms_json)
  VALUES (@figure_id, @book_id, @utterances, @tokens, @types, @mattr,
    @mattr_window, @mtld, @avg_utterance_len, @terms_json)
`);

// Existenz-Checks vor dem Schreiben abgeleiteter Zeilen — derselbe Grund wie bei
// `_safePageId`: der Scan läuft über Minuten, ein inzwischen gelöschtes Kapitel
// (bzw. eine gelöschte Figur) würde per FK-Verstoss die ganze Analyse verwerfen.
// Hier fällt die Zeile weg statt nur das Sprungziel: ohne ihr Kapitel ist sie leer.
const _stmtChapterInBook = db.prepare('SELECT 1 FROM chapters WHERE chapter_id = ? AND book_id = ?');
const _stmtFigureInBook = db.prepare('SELECT 1 FROM figures WHERE id = ? AND book_id = ?');

const _stmtInsertStats = db.prepare(`
  INSERT INTO book_lexicon (
    book_id, scanned_at, lexicon_version, content_sig, input_sig,
    pages, segments, tokens, types, lemma_types, hapax, hapax_listed, dislegomena, hapax_ratio,
    mattr, mattr_window, mattr_windows, mtld, yule_k, heaps_beta, heaps_k, lex_density,
    idiolect_coverage, freq_json
  ) VALUES (
    @book_id, ${NOW_ISO_SQL}, @lexicon_version, @content_sig, @input_sig,
    @pages, @segments, @tokens, @types, @lemma_types, @hapax, @hapax_listed, @dislegomena, @hapax_ratio,
    @mattr, @mattr_window, @mattr_windows, @mtld, @yule_k, @heaps_beta, @heaps_k, @lex_density,
    @idiolect_coverage, @freq_json
  )
`);

const _stmtInsertTerm = db.prepare(`
  INSERT INTO lexicon_terms (book_id, term, kind, count, chapter_spread, keyness, first_page_id, novel, sort_rank)
  VALUES (@book_id, @term, @kind, @count, @chapter_spread, @keyness, @first_page_id, @novel, @sort_rank)
`);

const _stmtInsertNgram = db.prepare(`
  INSERT INTO lexicon_ngrams (book_id, phrase, n, count, chapter_spread, log_dice, first_page_id)
  VALUES (@book_id, @phrase, @n, @count, @chapter_spread, @log_dice, @first_page_id)
`);

// Seiten-IDs, die es wirklich gibt — `first_page_id` ist ein FK, und der Scan
// kann eine Seite gesehen haben, die zwischen Analyse und Schreiben gelöscht wurde
// (der Scan läuft über Minuten). Ein FK-Verstoss würde die ganze Transaktion
// verwerfen und damit die komplette Analyse; ein fehlendes Sprungziel kostet nur
// den Klick.
const _stmtPageExists = db.prepare('SELECT 1 FROM pages WHERE page_id = ?');
function _safePageId(id) {
  if (id == null) return null;
  return _stmtPageExists.get(id) ? id : null;
}

// Full-Replace in einer Transaktion: erst die drei Tabellen für das Buch leeren,
// dann neu füllen. Reihenfolge innerhalb der Transaktion ist unkritisch (keine
// Abhängigkeit untereinander), die Atomarität ist es nicht: ein Abbruch nach dem
// DELETE würde das Buch sonst ohne Analyse dastehen lassen, obwohl es eine hatte.
const _replace = db.transaction((bookId, { stats, terms, phrases, chapters, idiolect }) => {
  _stmtDelTerms.run(bookId);
  _stmtDelNgrams.run(bookId);
  _stmtDelChapters.run(bookId);
  _stmtDelIdiolect.run(bookId);
  _stmtDelStats.run(bookId);

  _stmtInsertStats.run({
    book_id: bookId,
    lexicon_version: stats.version ?? 0,
    content_sig: stats.content_sig ?? null,
    input_sig: stats.input_sig ?? null,
    pages: stats.pages ?? null,
    segments: stats.segments ?? null,
    tokens: stats.tokens ?? null,
    types: stats.types ?? null,
    lemma_types: stats.lemma_types ?? null,
    hapax: stats.hapax ?? null,
    hapax_listed: stats.hapax_listed ?? null,
    dislegomena: stats.dislegomena ?? null,
    hapax_ratio: stats.hapax_ratio ?? null,
    mattr: stats.mattr ?? null,
    mattr_window: stats.mattr_window ?? null,
    mattr_windows: stats.mattr_windows ?? null,
    mtld: stats.mtld ?? null,
    yule_k: stats.yule_k ?? null,
    heaps_beta: stats.heaps_beta ?? null,
    heaps_k: stats.heaps_k ?? null,
    lex_density: stats.lex_density ?? null,
    idiolect_coverage: stats.idiolect_coverage ?? null,
    freq_json: stats.freq_json ?? null,
  });

  for (const t of terms || []) {
    _stmtInsertTerm.run({
      book_id: bookId,
      term: t.term,
      // Ohne `kind` gaebe es keinen Weg, die drei Zeilensorten wieder zu trennen —
      // ein Einmalwort ist nicht „ein Lieblingswort mit count 1".
      kind: t.kind || 'freq',
      count: t.count,
      chapter_spread: t.chapter_spread ?? 0,
      keyness: t.keyness ?? null,
      first_page_id: _safePageId(t.first_page_id),
      novel: t.novel ?? null,
      sort_rank: t.sort_rank ?? null,
    });
  }
  for (const p of phrases || []) {
    _stmtInsertNgram.run({
      book_id: bookId,
      phrase: p.phrase,
      n: p.n,
      count: p.count,
      chapter_spread: p.chapter_spread ?? 0,
      log_dice: p.log_dice ?? null,
      first_page_id: _safePageId(p.first_page_id),
    });
  }
  let position = 0;
  for (const c of chapters || []) {
    position++;
    if (!_stmtChapterInBook.get(c.chapter_id, bookId)) continue;
    _stmtInsertChapter.run({
      chapter_id: c.chapter_id,
      book_id: bookId,
      position,
      tokens: c.tokens,
      types: c.types,
      hapax_ratio: c.hapax_ratio ?? null,
      mattr: c.mattr ?? null,
      mattr_window: c.mattr_window ?? null,
      mtld: c.mtld ?? null,
      yule_k: c.yule_k ?? null,
      lex_density: c.lex_density ?? null,
      delta: c.delta ?? null,
      delta_top_json: c.delta_top ? JSON.stringify(c.delta_top) : null,
    });
  }
  for (const f of idiolect || []) {
    if (!_stmtFigureInBook.get(f.figure_id, bookId)) continue;
    _stmtInsertIdiolect.run({
      figure_id: f.figure_id,
      book_id: bookId,
      utterances: f.utterances,
      tokens: f.tokens,
      types: f.types,
      mattr: f.mattr ?? null,
      mattr_window: f.mattr_window ?? null,
      mtld: f.mtld ?? null,
      avg_utterance_len: f.avg_utterance_len ?? null,
      terms_json: JSON.stringify(f.terms || []),
    });
  }
});

function replaceBookLexicon(bookId, result) {
  _replace(bookId, result);
}

// Spalten explizit, NICHT `SELECT *`: `freq_json` ist die Referenz-Frequenztabelle
// (bis ~5000 Terme) und hat im Lesepfad der Karte nichts zu suchen — sie würde bei
// jedem Kartenaufruf mitgeschleppt.
const _stmtGetStats = db.prepare(`
  SELECT book_id, scanned_at, lexicon_version, content_sig,
         pages, segments, tokens, types, lemma_types, hapax, hapax_listed, dislegomena, hapax_ratio,
         mattr, mattr_window, mattr_windows, mtld, yule_k, heaps_beta, heaps_k, lex_density,
         idiolect_coverage
    FROM book_lexicon WHERE book_id = ?
`);

// Ranglisten kommen mit dem Seitennamen des Sprungziels, damit die Karte kein
// zweites Roundtrip pro Zeile braucht. Snapshot-Spalten wären hier verboten
// (siehe „Snapshot-Spalten verboten" in CLAUDE.md) — der Name kommt per JOIN.
// Wortliste ohne die Einmalwörter: das ist eine eigene Rangliste mit eigener
// Auswahlregel und eigenem Reiter, und sie ist um ein Vielfaches länger — in
// derselben Tabelle gemischt würde sie die Lieblingswörter erschlagen.
const _stmtListTerms = db.prepare(`
  SELECT lt.term, lt.kind, lt.count, lt.chapter_spread, lt.keyness, lt.first_page_id,
         p.page_name AS first_page_name
    FROM lexicon_terms lt
    LEFT JOIN pages p ON p.page_id = lt.first_page_id
   WHERE lt.book_id = ? AND lt.kind != 'hapax'
   ORDER BY lt.count DESC, lt.term
`);

// Einmalwörter in der Reihenfolge, nach der der Scan ausgewählt hat
// (`sort_rank`: erst „sonst nie benutzt", dann lang zuerst — siehe
// lib/lexicon/analyze.js#_selectHapax). Die Reihenfolge selbst als Spalte, nicht
// in SQL nachgebaut: `novel` hängt an der Referenz zum Scanzeitpunkt, und SQLites
// binäre Sortierung ist nicht die `localeCompare` der Auswahl.
const _stmtListHapax = db.prepare(`
  SELECT lt.term, lt.novel, lt.sort_rank, lt.first_page_id, p.page_name AS first_page_name
    FROM lexicon_terms lt
    LEFT JOIN pages p ON p.page_id = lt.first_page_id
   WHERE lt.book_id = ? AND lt.kind = 'hapax'
   ORDER BY lt.sort_rank IS NULL, lt.sort_rank, length(lt.term) DESC, lt.term
`);

const _stmtListNgrams = db.prepare(`
  SELECT ln.phrase, ln.n, ln.count, ln.chapter_spread, ln.log_dice, ln.first_page_id,
         p.page_name AS first_page_name
    FROM lexicon_ngrams ln
    LEFT JOIN pages p ON p.page_id = ln.first_page_id
   WHERE ln.book_id = ?
   ORDER BY ln.count DESC, ln.n, ln.phrase
`);

function getBookLexicon(bookId) {
  return _stmtGetStats.get(bookId) || null;
}

function listLexiconTerms(bookId) {
  return _stmtListTerms.all(bookId);
}

function listLexiconHapax(bookId) {
  return _stmtListHapax.all(bookId);
}

function listLexiconNgrams(bookId) {
  return _stmtListNgrams.all(bookId);
}

// Kapitel-Band in Buchreihenfolge (`position` = Reihenfolge des Scans). Der Name
// kommt per JOIN — keine Snapshot-Spalte.
const _stmtListChapters = db.prepare(`
  SELECT cl.chapter_id, c.chapter_name, cl.position, cl.tokens, cl.types, cl.hapax_ratio, cl.mattr,
         cl.mattr_window, cl.mtld, cl.yule_k, cl.lex_density, cl.delta, cl.delta_top_json
    FROM chapter_lexicon cl
    JOIN chapters c ON c.chapter_id = cl.chapter_id
   WHERE cl.book_id = ?
   ORDER BY cl.position
`);
function listChapterLexicon(bookId) {
  return _stmtListChapters.all(bookId).map(({ delta_top_json, ...r }) => ({
    ...r, delta_top: delta_top_json ? JSON.parse(delta_top_json) : null,
  }));
}

// Figuren-Idiolekt. Figuren sind pro Konto angelegt (`figures.user_email`); der
// Scan schreibt für alle gleichnamigen Kopien dieselbe Zeile. Gezeigt werden die
// Figuren des Betrachters, und wer keine eigenen hat (Lektor), sieht die des
// Besitzers — sonst stünde jede Figur so oft da, wie es Konten mit Figuren gibt.
const _stmtListIdiolect = db.prepare(`
  SELECT fi.figure_id, f.fig_id, f.name, f.typ, fi.utterances, fi.tokens, fi.types, fi.mattr,
         fi.mattr_window, fi.mtld, fi.avg_utterance_len, fi.terms_json
    FROM figure_idiolect fi
    JOIN figures f ON f.id = fi.figure_id
   WHERE fi.book_id = ? AND f.user_email = ?
   ORDER BY fi.tokens DESC, f.name
`);
function listFigureIdiolect(bookId, viewerEmail, ownerEmail) {
  const parse = ({ terms_json, ...r }) => ({ ...r, terms: terms_json ? JSON.parse(terms_json) : [] });
  let rows = viewerEmail ? _stmtListIdiolect.all(bookId, viewerEmail) : [];
  if (!rows.length && ownerEmail && ownerEmail !== viewerEmail) rows = _stmtListIdiolect.all(bookId, ownerEmail);
  return rows.map(parse);
}

// Tagesverlauf (book_stats_history) mit den längenrobusten Kennzahlen des
// aktuellen Scans stempeln. Zwei Aufrufer: der Sync (schreibt die Tageszeile und
// übernimmt den Stand des letzten Scans) und der Scan selbst (überschreibt mit dem
// frischen Stand, falls die Tageszeile schon existiert). Ohne Tageszeile tut der
// Aufruf nichts — die Zeile gehört dem Sync.
//
// MATTR nur mit vollem Fenster: ein kurzes Buch liefert dort die einfache TTR, und
// im Verlauf sähe der Sprung vom TTR- zum MATTR-Wert wie eine Stiländerung aus.
// NULL statt eines nicht vergleichbaren Werts.
const _stmtStampHistory = db.prepare(`
  UPDATE book_stats_history SET
    mattr       = (SELECT CASE WHEN mattr_window >= @window THEN mattr END FROM book_lexicon WHERE book_id = @book_id),
    mtld        = (SELECT mtld        FROM book_lexicon WHERE book_id = @book_id),
    lex_density = (SELECT lex_density FROM book_lexicon WHERE book_id = @book_id),
    hapax_ratio = (SELECT hapax_ratio FROM book_lexicon WHERE book_id = @book_id)
   WHERE book_id = @book_id AND recorded_at = @date
`);
function stampLexiconHistory(bookId, date, mattrWindow) {
  return _stmtStampHistory.run({ book_id: bookId, date, window: mattrWindow }).changes;
}

// Für den Delta-Skip im Job: nur die Signatur, ohne die ganze Zeile zu laden.
const _stmtGetSig = db.prepare('SELECT content_sig, input_sig, lexicon_version FROM book_lexicon WHERE book_id = ?');
function getLexiconSignature(bookId) {
  return _stmtGetSig.get(bookId) || null;
}

// Referenzkorpus für die Keyness: die Häufigkeitstabellen ALLER ÜBRIGEN Bücher
// desselben Besitzers, zu einer Tabelle verschmolzen. Bücher ohne abgeschlossenen
// Scan (kein `freq_json`) tragen nichts bei. Nur Tabellen der AKTUELLEN
// Analyse-Version: eine ältere wurde mit anderer Tokenisierung gezählt und passt
// Wort für Wort nicht zu den Termen dieses Buchs.
//
// Rückgabe: { freq: Map<term,count>, total, books, upper(term), absentBound }
// oder null, wenn es kein anderes gescanntes Buch gibt (dann bleibt die
// Keyness-Spalte leer — siehe lib/lexicon/keyness.js).
//
// `upper(term)` ist die OBERE Schranke der echten Referenzhäufigkeit. Die
// gespeicherten Tabellen sind gedeckelt: fehlt ein Term in der Tabelle eines
// Buchs, kommt er dort trotzdem bis zu `bookMin` Mal vor (seltenster
// aufgenommener Term dieses Buchs). Die Schranke summiert das PRO BUCH, in dem der
// Term fehlt — ein Maximum über die Bücher wäre keine Schranke: zehn Bücher mit je
// zwei Vorkommen sind zwanzig, nicht drei. Mit dieser Schranke ist die Keyness der
// Auswahl (lib/lexicon/analyze.js) eine echte untere Schranke der Auffälligkeit.
const _stmtRefRows = db.prepare(`
  SELECT bl.tokens, bl.freq_json
    FROM book_lexicon bl
    JOIN books b ON b.book_id = bl.book_id
   WHERE bl.book_id != ?
     AND bl.freq_json IS NOT NULL
     AND bl.lexicon_version = ?
     AND b.owner_email IS NOT NULL
     AND b.owner_email = (SELECT owner_email FROM books WHERE book_id = ?)
`);
function loadReferenceCorpus(bookId, version) {
  const rows = _stmtRefRows.all(bookId, version, bookId);
  if (!rows.length) return null;
  const freq = new Map();
  // Summe der Fehl-Schranken der Bücher, in denen der Term VORKOMMT — abgezogen
  // von der Gesamtsumme bleibt die Schranke der Bücher, in denen er fehlt.
  const presentBound = new Map();
  let total = 0;
  let absentBound = 0;
  let books = 0;
  for (const r of rows) {
    let obj;
    try { obj = JSON.parse(r.freq_json); } catch { continue; }
    const entries = Object.entries(obj || {});
    let bookMin = Infinity;
    for (const [, count] of entries) if (count < bookMin) bookMin = count;
    const bound = Number.isFinite(bookMin) ? bookMin : 0;
    for (const [term, count] of entries) {
      freq.set(term, (freq.get(term) || 0) + count);
      if (bound) presentBound.set(term, (presentBound.get(term) || 0) + bound);
    }
    // Token erst NACH erfolgreichem Parse zählen: ein unlesbares Buch trägt keine
    // Frequenzen bei und darf den Nenner nicht aufblähen.
    total += r.tokens || 0;
    absentBound += bound;
    books++;
  }
  if (!total) return null;
  const upper = (term) => (freq.get(term) || 0) + absentBound - (presentBound.get(term) || 0);
  return { freq, total, books, upper, absentBound };
}

// Fingerabdruck der Referenz für die Eingangs-Signatur des Scans (input_sig):
// welche Bücher in welchem TEXTSTAND (content_sig) die Referenz bilden. Bewusst
// die Text-Signatur der anderen Bücher, nicht deren input_sig — sonst hinge jedes
// Buch an den Referenzen der anderen, und zwei Bücher desselben Autors würden
// sich gegenseitig in jeder Nacht neu anstossen.
const _stmtRefFingerprint = db.prepare(`
  SELECT bl.book_id, bl.content_sig
    FROM book_lexicon bl
    JOIN books b ON b.book_id = bl.book_id
   WHERE bl.book_id != ?
     AND bl.freq_json IS NOT NULL
     AND bl.lexicon_version = ?
     AND b.owner_email IS NOT NULL
     AND b.owner_email = (SELECT owner_email FROM books WHERE book_id = ?)
   ORDER BY bl.book_id
`);
function referenceFingerprint(bookId, version) {
  return _stmtRefFingerprint.all(bookId, version, bookId)
    .map(r => `${r.book_id}:${r.content_sig || ''}`).join(',');
}

// Vergleichswerte aus den übrigen Büchern desselben Besitzers (Median je Kennzahl).
// Warum: eine nackte Zahl wie „MTLD 78" sagt niemandem etwas — erst „78, dein
// Median ist 71" ist eine Aussage. Median statt Mittelwert, weil ein einzelnes
// kurzes Buch mit Ausreisserwerten den Mittelwert kippt.
//
// Nur Bücher mit MTLD-Wert zählen für den MTLD-Median usw. — sonst würde ein zu
// kurzes Buch (dort ist der Wert bewusst NULL) als 0 in den Vergleich eingehen.
const _stmtPeerRows = db.prepare(`
  SELECT bl.mattr, bl.mattr_window, bl.mtld, bl.hapax_ratio, bl.yule_k,
         bl.heaps_beta, bl.lex_density
    FROM book_lexicon bl
    JOIN books b ON b.book_id = bl.book_id
   WHERE bl.book_id != ?
     AND bl.lexicon_version = ?
     AND b.owner_email IS NOT NULL
     AND b.owner_email = (SELECT owner_email FROM books WHERE book_id = ?)
`);
const PEER_KEYS = ['mattr', 'mtld', 'hapax_ratio', 'yule_k', 'heaps_beta', 'lex_density'];
function _median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Nur Bücher derselben Analyse-Version: nach einer Regeländerung (z.B. einer
// vollständigeren Funktionswortliste) sind alte und neue Werte nicht vergleichbar.
function loadPeerStats(bookId, version) {
  const rows = _stmtPeerRows.all(bookId, version, bookId);
  if (!rows.length) return null;
  const out = { books: rows.length };
  for (const key of PEER_KEYS) {
    // MATTR nur aus Büchern, die lang genug für ein echtes Fenster waren —
    // ein Kurzbuch liefert dort die einfache TTR und ist nicht vergleichbar.
    const vals = rows
      .filter(r => (key !== 'mattr' || (r.mattr_window || 0) >= 1000))
      .map(r => r[key])
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    out[key] = _median(vals);
  }
  return out;
}

// Alle Bücher mit mindestens einer Seite — Scope des Nacht-Crons. Bücher ohne
// Seiten würden nur eine Nullzeile erzeugen.
const _stmtScanScopes = db.prepare(`
  SELECT b.book_id
    FROM books b
   WHERE EXISTS (SELECT 1 FROM pages p WHERE p.book_id = b.book_id)
   ORDER BY b.book_id
`);
function listScanScopes() {
  return _stmtScanScopes.all().map(r => r.book_id);
}

module.exports = {
  replaceBookLexicon, getBookLexicon, listLexiconTerms, listLexiconHapax, listLexiconNgrams,
  listChapterLexicon, listFigureIdiolect, stampLexiconHistory,
  getLexiconSignature, loadReferenceCorpus, referenceFingerprint, loadPeerStats, listScanScopes,
};
