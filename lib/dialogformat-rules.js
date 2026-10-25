'use strict';
// Regelbasierte Prüfung der direkten Rede (typ «dialogformat»), deutsche und
// englische Norm.
//
// Ergänzt das KI-Lektorat um Befunde, die sich ohne Sprachverständnis sicher
// erkennen lassen: der Anschluss des Begleitsatzes an die Rede. Läuft für jeden
// Provider — lokale Modelle prüfen `dialogformat` gar nicht (LOCAL_SET in
// prompts/lektorat-typen.js), und auch Claude übersieht einzelne Stellen.
// Jede Regel ist an ein Verb des Sagens gebunden (INQUIT): ohne Verb kein
// Befund, so dass hervorgehobene Begriffe und Titel in Anführungszeichen nie
// anschlagen. Bewusst NICHT hier: Wahl und Einheitlichkeit des Anführungszeichen-
// Stils — die braucht den Blick aufs ganze Buch und bleibt beim Modell.
//
// Jeder Befund trägt `erklaerung_key` (i18n, `lektorat.regel.*`): das Frontend
// zeigt die Erklärung in der UI-Sprache (findingErklaerung in public/js/i18n.js).
// «erklaerung» bleibt als Text in der Buchsprache für Leser ohne i18n (Buch-Chat-
// Werkzeuge, Konsolidierung).
//
// Deutsch: Komma NACH dem schliessenden Anführungszeichen, auch nach ?/!.
// Englisch (US und GB gleich für Dialog): Komma IN der Rede, nach ?/! kein Komma.
// Britische Sachtexte setzen Satzzeichen logisch (nur ins Zitat, wenn sie dazu-
// gehören) — dort entfallen die Komma-Regeln, die ein Fragment-Zitat träfen.

const INQUIT_VERBEN = [
  'sagte', 'sagt', 'fragte', 'fragt', 'rief', 'ruft', 'meinte', 'meint',
  'antwortete', 'antwortet', 'erwiderte', 'erwidert', 'entgegnete', 'entgegnet',
  'flüsterte', 'flüstert', 'murmelte', 'murmelt', 'schrie', 'schreit',
  'brüllte', 'brüllt', 'knurrte', 'knurrt', 'zischte', 'zischt',
  'stammelte', 'stammelt', 'seufzte', 'seufzt', 'wiederholte', 'wiederholt',
  'bemerkte', 'bemerkt', 'erklärte', 'erklärt', 'behauptete', 'behauptet',
  'versicherte', 'versichert', 'fügte', 'fügt', 'raunte', 'raunt',
  'hauchte', 'haucht', 'befahl', 'befiehlt', 'bat', 'bittet', 'warf', 'wirft',
];
const INQUIT = `(?:${INQUIT_VERBEN.join('|')})`;
const INQUIT_GROSS = `(?:${INQUIT_VERBEN.map(v => v[0].toUpperCase() + v.slice(1)).join('|')})`;
// Schliessende bzw. öffnende Anführungszeichen. « und » sind je nach Stil
// (»…« oder «…») öffnend oder schliessend; die Regeln lesen sie aus der Stellung.
const CLOSE = '[“”"«»]';
const OPEN = '[„"«»]';
// Wortende ohne eigenes Satzzeichen (Buchstabe, Ziffer, schliessende Klammer).
const WORT = '[\\p{L}\\p{N})]';
// Nach dem Verb folgt das Subjekt (Pronomen oder Name): «„Komm“ sagte sie».
// Ohne diese Bedingung schlüge ein Begriff in Anführungszeichen an («„Liebe“ sagt viel»).
const SUBJEKT = '(?=[ \\t]+(?:ich|du|er|sie|es|wir|ihr|man|\\p{Lu}))';
// Die Rede nach einem vorangestellten Begleitsatz ist ein Satz: Grossbuchstabe am
// Anfang, Satzzeichen vor dem Schluss. Sonst ist es ein zitierter Titel oder
// Begriff in indirekter Rede («Er sagte, „Faust“ sei langweilig»).
const REDE_SATZ = '(?=\\p{Lu}[^„“”"«»\\n]*[.!?…][“”"«»])';

// Jede Regel: Regex (global, unicode) + Bau von korrektur/erklaerung aus dem Treffer.
// «original» ist immer der ganze Treffer — mit dem letzten Redewort davor, damit
// er im Text eindeutig auffindbar ist.
const REGELN_DE = [
  {
    // „Komm her!“ rief sie. → „Komm her!“, rief sie.
    re: new RegExp(`(\\p{L}+[!?…])(${CLOSE})([ \\t]+)(${INQUIT})\\b`, 'gu'),
    korrektur: (m) => `${m[1]}${m[2]}, ${m[4]}`,
    erklaerung: 'Auch nach Frage- oder Ausrufezeichen steht nach dem schliessenden Anführungszeichen ein Komma.',
    key: 'lektorat.regel.kommaNachFrage',
  },
  {
    // „Komm her“ sagte sie. → „Komm her“, sagte sie.
    re: new RegExp(`(\\p{L}*${WORT})(${CLOSE})([ \\t]+)(${INQUIT})\\b${SUBJEKT}`, 'gu'),
    korrektur: (m) => `${m[1]}${m[2]}, ${m[4]}`,
    erklaerung: 'Zwischen Rede und nachgestelltem Begleitsatz fehlt das Komma nach dem schliessenden Anführungszeichen.',
    key: 'lektorat.regel.kommaFehlt',
  },
  {
    // „Komm her.“, sagte sie. / „Komm her.“ sagte sie. → „Komm her“, sagte sie.
    re: new RegExp(`(\\p{L}+)\\.(${CLOSE}),?([ \\t]+)(${INQUIT})\\b`, 'gu'),
    korrektur: (m) => `${m[1]}${m[2]}, ${m[4]}`,
    erklaerung: 'Folgt der Begleitsatz, entfällt der Punkt am Ende der Rede; das Komma steht nach dem Anführungszeichen.',
    key: 'lektorat.regel.punktVorInquit',
  },
  {
    // „Komm her,“ sagte sie. → „Komm her“, sagte sie.
    re: new RegExp(`(\\p{L}+),(${CLOSE})([ \\t]+)(${INQUIT})\\b`, 'gu'),
    korrektur: (m) => `${m[1]}${m[2]}, ${m[4]}`,
    erklaerung: 'Das Komma gehört nach das schliessende Anführungszeichen, nicht davor.',
    key: 'lektorat.regel.kommaVorZeichen',
  },
  {
    // „Komm her“, Sagte sie. → „Komm her“, sagte sie.
    re: new RegExp(`(\\p{L}+[!?…]?${CLOSE}),([ \\t]+)(${INQUIT_GROSS})\\b`, 'gu'),
    korrektur: (m) => `${m[1]},${m[2]}${m[3].toLowerCase()}`,
    erklaerung: 'Der nachgestellte Begleitsatz beginnt klein.',
    key: 'lektorat.regel.inquitKlein',
  },
  {
    // Sie sagte, „Komm her.“ → Sie sagte: „Komm her.“
    // Bis zu drei Wörter zwischen Verb und Komma («sagte sie leise zu ihm»).
    re: new RegExp(`\\b(${INQUIT})((?:[ \\t]+\\p{L}+){0,3}),[ \\t]*(${OPEN})${REDE_SATZ}`, 'gu'),
    korrektur: (m) => `${m[1]}${m[2]}: ${m[3]}`,
    erklaerung: 'Ein vorangestellter Begleitsatz wird mit Doppelpunkt an die Rede angeschlossen.',
    key: 'lektorat.regel.doppelpunkt',
    // Eingeschobenes Inquit («„Komm“, sagte sie, „aber leise.“»): vor dem Verb
    // steht ein schliessendes Anführungszeichen mit Komma — dort ist das Komma richtig.
    ausnahme: (text, index) => new RegExp(`${CLOSE},[ \\t]*$`, 'u').test(text.slice(Math.max(0, index - 4), index)),
  },
];

// ── Englisch ────────────────────────────────────────────────────────────────
const SAY_VERBS = [
  'said', 'says', 'asked', 'asks', 'replied', 'replies', 'answered', 'shouted',
  'yelled', 'cried', 'called', 'whispered', 'muttered', 'murmured', 'snapped',
  'sighed', 'added', 'continued', 'repeated', 'insisted', 'explained',
  'admitted', 'demanded', 'protested',
];
const SAY = `(?:${SAY_VERBS.join('|')})`;
// Begleitsatz: Pronomen + Verb («she said») oder Verb + Subjekt («said Anna»).
// Ein grossgeschriebenes «She said» nach dem Punkt ist ein neuer Satz und trifft
// absichtlich nicht («"Come here." She said it softly.»).
const TAG = `(?:(?:he|she|they|we|you|I)[ \\t]+${SAY}|${SAY}[ \\t]+(?:he|she|they|we|you|I|\\p{Lu}\\p{L}*))\\b`;
const CLOSE_EN = '[”"’\']';

const REGELN_EN = [
  {
    // "Come here!", she said. → "Come here!" she said.
    re: new RegExp(`(\\p{L}+[!?])(${CLOSE_EN}),([ \\t]+)(${TAG})`, 'gu'),
    korrektur: (m) => `${m[1]}${m[2]} ${m[4]}`,
    erklaerung: 'After a question or exclamation mark inside the quotes, no comma follows the closing quote.',
    key: 'lektorat.regel.enKeinKommaNachFrage',
  },
  {
    // "Come here." she said. → "Come here," she said.
    re: new RegExp(`(\\p{L}+)\\.(${CLOSE_EN})([ \\t]+)(${TAG})`, 'gu'),
    korrektur: (m) => `${m[1]},${m[2]} ${m[4]}`,
    erklaerung: 'When a dialogue tag follows, the speech ends with a comma inside the quotes, not a full stop.',
    key: 'lektorat.regel.enPunktStattKomma',
  },
  {
    // "Come here", she said. → "Come here," she said.
    re: new RegExp(`(\\p{L}+)(${CLOSE_EN}),([ \\t]+)(${TAG})`, 'gu'),
    korrektur: (m) => `${m[1]},${m[2]} ${m[4]}`,
    erklaerung: 'The comma before a dialogue tag belongs inside the closing quote.',
    key: 'lektorat.regel.enKommaInnen',
    logisch: true,
  },
  {
    // "Come here" she said. → "Come here," she said.
    re: new RegExp(`(\\p{L}+)(${CLOSE_EN})([ \\t]+)(${TAG})`, 'gu'),
    korrektur: (m) => `${m[1]},${m[2]} ${m[4]}`,
    erklaerung: 'A comma inside the quotes is missing before the dialogue tag.',
    key: 'lektorat.regel.enKommaFehlt',
    logisch: true,
  },
  {
    // "Come here," She said. → "Come here," she said.
    re: new RegExp(`(\\p{L}+,${CLOSE_EN})([ \\t]+)(He|She|They|We|You)([ \\t]+${SAY})\\b`, 'gu'),
    korrektur: (m) => `${m[1]}${m[2]}${m[3].toLowerCase()}${m[4]}`,
    erklaerung: 'The dialogue tag after the comma continues the sentence and starts lowercase.',
    key: 'lektorat.regel.enTagKlein',
  },
];

/**
 * Befunde der Regelprüfung für einen Seitentext.
 * @param {string} text  Prompt-Text der Seite (htmlToTextForPrompt)
 * @param {string} langCode
 * @param {{locale?: string|null, sachtext?: boolean}} [opts]  `sachtext` = Buchtyp
 *   ausserhalb des narrativen Profils (für die logische Zeichensetzung in en-GB)
 * @returns {{typ:'dialogformat', original:string, korrektur:string, erklaerung:string, erklaerung_key:string, regel:true}[]}
 */
function checkDialogformat(text, langCode = 'de', { locale = null, sachtext = false } = {}) {
  if (!text) return [];
  let regeln;
  if (langCode === 'de') regeln = REGELN_DE;
  else if (langCode === 'en') {
    const logisch = locale === 'en-GB' && sachtext;
    regeln = logisch ? REGELN_EN.filter(r => !r.logisch) : REGELN_EN;
  } else return [];
  const out = [];
  const belegt = [];
  for (const regel of regeln) {
    for (const m of text.matchAll(regel.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (regel.ausnahme?.(text, start)) continue;
      // Eine Stelle nur einmal: die erste (spezifischere) Regel gewinnt.
      if (belegt.some(([s, e]) => start < e && s < end)) continue;
      const korrektur = regel.korrektur(m);
      if (korrektur === m[0]) continue;
      belegt.push([start, end]);
      out.push({
        typ: 'dialogformat', original: m[0], korrektur,
        erklaerung: regel.erklaerung, erklaerung_key: regel.key, regel: true,
      });
    }
  }
  return out;
}

/**
 * KI-Befunde ohne frühere Regelbefunde. Ein gecachtes Ergebnis trägt die
 * Regelbefunde seines Laufs mit (`regel: true`); sie werden bei jedem Lauf neu
 * aus dem Text abgeleitet, sonst überlebte eine geänderte oder entfernte Regel
 * im Cache und verdrängte über die Überlappung den neuen Befund.
 */
function ohneRegelBefunde(fehler) {
  return Array.isArray(fehler) ? fehler.filter(f => !f?.regel) : [];
}

/**
 * Regelbefunde zu den KI-Befunden hinzufügen. Überlappt ein Regelbefund eine
 * Stelle, die das Modell schon gemeldet hat, gewinnt der KI-Befund — zwei
 * Korrekturen an derselben Stelle lassen sich nicht beide übernehmen.
 */
function mergeRegelBefunde(fehler, regelBefunde, text) {
  const liste = ohneRegelBefunde(fehler);
  if (!regelBefunde.length) return liste;
  const spans = liste
    .map(f => {
      const i = f?.original ? text.indexOf(f.original) : -1;
      return i < 0 ? null : [i, i + f.original.length];
    })
    .filter(Boolean);
  const neu = regelBefunde.filter(r => {
    if (liste.some(f => f?.original === r.original)) return false;
    const i = text.indexOf(r.original);
    return !spans.some(([s, e]) => i < e && s < i + r.original.length);
  });
  return neu.length ? [...liste, ...neu] : liste;
}

module.exports = { checkDialogformat, mergeRegelBefunde, ohneRegelBefunde, INQUIT_VERBEN, SAY_VERBS };
