'use strict';
// Rolle einer Figur an einem Song (song_figures.kontext_typ). Reine Konstante ohne
// DB-Abhängigkeit, damit auch der Prompt-Test sie laden kann. Das Extraktions-Schema
// (public/js/prompts/komplett/schemas.js#_songFigRolle) und die Detailansicht
// (public/js/book/songs.js#FIG_ROLLEN) führen dieselben Werte — gegated in
// tests/unit/songs-prompt.test.mjs.
const SONG_FIG_ROLLEN = ['spielt', 'singt', 'komponiert', 'hört', 'erwähnt'];

module.exports = { SONG_FIG_ROLLEN };
