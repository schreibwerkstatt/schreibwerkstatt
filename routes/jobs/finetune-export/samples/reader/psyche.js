'use strict';

// Innenleben der Figuren aus den Werkstatt-Kernen (want/need/wound/lie/konflikt/
// bogen). Zwei Sample-Arten je Kern:
//   1) Deutung aus den Notizen des Autors («Was treibt X an?») — für die
//      Umschreibung im Buchton angemeldet, weil Notizen Stichworte sind;
//   2) Beleg aus dem Text («Wo zeigt sich das?») — die vom Anchor-Job geprüften
//      Fundstellen (`draft_figure_occurrences.snippet`), wörtlich, Split pro Kapitel.
// Fragen- und Antwortvorlagen sind Trainingstext, keine UI-Strings.

const { PSYCHE_KERNE } = require('../../../../../lib/draft-mindmap-extract');

const KERN_TEXT = {
  want: {
    de: { q: ['Was will {name}?', 'Was treibt {name} an?', 'Wonach strebt {name}?'],
          lead: 'Was {name} antreibt: {notes}.', where: 'Wo zeigt sich im Buch, was {name} will?' },
    en: { q: ['What does {name} want?', 'What drives {name}?', 'What is {name} striving for?'],
          lead: 'What drives {name}: {notes}.', where: 'Where does the book show what {name} wants?' },
  },
  need: {
    de: { q: ['Was braucht {name} wirklich?', 'Was fehlt {name} eigentlich?'],
          lead: 'Was {name} wirklich braucht, auch ohne es zu wissen: {notes}.', where: 'Wo zeigt sich im Buch, was {name} eigentlich fehlt?' },
    en: { q: ['What does {name} really need?', 'What is {name} actually missing?'],
          lead: 'What {name} really needs, even without knowing it: {notes}.', where: 'Where does the book show what {name} is missing?' },
  },
  wound: {
    de: { q: ['Was hat {name} verletzt?', 'Welche alte Wunde trägt {name} mit sich?'],
          lead: 'Die Wunde, die {name} mit sich trägt: {notes}.', where: 'Wo spürt man im Buch die alte Wunde von {name}?' },
    en: { q: ['What has hurt {name}?', 'What old wound does {name} carry?'],
          lead: 'The wound {name} carries: {notes}.', where: 'Where can you feel {name}\'s old wound in the book?' },
  },
  lie: {
    de: { q: ['Was redet sich {name} ein?', 'Welcher Selbsttäuschung erliegt {name}?'],
          lead: 'Was {name} sich selbst erzählt: {notes}.', where: 'Wo zeigt sich im Buch, was {name} sich einredet?' },
    en: { q: ['What does {name} tell themselves?', 'What self-deception holds {name} captive?'],
          lead: 'The story {name} tells themselves: {notes}.', where: 'Where does the book show the lie {name} believes?' },
  },
  konflikt: {
    de: { q: ['Womit ringt {name}?', 'Was ist der innere Konflikt von {name}?'],
          lead: 'Womit {name} ringt: {notes}.', where: 'Wo bricht im Buch der innere Konflikt von {name} auf?' },
    en: { q: ['What is {name} struggling with?', 'What is {name}\'s inner conflict?'],
          lead: 'What {name} struggles with: {notes}.', where: 'Where does {name}\'s inner conflict break through in the book?' },
  },
  bogen: {
    de: { q: ['Wie verändert sich {name} im Lauf der Geschichte?', 'Welche Entwicklung macht {name} durch?'],
          lead: 'Der Weg, den {name} geht: {notes}.', where: 'Wo sieht man im Buch, wie sich {name} verändert?' },
    en: { q: ['How does {name} change over the story?', 'What journey does {name} go through?'],
          lead: 'The path {name} takes: {notes}.', where: 'Where can you see {name} change in the book?' },
  },
};

const OVERVIEW = {
  de: { q: ['Was geht in {name} vor?', 'Wie sieht es in {name} innen aus?', 'Was für ein Innenleben hat {name}?'] },
  en: { q: ['What is going on inside {name}?', 'What is {name}\'s inner life like?', 'What moves {name} inside?'] },
};

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

function buildPsycheSamples(ctx, readerFigures, push) {
  const lang = ctx.langIsEn ? 'en' : 'de';
  for (const rf of readerFigures) {
    const leads = [];
    for (const kern of PSYCHE_KERNE) {
      const notes = rf.notes[kern];
      const tx = KERN_TEXT[kern][lang];
      if (notes?.length) {
        const answer = fill(tx.lead, { name: rf.name, notes: notes.join('; ') });
        leads.push(answer);
        tx.q.forEach((q, i) => push({
          id: `reader|psyche|${rf.key}|${kern}|${i}`,
          turns: [[fill(q, { name: rf.name }), answer]],
          convKey: rf.key,
          voice: { key: `psyche|${rf.key}|${kern}`, kind: 'figure', name: rf.name },
        }));
      }
      // Belegstellen: eine Antwort je Fundstelle, damit jede Stelle als eigene
      // Erinnerung gelernt wird.
      (rf.occByKern[kern] || []).forEach((o, i) => {
        const where = o.chapter_name || o.page_name || '';
        const answer = ctx.langIsEn
          ? `${where ? `In «${where}»` : 'In the book'}: «${o.snippet.trim()}»`
          : `${where ? `In «${where}»` : 'Im Buch'}: «${o.snippet.trim()}»`;
        push({
          id: `reader|psycheOcc|${rf.key}|${kern}|${o.id ?? i}`,
          turns: [[fill(tx.where, { name: rf.name }), answer]],
          sourceKey: 'ch:' + (o.chapter_id ?? 0),
          convKey: rf.key,
        });
      });
    }
    if (leads.length >= 2) {
      const answer = leads.join(' ');
      OVERVIEW[lang].q.forEach((q, i) => push({
        id: `reader|psycheAll|${rf.key}|${i}`,
        turns: [[fill(q, { name: rf.name }), answer]],
        convKey: rf.key,
        voice: { key: `psycheAll|${rf.key}`, kind: 'figure', name: rf.name },
      }));
    }
  }
}

module.exports = { buildPsycheSamples, KERN_TEXT };
