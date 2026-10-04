'use strict';
// Schutz der public Vorlese-Route POST /share/:token/tts (routes/share/tts.js).
// Der Share-Token beschraenkt nur, WER vorlesen darf — nicht WAS. Ohne diese
// Pruefung koennte jeder mit einem Link den GPU-Speech-Server als freien
// Vorlese-Dienst fuer beliebige Texte nutzen.
//
// Zwei Schichten:
//   1. Ratenlimit pro (Token, IP-Hash) — eigene Buckets in lib/share-ratelimit.js
//      (checkTts), getrennt vom Kommentar-Limit.
//   2. Inhaltsbindung: die Woerter des angefragten Texts muessen (fast) alle im
//      geteilten Inhalt vorkommen. Wort-Ebene statt Teilstring, weil der Client
//      den Sprechtext aufbereitet (Belege ausgelassen, Satzzeichen normalisiert,
//      Zeilen zu Kommas — public/js/tts-segment.js#normalizeForSpeech). Wer
//      Woerter des Buchs neu kombiniert, liest damit hoechstens das Buch vor.
//
// Wortmenge pro Token im Speicher (TTL), damit nicht jeder Satz den ganzen
// Inhalt neu laedt. Prozess-Neustart leert den Cache (Self-Hosted-Muster).

const { htmlToPlainText } = require('./html-text');

const TTL_MS = 10 * 60 * 1000;
const REFRESH_MIN_AGE_MS = 30 * 1000;   // fehlgeschlagene Pruefung → frisch laden, aber hoechstens so oft
const MAX_ENTRIES = 200;
// Anteil der Woerter, die im Inhalt stehen muessen. Nicht 100 %: zur Laufzeit
// eingesetzte Texte (Querverweis-Nummern, Abbildungs-Badges) koennen im
// gerenderten Artikel stehen, ohne im gespeicherten HTML zu stehen.
const MIN_HIT_RATIO = 0.85;

const _cache = new Map(); // token → { at, words: Set<string> }

function words(s) {
  return String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

// Beide Lesarten eines Inline-Tags aufnehmen: `Wo<em>rt</em>` ist im Browser
// „Wort", ein Tag-zu-Leerzeichen-Strip machte daraus „Wo rt".
function contentWords(parts) {
  const set = new Set();
  for (const html of parts) {
    if (!html) continue;
    for (const w of words(htmlToPlainText(html))) set.add(w);
    for (const w of words(htmlToPlainText(String(html).replace(/<\/?(?:em|strong|b|i|u|s|span|mark|a|sup|sub|small|code)\b[^>]*>/gi, '')))) set.add(w);
  }
  return set;
}

async function _load(link) {
  const { loadContentForLink } = require('./share-helpers');
  const content = await loadContentForLink(link);
  if (!content) return null;
  const entry = { at: Date.now(), words: contentWords([content.title, content.kicker, content.html]) };
  _cache.set(link.token, entry);
  while (_cache.size > MAX_ENTRIES) _cache.delete(_cache.keys().next().value);
  return entry;
}

async function _entry(link) {
  const e = _cache.get(link.token);
  if (e && Date.now() - e.at < TTL_MS) return e;
  return _load(link);
}

function _ratio(entry, ws) {
  let hit = 0;
  for (const w of ws) if (entry.words.has(w)) hit++;
  return hit / ws.length;
}

/** Stammt `text` aus dem geteilten Inhalt? Text ohne Woerter → true (der
 *  Synthese-Kern weist ihn ohnehin als leer ab). */
async function isFromSharedContent(link, text) {
  const ws = words(text);
  if (!ws.length) return true;
  let entry = await _entry(link);
  if (!entry) return false;
  if (_ratio(entry, ws) >= MIN_HIT_RATIO) return true;
  // Inhalt kann sich seit dem Cachen geaendert haben (Autor tippt weiter).
  if (Date.now() - entry.at < REFRESH_MIN_AGE_MS) return false;
  entry = await _load(link);
  return !!entry && _ratio(entry, ws) >= MIN_HIT_RATIO;
}

function _resetForTests() { _cache.clear(); }

module.exports = { isFromSharedContent, contentWords, words, _resetForTests };
