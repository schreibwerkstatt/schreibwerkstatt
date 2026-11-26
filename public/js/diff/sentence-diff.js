// Satzweise Lesbarkeit eines Wort-Diffs — geteilt von allen Diff-Ansichten im
// Lesefluss (Chat-/Profil-Vorschläge über diff-parts.js#diffParts, Inline-Ansicht
// der Abschnitts-Historie, Änderungsvorschläge der Kommentar-Leisten über
// suggestion-diff.js).
//
// Ein Wort-Diff liest sich gut, solange in einem Satz wenig ändert. Ist ein Satz
// umgeschrieben, wechseln Streichung und Einfügung Wort für Wort ab und keine der
// beiden Fassungen ist mehr lesbar. Solche Sätze erscheinen deshalb wie ein
// Lektorat-Befund (Original → Korrektur): der alte Satz ganz gestrichen, danach
// der neue ganz eingefügt.
//
// Pure — kein DOM, kein Alpine. Ein- und Ausgabe sind rohe Teile
// `[{ t: 'eq'|'del'|'add', v }]` (word-diff.js); markiert wird danach (diff-parts.js).

// Satzende im Gleichtext: Satzzeichen, optional schliessende Anführung/Klammer,
// dann Whitespace — oder ein Zeilenumbruch. Satzgrenzen in einer Änderung zählen
// nicht: reicht eine Änderung über ein Satzende, bleiben beide Sätze zusammen.
const SENTENCE_END = /[.!?…][»«"'”’)\]]*\s+|\n+/g;

const WORD_RE = /[\p{L}\p{N}]+/gu;
const _words = s => (s.match(WORD_RE) || []).length;

// Ab hier gilt ein Satz als umgeschrieben: mehr als ein Drittel seiner Wörter
// (alt + neu) geändert und mindestens drei geänderte Wörter — ein einzelnes
// ersetztes Wort (zwei geänderte) bleibt immer ein Wort-Diff, auch im Kurzsatz.
const REWRITE_SHARE = 1 / 3;
const REWRITE_MIN_WORDS = 3;

/** Rohe Diff-Teile → Sätze, je Satz eine Liste von Teilen. */
export function sentenceUnits(parts) {
  const out = [[]];
  for (const p of parts) {
    if (p.t !== 'eq') { out[out.length - 1].push(p); continue; }
    let last = 0;
    for (const m of p.v.matchAll(SENTENCE_END)) {
      const end = m.index + m[0].length;
      out[out.length - 1].push({ t: 'eq', v: p.v.slice(last, end) });
      out.push([]);
      last = end;
    }
    if (last < p.v.length) out[out.length - 1].push({ t: 'eq', v: p.v.slice(last) });
  }
  return out.filter(s => s.length);
}

/** Hat der Satz eine Änderung? */
export const sentenceChanged = s => s.some(p => p.t !== 'eq');

/** Ist der Satz so stark geändert, dass er als Ganzes gezeigt wird? */
export function sentenceRewritten(s) {
  let changed = 0;
  let total = 0;
  for (const p of s) {
    const n = _words(p.v);
    total += p.t === 'eq' ? 2 * n : n;   // Gleichtext steht in alt und neu
    if (p.t !== 'eq') changed += n;
  }
  return changed >= REWRITE_MIN_WORDS && changed > total * REWRITE_SHARE;
}

/** Satz → alter Satz ganz gestrichen, neuer ganz eingefügt; Rand-Whitespace bleibt Gleichtext. */
function _asBlock(s) {
  const oldText = s.filter(p => p.t !== 'add').map(p => p.v).join('');
  const newText = s.filter(p => p.t !== 'del').map(p => p.v).join('');
  const ws = /\s*$/.exec(oldText)[0];
  const newTrim = newText.replace(/\s*$/, '');
  const out = [];
  if (oldText.trim()) out.push({ t: 'del', v: oldText.slice(0, oldText.length - ws.length) });
  if (newTrim.trim()) out.push({ t: 'add', v: newTrim });
  if (ws) out.push({ t: 'eq', v: ws });
  // Zwischen Streichung und Einfügung ein Leerzeichen, sonst kleben die Sätze.
  if (out[0]?.t === 'del' && out[1]?.t === 'add') out.splice(1, 0, { t: 'eq', v: ' ' });
  return out;
}

/** Einen Satz lesbar machen: umgeschrieben → als Block, sonst unverändert. */
export function readableSentence(s) {
  return sentenceRewritten(s) ? _asBlock(s) : s;
}

/**
 * Rohe Diff-Teile satzweise lesbar machen (umgeschriebene Sätze als Block).
 * `null` bleibt `null` (Text zu gross für den Wort-Diff).
 * @param {Array<{t:string,v:string}>|null} parts
 */
export function readableParts(parts) {
  if (!parts) return null;
  return sentenceUnits(parts).flatMap(readableSentence);
}
