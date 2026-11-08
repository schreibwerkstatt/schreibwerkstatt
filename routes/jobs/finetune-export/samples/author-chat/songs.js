'use strict';

const { listSongsForBook } = require('../../../../../db/songs');

// Block 30: Songs (Buch-Soundtrack) — Lieder, die im Buch vorkommen oder
// als Stimmungs-/Szenen-Untermalung markiert sind. Pro Song reiche Antwort
// (Interpret, Genre, Stimmung, Kontext, Beschreibung, Kapitel, Figuren)
// plus facettierte Q&A + Reverse-Lookup Figur → Songs + globaler Soundtrack.
// Fragen zu einem Song tragen `unit: song:<uid>`, zu einer Figur `fig:<fig_id>`
// (dieselbe Einheit wie figures.js) — sie wandern im Train/Val-Split gemeinsam.

// Kontext des Songs als Satz statt als DB-Schlüssel («Kontext: diegetisch»).
const KONTEXT_SATZ = {
  de: {
    'hört':     t => `Im Buch hört eine Figur «${t}».`,
    spielt:     t => `Im Buch spielt eine Figur «${t}» selbst.`,
    'erwähnt':  t => `«${t}» wird im Buch erwähnt.`,
    leitmotiv:  t => `«${t}» zieht sich als Leitmotiv durch das Buch.`,
    diegetisch: t => `«${t}» läuft im Hintergrund einer Szene.`,
  },
  en: {
    'hört':     t => `In the book, a character listens to «${t}».`,
    spielt:     t => `In the book, a character plays «${t}» themselves.`,
    'erwähnt':  t => `«${t}» is mentioned in the book.`,
    leitmotiv:  t => `«${t}» runs through the book as a leitmotif.`,
    diegetisch: t => `«${t}» plays in the background of a scene.`,
  },
};

// Rolle einer Figur am Song (song_figures.kontext_typ) als Zusatz zum Namen.
const FIG_ROLLE = {
  de: { spielt: 'spielt ihn', singt: 'singt ihn', komponiert: 'hat ihn komponiert', 'hört': 'hört ihn', 'erwähnt': 'erwähnt ihn' },
  en: { spielt: 'plays it', singt: 'sings it', komponiert: 'composed it', 'hört': 'listens to it', 'erwähnt': 'mentions it' },
};

function buildSongSamples(ctx) {
  const { langIsEn, bookIdInt, userEmail, pushQA, pickVariants, PARAPHRASES } = ctx;
  const lang = langIsEn ? 'en' : 'de';

  const lib = listSongsForBook(bookIdInt, userEmail);
  const songs = (lib?.songs || []).filter(s => (s.titel || '').trim());
  if (!songs.length) return;

  const songQuestions = langIsEn
    ? ['What is the song «{titel}»?', 'Tell me about the song «{titel}».',
       'Describe «{titel}».', 'What role does «{titel}» play in the book?']
    : ['Was ist der Song «{titel}»?', 'Erzähl mir über das Lied «{titel}».',
       'Beschreibe «{titel}».', 'Welche Rolle spielt «{titel}» im Buch?'];

  const songsByFig = new Map(); // fig_id → { name, titles[] }

  for (const s of songs) {
    const titel = s.titel.trim();
    const unit = 'song:' + s.id;
    const kapitel = (s.kapitel || []).map(k => k.name).filter(Boolean);
    const figuren = (s.figuren || []).filter(f => f.name);
    const figLabel = f => (FIG_ROLLE[lang][f.kontext_typ] ? `${f.name} (${FIG_ROLLE[lang][f.kontext_typ]})` : f.name);

    for (const f of figuren) {
      if (!songsByFig.has(f.fig_id)) songsByFig.set(f.fig_id, { name: f.name, titles: [] });
      songsByFig.get(f.fig_id).titles.push(titel);
    }

    // Vollantwort
    const parts = [];
    if (s.interpret)    parts.push(langIsEn ? `«${titel}» by ${s.interpret}.` : `«${titel}» von ${s.interpret}.`);
    else                parts.push(`«${titel}».`);
    if (s.genre)        parts.push(`Genre: ${s.genre}.`);
    if (s.stimmung)     parts.push(langIsEn ? `Mood: ${s.stimmung}.` : `Stimmung: ${s.stimmung}.`);
    const kontextSatz = KONTEXT_SATZ[lang][s.kontext_typ];
    if (kontextSatz)    parts.push(kontextSatz(titel));
    if (s.beschreibung) parts.push(s.beschreibung.trim());
    if (figuren.length) parts.push(langIsEn ? `Tied to: ${figuren.slice(0, 8).map(figLabel).join(', ')}.` : `Verknüpft mit: ${figuren.slice(0, 8).map(figLabel).join(', ')}.`);
    if (kapitel.length) parts.push(langIsEn ? `In chapter(s): ${kapitel.slice(0, 5).join(', ')}.` : `In Kapitel: ${kapitel.slice(0, 5).join(', ')}.`);
    if (s.erste_erwaehnung) parts.push(langIsEn ? `First mentioned: ${s.erste_erwaehnung}.` : `Erste Erwähnung: ${s.erste_erwaehnung}.`);
    const fullAnswer = parts.join(' ');

    // Haupt-Q&A mit allen Paraphrasen
    const idxs = pickVariants('song|' + s.id, songQuestions, PARAPHRASES);
    for (const idx of idxs) {
      const q = songQuestions[idx].replace('{titel}', titel);
      pushQA('authorChat|song|' + s.id + '|' + idx, q, fullAnswer, { unit });
    }

    // Facetten
    if (s.interpret) {
      pushQA('authorChat|songArtist|' + s.id,
        langIsEn ? `Who performs «${titel}»?` : `Von wem ist «${titel}»?`,
        s.interpret, { unit });
    }
    if (s.genre) {
      pushQA('authorChat|songGenre|' + s.id,
        langIsEn ? `What genre is «${titel}»?` : `Welches Genre hat «${titel}»?`,
        langIsEn ? `«${titel}» belongs to the genre ${s.genre}.` : `«${titel}» gehört zum Genre ${s.genre}.`, { unit });
    }
    if (s.stimmung) {
      pushQA('authorChat|songMood|' + s.id,
        langIsEn ? `What mood does «${titel}» carry?` : `Welche Stimmung trägt «${titel}»?`,
        langIsEn ? `The mood of «${titel}» is ${s.stimmung}.` : `Die Stimmung von «${titel}» ist ${s.stimmung}.`, { unit });
    }
    if (figuren.length) {
      pushQA('authorChat|songFigs|' + s.id,
        langIsEn ? `Which characters are tied to «${titel}»?` : `Welche Figuren sind mit «${titel}» verknüpft?`,
        figuren.map(figLabel).join(', '), { unit });
    }
  }

  // Reverse: Figur → Songs. Eine Antwort, Fragevarianten über pickVariants.
  const figQuestions = langIsEn
    ? ['Which songs belong to {name}?', "What's {name}'s soundtrack?"]
    : ['Welche Songs gehören zu {name}?', 'Wie klingt der Soundtrack von {name}?'];
  for (const [figId, { name, titles }] of songsByFig) {
    const list = [...new Set(titles)].slice(0, 12).map(t => `«${t}»`).join(', ');
    for (const idx of pickVariants('songsByFig|' + figId, figQuestions, PARAPHRASES)) {
      pushQA('authorChat|songsByFig|' + figId + '|' + idx,
        figQuestions[idx].replace('{name}', name), list, { unit: 'fig:' + figId });
    }
  }

  // Globaler Soundtrack
  if (songs.length >= 2) {
    const all = songs.slice(0, 30)
      .map(s => s.interpret ? `«${s.titel}» (${s.interpret})` : `«${s.titel}»`)
      .join(', ');
    const allQuestions = langIsEn
      ? ["What's the soundtrack of this book?", 'List the songs that appear in the book.']
      : ['Wie sieht der Soundtrack dieses Buches aus?', 'Liste die Songs auf, die im Buch vorkommen.'];
    for (const idx of pickVariants('songsAll', allQuestions, PARAPHRASES)) {
      pushQA('authorChat|songsAll|' + idx, allQuestions[idx], all, { unit: 'songs:all' });
    }
  }
}

module.exports = { buildSongSamples };
