'use strict';
// Reihe hat EINEN Ort: book_series (+ book_series_members). Die Freitextfelder
// book_publication.series/series_index (Publikation-Tab, EPUB) werden überführt und
// entfernt. Bücher desselben Besitzers mit gleichem Reihennamen (getrimmt, ohne
// Gross-/Kleinschreibung) werden eine Reihe; die Bände ordnet series_index
// (numerisch, leer/unlesbar ans Ende, dann Buch-ID), die Positionen werden 1..n.
// Bücher, die schon in einer Reihe stehen, bleiben dort.

module.exports = {
  version: 341,
  up(db) {
    const has = (c) => db.prepare("SELECT 1 FROM pragma_table_info('book_publication') WHERE name = ?").get(c);
    if (!has('series')) return;

    const rows = db.prepare(`
      SELECT bp.book_id, TRIM(bp.series) AS name, bp.series_index AS idx, b.owner_email
        FROM book_publication bp JOIN books b ON b.book_id = bp.book_id
       WHERE TRIM(COALESCE(bp.series, '')) <> ''
         AND bp.book_id NOT IN (SELECT book_id FROM book_series_members)`).all();

    const groups = new Map();
    for (const r of rows) {
      const key = `${r.owner_email || ''}\u0000${r.name.toLocaleLowerCase('de')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const num = (v) => {
      const n = parseFloat(String(v ?? '').trim().replace(',', '.'));
      return Number.isFinite(n) ? n : Infinity;
    };
    const insSeries = db.prepare(`
      INSERT INTO book_series (name, created_at, updated_at)
      VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    const insMember = db.prepare('INSERT INTO book_series_members (series_id, book_id, position) VALUES (?, ?, ?)');
    for (const members of groups.values()) {
      members.sort((a, b) => (num(a.idx) - num(b.idx)) || (a.book_id - b.book_id));
      const seriesId = insSeries.run(members[0].name).lastInsertRowid;
      members.forEach((m, i) => insMember.run(seriesId, m.book_id, i + 1));
    }

    db.exec(`
      ALTER TABLE book_publication DROP COLUMN series;
      ALTER TABLE book_publication DROP COLUMN series_index;
    `);
  },
};
