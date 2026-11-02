'use strict';

// Satz über eine Figur in der 3. Person → derselbe Satz in ihrer Ich-Form
// («Stefan sucht Wirksamkeit über Arbeit.» → «Ich suche Wirksamkeit über
// Arbeit.»). Nur Deutsch; streng: was sich nicht sicher umformen lässt, gibt ''
// zurück, nie einen halb umgeformten Satz. Eine Ich-Antwort, die nach dem
// ersten Satz in die 3. Person fällt («Ich bin Robert. Robert ist …»), lernte
// das Modell als Rollenbruch (lib/answer-lint.js#personaThirdPerson).
//
// Umgeformt wird nur ein Satz, der mit dem Namen als Subjekt beginnt («Stefan
// will …», «Stefan fehlen …»); das Verb danach wird von der 3. in die 1. Person
// Singular gesetzt (Tabelle für unregelmässige Verben, sonst -t → -e), die
// Pronomen der Figur im Rest ebenfalls (er/ihn/ihm/sein… bzw. bei einer Frau
// ihr…). Bleibt danach ein Pronomen, das die Figur meinen könnte, oder steht
// ihr Name noch im Satz, fällt der Satz weg.

const { escapeRe } = require('../../lib/names');

const ADVERB_T = new Set(['nicht', 'selbst', 'zugleich', 'dort', 'jetzt', 'meist', 'zuletzt', 'bereits', 'erst', 'oft', 'sonst',
  'trotzdem', 'fast', 'gut', 'laut', 'damit', 'heut', 'seit', 'mit', 'bis', 'samt', 'geschickt', 'überhaupt', 'bisweilen', 'zunächst']);

const IRREGULAR = {
  ist: 'bin', hat: 'habe', wird: 'werde', will: 'will', kann: 'kann', muss: 'muss', darf: 'darf', soll: 'soll', mag: 'mag',
  weiss: 'weiss', weiß: 'weiss', hält: 'halte', trägt: 'trage', fällt: 'falle', läuft: 'laufe', lässt: 'lasse', sieht: 'sehe',
  gibt: 'gebe', nimmt: 'nehme', liest: 'lese', spricht: 'spreche', trifft: 'treffe', wirft: 'werfe', hilft: 'helfe',
  schläft: 'schlafe', wächst: 'wachse', fährt: 'fahre', erhält: 'erhalte', verlässt: 'verlasse', vergisst: 'vergesse',
  isst: 'esse', tut: 'tue', gerät: 'gerate', rät: 'rate', bricht: 'breche', stirbt: 'sterbe', vergibt: 'vergebe',
  entgleitet: 'entgleite', verliert: 'verliere', empfindet: 'empfinde', findet: 'finde', leidet: 'leide', arbeitet: 'arbeite',
  wartet: 'warte', fürchtet: 'fürchte', betrachtet: 'betrachte', erwartet: 'erwarte', flüchtet: 'flüchte', richtet: 'richte',
};

// 3. → 1. Person Singular, Präsens. null, wenn das Wort kein sicheres Verb ist.
function conjugate1sg(verb) {
  const v = String(verb || '');
  if (IRREGULAR[v]) return IRREGULAR[v];
  // Starke Verben mit Umlaut nur aus der Tabelle (fährt → fahre); die übrigen
  // Umlaute sind Stamm (kämpft → kämpfe, fühlt → fühle).
  if (/ä/.test(v) && /(ä[hlst]t|äuft|äst|ägt|ädt|äckt|äbt)$/.test(v)) return null;
  if (/(stösst|stößt)$/.test(v)) return null;
  if (/[^aeiouäöü]t$/.test(v) && v.length >= 4) return v.slice(0, -1) + 'e';
  if (/ert$|elt$/.test(v)) return v.slice(0, -1) + 'e';
  return null;
}

const POSS_M = [[/\bseine\b/g, 'meine'], [/\bseinen\b/g, 'meinen'], [/\bseinem\b/g, 'meinem'], [/\bseiner\b/g, 'meiner'],
  [/\bseines\b/g, 'meines'], [/\bsein\b/g, 'mein'], [/\bihm\b/g, 'mir'], [/\bihn\b/g, 'mich'], [/\bsich\b/g, 'mich'], [/\ber\b/g, 'ich']];
const POSS_F = [[/\bihre\b/g, 'meine'], [/\bihren\b/g, 'meinen'], [/\bihrem\b/g, 'meinem'], [/\bihrer\b/g, 'meiner'],
  [/\bihres\b/g, 'meines'], [/\bsich\b/g, 'mich']];

// Satz aus dem Hintergrund ohne Namen als Subjekt: «Stammt aus Oensingen …»
// (Verb vorn) oder «Ihre religiösen Eltern verstossen sie …» (Possessiv vorn).
// → Ich-Satz oder ''.
const POSS_LEAD = { m: /^(Sein|Seine|Seinen|Seinem|Seiner)\s/, f: /^(Ihr|Ihre|Ihren|Ihrem|Ihrer)\s/ };
function backgroundToFirstPerson(sentence, X, gender) {
  const t = String(sentence || '').trim();
  if (/^\p{Lu}\p{Ll}+t\s/u.test(t) && conjugate1sg(t.split(/\s/)[0].toLowerCase())) {
    return toFirstPerson(`${X} ${t.charAt(0).toLowerCase()}${t.slice(1)}`, X, gender);
  }
  const lead = POSS_LEAD[gender];
  const m = lead && t.match(lead);
  if (!m) return '';
  const ending = m[1].replace(/^(Sein|Ihr)/, '');
  let rest = t.slice(m[0].length);
  if (gender === 'm') for (const [re, to] of POSS_M) rest = rest.replace(re, to);
  else for (const [re, to] of POSS_F) rest = rest.replace(re, to);
  // Objekt-«sie» der Frau am Satzende («verstossen sie wegen …» → «mich»).
  if (gender === 'f') rest = rest.replace(/\b(verstossen|verlassen|lieben|schlagen|betrügen|unterstützen|ignorieren|bevormunden|zwingen)\s+sie\b/g, '$1 mich');
  const out = `Mein${ending} ${rest}`;
  const left = gender === 'f' ? /\b(sie|ihr|ihre\w*)\b/ : /\b(er|ihn|ihm|sein\w*)\b/;
  return left.test(rest) || new RegExp(`(?<![\\p{L}])${escapeRe(X)}`, 'u').test(out) ? '' : out;
}

// `X`: Name der Figur, `gender`: 'm' | 'f' | 'n'.
function toFirstPerson(sentence, X, gender) {
  let t = String(sentence || '').trim();
  const name = escapeRe(X);
  let m = t.match(new RegExp(`^${name}\\s+(fehlen|fehlt)\\s+(.+)$`, 'u'));
  if (m) t = `Mir ${m[1]} ${m[2]}`;
  else {
    m = t.match(new RegExp(`^${name}\\s+(\\p{Ll}+)\\s+(.+)$`, 'u'));
    if (!m) return '';
    const v = conjugate1sg(m[1]);
    if (!v) return '';
    t = `Ich ${v} ${m[2]}`;
  }
  // Rest: Pronomen der Figur in die 1. Person. Ohne Geschlecht nichts sicher.
  const head = t.split(/\s+/).slice(0, 2).join(' ');
  let rest = t.slice(head.length);
  if (gender === 'm') for (const [re, to] of POSS_M) rest = rest.replace(re, to);
  else if (gender === 'f') for (const [re, to] of POSS_F) rest = rest.replace(re, to);
  else if (/\b(er|sie|ihm|ihn|ihr|sein\w*|ihre\w*)\b/.test(rest)) return '';
  t = head + rest;
  // Was die Figur noch meinen könnte, macht den Satz unsicher.
  const left = gender === 'f' ? /\b(sie|ihr|Sie)\b/ : /\b(er|ihn|ihm|Er)\b/;
  if (left.test(rest) || new RegExp(`(?<![\\p{L}])${name}(s|')?(?![\\p{L}])`, 'u').test(rest)) return '';
  // Ein zweites Verb nach «und» («… und sucht Wirksamkeit») ebenfalls; ein
  // Adverb auf -t («und dort», «und jetzt») bleibt.
  rest = rest.replace(/\bund\s+(\p{Ll}+t)(?=\s)/gu, (all, w) => {
    if (ADVERB_T.has(w)) return all;
    const v = conjugate1sg(w);
    return v ? 'und ' + v : all + '\u0000';
  });
  if (rest.includes('\u0000')) return '';
  t = head + rest;
  return t;
}

module.exports = { toFirstPerson, backgroundToFirstPerson, conjugate1sg };
