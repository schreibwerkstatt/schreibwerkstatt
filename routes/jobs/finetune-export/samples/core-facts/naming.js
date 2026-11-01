'use strict';

// Namen der Figuren als Satzglied: Rollenfiguren erkennen, Klammerzusätze
// abtrennen, mehrdeutige Namen finden und deklinieren («Herr Koch» →
// «Herrn Koch», «Fahrer des Mercedes» → «dem Fahrer des Mercedes»).
// Trainingstext, keine UI-Strings; nur Deutsch dekliniert, Englisch bleibt
// unverändert (mit «the» vor Rollenfiguren).
//
// Rollenfigur = Figur ohne Eigennamen: die Analyse benennt sie nach Funktion
// («Rektor der Kantonsschule Olten», «Alfreds Vater», «Barfrau im Bolero»)
// oder nach einem Nutzernamen («madame_phantasma»). Sie trägt keine
// Kernfakten zu Beziehungen und Attributen («Dieter ist ein Vorgesetzter von
// Fahrer des Mercedes»), darf aber in Prosa und Szenen vorkommen.

const TITLES = new Set(['Herr', 'Frau', 'Fräulein', 'Doktor', 'Dr.', 'Professor', 'Prof.', 'Pfarrer', 'Pastor',
  'Schreiner', 'Konsul', 'Senator', 'Pater', 'Schwester', 'Bruder', 'Onkel', 'Tante', 'Mr.', 'Mrs.', 'Ms.', 'Miss', 'Sir', 'Lady']);

// Funktionswörter, die eine Rolle näher bestimmen («Fahrer des Mercedes»).
const ROLE_LINK = /^(des|der|im|am|an|bei|beim|vom|von|aus|in|zur|zum|auf|vor|unter|of|at|from|in)$/;

// Köpfe von Rollenbezeichnungen ohne Eigennamen («Alfreds Vater», «Knigge-Experte»).
const ROLE_HEADS = new Set([
  'vater', 'mutter', 'eltern', 'bruder', 'schwester', 'sohn', 'tochter', 'freund', 'freundin', 'onkel', 'tante',
  'grossvater', 'grossmutter', 'lehrer', 'lehrerin', 'klassenlehrer', 'klassenlehrerin', 'arzt', 'ärztin',
  'hausarzt', 'psychiater', 'rektor', 'rektorin', 'fahrer', 'fahrerin', 'chef', 'chefin', 'vorgesetzter', 'vorgesetzte',
  'mitarbeiter', 'mitarbeiterin', 'kollege', 'kollegin', 'nachbar', 'nachbarin', 'experte', 'expertin', 'wirt', 'wirtin',
  'kellner', 'kellnerin', 'polizist', 'polizistin', 'dealer', 'besitzer', 'besitzerin', 'verkäufer', 'verkäuferin',
  'direktor', 'direktorin', 'präsident', 'präsidentin', 'trainer', 'trainerin', 'father', 'mother', 'friend', 'teacher',
]);

// Substantivierte Adjektive: die Endung folgt dem Artikel («der Vorgesetzte»,
// «dem Vorgesetzten», «ein Vorgesetzter»).
const NOMINAL_ADJ = /^(Vorgesetzt|Angestellt|Bekannt|Verwandt|Prostituiert|Beamt|Älte?st|Alt|Jung|Fremd|Verletzt|Tot)(e|er|es|en)?$/;
// Schwach deklinierte Maskulina: Akkusativ/Dativ/Genitiv auf -(e)n.
const WEAK_NOUN = /(e|ent|ant|ist|oge|graph|soldat|pilot|kandidat|diplomat|automat|graf|fürst|prinz|held|mensch|nachbar|bauer)$/i;
const NOT_WEAK = /(käse|rat)$/i;

const stripQualifier = (name) => String(name || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();

// Nennform einer Figur im Fliesstext: ohne Klammerzusatz.
function plainName(f) { return stripQualifier(f?.name); }

function isPseudonym(name) {
  const n = String(name || '').trim();
  return !/^\p{Lu}/u.test(n) || /[_@#\d]/.test(n);
}

// `figNames`: kleingeschriebene Namen und Kurznamen aller Figuren — für
// Besitz-Rollen wie «Alfreds Vater» oder «Hausarzt Veronikas».
function isRoleName(name, figNames = new Set()) {
  const n = stripQualifier(name);
  if (!n) return true;
  if (isPseudonym(n)) return true;
  const w = n.split(/\s+/);
  if (w.length >= 2 && TITLES.has(w[0]) && /^\p{Lu}/u.test(w[1]) && !ROLE_LINK.test(w[1])) return false;
  if (w.slice(1, 4).some(x => ROLE_LINK.test(x))) return true;
  const head = (x) => ROLE_HEADS.has(x.toLowerCase()) || ROLE_HEADS.has(x.split('-').pop().toLowerCase());
  const possessor = (x) => /(s|')$/.test(x) && figNames.has(x.replace(/'?s?$|'$/, '').toLowerCase());
  if (w.length === 2 && ((possessor(w[0]) && /^\p{Lu}/u.test(w[1])) || (head(w[0]) && possessor(w[1])))) return true;
  if (w.length === 2 && /(s|')$/.test(w[0]) && head(w[1])) return true;
  if (w.length === 1 && w[0].includes('-') && head(w[0])) return true;
  return false;
}

// Namensinfo für alle Figuren eines Buchs: `role` (kein Eigenname),
// `ambiguous` (Nennform oder Kurzname teilt sich eine andere Figur),
// `aliases` (eindeutige Namen, nach denen Leser fragen können).
function nameInfo(figRows) {
  const figNames = new Set();
  const owners = new Map();
  const own = (n, id) => {
    const k = String(n || '').trim().toLowerCase();
    if (k.length < 2) return;
    if (!owners.has(k)) owners.set(k, new Set());
    owners.get(k).add(id);
  };
  for (const f of figRows) {
    for (const n of [f.name, f.kurzname]) if (n) figNames.add(stripQualifier(n).toLowerCase());
    own(plainName(f), f.fig_id);
    if (f.kurzname) own(stripQualifier(f.kurzname), f.fig_id);
  }
  const uniq = (n) => (owners.get(String(n).toLowerCase())?.size || 0) <= 1;
  const out = new Map();
  for (const f of figRows) {
    const name = plainName(f);
    const kurz = f.kurzname ? stripQualifier(f.kurzname) : '';
    const role = isRoleName(f.name, figNames);
    const ambiguous = !uniq(name);
    const aliases = [name, kurz].filter((n, i, a) => n && n.length >= 2 && a.indexOf(n) === i && uniq(n)
      && (i === 0 || !isRoleName(n, figNames)));
    out.set(f.fig_id, { name, role, ambiguous, aliases, proper: !role && !ambiguous });
  }
  return out;
}

const ART = {
  def: { nom: { m: 'der', f: 'die', n: 'das' }, akk: { m: 'den', f: 'die', n: 'das' }, dat: { m: 'dem', f: 'der', n: 'dem' }, gen: { m: 'des', f: 'der', n: 'des' } },
};

// Endung eines Adjektivs nach bestimmtem Artikel (schwache Flexion).
const adjEnding = (kasus, g) => (kasus === 'nom' || (kasus === 'akk' && g !== 'm') ? 'e' : 'en');

function inflectHead(word, kasus, g, adjective) {
  if (adjective) {
    const m = word.match(NOMINAL_ADJ) || word.match(/^(\p{L}+?)(e|er|es|en)$/u);
    return m ? m[1] + adjEnding(kasus, g) : word;
  }
  if (kasus === 'nom' || g !== 'm') return word;
  if (word === 'Herr') return 'Herrn';
  if (WEAK_NOUN.test(word) && !NOT_WEAK.test(word)) return /e$/.test(word) ? word + 'n' : word + 'en';
  return word;
}

// Satzglied für eine Figur im Kasus `kasus` (nom/akk/dat). `gender`: m/f/n
// (words.js#genderOf). Eigennamen bleiben, ausser «Herr» → «Herrn».
// Rollenfiguren bekommen den bestimmten Artikel und dekliniert («der alten
// Frau an der Ziegelfeldstrasse»). null, wenn die Form nicht sicher zu bilden
// ist (Rolle mit eigenem Artikel, unbekanntes Geschlecht) — die Vorlage
// entfällt dann.
function declineName(name, kasus = 'nom', { gender = 'n', role = false, langIsEn = false } = {}) {
  const n = stripQualifier(name);
  if (!n) return null;
  if (langIsEn) return role ? 'the ' + n : n;
  if (!role) {
    const w = n.split(/\s+/);
    if (w[0] === 'Herr' && w.length >= 2 && kasus !== 'nom') w[0] = 'Herrn';
    return w.join(' ');
  }
  if (isPseudonym(n)) return n;
  const w = n.split(/\s+/);
  if (/^(der|die|das|den|dem|des)$/i.test(w[0])) return kasus === 'nom' ? w[0].toLowerCase() + ' ' + w.slice(1).join(' ') : null;
  // Besitz-Rolle: «Alfreds Vater» — kein Artikel, nur der Kopf flektiert.
  if (w.length >= 2 && /(s|')$/.test(w[0]) && /^\p{Lu}/u.test(w[1])) {
    // Substantivierte Adjektive nach Genitiv flektieren stark («Renates
    // Vorgesetztem») — selten und holprig, dort bleibt die Grundform.
    if (!NOMINAL_ADJ.test(w[1])) w[1] = inflectHead(w[1], kasus, gender, false);
    return w.join(' ');
  }
  if (gender !== 'm' && gender !== 'f') return null;
  const linkAt = w.findIndex((x, i) => i > 0 && ROLE_LINK.test(x));
  const core = linkAt > 0 ? w.slice(0, linkAt) : w;
  const tail = linkAt > 0 ? w.slice(linkAt) : [];
  const out = core.map((x, i) => {
    const isLast = i === core.length - 1;
    if (!isLast) return /^\p{Lu}/u.test(x) && /(e|er|es|en)$/.test(x) ? inflectHead(x, kasus, gender, true).toLowerCase() : x;
    return inflectHead(x, kasus, gender, NOMINAL_ADJ.test(x));
  });
  return `${ART.def[kasus][gender]} ${[...out, ...tail].join(' ')}`;
}

const CONTRACT = [[/\bvon dem\b/g, 'vom'], [/\bzu dem\b/g, 'zum'], [/\bzu der\b/g, 'zur'], [/\ban dem\b/g, 'am'], [/\bin dem\b/g, 'im'], [/\bbei dem\b/g, 'beim']];
const contract = (s) => CONTRACT.reduce((acc, [re, to]) => acc.replace(re, to), s);
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Vorlage mit Kasus-Platzhaltern füllen: `{n}` Nominativ, `{n:akk}`,
// `{n:dat}`. null, wenn eine Form fehlt.
function fillCase(tpl, name, opts) {
  let missing = false;
  const out = tpl.replace(/\{n(?::(nom|akk|dat))?\}/g, (_, k) => {
    const v = declineName(name, k || 'nom', opts);
    if (!v) missing = true;
    return v || '';
  });
  return missing ? null : capFirst(contract(out));
}

module.exports = { nameInfo, isRoleName, declineName, fillCase, plainName, stripQualifier, contract, capFirst };
