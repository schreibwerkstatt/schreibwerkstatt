'use strict';

// Querprüfungen über das ganze Set (finalize.js), nachdem die Sampler gelaufen
// sind — Schutznetze, keine Generatoren:
//   - `tierMismatch`: jede Stufenbezeichnung einer Figur («eine der
//     Hauptfiguren», «eine Nebenfigur», «eine Randfigur», «die
//     Gegenspielerin») muss in allen Aufgaben dieselbe sein wie die aus
//     `figures.typ` (core-facts/words.js#figureTypePhrase). Eine abweichende
//     Kurzform irgendwo im Set brächte dem Modell zwei Stufen für dieselbe
//     Figur bei; das Beispiel fällt weg.
//   - `precedingAfterTarget`: «Vorausgegangen ist/sind «…»» bzw. «Davor erlebt
//     X «…»» darf nur Ereignisse nennen, die zeitlich vor dem gefragten liegen
//     (core-facts/why-parts.js#isBefore). Gezählt, nicht korrigiert — die
//     Sampler bauen solche Sätze nicht; die Zahl muss 0 sein.

const { figureTypePhrase, genderOf } = require('../samples/core-facts/words');
const { escapeRe } = require('./names');
const { isBefore } = require('../samples/core-facts/why-parts');

const TIER_PHRASES = {
  de: ['eine der Hauptfiguren', 'eine Hauptfigur', 'eine Nebenfigur', 'eine Randfigur', 'die Gegenspielerin', 'ein Gegenspieler', 'der Gegenspieler'],
  en: ['one of the main characters', 'a main character', 'a supporting character', 'a minor character', 'the antagonist', 'an antagonist'],
};

// Figuren mit ihrem Namen-Muster und der erwarteten Stufe.
function tierIndex(figRows, langIsEn, nameOf = (f) => f.name) {
  return figRows.map(f => {
    const name = nameOf(f);
    const want = figureTypePhrase(f.typ, genderOf(f), langIsEn);
    return name && want && name.length >= 3 ? { name, want, re: new RegExp(`(?<![\\p{L}])${escapeRe(name)}(?![\\p{L}])[^.!?]{0,60}?(${TIER_PHRASES[langIsEn ? 'en' : 'de'].map(escapeRe).join('|')})`, 'u') } : null;
  }).filter(Boolean);
}

// Erste Abweichung in den Antworten eines Samples → { name, found, want } | null.
function tierMismatchOf(sample, index) {
  for (const m of sample.messages) {
    if (m.role !== 'assistant') continue;
    for (const sent of String(m.content).split(/(?<=[.!?])\s+/)) {
      for (const t of index) {
        const hit = sent.match(t.re);
        if (!hit) continue;
        // Steht vor der Stufe noch ein anderer Figurenname, gehört sie dem.
        const between = sent.slice(hit.index + t.name.length, sent.indexOf(hit[1], hit.index));
        if (index.some(o => o !== t && new RegExp(`(?<![\\p{L}])${escapeRe(o.name)}(?![\\p{L}])`, 'u').test(between))) continue;
        const same = hit[1] === t.want || (t.want === 'eine der Hauptfiguren' && hit[1] === 'eine Hauptfigur');
        if (!same) return { name: t.name, found: hit[1], want: t.want };
      }
    }
  }
  return null;
}

// Vorgeschichte-Sätze der Deutungen prüfen. `events`: ctx.events.
const PRECEDING = /(?:Vorausgegangen (?:ist|sind)|Davor erlebt \S+(?: \S+)?|It is preceded by|Before that, \S+ goes through) ([^]*?)(?:\.\s|\.$)/g;
function precedingAfterTarget(samples, events) {
  const byTitle = new Map((events || []).map(e => [e.ereignis, e]));
  const out = [];
  for (const s of samples) {
    if (s.task !== 'eventWhy' && s.task !== 'sceneWhy') continue;
    const a = s.messages[s.messages.length - 1].content;
    let target = null;
    const m = String(s.factId || '').match(/^evt:(\d+):motive/);
    if (m) target = (events || []).find(e => String(e.i) === m[1]);
    if (!target) {
      const t = a.match(/(?:geschieht|gehört zu|happens|belongs to) «([^»]+)»/);
      if (t) target = byTitle.get(t[1]);
    }
    if (!target) continue;
    for (const p of a.matchAll(PRECEDING)) {
      for (const q of p[1].matchAll(/«([^»]+)»/g)) {
        const ev = byTitle.get(q[1]);
        if (ev && !isBefore(ev, target)) out.push({ id: s.id, target: target.ereignis, preceding: ev.ereignis });
      }
    }
  }
  return out;
}

module.exports = { tierIndex, tierMismatchOf, precedingAfterTarget, TIER_PHRASES };
