'use strict';
// Buchentwicklung: `avg_sentence_len` und `unique_words` der bisherigen
// Snapshots sind mit falscher Zerlegung entstanden — Satzende an jedem Punkt
// („Dr.", „14.30", „z.B."), Wortformen mit angehängten Satzzeichen
// („komm," ≠ „komm."). Den Text alter Tage gibt es nicht mehr, nachrechnen geht
// nicht; ein Verlauf, der beim nächsten Sync von falsch auf richtig springt,
// sähe aus wie eine Stiländerung. Darum leer statt falsch.
//
// Ab jetzt: Satzlänge aus dem Stil-Index (routes/sync.js#syncBook), Wortformen
// aus dem Wortschatz-Scan (db/lexicon.js#stampLexiconHistory). Die jüngste
// Zeile je Buch bekommt die Wortformen des vorhandenen Scans sofort, damit
// „Meine Statistik" bis zum nächsten Sync nicht auf 0 fällt.
module.exports = {
  version: 353,
  up(db) {
    db.exec('UPDATE book_stats_history SET avg_sentence_len = NULL, unique_words = NULL');
    const hasLexicon = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'book_lexicon'").get();
    if (!hasLexicon) return;
    db.exec(`
      UPDATE book_stats_history AS h
         SET unique_words = (SELECT l.types FROM book_lexicon l WHERE l.book_id = h.book_id)
       WHERE h.recorded_at = (SELECT MAX(x.recorded_at) FROM book_stats_history x WHERE x.book_id = h.book_id)
    `);
  },
};
