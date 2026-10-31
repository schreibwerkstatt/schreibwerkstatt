// Text-Logik der Synonymsuche: Wort erkennen, Satz-Kontext schneiden,
// Schreibung des Ersatzworts angleichen.
//
// Zwei Konsumenten: SPA-Picker ([editor/synonyme.js]) und der Alpine-freie
// Controller ([cards/editor-synonyme/controller.js]), der im OTA-Editor-Bundle
// an den nativen Mac-Focus-Writer geht. Darum framework-frei und ohne Imports —
// das Modul landet über die Import-Closure des Controllers im Bundle.

// Ein Synonym-Kandidat: beginnt mit Buchstabe/Ziffer, danach Buchstaben, Ziffern,
// Kombinationszeichen, Bindestrich und beide Apostrophe (geht's / geht’s).
const WORD_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*$/u;
const WORD_CHAR_RE = /[\p{L}\p{M}\p{N}'’-]/u;
// Zeichen, die am Wortrand nicht zum Wort gehören („Haus- und Gartenarbeit",
// «'Wort'»).
const EDGE_RE = /^['’-]+|['’-]+$/gu;

// Satz-Kontext für den KI-Call: grösser als jeder normale Satz, klein genug,
// dass ein Absatz ohne Satzzeichen nicht als Ganzes mitgeht.
export const SENTENCE_MAX = 600;

// Abkürzungen, deren Punkt keinen Satz beendet (klein geschrieben, ohne Punkt).
// Einbuchstabige Tokens („z.", „B.", „d.") fängt die Längen-Regel ab.
const ABBREVIATIONS = new Set([
  'abb', 'abs', 'bd', 'bzw', 'ca', 'dr', 'etc', 'evtl', 'fr', 'ggf', 'hr', 'inkl',
  'jh', 'jr', 'kap', 'max', 'min', 'mio', 'mr', 'mrs', 'ms', 'nr', 'prof', 'sr',
  'st', 'str', 'tel', 'usw', 'vgl', 'vs', 'zb', 'zt',
]);

/** Kanonische Form eines markierten Worts: NFC (zerlegte Umlaute aus macOS-
 *  Paste), Randzeichen ab. Liefert '' für alles, was kein Einzelwort ist. */
export function normalizeSynonymWord(text) {
  const w = String(text || '').normalize('NFC').trim().replace(EDGE_RE, '');
  return WORD_RE.test(w) ? w : '';
}

/** Wortgrenzen um `offset` in einem Text-Knoten-String. Liefert
 *  `{ start, end, word }` (word bereits normalisiert, Randzeichen ausserhalb
 *  von start/end) oder null. */
export function wordBoundsAt(text, offset) {
  let s = offset;
  let e = offset;
  while (s > 0 && WORD_CHAR_RE.test(text[s - 1])) s--;
  while (e < text.length && WORD_CHAR_RE.test(text[e])) e++;
  // Randzeichen aus dem Bereich schieben, damit die Ersetzung sie stehen lässt.
  while (s < e && /['’-]/u.test(text[s])) s++;
  while (e > s && /['’-]/u.test(text[e - 1])) e--;
  if (e <= s) return null;
  const word = normalizeSynonymWord(text.slice(s, e));
  return word ? { start: s, end: e, word } : null;
}

// Endet der Satz an Index `i` (ein `.`/`!`/`?`/`…`) in `full`?
function _isBoundary(full, i) {
  const ch = full[i];
  if (ch !== '.') return true;
  // „..." gilt als Auslassung am Satzende, nur der letzte Punkt zählt.
  if (full[i + 1] === '.') return false;
  const token = (full.slice(0, i).match(/([\p{L}\p{N}]+)$/u) || [])[1] || '';
  if (/^\d+$/u.test(token)) return false;                 // „3. Mai", „19. Jh."
  if (token.length === 1) return false;                    // „z. B.", „d. h."
  if (ABBREVIATIONS.has(token.toLowerCase())) return false;
  // Nach dem Punkt muss ein neuer Satz beginnen (Grossbuchstabe, Ziffer,
  // öffnendes Zeichen) oder der Text enden.
  const rest = full.slice(i + 1).replace(/^[\s"»«“”‚‘')\]]+/u, '');
  if (!rest) return true;
  return !/^\p{Ll}/u.test(rest);
}

/** Schneidet den Satz um `offset` aus einem whitespace-normalisierten Text.
 *  Überlange Sätze werden auf ein Fenster um das Wort gekürzt. */
export function sentenceAround(full, offset, wordLength = 0) {
  if (!full) return '';
  let start = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (/[.!?…]/u.test(full[i]) && _isBoundary(full, i)) { start = i + 1; break; }
  }
  let end = full.length;
  for (let i = offset + Math.max(wordLength, 1); i < full.length; i++) {
    if (/[.!?…]/u.test(full[i]) && _isBoundary(full, i)) { end = i + 1; break; }
  }
  // Schliessende Zeichen direkt nach dem Satzende gehören zum Satz.
  while (end < full.length && /["»“”‘')\]]/u.test(full[end])) end++;
  const raw = full.slice(start, end);
  const lead = raw.length - raw.trimStart().length;
  const sentence = raw.trim();
  if (sentence.length <= SENTENCE_MAX) return sentence;
  return windowAround(sentence, offset - start - lead, wordLength, SENTENCE_MAX);
}

/** Fenster von höchstens `max` Zeichen um [offset, offset+len), an Wortgrenzen
 *  geschnitten und mit „…" markiert. Geteilt mit dem Server-Deckel. */
export function windowAround(text, offset, len, max) {
  if (text.length <= max) return text;
  const pad = Math.max(0, Math.floor((max - len) / 2));
  let s = Math.max(0, offset - pad);
  let e = Math.min(text.length, s + max);
  s = Math.max(0, e - max);
  if (s > 0) { const sp = text.indexOf(' ', s); if (sp > -1 && sp < offset) s = sp + 1; }
  if (e < text.length) { const sp = text.lastIndexOf(' ', e); if (sp > offset + len) e = sp; }
  return (s > 0 ? '…' : '') + text.slice(s, e).trim() + (e < text.length ? '…' : '');
}

/** Steht ein Wort am Satzanfang? `prefix` = Text des Blocks vor dem Wort. */
export function isSentenceStart(prefix) {
  const p = String(prefix || '').replace(/[\s"„“”«»‹›‚‘'(\[—–-]+$/u, '');
  if (!p) return true;
  const i = p.length - 1;
  return /[.!?…]/u.test(p[i]) && _isBoundary(p + ' X', i);
}

/** Gleicht die Schreibung des Ersatzworts an das Original an: VERSALIEN
 *  bleiben Versalien, am Satzanfang wird gross geschrieben. Mitten im Satz
 *  bleibt die Schreibung des Vorschlags (Substantive, Eigennamen). */
export function matchSynonymCase(original, replacement, atSentenceStart) {
  const o = String(original || '');
  const r = String(replacement || '');
  if (!o || !r) return r;
  const letters = o.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toLocaleUpperCase() && letters !== letters.toLocaleLowerCase()) {
    return r.toLocaleUpperCase();
  }
  if (atSentenceStart && /^\p{Lu}/u.test(o)) {
    return r.charAt(0).toLocaleUpperCase() + r.slice(1);
  }
  return r;
}

// ── DOM-Teil ──────────────────────────────────────────────────────────────

const BLOCK_SEL = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, figcaption, td, th, dt, dd, div';

// Umschliessender Textblock der Range, nie ausserhalb von `root`.
function _blockOf(range, root) {
  let node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const block = node?.closest?.(BLOCK_SEL);
  if (block && (!root || root.contains(block))) return block;
  return root || block || node;
}

// Text des Blocks vor der Range-Start-Position, gleich normalisiert wie der
// Volltext (Whitespace kollabiert, führender Whitespace weg).
function _prefixText(range, block) {
  const pre = document.createRange();
  pre.selectNodeContents(block);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().replace(/\s+/g, ' ').trimStart();
}

/** Satz-Kontext um die Range: `{ satz, sentenceStart }`. */
export function synonymContext(range, wort, root) {
  const block = _blockOf(range, root);
  const full = (block?.textContent || '').replace(/\s+/g, ' ').trim();
  if (!full) return { satz: wort, sentenceStart: true };
  let prefix = null;
  try { prefix = _prefixText(range, block); } catch { /* Fallback via indexOf */ }
  let offset = prefix != null ? prefix.length : -1;
  if (offset < 0 || offset > full.length) offset = full.indexOf(wort);
  if (offset < 0) return { satz: windowAround(full, 0, 0, SENTENCE_MAX), sentenceStart: false };
  return {
    satz: sentenceAround(full, offset, wort.length) || wort,
    sentenceStart: isSentenceStart(full.slice(0, offset)),
  };
}
