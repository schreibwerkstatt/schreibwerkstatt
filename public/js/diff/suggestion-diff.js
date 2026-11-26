// Änderungsvorschlag eines Reviewers (Share-Link im Review-Modus) als Diff,
// gekürzt auf die geänderten Sätze — eine Darstellung für Share-Reader,
// Notebook-Leseansicht und Bucheditor.
//
// Die markierte Stelle ist oft ein ganzer Absatz, die Änderung ein Wort; der
// volle Alt- und Neutext nebeneinander verstecken sie. Gezeigt werden deshalb
// nur die Sätze mit einer Änderung — wenig geändert als Wort-Diff, umgeschrieben
// als ganzer Satz alt → neu (sentence-diff.js, dieselbe Regel wie alle
// Diff-Ansichten im Lesefluss); unveränderte Sätze davor, dazwischen und danach
// werden zu «…».
//
// Pure — kein DOM, kein Alpine. Markierung und Klassen: diff-parts.js.

import { wordDiff } from './word-diff.js';
import { markParts } from './diff-parts.js';
import { sentenceUnits, sentenceChanged, readableSentence, readableParts } from './sentence-diff.js';

const ELLIPSIS = '…';

/**
 * Markierte Teile des Vorschlags (`{ t, v, c }`, wie markParts), auf die
 * geänderten Sätze gekürzt. Ausgelassenes steht als Gleichtext «…».
 * `null`, wenn der Text zu gross für den Wort-Diff ist — der Aufrufer zeigt
 * dann den neuen Text ungemarkert.
 * @param {string} oldText  markierte Stelle (Anker-Zitat)
 * @param {string} newText  Ersatztext des Reviewers
 * @returns {Array<{t:string,v:string,c:string}>|null}
 */
export function suggestionDiffParts(oldText, newText) {
  const parts = wordDiff(String(oldText ?? ''), String(newText ?? ''));
  if (!parts) return null;
  const sentences = sentenceUnits(parts);
  const changed = sentences.map(sentenceChanged);
  if (!changed.some(Boolean)) return markParts(readableParts(parts), 'both');

  const out = [];
  // Rand-Whitespace vor einer Auslassung fällt weg, sonst steht «…» mit
  // doppelter Lücke bzw. das Ende mit hängendem Leerzeichen.
  const trimTail = () => {
    const tail = out[out.length - 1];
    if (tail?.t === 'eq') tail.v = tail.v.trimEnd();
  };
  let skipped = false;
  sentences.forEach((s, k) => {
    if (!changed[k]) { skipped = true; return; }
    if (skipped) {
      trimTail();
      out.push({ t: 'eq', v: out.length ? ` ${ELLIPSIS} ` : `${ELLIPSIS} ` });
    }
    skipped = false;
    out.push(...readableSentence(s));
  });
  trimTail();
  if (skipped) out.push({ t: 'eq', v: ` ${ELLIPSIS}` });
  return markParts(out, 'both');
}
