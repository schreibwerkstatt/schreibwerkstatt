'use strict';
// Kandidatenstellen je Figur für Beleg-Jobs (Schulweg-Vorschlag, Berufsweg-/
// Hobby-Vorschlag): Sätze, in denen eine Figur und ein Themenbegriff stehen,
// gekappt, über das Buch verteilt ausgewählt — und später das Zitat des Modells
// darin nachschlagen. Eine Mechanik, je Job nur der Begriffs-Regex.
//
// Steht im Satz keine Figur, gilt der Satz davor — aber nur, wenn dort genau
// eine steht; bei zweien wüsste niemand, wem das «sie» gehört, und die
// Zitatprüfung könnte die Verwechslung nicht fangen.

const { figuresInText, splitSentences, trimSatz } = require('../../../lib/figure-age');

const SATZ_MAX = 320;

/** Normalform für den Zitatvergleich (Anführungszeichen, Striche, Leerraum). */
const normZitat = (s) => String(s ?? '').toLowerCase()
  .replace(/[«»„“”‚‘’"'`´]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

/** Satz um den ersten Treffer von `re` auf `max` Zeichen kappen (an Wortgrenzen). */
function clipAround(text, re, max = SATZ_MAX) {
  const t = trimSatz(text);
  if (t.length <= max) return t;
  const m = re.exec(t);
  const at = m ? m.index : 0;
  let start = Math.max(0, at - Math.floor(max / 2));
  const sp = t.lastIndexOf(' ', start);
  if (sp > 0 && start - sp < 20) start = sp + 1;
  return t.slice(start, start + max).replace(/\s\S*$/, '');
}

/** Gleichmässig über den Buchbogen verteilt auswählen (erste + letzte immer). */
function spread(list, max) {
  if (list.length <= max) return list;
  // max = 1 hiesse (max - 1) = 0 im Nenner → Index NaN → undefined-Eintrag.
  if (max <= 1) return max === 1 ? [list[0]] : [];
  const out = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

/** Stellen einer Figur auswählen: starke Begriffe zuerst (verteilt), mit
 *  schwachen auffüllen (verteilt) — Reihenfolge danach wieder im Buchverlauf. */
function pickStellen(list, max, strongRe) {
  const stark = list.filter(s => strongRe.test(s.satz));
  const schwach = list.filter(s => !strongRe.test(s.satz));
  const picked = spread(stark, max);
  if (picked.length < max) picked.push(...spread(schwach, max - picked.length));
  const order = new Map(list.map((s, i) => [s, i]));
  return picked.sort((a, b) => order.get(a) - order.get(b));
}

/** Kandidatensätze je Figur (Map figures.id → [{ satz, page_id }]). */
function collectStellen(pageTexts, nameIndex, re, max = SATZ_MAX) {
  const byFig = new Map();
  for (const { text, page_id } of pageTexts) {
    const sents = splitSentences(text);
    for (let i = 0; i < sents.length; i++) {
      const cur = sents[i].text;
      if (!re.test(cur)) continue;
      let ids = figuresInText(cur, nameIndex);
      let satz = cur;
      if (!ids.length && i > 0) {
        const prev = figuresInText(sents[i - 1].text, nameIndex);
        if (prev.length !== 1) continue;
        ids = prev;
        satz = `${sents[i - 1].text} ${cur}`;
      }
      for (const id of ids) {
        if (!byFig.has(id)) byFig.set(id, []);
        byFig.get(id).push({ satz: clipAround(satz, re, max), page_id });
      }
    }
  }
  return byFig;
}

/** Die Stelle, aus der das Zitat stammt: zuerst die vom Modell genannte
 *  («2.3» = Figur 2, Stelle 3 im Bündel), sonst irgendeine Stelle der Figur. */
function findeStelle(zitat, stellen, stelleRef, figIndex) {
  const nz = normZitat(zitat);
  const m = /^(\d+)\.(\d+)$/.exec(String(stelleRef || '').trim());
  if (m && Number(m[1]) === figIndex + 1) {
    const s = stellen[Number(m[2]) - 1];
    if (s && normZitat(s.satz).includes(nz)) return s;
  }
  return stellen.find(s => normZitat(s.satz).includes(nz)) || null;
}

module.exports = { SATZ_MAX, normZitat, clipAround, spread, pickStellen, collectStellen, findeStelle };
