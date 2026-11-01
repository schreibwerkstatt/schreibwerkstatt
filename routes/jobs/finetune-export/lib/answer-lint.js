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
//     Etikett («vorgesetzter: …», «Mitglieder: …»);
//   - `isTrivial`: die Antwort sagt nichts, was nicht schon in der Frage
//     steht («Wer ist an «Renate tritt … bei» beteiligt?» → «Renate …»);
//   - `promptKey`: Schlüssel für das Prompt-Dedup (alle Nutzer-Turns).

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
// `swiss`: Buch in Schweizer Schreibung — ein «ß» ist dann ein Fehler.
function lintAnswer(text, swiss = false) {
  const t = String(text || '').trim();
  if (!t) return 'empty';
  if (LABEL_START.test(t)) return 'label';
  if (!GOOD_START.test(t)) return 'lowercase';
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

module.exports = { swissSpelling, hasEditorNote, lintAnswer, isTrivial, promptKey, ESZETT };
