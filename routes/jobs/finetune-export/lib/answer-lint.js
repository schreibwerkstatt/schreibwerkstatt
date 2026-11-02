'use strict';

// Schutznetze hinter den Samplern, angewandt in finalize.js:
//   - `swissSpelling`: schreibt der Buchtext selbst kein «ß» (Schweizer
//     Schreibung), wird es in generierten Antworten (KI-Deutungen, Persona)
//     zu «ss». Buchtext-Ziele bleiben, wie sie sind;
//   - `hasEditorNote`: Lektoratsnotiz im Manuskript («… – Anspielung auf X,
//     aber im Kontext …; besser: «…»») — ein solcher Text ist keine Prosa
//     und fällt in jeder Familie weg;
//   - `lintAnswer`: eine Antwort ausserhalb der Schreibaufgaben beginnt mit
//     Grossbuchstabe, Ziffer oder Anführungszeichen und nie mit einem
//     Etikett («vorgesetzter: …», «Mitglieder: …»); sie ist keine
//     Doppelpunkt-Liste («Renate ist: …», «Zur Familie gehören: …» —
//     `colonList`) und wiederholt keinen Teilsatz von vier Wörtern mehr als
//     zweimal (`repetition`, Nährboden für Endlosschleifen);
//   - `isTrivial`: die Antwort sagt nichts, was nicht schon in der Frage
//     steht («Wer ist an «Renate tritt … bei» beteiligt?» → «Renate …»);
//   - `selfRepeat`: ein Teilsatz aus vier Wörtern mindestens dreimal oder
//     mindestens vier Sätze hintereinander mit demselben ersten Wort
//     («Er wollte … Er wollte … Er wollte …»). In synthetischen Antworten ein
//     Fehler (Lint `repetition` bzw. `anaphora`); im Buchtext ein Stilmittel des
//     Autors, dort nur gezählt (`selfRepeatBook`);
//   - `personaThirdPerson`: eine Ich-Antwort der Figur fällt in die 3. Person
//     («Ich bin Robert. Robert ist …») oder spricht den Leser als Bekannten an
//     («Du bist mein bester Freund»);
//   - `promptKey`: Schlüssel für das Prompt-Dedup (alle Nutzer-Turns).

const { splitSentences } = require('./text');
const { escapeRe } = require('./names');

const ESZETT = /ß/;

function swissSpelling(text) {
  return String(text).replace(/ß/g, 'ss');
}

// Bewusst eng: Bewertung + Vorschlag in einem Zug, wie ihn eine übernommene
// Lektoratsbemerkung hinterlässt.
const EDITOR_NOTE = [
  /[;,–—-]\s*(besser|stattdessen|korrekt|richtiger|vorschlag)(\s+wäre)?\s*:\s*[«„"]/i,
  /\bAnspielung auf\b[^.!?]{0,60}\b(aber|jedoch)\b[^.!?]{0,40}\b(Kontext|grammatisch|stilistisch)\b/i,
  /\b(better|instead|suggestion)\s*:\s*[«"“]/i,
];
const hasEditorNote = (text) => EDITOR_NOTE.some(re => re.test(String(text || '')));

const LABEL_START = /^[\p{L}\p{N}_]+\s*:/u;
const GOOD_START = /^[\p{Lu}\p{N}«„"“'‹(]/u;
// «<Name> ist: …», «Zur Familie von X gehören: …», «X is: …» — eine Aufzählung
// statt eines Satzes.
const COLON_LIST = /^[^.!?:]{0,80}?(?<![\p{L}])(ist|sind|gehören|gehört|is|are|include|includes|belong to)\s*:/u;
const REPEAT_N = 4;
const REPEAT_MAX = 2;
// Ein Teilsatz aus REPEAT_N Wörtern, der öfter als REPEAT_MAX-mal vorkommt.
function hasRepetition(text) {
  const w = String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const seen = new Map();
  for (let i = 0; i + REPEAT_N <= w.length; i++) {
    const k = w.slice(i, i + REPEAT_N).join(' ');
    const n = (seen.get(k) || 0) + 1;
    if (n > REPEAT_MAX) return true;
    seen.set(k, n);
  }
  return false;
}
const ANAPHORA_RUN = 4;
// Mindestens ANAPHORA_RUN Sätze hintereinander mit demselben ersten Wort.
function hasAnaphora(text) {
  const firsts = splitSentences(String(text || '')).map(s => (s.trim().match(/^[«„"]?([\p{L}\p{N}]+)/u) || [])[1] || '').map(w => w.toLowerCase());
  let run = 1;
  for (let i = 1; i < firsts.length; i++) {
    run = firsts[i] && firsts[i] === firsts[i - 1] ? run + 1 : 1;
    if (run >= ANAPHORA_RUN) return true;
  }
  return false;
}
const selfRepeat = (text) => hasRepetition(text) || hasAnaphora(text);

// Ich-Antwort einer Figur: kein Satz mit ihrem Namen als Subjekt in der 3.
// Person («Robert ist …», «Robert hat …»), keine Anrede des Lesers als
// Freund oder Vertrauter. Ihr Name als Anrede-Antwort («Ich bin Robert.») ist
// erlaubt. → Grund oder null.
const FAMILIAR = /\b(du bist mein\w*\s+(beste\w*|liebste\w*|einzige\w*)?\s*(Freund|Freundin|Vertraute\w*|Schatz)|mein\s+(lieber|bester)\s+Freund|meine\s+(liebe|beste)\s+Freundin)\b/i;
function personaThirdPerson(text, name) {
  const t = String(text || '');
  if (FAMILIAR.test(t)) return 'personaFamiliar';
  const first = String(name || '').trim().split(/\s+/)[0];
  if (first.length < 2) return null;
  const re = new RegExp(`^[«„"]?${escapeRe(first)}(\\s+\\p{L}+)?\\s+(\\p{Ll}+)`, 'u');
  for (const s of splitSentences(t)) {
    const m = s.trim().match(re);
    if (m && !/^(und|oder|ist mein|bin)$/.test(m[2])) return 'personaThirdPerson';
  }
  return null;
}

// `swiss`: Buch in Schweizer Schreibung — ein «ß» ist dann ein Fehler.
function lintAnswer(text, swiss = false) {
  const t = String(text || '').trim();
  if (!t) return 'empty';
  if (LABEL_START.test(t)) return 'label';
  if (!GOOD_START.test(t)) return 'lowercase';
  if (COLON_LIST.test(t)) return 'colonList';
  if (hasRepetition(t)) return 'repetition';
  if (hasAnaphora(t)) return 'anaphora';
  if (swiss && ESZETT.test(t)) return 'eszett';
  return null;
}

const STOP = new Set(('der die das den dem des ein eine einen einem einer und oder ist sind war waren wird werden an am bei beim im in '
  + 'von vom zu zur zum mit auf aus für über wer wie was wo wann warum welche welcher welches dabei beteiligt erlebt erleben '
  + 'passiert geschieht findet statt hat haben er sie es ihr sein seine ihre auch neben ausser nur noch dann so '
  + 'the a an and or is are was were at in of to with on for who how what where when why which involved there it his her').split(' '));
const contentWords = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w && !STOP.has(w));

function isTrivial(question, answer) {
  const a = contentWords(answer);
  if (!a.length) return true;
  const q = new Set(contentWords(question));
  return a.every(w => q.has(w));
}

const promptKey = (s) => s.messages.filter(m => m.role === 'user').map(m => m.content.trim()).join('\u0000');

module.exports = {
  swissSpelling, hasEditorNote, lintAnswer, hasRepetition, hasAnaphora, selfRepeat, personaThirdPerson, isTrivial, promptKey, ESZETT,
};
