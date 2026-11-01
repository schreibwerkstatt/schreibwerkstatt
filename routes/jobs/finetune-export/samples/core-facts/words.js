'use strict';

// Sprachbausteine für das Kernwissen: Geschlecht, Genitiv, Rollenwörter der
// Beziehungstypen (public/js/book/beziehung-typen.js) und Figurentypen.
// Trainingstext, keine UI-Strings.

const { declineName } = require('./naming');
const datOf = (name, langIsEn) => (langIsEn ? name : declineName(name, 'dat') || name);

// figures.geschlecht ist Freitext der Analyse («männlich (Plural)»,
// «männlich/weiblich (Familie)») — eindeutig ist nur ein reines
// männlich/weiblich am Anfang ohne Zweitwert.
function genderOf(f) {
  const g = String(f?.geschlecht || '').trim().toLowerCase();
  if (/plural|gruppe|familie|\//.test(g)) return 'n';
  if (/^(männlich|maennlich|male)\b/.test(g)) return 'm';
  if (/^(weiblich|female)\b/.test(g)) return 'f';
  return 'n';
}

// Genitiv eines Namens als Präfix («Stefans», «Hans'»). null, wenn der Name
// kein schlichter Eigenname ist — Klammer («Antonie Buddenbrook (Tony)»),
// Punkt («geb.»), kleingeschriebenes Wort («Vater von Thomas») oder mehr als
// drei Wörter: dann «von X».
function genitive(name, langIsEn) {
  const n = String(name || '').trim();
  if (!n || /[().,;]/.test(n)) return null;
  const words = n.split(/\s+/);
  if (words.length > 3 || words.some(w => !/^\p{Lu}/u.test(w))) return null;
  if (langIsEn) return /s$/i.test(n) ? n + "'" : n + "'s";
  const base = words[0] === 'Herr' && words.length > 1 ? 'Herrn ' + words.slice(1).join(' ') : n;
  return /(s|ß|x|z|ce)$/i.test(base) ? base + "'" : base + 's';
}

// Rollenwort je Beziehungstyp und Geschlecht der Person, die die Rolle hat.
// [Nomen, grammatisches Geschlecht des Nomens]. `andere` hat kein Wort.
const ROLE_DE = {
  elternteil:      { m: ['Vater', 'm'], f: ['Mutter', 'f'], n: ['Elternteil', 'm'] },
  kind:            { m: ['Sohn', 'm'], f: ['Tochter', 'f'], n: ['Kind', 'n'] },
  geschwister:     { m: ['Bruder', 'm'], f: ['Schwester', 'f'], n: ['Geschwister', 'n'] },
  ehepartner:      { m: ['Ehemann', 'm'], f: ['Ehefrau', 'f'], n: ['Ehepartner', 'm'] },
  ex_partner:      { m: ['früherer Partner', 'm'], f: ['frühere Partnerin', 'f'], n: ['früherer Partner', 'm'] },
  liebesbeziehung: { m: ['Geliebter', 'm'], f: ['Geliebte', 'f'], n: ['Liebe', 'f'] },
  freund:          { m: ['Freund', 'm'], f: ['Freundin', 'f'], n: ['Freund', 'm'] },
  feind:           { m: ['Feind', 'm'], f: ['Feindin', 'f'], n: ['Feind', 'm'] },
  kollege:         { m: ['Kollege', 'm'], f: ['Kollegin', 'f'], n: ['Kollege', 'm'] },
  bekannt:         { m: ['Bekannter', 'm'], f: ['Bekannte', 'f'], n: ['Bekannter', 'm'] },
  rivale:          { m: ['Rivale', 'm'], f: ['Rivalin', 'f'], n: ['Rivale', 'm'] },
  mentor:          { m: ['Mentor', 'm'], f: ['Mentorin', 'f'], n: ['Mentor', 'm'] },
  schuetzling:     { m: ['Schützling', 'm'], f: ['Schützling', 'm'], n: ['Schützling', 'm'] },
  patronage:       { m: ['Gönner', 'm'], f: ['Gönnerin', 'f'], n: ['Gönner', 'm'] },
  geschaeft:       { m: ['Geschäftspartner', 'm'], f: ['Geschäftspartnerin', 'f'], n: ['Geschäftspartner', 'm'] },
  verbuendete:     { m: ['Verbündeter', 'm'], f: ['Verbündete', 'f'], n: ['Verbündeter', 'm'] },
  komplize:        { m: ['Komplize', 'm'], f: ['Komplizin', 'f'], n: ['Komplize', 'm'] },
  vorgesetzter:    { m: ['Vorgesetzter', 'm'], f: ['Vorgesetzte', 'f'], n: ['Vorgesetzter', 'm'] },
  untergebener:    { m: ['Mitarbeiter', 'm'], f: ['Mitarbeiterin', 'f'], n: ['Mitarbeiter', 'm'] },
};
const ROLE_EN = {
  elternteil: { m: 'father', f: 'mother', n: 'parent' },
  kind: { m: 'son', f: 'daughter', n: 'child' },
  geschwister: { m: 'brother', f: 'sister', n: 'sibling' },
  ehepartner: { m: 'husband', f: 'wife', n: 'spouse' },
  ex_partner: { m: 'former partner', f: 'former partner', n: 'former partner' },
  liebesbeziehung: { m: 'lover', f: 'lover', n: 'lover' },
  freund: { m: 'friend', f: 'friend', n: 'friend' },
  feind: { m: 'enemy', f: 'enemy', n: 'enemy' },
  kollege: { m: 'colleague', f: 'colleague', n: 'colleague' },
  bekannt: { m: 'acquaintance', f: 'acquaintance', n: 'acquaintance' },
  rivale: { m: 'rival', f: 'rival', n: 'rival' },
  mentor: { m: 'mentor', f: 'mentor', n: 'mentor' },
  schuetzling: { m: 'protégé', f: 'protégée', n: 'protégé' },
  patronage: { m: 'patron', f: 'patron', n: 'patron' },
  geschaeft: { m: 'business partner', f: 'business partner', n: 'business partner' },
  verbuendete: { m: 'ally', f: 'ally', n: 'ally' },
  komplize: { m: 'accomplice', f: 'accomplice', n: 'accomplice' },
  vorgesetzter: { m: 'superior', f: 'superior', n: 'superior' },
  untergebener: { m: 'subordinate', f: 'subordinate', n: 'subordinate' },
};

// Gegenrolle: «A ist Elternteil von B» ⇔ «B ist Kind von A». Ungerichtete
// Typen sind ihre eigene Gegenrolle.
const INVERSE = {
  elternteil: 'kind', kind: 'elternteil',
  mentor: 'schuetzling', schuetzling: 'mentor',
  vorgesetzter: 'untergebener', untergebener: 'vorgesetzter',
  patronage: 'schuetzling',
};
const inverseTyp = (typ) => INVERSE[typ] || typ;

const FAMILY_TYPES = new Set(['elternteil', 'kind', 'geschwister', 'ehepartner', 'ex_partner']);

// Verwandtschaft, die keinen eigenen Typ hat. Steht sie in der Beschreibung
// einer Eltern-/Kind-/Geschwister-Beziehung («Enkelin Antonie»), ist der Typ
// falsch erfasst — so ein Paar bekommt keinen Kernfakt.
const DISTANT_KIN = /\b(enkel|enkelin|grossvater|großvater|grossmutter|großmutter|grosseltern|großeltern|opa|oma|onkel|tante|neffe|nichte|cousin|cousine|schwager|schwägerin|schwieger\w*|stief\w*|halbbruder|halbschwester|urgross\w*|urgroß\w*|grandson|granddaughter|grandfather|grandmother|uncle|aunt|nephew|niece|cousin|step\w+|in-law)\b/i;

function roleNoun(typ, holderGender, langIsEn) {
  if (langIsEn) return ROLE_EN[typ]?.[holderGender] ? { noun: ROLE_EN[typ][holderGender], g: 'n' } : null;
  const e = ROLE_DE[typ]?.[holderGender];
  return e ? { noun: e[0], g: e[1] } : null;
}

const ART_DEF = { m: 'der', f: 'die', n: 'das' };
const ART_INDEF = { m: 'ein', f: 'eine', n: 'ein' };

// Rollen, die eine Person meist nur einmal hat: «die Mutter von X», sonst
// «eine Bekannte von X» — «die Bekannte» klänge, als gäbe es nur eine.
const UNIQUE_ROLES = new Set(['elternteil', 'ehepartner']);
const roleArticle = (typ, g, langIsEn) => (langIsEn
  ? (UNIQUE_ROLES.has(typ) ? 'the' : 'a')
  : (UNIQUE_ROLES.has(typ) ? ART_DEF[g] : ART_INDEF[g]));

// Platzhalter-Figuren der Analyse («Vater von Konsul Buddenbrook (unnamed)»)
// tragen keinen Namen, nach dem Leser fragen.
const PLACEHOLDER_NAME = /\b(unnamed|unbenannt|namenlos|ohne namen|nameless)\b/i;

// Verwandtschaftswörter einer Beschreibung → Beziehungstyp. Nennt die
// Beschreibung eine Verwandtschaft, die zum Typ nicht passt («Freundin» mit
// «seine Schwägerin»), ist der Typ falsch erfasst.
const KIN_WORDS = [
  [/\b(vater|mutter|eltern|father|mother|parents?)\b/i, 'elternteil'],
  [/\b(sohn|tochter|son|daughter)\b/i, 'kind'],
  [/\b(bruder|schwester|brother|sister)\b/i, 'geschwister'],
  [/\b(ehemann|ehefrau|gatte|gattin|husband|wife)\b/i, 'ehepartner'],
];

// Possessivpronomen der Person `ownerGender` vor einem Nomen des Genus `nounG`:
// «sein Sohn», «ihre Tochter». null bei unbestimmtem Geschlecht.
function possessive(ownerGender, nounG, langIsEn) {
  if (langIsEn) return ownerGender === 'm' ? 'his' : ownerGender === 'f' ? 'her' : null;
  const base = ownerGender === 'm' ? 'sein' : ownerGender === 'f' ? 'ihr' : null;
  if (!base) return null;
  return nounG === 'f' ? base + 'e' : base;
}

// «Gisela ist Stefans Mutter» / «Gisela ist die Mutter von Antonie Buddenbrook (Tony)»
// / «Frau Stuht ist eine Bekannte von Vater von Thomas».
function roleStatement(holder, other, role, langIsEn, typ) {
  const gen = genitive(other, langIsEn);
  const art = roleArticle(typ, role.g, langIsEn);
  if (langIsEn) return gen ? `${holder} is ${gen} ${role.noun}` : `${holder} is ${art} ${role.noun} of ${other}`;
  return gen ? `${holder} ist ${gen} ${role.noun}` : `${holder} ist ${art} ${role.noun} von ${datOf(other)}`;
}

// Rolle als Nominalphrase: «Stefans Mutter» / «eine Kollegin von Vater von Thomas».
function rolePhrase(other, role, typ, langIsEn) {
  const gen = genitive(other, langIsEn);
  const art = roleArticle(typ, role.g, langIsEn);
  if (langIsEn) return gen ? `${gen} ${role.noun}` : `${art} ${role.noun} of ${other}`;
  return gen ? `${gen} ${role.noun}` : `${art} ${role.noun} von ${datOf(other)}`;
}

// `figures.beruf` ist Freitext der Analyse und trägt oft keinen Beruf
// («Familienmitglied (Onkel)», «Geschäftspartner von Permaneder»). Als Beruf
// gilt nur ein kurzer Eintrag ohne Klammer, ohne «von» und ohne Verwandtschaft.
function cleanBeruf(beruf) {
  const b = String(beruf || '').trim();
  if (!b || b.length > 60 || /[()]/.test(b) || /\b(von|vom|des|der)\b/i.test(b)) return '';
  if (/\b(familie\w*|unbekannt|keine?r?|ohne|nicht|unklar|kind|child|baby|säugling)\b/i.test(b)) return '';
  if (KIN_WORDS.some(([re]) => re.test(b)) || DISTANT_KIN.test(b)) return '';
  return b;
}

// Kein Erwerbsberuf, sondern ein Stand («Schüler», «Rentnerin»): «X ist
// Schüler», nicht «X arbeitet als Schüler».
const isStatus = (beruf) => /^(schüler|schülerin|student|studentin|maturand|maturandin|gymnasiast|gymnasiastin|lehrling|lehrtochter|lernende[rn]?|auszubildende[rn]?|azubi|rentner|rentnerin|pensionär|pensionärin|hausfrau|hausmann|arbeitslos|pupil|student|retired|unemployed|housewife)\b/i.test(String(beruf || '').trim());

// Zeitangabe, die als Adverbial in «passiert …» passt: Zahl oder Präposition
// vorne («1968», «im März 1968», «von 1990 bis 1995»). Sonst («Beginn des
// Jahres 72») nur als «Zeitpunkt: …».
const isAdverbialWhen = (when) => /^(\d|(von|im|am|um|ab|bis|seit|vor|nach|gegen|in|zu|from|in|on|at|around|before|after|until|since)\b)/i.test(String(when || '').trim());

// Passt die Beschreibung zum Typ? false bei entfernter Verwandtschaft oder
// einem Verwandtschaftswort, das weder Typ noch Gegenrolle ist.
function descFitsType(desc, typ) {
  const d = String(desc || '');
  if (!d) return true;
  if (DISTANT_KIN.test(d)) return false;
  const allowed = new Set([typ, inverseTyp(typ)]);
  return KIN_WORDS.every(([re, t]) => !re.test(d) || allowed.has(t));
}

// Figurentyp als Prädikat: «eine der Hauptfiguren».
const FIGURE_TYPE_DE = {
  hauptfigur: () => 'eine der Hauptfiguren',
  nebenfigur: () => 'eine Nebenfigur',
  randfigur: () => 'eine Randfigur',
  antagonist: (g) => (g === 'f' ? 'die Gegenspielerin' : 'ein Gegenspieler'),
};
const FIGURE_TYPE_EN = {
  hauptfigur: () => 'one of the main characters',
  nebenfigur: () => 'a supporting character',
  randfigur: () => 'a minor character',
  antagonist: () => 'an antagonist',
};
function figureTypePhrase(typ, gender, langIsEn) {
  const fn = (langIsEn ? FIGURE_TYPE_EN : FIGURE_TYPE_DE)[String(typ || '').trim().toLowerCase()];
  return fn ? fn(gender) : '';
}

// Bedeutungsstufe einer Figur aus `figures.typ` (Figuren-Analyse bzw.
// Figurenwerkstatt, nicht aus der Erwähnungszahl): main / side / minor.
// Sie steuert die Zahl der Porträt-Varianten (`corePerTier`) und die
// Reihenfolge beim Kürzen (lib/token-mix.js).
function figureTier(typ) {
  const t = String(typ || '').trim().toLowerCase();
  if (t === 'hauptfigur') return 'main';
  if (t === 'nebenfigur' || t === 'mentor' || t === 'antagonist') return 'side';
  return 'minor';
}

// Personalpronomen (Nominativ) für zweite Sätze; null → Name wiederholen.
function pronoun(gender, langIsEn) {
  if (langIsEn) return gender === 'm' ? 'He' : gender === 'f' ? 'She' : null;
  return gender === 'm' ? 'Er' : gender === 'f' ? 'Sie' : null;
}

const firstSentences = (text, n) => {
  const parts = String(text || '').trim().split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ«„"])/);
  return parts.slice(0, n).join(' ').trim();
};

module.exports = {
  figureTier, datOf, genderOf, genitive, roleNoun, inverseTyp, roleStatement, possessive,
  figureTypePhrase, pronoun, firstSentences, roleArticle, descFitsType, rolePhrase, cleanBeruf, isAdverbialWhen, isStatus,
  FAMILY_TYPES, DISTANT_KIN, ART_DEF, ART_INDEF, ROLE_DE, UNIQUE_ROLES, PLACEHOLDER_NAME,
};
