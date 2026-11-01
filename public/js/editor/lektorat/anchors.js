// Positions-Anker der Übernahmen im Notebook-Edit-Modus (editor/lektorat-live.js).
// Pure, ohne DOM: gerechnet wird auf dem Index-Text von shared/text-locate.js
// (Anführungszeichen gefaltet, Whitespace kollabiert) — `at` ist der Offset der
// eingesetzten Korrektur darin, -1 = unbekannt.
//
// Strg+Z ist erst dann erkannt, wenn genau an der Stelle der Übernahme wieder
// das Original steht. Eine Suche im ganzen Abschnitt fände dieselbe Korrektur
// auch anderswo («dass» steht in fast jedem Text) und hielte die Übernahme
// für noch da.

import { normalizeMatchText } from '../../utils/text-match.js';

/** Längenänderung einer Übernahme im Index-Text. */
export function correctionDelta(f) {
  return normalizeMatchText(f.korrektur).length - normalizeMatchText(f.original).length;
}

/** Anker auf einen neuen Text nachführen. Geändert hat sich der Bereich
 *  zwischen gemeinsamem Anfang und gemeinsamem Ende: ein Anker davor bleibt,
 *  einer dahinter verschiebt sich um die Längendifferenz. Ein Anker im
 *  geänderten Bereich bleibt stehen — dort entscheidet `anchorState`. */
export function shiftAnchors(prevText, text, entries) {
  if (prevText == null || prevText === text) return;
  const max = Math.min(prevText.length, text.length);
  let p = 0;
  while (p < max && prevText[p] === text[p]) p++;
  let s = 0;
  while (s < max - p && prevText[prevText.length - 1 - s] === text[text.length - 1 - s]) s++;
  const oldEnd = prevText.length - s;
  const delta = text.length - prevText.length;
  for (const e of entries) {
    if (e.at >= 0 && e.at >= oldEnd) e.at += delta;
  }
}

/** Anker über bekannte Ersetzungen nachführen (`edits`: `{ at, len, delta }`,
 *  Offsets im Text VOR den Ersetzungen) — genauer als `shiftAnchors`, wenn
 *  eine Übernahme mehrere Stellen auf einmal ersetzt. */
export function shiftAnchorsByEdits(edits, entries) {
  for (const e of entries) {
    if (e.at < 0) continue;
    const at = e.at;
    for (const ed of edits) if (ed.at + ed.len <= at) e.at += ed.delta;
  }
}

/** Steht an der gemerkten Stelle die Korrektur ('applied'), wieder das
 *  Original ('undone') oder keins von beiden ('lost', umgeschrieben)?
 *  null = kein Anker. Bei gleichem Anfang („sagte er" ↔ „sagte er,") prüft
 *  die längere Form zuerst, sonst sähe die kürzere in der längeren sich selbst. */
export function anchorState(text, entry) {
  if (!(entry.at >= 0)) return null;
  const k = normalizeMatchText(entry.f.korrektur);
  const o = normalizeMatchText(entry.f.original);
  const forms = k.length >= o.length ? [[k, 'applied'], [o, 'undone']] : [[o, 'undone'], [k, 'applied']];
  for (const [form, state] of forms) if (form && text.startsWith(form, entry.at)) return state;
  return 'lost';
}
