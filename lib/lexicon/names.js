'use strict';
// Eigennamen (Figuren, Orte, Szenentitel) als Zusatz-Stoppwörter der Wortliste.
// Pure — die Namen liest der Job aus der DB, hier wird nur normalisiert.
//
// Zwei Quellen werden vereinigt:
//   - `baseWords`: die Namensteile aus lib/page-index.js#tokenizeNamesForStopwords
//     (dieselbe Zerlegung wie die Wiederholungs-Metrik, inkl. Blocklist für
//     Anreden/Titel). Sie werden hier durch DIESELBE Normalisierung geschickt wie
//     der Buchtext (NFC, ß→ss, Apostroph-Faltung) — sonst greift „Straßer" oder
//     ein zerlegt importiertes „José" nicht.
//   - Namen mit innerem Apostroph („O'Brien"): die Basis-Zerlegung trennt am
//     Apostroph und liefert „brien", der Text-Tokenizer behält „o'brien" als ein
//     Token. Darum zusätzlich jedes Apostroph-Token aus dem Namen selbst.
//
// Genitiv: „Annas Blick" ist im Deutschen der häufigste Kontext eines Namens.
// Ohne die s-Form stünde „annas" als Lieblingswort in der Liste, obwohl der Name
// selbst gefiltert ist. Namen auf s/x/z bilden den Genitiv mit Apostroph
// („Hans'"), der Tokenizer liefert dort ohnehin die Grundform. Der englische
// Genitiv („Anna's") bleibt im Tokenizer ein Token — darum auch die 's-Form.

const { normalizeToken, tokenize } = require('./tokenize');

const MIN_NAME_LEN = 4;

function buildNameStopwords(names, baseWords) {
  const out = new Set();
  const add = (w) => {
    const t = normalizeToken(w);
    if (t.length < MIN_NAME_LEN) return;
    out.add(t);
    if (!/[sxz]$/.test(t)) out.add(t + 's');
    out.add(t + "'s");
  };
  for (const w of baseWords || []) add(w);
  for (const n of names || []) {
    if (!n) continue;
    for (const t of tokenize(n)) if (t.includes("'")) add(t);
  }
  return out;
}

module.exports = { buildNameStopwords };
