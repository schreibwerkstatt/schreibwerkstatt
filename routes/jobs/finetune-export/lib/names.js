'use strict';

const { createHash } = require('crypto');
const { escapeRegex: escapeRe } = require('../../../../lib/regex-escape');

function hashSplit(id, seed) {
  const h = createHash('sha1').update(String(seed || 0) + '|' + id).digest();
  return ((h[0] << 8) | h[1]) / 0xffff;
}

// Robustes Label aus einem Listenelement extrahieren. Akzeptiert:
//   - String-Namen ("Renate")
//   - String-IDs (in `byMap` aufgelöst)
//   - Objekte ({ name, id, fig_id, loc_id, … }) — Name direkt oder via byMap-Lookup
// Verhindert "[object Object]" im Output, wenn KI strukturierte Refs liefert
// statt blanker Strings.
function extractName(v, byMap = null) {
  if (v == null) return '';
  if (typeof v === 'string') {
    if (byMap && byMap.has(v)) return byMap.get(v).name || '';
    return isIdLike(v) ? '' : v.trim();
  }
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const id = v.fig_id || v.loc_id || v.id;
    if (id && byMap && byMap.has(id)) return byMap.get(id).name || '';
    return (v.name || v.titel || v.label || '').toString().trim();
  }
  return '';
}

// Name, der wie ein Slug aussieht: `das_unklare_abdomen`, `cat_lady_40`.
// Das kann eine Kennung der Analyse sein oder die Schreibweise des Buchs
// selbst (Chat-Nicknames) — entscheidet `slugDisplayName` am Buchtext.
function isSlugName(s) {
  return /^[\p{Ll}\d]+(?:_[\p{Ll}\d]+)+$/u.test(String(s || '').trim());
}

// Reine Datenbank-Kennung (`fig_129`, `loc_7`): nie ein Anzeigename.
function isIdLike(s) {
  return /^[a-z]+_\d+$/.test(String(s || '').trim());
}

// Anzeigename für einen Slug-Namen in der Schreibweise des Buchs: steht der
// Slug wörtlich im Text (ein Chat-Nickname wie «madame_phantasma»), bleibt er;
// sonst die Wortfolge ohne Unterstriche und ohne angehängte Zählnummer
// («cat_lady_40» → «Cat Lady», wenn das Buch so schreibt). '' = das Buch kennt
// den Namen nicht, die Entität bleibt aus dem Training.
function slugDisplayName(slug, bookText) {
  const raw = String(slug || '').trim();
  if (!raw || !bookText) return '';
  const literal = new RegExp(NB + escapeRe(raw) + NA, 'iu').exec(bookText);
  if (literal) return literal[0];
  const words = raw.split('_').filter(Boolean);
  while (words.length > 1 && /^\d+$/.test(words[words.length - 1])) words.pop();
  const m = new RegExp(NB + words.map(escapeRe).join('\\s+') + NA, 'iu').exec(bookText);
  return m ? m[0].replace(/\s+/g, ' ') : '';
}


// Name als ganzes Wort, case-insensitiv. Nicht `\b`: das kennt in JavaScript
// nur ASCII-Buchstaben, ein Name, der mit Umlaut, ß oder Akzent beginnt oder
// endet (Ömer, Strauß, René), fände dann nie einen Treffer.
const NB = '(?<![\\p{L}\\p{N}_])';
const NA = '(?![\\p{L}\\p{N}_])';
function nameRegex(name) {
  return new RegExp(NB + escapeRe(name) + NA, 'iu');
}

// Redeverben (DE + EN) für die Sprecher-Disambiguierung. Bei mehreren Figuren
// im Fenster gewinnt die, die direkt an einer Redeverb-Konstruktion klebt
// («…», sagte Anna / Anna fragte: «…»).
const SPEECH_VERBS =
  'sagte|sagt|fragte|fragt|rief|ruft|flüsterte|flüstert|antwortete|antwortet|'
  + 'erwiderte|erwidert|meinte|meint|murmelte|murmelt|brüllte|brüllt|'
  + 'entgegnete|entgegnet|seufzte|lachte|schrie|zischte|stammelte|knurrte|'
  + 'raunte|wisperte|erklärte|fügte|fuhr|'
  + 'said|says|asked|asks|replied|replies|whispered|whispers|shouted|shouts|'
  + 'murmured|muttered|answered|exclaimed|added|cried|yelled|hissed';

// Ordnet einem Zitat genau dann einen Sprecher zu, wenn die Zuordnung
// eindeutig ist: entweder kommt im Fenster nur EINE Figur vor, oder bei
// mehreren klebt genau eine an einem Redeverb. Sonst `null` — lieber kein
// Sample als ein falsch attribuiertes. Falsche „Wer sagt X?"-Fakten sind in
// einem Memorisierungs-Datensatz aktiv schädlich.
function findSpeaker(text, quoteStart, quoteEnd, figureNames) {
  const pre = text.slice(Math.max(0, quoteStart - 280), quoteStart);
  const post = text.slice(quoteEnd, quoteEnd + 280);
  const window = pre + ' \u0000 ' + post;

  const present = figureNames.filter(name =>
    nameRegex(name).test(window));
  if (!present.length) return null;

  // Name/Kurzname derselben Figur nicht doppelt zählen: ein vorkommender Name,
  // der Wort-Teilmenge eines längeren vorkommenden Namens ist, wird verworfen.
  const distinct = present.filter((n, idx) =>
    !present.some((other, j) => j !== idx && other.length > n.length
      && nameRegex(n).test(other)));
  if (distinct.length === 1) return distinct[0];

  // Mehrdeutig → über Redeverb-Adjazenz in der engen Zone ums Zitat auflösen.
  const tight = text.slice(quoteEnd, quoteEnd + 60)
    + ' \u0000 ' + text.slice(Math.max(0, quoteStart - 60), quoteStart);
  const adjacent = distinct.filter(name => {
    const n = escapeRe(name);
    const re1 = new RegExp(NB + n + NA + '[^.!?\\n]{0,15}' + NB + '(?:' + SPEECH_VERBS + ')' + NA, 'iu');
    const re2 = new RegExp(NB + '(?:' + SPEECH_VERBS + ')' + NA + '[^.!?\\n]{0,15}' + NB + n + NA, 'iu');
    return re1.test(tight) || re2.test(tight);
  });
  return adjacent.length === 1 ? adjacent[0] : null;
}

module.exports = { hashSplit, extractName, escapeRe, nameRegex, findSpeaker, isSlugName, isIdLike, slugDisplayName };
