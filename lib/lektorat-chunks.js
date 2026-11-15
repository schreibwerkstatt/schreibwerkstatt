'use strict';
// Lange Abschnitte prüft das Lektorat in Stücken (routes/jobs/lektorat-split.js):
// je Stück Objektiv- und Stil-Pass, dazu ein Bewertungs-Pass über den ganzen
// Abschnitt. Hier steht, WANN zerlegt wird und WIE.
//
// Why: auf Prod fiel die Fundrate pro 10'000 Zeichen mit der Abschnittslänge auf
// ein Drittel (objektive wie stilistische Befunde, gleiche Autorin) — das Modell
// liest einen 30'000-Zeichen-Abschnitt nicht so gründlich wie einen kurzen. In
// Stücken fand derselbe Prompt dort Fehler, die zehn Läufe über den ganzen Text
// nie gemeldet hatten. Die Stil-Obergrenze war dabei nicht der Engpass.

const appSettings = require('./app-settings');

// Zielgrösse eines Stücks (Zeichen Prompt-Text). Ein Stück endet an der ersten
// Absatzgrenze nach dieser Länge; ein Rest unter einem Drittel hängt am letzten.
const CHUNK_TARGET_CHARS = 7000;
// Lesekontext je Seite eines Stücks (Zeichen, an Absatzgrenze geschnitten).
const CHUNK_CONTEXT_CHARS = 1500;

/** Ab dieser Länge (Zeichen) wird zerlegt; 0 = nie. Admin: `ai.lektorat_chunk_chars`. */
function chunkThreshold() {
  const n = parseInt(appSettings.get('ai.lektorat_chunk_chars'), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Wird dieser Text in Stücken geprüft? Nur im Claude-Split (lokale Provider und
 * der Kombi-Call prüfen immer am Stück) und nur über der Schwelle.
 * @param {number} textLen  Länge des Prompt-Texts
 * @param {{ local?: boolean, split?: boolean }} o
 */
function chunkingApplies(textLen, { local = false, split = false } = {}) {
  const t = chunkThreshold();
  return !local && split && t > 0 && textLen > t;
}

/**
 * Zerlegt an Absatzgrenzen (`\n\n`, wie htmlToTextForPrompt sie setzt). Jedes
 * Stück ist ein exakter Teilstring: `text.slice(start, start + c.text.length) === c.text`.
 * Ein einzelner Absatz über der Zielgrösse bleibt ein (grösseres) Stück — mitten
 * im Absatz wird nicht geschnitten.
 * @returns {{ start: number, text: string }[]}
 */
function chunkText(text, target = CHUNK_TARGET_CHARS) {
  const src = String(text || '');
  const parts = src.split(/(\n{2,})/);
  const raw = [];
  let cur = '';
  let start = 0;
  let pos = 0;
  for (const p of parts) {
    if (cur.length >= target && !/^\n+$/.test(p)) { raw.push({ start, raw: cur }); start = pos; cur = ''; }
    cur += p;
    pos += p.length;
  }
  if (cur.trim()) {
    if (raw.length && cur.trim().length < target / 3) raw[raw.length - 1].raw += cur;
    else raw.push({ start, raw: cur });
  }
  return raw
    .map(c => ({ start: c.start + (c.raw.length - c.raw.trimStart().length), text: c.raw.trim() }))
    .filter(c => c.text);
}

// Ende von `s` als Lesekontext: höchstens CHUNK_CONTEXT_CHARS, ab einer Absatzgrenze.
function _tail(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (t.length <= CHUNK_CONTEXT_CHARS) return t;
  const cut = t.lastIndexOf('\n\n', t.length - CHUNK_CONTEXT_CHARS);
  return t.slice(cut > 0 ? cut + 2 : t.length - CHUNK_CONTEXT_CHARS);
}

// Anfang von `s` als Lesekontext, bis zur ersten Absatzgrenze nach CHUNK_CONTEXT_CHARS.
function _head(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (t.length <= CHUNK_CONTEXT_CHARS) return t;
  const cut = t.indexOf('\n\n', CHUNK_CONTEXT_CHARS);
  return t.slice(0, cut > 0 ? cut : CHUNK_CONTEXT_CHARS);
}

/** Text vor und nach einem Stück desselben Abschnitts, als Lesekontext gekürzt. */
function chunkContext(text, chunk) {
  return {
    before: _tail(text.slice(0, chunk.start)),
    after: _head(text.slice(chunk.start + chunk.text.length)),
  };
}

module.exports = {
  CHUNK_TARGET_CHARS, CHUNK_CONTEXT_CHARS,
  chunkThreshold, chunkingApplies, chunkText, chunkContext,
};
