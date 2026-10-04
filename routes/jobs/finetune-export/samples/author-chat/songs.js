'use strict';

const { db } = require('../../../../../db/schema');

// Block 30: Songs (Buch-Soundtrack) — Lieder, die im Buch vorkommen oder
// als Stimmungs-/Szenen-Untermalung markiert sind. Pro Song reiche Antwort
// (Interpret, Genre, Stimmung, Kontext, Beschreibung, Kapitel, Figuren)
// plus facettierte Q&A + Reverse-Lookup Figur → Songs + globaler Soundtrack.
function buildSongSamples(ctx) {
  const { langIsEn, bookIdInt, userEmail, pushQA, pickVariants } = ctx;

  const songRows = db.prepare(`
    SELECT id, titel, interpret, genre, kontext_typ, beschreibung, stimmung, erste_erwaehnung
    FROM songs
    WHERE book_id = ? AND (user_email = ? OR (? IS NULL AND user_email IS NULL))
    ORDER BY sort_order
  `).all(bookIdInt, userEmail, userEmail);
  if (!songRows.length) return;

  // Junctions: song_id → [chapter_name | figur_name | scene_titel]
  const chBySong = new Map();
  for (const r of db.prepare(`
    SELECT sc.song_id, c.chapter_name AS name
    FROM song_chapters sc
    JOIN songs s ON s.id = sc.song_id
    LEFT JOIN chapters c ON c.chapter_id = sc.chapter_id
    WHERE s.book_id = ?
    ORDER BY sc.haeufigkeit DESC
  `).all(bookIdInt)) {
    if (!r.name) continue;
    if (!chBySong.has(r.song_id)) chBySong.set(r.song_id, []);
    chBySong.get(r.song_id).push(r.name);
  }
  const figBySong = new Map();
  const songsByFig = new Map(); // figur_name → [titel]
  for (const r of db.prepare(`
    SELECT sf.song_id, f.name
    FROM song_figures sf
    JOIN songs s ON s.id = sf.song_id
    JOIN figures f ON f.id = sf.figure_id
    WHERE s.book_id = ?
  `).all(bookIdInt)) {
    if (!r.name) continue;
    if (!figBySong.has(r.song_id)) figBySong.set(r.song_id, []);
    figBySong.get(r.song_id).push(r.name);
  }

  const songQuestions = langIsEn
    ? ['What is the song «{titel}»?', 'Tell me about the song «{titel}».',
       'Describe «{titel}».', 'What role does «{titel}» play in the book?']
    : ['Was ist der Song «{titel}»?', 'Erzähl mir über das Lied «{titel}».',
       'Beschreibe «{titel}».', 'Welche Rolle spielt «{titel}» im Buch?'];

  for (const s of songRows) {
    const titel = (s.titel || '').trim();
    if (!titel) continue;
    const kapitel = chBySong.get(s.id) || [];
    const figuren = figBySong.get(s.id) || [];

    // Aggregierte Figur-Reverse-Map füllen
    for (const fn of figuren) {
      if (!songsByFig.has(fn)) songsByFig.set(fn, []);
      songsByFig.get(fn).push(titel);
    }

    // Vollantwort
    const parts = [];
    if (s.interpret)    parts.push(langIsEn ? `«${titel}» by ${s.interpret}.` : `«${titel}» von ${s.interpret}.`);
    else                parts.push(`«${titel}».`);
    if (s.genre)        parts.push(langIsEn ? `Genre: ${s.genre}.` : `Genre: ${s.genre}.`);
    if (s.stimmung)     parts.push(langIsEn ? `Mood: ${s.stimmung}.` : `Stimmung: ${s.stimmung}.`);
    if (s.kontext_typ)  parts.push(langIsEn ? `Context: ${s.kontext_typ}.` : `Kontext: ${s.kontext_typ}.`);
    if (s.beschreibung) parts.push(s.beschreibung.trim());
    if (figuren.length) parts.push(langIsEn ? `Tied to: ${figuren.slice(0, 8).join(', ')}.` : `Verknüpft mit: ${figuren.slice(0, 8).join(', ')}.`);
    if (kapitel.length) parts.push(langIsEn ? `In chapter(s): ${kapitel.slice(0, 5).join(', ')}.` : `In Kapitel: ${kapitel.slice(0, 5).join(', ')}.`);
    if (s.erste_erwaehnung) parts.push(langIsEn ? `First mentioned: ${s.erste_erwaehnung}.` : `Erste Erwähnung: ${s.erste_erwaehnung}.`);
    const fullAnswer = parts.join(' ');

    // Haupt-Q&A mit allen Paraphrasen
    const idxs = pickVariants('song|' + s.id, songQuestions, songQuestions.length);
    for (const idx of idxs) {
      const q = songQuestions[idx].replace('{titel}', titel);
      pushQA('authorChat|song|' + s.id + '|' + idx, q, fullAnswer);
    }

    // Facetten
    if (s.interpret) {
      pushQA('authorChat|songArtist|' + s.id,
        langIsEn ? `Who performs «${titel}»?` : `Von wem ist «${titel}»?`,
        s.interpret);
    }
    if (s.genre) {
      pushQA('authorChat|songGenre|' + s.id,
        langIsEn ? `What genre is «${titel}»?` : `Welches Genre hat «${titel}»?`,
        s.genre);
    }
    if (s.stimmung) {
      pushQA('authorChat|songMood|' + s.id,
        langIsEn ? `What mood does «${titel}» carry?` : `Welche Stimmung trägt «${titel}»?`,
        s.stimmung);
    }
    if (figuren.length) {
      pushQA('authorChat|songFigs|' + s.id,
        langIsEn ? `Which characters are tied to «${titel}»?` : `Welche Figuren sind mit «${titel}» verknüpft?`,
        figuren.join(', '));
    }
  }

  // Reverse: Figur → Songs
  for (const [fn, titles] of songsByFig) {
    const list = [...new Set(titles)].slice(0, 12).map(t => `«${t}»`).join(', ');
    pushQA('authorChat|songsByFig|' + fn.toLowerCase().replace(/\s+/g, '_').slice(0, 60),
      langIsEn ? `Which songs belong to ${fn}?` : `Welche Songs gehören zu ${fn}?`,
      list);
    pushQA('authorChat|songsByFig2|' + fn.toLowerCase().replace(/\s+/g, '_').slice(0, 60),
      langIsEn ? `What's ${fn}'s soundtrack?` : `Wie klingt ${fn}s Soundtrack?`,
      list);
  }

  // Globaler Soundtrack
  if (songRows.length >= 2) {
    const all = songRows.slice(0, 30)
      .map(s => s.interpret ? `«${s.titel}» (${s.interpret})` : `«${s.titel}»`)
      .join(', ');
    pushQA('authorChat|songsAll',
      langIsEn ? `What's the soundtrack of this book?` : `Wie sieht der Soundtrack dieses Buches aus?`,
      all);
    pushQA('authorChat|songsAll2',
      langIsEn ? `List the songs that appear in the book.` : `Liste die Songs auf, die im Buch vorkommen.`,
      all);
  }
}

module.exports = { buildSongSamples };
