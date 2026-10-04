'use strict';
// Musik (Songs, Buch-Soundtrack): Schreibpfad der Komplettanalyse und Lesepfad
// der Musik-Karte. FK-CASCADE raeumt song_figures / song_chapters bei Song-DELETE.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { toRefString: _toRefString } = require('./write-helpers');
const { inClause: _inClause } = require('../lib/validate');
const { listSongChaptersWithNames } = require('./content-names');

// Identitaet eines Songs ueber Laeufe: normalisierter Titel + Interpret. Exakt,
// nicht fuzzy — kurze Titel sind schlechte Fuzzy-Kandidaten, und Songs fehlen
// die Indizien (Typ, Land, Koordinaten), mit denen Orte den Graubereich klaeren.
function songKey(s) {
  const norm = v => String(v ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[„“”"'‚‘’«»‹›]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const titel = norm(s?.titel ?? s?.title);
  return titel ? `${titel}\u0000${norm(s?.interpret)}` : null;
}

// Schreibt die Musikbibliothek eines Laufs. Die `id` der Eingabe-Songs ist nur
// lauf-intern (die Komplettanalyse nummeriert jeden Lauf neu `song_1…N`) und
// wird hier NICHT als Identitaet benutzt: ein wiedererkannter Song (gleicher
// songKey) behaelt seine songs.id und seine song_uid, damit Suchindex und
// Deep-Links (#…/song/<uid>) ueber Laeufe auf denselben Titel zeigen. Neue Songs
// bekommen eine freie song_uid, nicht mehr gefundene werden geloescht.
function saveSongsToDb(bookId, songs, userEmail, chNameToId = null, pageNameToIdByChapter = null) {
  if (chNameToId == null) {
    const rows = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookId);
    chNameToId = Object.fromEntries(rows.map(r => [r.chapter_name, r.chapter_id]));
  }
  if (pageNameToIdByChapter == null) {
    const rows = db.prepare('SELECT page_id, page_name, chapter_id FROM pages WHERE book_id = ?').all(bookId);
    pageNameToIdByChapter = {};
    for (const r of rows) {
      const k = r.chapter_id ?? 0;
      (pageNameToIdByChapter[k] ??= {})[r.page_name] = r.page_id;
    }
  }
  const resolveErstePageIdForSong = (ersteErwaehnung, kapitel) => {
    if (!ersteErwaehnung) return null;
    for (const k of (kapitel || [])) {
      const chName = _toRefString(typeof k === 'object' && k ? (k.name ?? k) : k);
      const chapId = chName ? chNameToId?.[chName] : null;
      if (chapId != null) {
        const pid = pageNameToIdByChapter[chapId]?.[ersteErwaehnung];
        if (pid) return pid;
      }
    }
    const cand = [];
    for (const m of Object.values(pageNameToIdByChapter)) {
      if (m[ersteErwaehnung]) cand.push(m[ersteErwaehnung]);
    }
    return cand.length === 1 ? cand[0] : null;
  };
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal  = userEmail ? [userEmail] : [];

  const written = [];
  db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, song_uid, titel, interpret FROM songs WHERE book_id = ? AND ${emailCond} ORDER BY id`
    ).all(bookId, ...emailVal);
    // Pro Schluessel eine Warteschlange: hat der Bestand (Altdaten) Dubletten,
    // bekommt jeder Eingabe-Song hoechstens eine Zeile, der Rest faellt weg.
    const byKey = new Map();
    for (const r of existing) {
      const k = songKey(r);
      if (k) (byKey.get(k) ?? byKey.set(k, []).get(k)).push(r);
    }
    const usedUids = new Set(existing.map(r => r.song_uid));
    let uidSeq = 0;
    const freshUid = () => {
      let uid;
      do { uid = 'song_' + (++uidSeq); } while (usedUids.has(uid));
      usedUids.add(uid);
      return uid;
    };

    const upd = db.prepare(`
      UPDATE songs SET titel=?, interpret=?, genre=?, beschreibung=?, stimmung=?,
        kontext_typ=?, erste_erwaehnung=?, erste_erwaehnung_page_id=?,
        sort_order=?, updated_at=${NOW_ISO_SQL}
      WHERE id=?`);
    const ins = db.prepare(`
      INSERT INTO songs (book_id, song_uid, titel, interpret, genre, beschreibung, stimmung,
        kontext_typ, erste_erwaehnung, erste_erwaehnung_page_id, sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`);
    const delSf = db.prepare('DELETE FROM song_figures WHERE song_id = ?');
    const delSc = db.prepare('DELETE FROM song_chapters WHERE song_id = ?');
    const figRows = db.prepare(
      'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, userEmail || null);
    const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
    const insSf = db.prepare('INSERT OR IGNORE INTO song_figures (song_id, figure_id, kontext_typ) VALUES (?, ?, ?)');
    const insSc = db.prepare('INSERT OR IGNORE INTO song_chapters (song_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)');

    // Erst alle Zuordnungen, dann loeschen: eine freigegebene song_uid darf
    // nicht an einen neuen Song gehen, solange die alte Zeile noch steht.
    const plan = [];
    for (const s of songs) {
      const titel = _toRefString(s.titel ?? s.title);
      if (!titel) continue;
      const k = songKey(s);
      const match = k ? byKey.get(k)?.shift() : null;
      plan.push({ s, titel, match });
    }
    const kept = new Set(plan.filter(p => p.match).map(p => p.match.id));
    const del = db.prepare('DELETE FROM songs WHERE id = ?');
    for (const r of existing) if (!kept.has(r.id)) del.run(r.id);

    plan.forEach(({ s, titel, match }, i) => {
      const erstPageId = resolveErstePageIdForSong(s.erste_erwaehnung, s.kapitel);
      const vals = [titel, s.interpret || null, s.genre || null, s.beschreibung || null,
        s.stimmung || null, s.kontext_typ || null, s.erste_erwaehnung || null, erstPageId, i];
      let songDbId;
      if (match) {
        songDbId = match.id;
        upd.run(...vals, songDbId);
        delSf.run(songDbId);
        delSc.run(songDbId);
      } else {
        const [t, ...rest] = vals;
        songDbId = ins.run(bookId, freshUid(), t, ...rest, userEmail || null).lastInsertRowid;
      }
      written.push(songDbId);
      for (const f of (s.figuren || [])) {
        // figuren: entweder String (fig_id) oder Objekt { fig_id, kontext_typ }
        const ref = _toRefString(typeof f === 'object' && f ? (f.fig_id ?? f.id) : f);
        const rowId = ref ? figIdToRowId[ref] : null;
        const fKtx = (typeof f === 'object' && f && f.kontext_typ) ? f.kontext_typ : null;
        if (rowId != null) insSf.run(songDbId, rowId, fKtx);
      }
      for (const k of (s.kapitel || [])) {
        const chName = _toRefString(typeof k === 'object' && k ? (k.name ?? k) : k);
        if (!chName) continue;
        const chapId = chNameToId?.[chName] ?? null;
        const haeufigkeit = (k && typeof k === 'object' && k.haeufigkeit) || 1;
        if (chapId != null) insSc.run(songDbId, chapId, haeufigkeit);
      }
    });
  })();
  return { songIds: written.map(Number) };
}

// Musikbibliothek eines Buchs fuer die Musik-Karte. `null`, wenn es keine gibt.
function listSongsForBook(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT id, song_uid, titel, interpret, genre, kontext_typ, beschreibung,
           stimmung, erste_erwaehnung, erste_erwaehnung_page_id, updated_at
    FROM songs
    WHERE book_id = ? AND user_email IS ?
    ORDER BY sort_order, id
  `).all(bookId, userEmail || null);
  if (!rows.length) return null;

  const songIds = rows.map(r => r.id);
  const { sql: idSql, values: idVals } = _inClause(songIds);
  const figMap = {};
  for (const sf of db.prepare(`
    SELECT sf.song_id, f.fig_id, sf.kontext_typ
    FROM song_figures sf
    JOIN figures f ON f.id = sf.figure_id
    WHERE sf.song_id IN ${idSql}
  `).all(...idVals)) {
    (figMap[sf.song_id] ??= []).push({ fig_id: sf.fig_id, kontext_typ: sf.kontext_typ });
  }
  const kapMap = {};
  for (const sc of listSongChaptersWithNames(songIds)) {
    (kapMap[sc.song_id] ??= []).push({ chapter_id: sc.chapter_id, name: sc.chapter_name, haeufigkeit: sc.haeufigkeit });
  }

  const songs = rows.map(r => ({
    id:                       r.song_uid,
    titel:                    r.titel,
    interpret:                r.interpret,
    genre:                    r.genre,
    kontext_typ:              r.kontext_typ,
    beschreibung:             r.beschreibung,
    stimmung:                 r.stimmung,
    erste_erwaehnung:         r.erste_erwaehnung,
    erste_erwaehnung_page_id: r.erste_erwaehnung_page_id || null,
    figuren:                  figMap[r.id] || [],
    kapitel:                  kapMap[r.id] || [],
  }));
  // Stand = juengster Schreibvorgang, nicht die erste Zeile der Sortierung.
  const updatedAt = rows.reduce((m, r) => (r.updated_at && (!m || r.updated_at > m) ? r.updated_at : m), null);
  return { songs, updated_at: updatedAt };
}

// Alle Song-Zeilen eines Buchs (alle Konten) — fuer den Full-Replace des Suchindex.
function listSongIdsForBook(bookId) {
  return db.prepare('SELECT id FROM songs WHERE book_id = ?').all(bookId);
}

module.exports = {
  saveSongsToDb,
  listSongIdsForBook,
  listSongsForBook,
  songKey,
};
