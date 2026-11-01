'use strict';

const { nameRegex } = require('../../lib/names');
const { eventWhen } = require('../author-chat/event-data');
const { SCHICHT_PROSA } = require('../author-chat/figures');
const {
  genderOf, genitive, roleNoun, possessive, figureTypePhrase, pronoun, firstSentences,
  roleArticle, cleanBeruf, isStatus, FAMILY_TYPES, PLACEHOLDER_NAME,
} = require('./words');

// Wie oft eine Figur im Buchtext vorkommt (Name oder Kurzname als ganzes
// Wort). Kernwissen bekommen nur Figuren ab `minMentions` — eine Figur, die
// zweimal vorbeiläuft, trägt keine Grundfakten, nach denen Leser fragen.
function countMentions(figRows, pageContents) {
  const text = pageContents.map(p => p.text || '').join('\n');
  const out = new Map();
  for (const f of figRows) {
    const names = [...new Set([f.name, f.kurzname].filter(n => n && String(n).trim().length >= 2))];
    let n = 0;
    for (const nm of names) n = Math.max(n, (text.match(new RegExp(nameRegex(nm).source, 'gu')) || []).length);
    out.set(f.fig_id, n);
  }
  return out;
}

const Q = {
  de: {
    core: ['Wer ist {n}?', 'Erzähl mir kurz von {n}.', 'Was weisst du über {n}?', 'Was für eine Figur ist {n}?', 'Stell mir {n} kurz vor.'],
    beruf: ['Was macht {n} beruflich?', 'Welchen Beruf hat {n}?', 'Als was arbeitet {n}?'],
    birth: ['Wann wurde {n} geboren?', 'In welchem Jahr kam {n} zur Welt?', 'Wann ist {n} geboren?'],
    family: ['Wer gehört zu {n}s Familie?', 'Mit wem ist {n} verwandt?', 'Wie sieht die Familie von {n} aus?'],
    schicht: ['Aus welcher Schicht stammt {n}?', 'Aus welchem Milieu kommt {n}?', 'In welchen Verhältnissen lebt {n}?'],
  },
  en: {
    core: ['Who is {n}?', 'Tell me briefly about {n}.', 'What do you know about {n}?', 'What kind of character is {n}?', 'Introduce {n} to me.'],
    beruf: ['What does {n} do for a living?', "What is {n}'s job?", 'What does {n} work as?'],
    birth: ['When was {n} born?', 'In which year was {n} born?', "What is {n}'s year of birth?"],
    family: ["Who belongs to {n}'s family?", 'Who is {n} related to?', "What is {n}'s family like?"],
    schicht: ['Which social class does {n} come from?', 'What milieu does {n} come from?', 'What background does {n} have?'],
  },
};
const fill = (tpl, n) => tpl.replace(/\{n\}/g, n);
// «{n}s Familie» geht nur mit einfachem Genitiv; sonst «die Familie von {n}».
const familyQ = (tpl, f, langIsEn) => {
  if (langIsEn || !tpl.includes('{n}s ')) return fill(tpl, f.name);
  const gen = genitive(f.name, false);
  return gen ? tpl.replace('{n}s ', gen + ' ') : null;
};

// Familien-Sätze einer Figur aus den Beziehungsfakten (relations.js):
// [{ other, noun, g, typ }] — `noun` ist die Rolle der ANDEREN Figur.
function familyOf(f, relationFacts, langIsEn) {
  const out = [];
  for (const r of relationFacts) {
    if (!FAMILY_TYPES.has(r.typ)) continue;
    let other, typ;
    if (r.a.fig_id === f.fig_id) { other = r.b; typ = r.typ; }
    else if (r.b.fig_id === f.fig_id) {
      other = r.a;
      typ = ({ elternteil: 'kind', kind: 'elternteil' })[r.typ] || r.typ;
    } else continue;
    const role = roleNoun(typ, genderOf(other), langIsEn);
    if (role) out.push({ other, typ, ...role });
  }
  return out;
}

// «Seine Mutter ist Gisela.» / «Die Mutter von Stefan ist Gisela.»
function familySentence(f, rel, langIsEn, form) {
  const g = genderOf(f);
  const poss = possessive(g, rel.g, langIsEn);
  const gen = genitive(f.name, langIsEn);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  if (langIsEn) {
    if (form === 0 && poss) return `${cap(poss)} ${rel.noun} is ${rel.other.name}.`;
    return gen ? `${rel.other.name} is ${gen} ${rel.noun}.` : `${rel.other.name} is ${roleArticle(rel.typ, rel.g, true)} ${rel.noun} of ${f.name}.`;
  }
  if (form === 0 && poss) return `${cap(poss)} ${rel.noun} ist ${rel.other.name}.`;
  return gen ? `${rel.other.name} ist ${gen} ${rel.noun}.` : `${rel.other.name} ist ${roleArticle(rel.typ, rel.g, false)} ${rel.noun} von ${f.name}.`;
}

function birthYear(f, eventsByFigPk) {
  const ev = (eventsByFigPk.get(f.pk) || []).find(e => e.subtyp === 'geburt' && e.datum_year);
  return ev ? ev.datum_year : null;
}

function keyEvent(f, eventsByFigPk, langIsEn) {
  const evs = eventsByFigPk.get(f.pk) || [];
  const ev = evs.find(e => e.bedeutung && e.ereignis && e.subtyp !== 'geburt') || evs.find(e => e.ereignis && e.subtyp !== 'geburt');
  if (!ev) return null;
  const when = eventWhen(ev, langIsEn).when;
  return { text: String(ev.ereignis).trim().replace(/[.\s]+$/, ''), when };
}

function buildFigureCore(ctx, emitCard, relationFacts) {
  const {
    langIsEn, displayName, figRows, eligibleFigIds,
    eventsByFigPk, appearancesByFigPk, figsByLocPk, locRows,
  } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  const locsByFig = new Map();
  for (const l of locRows) {
    for (const id of (figsByLocPk.get(l.pk) || [])) {
      if (!locsByFig.has(id)) locsByFig.set(id, []);
      locsByFig.get(id).push(l.name);
    }
  }

  for (const f of figRows) {
    if (!eligibleFigIds.has(f.fig_id) || PLACEHOLDER_NAME.test(f.name)) continue;
    const g = genderOf(f);
    const pron = pronoun(g, langIsEn);
    const unit = 'fig:' + f.fig_id;
    const typePhrase = figureTypePhrase(f.typ, g, langIsEn);
    const desc = firstSentences(f.beschreibung, 2);
    const fam = familyOf(f, relationFacts, langIsEn).slice(0, 2);
    const beruf = cleanBeruf(f.beruf);
    const ch = (appearancesByFigPk.get(f.pk) || []).find(Boolean);
    const loc = (locsByFig.get(f.fig_id) || [])[0];
    const kev = keyEvent(f, eventsByFigPk, langIsEn);
    const subj = (form) => (form && pron ? pron : f.name);

    // Satzbausteine, je zwei Formulierungen.
    const identity = [];
    if (typePhrase) {
      identity.push(langIsEn ? `${f.name} is ${typePhrase} in «${displayName}».` : `${f.name} ist ${typePhrase} in «${displayName}».`);
      identity.push(langIsEn ? `In «${displayName}», ${f.name} is ${typePhrase}.` : `In «${displayName}» ist ${f.name} ${typePhrase}.`);
    }
    if (desc) identity.push(desc);
    const extras = [];
    for (const r of fam) extras.push([familySentence(f, r, langIsEn, 0), familySentence(f, r, langIsEn, 1)]);
    if (beruf) extras.push(isStatus(beruf)
      ? [langIsEn ? `${subj(1)} is ${beruf}.` : `${subj(1)} ist ${beruf}.`]
      : langIsEn
        ? [`${subj(1)} works as ${beruf}.`, `By profession, ${f.name} is ${beruf}.`]
        : [`${subj(1)} arbeitet als ${beruf}.`, `Von Beruf ist ${f.name} ${beruf}.`]);
    if (ch) extras.push(langIsEn
      ? [`${subj(1)} appears above all in the chapter «${ch}».`, `You meet ${f.name} most often in the chapter «${ch}».`]
      : [`${subj(1)} tritt vor allem im Kapitel «${ch}» auf.`, `Am häufigsten begegnet man ${f.name} im Kapitel «${ch}».`]);
    if (loc) extras.push(langIsEn
      ? [`${f.name} is closely tied to the setting «${loc}».`, `The setting «${loc}» belongs to ${f.name}'s story.`]
      : [`Mit ${f.name} verbunden ist vor allem der Schauplatz «${loc}».`, `Der Schauplatz «${loc}» gehört zur Geschichte von ${f.name}.`]);
    if (kev) extras.push(langIsEn
      ? [`An important event for ${f.name}: ${kev.text}${kev.when ? ` (${kev.when})` : ''}.`, `${kev.text}${kev.when ? ` (${kev.when})` : ''} marks ${f.name}'s story.`]
      : [`Ein wichtiges Ereignis für ${f.name}: ${kev.text}${kev.when ? ` (${kev.when})` : ''}.`, `${f.name} erlebt: ${kev.text}${kev.when ? ` (${kev.when})` : ''}.`]);
    // Ohne Typ, Beschreibung und Bausteine keine Kernantwort — die
    // Einzelattribute unten gibt es trotzdem.
    if (identity.length || extras.length) {

      // Antwortvarianten: 2–4 Sätze, Reihenfolge und Formulierung rotieren.
      const answers = [];
      const nAns = 5;
      for (let v = 0; v < nAns; v++) {
        const parts = [];
        if (identity.length) parts.push(identity[v % identity.length]);
        const take = Math.min(extras.length, 1 + (v % 3));
        for (let j = 0; j < take; j++) {
          const e = extras[(v + j) % extras.length];
          parts.push(e[(v + j) % e.length]);
        }
        if (!parts.length) continue;
        if (!parts[0].includes(f.name)) parts.unshift(identity[0] || `${f.name}.`);
        answers.push(parts.join(' '));
      }
      const names = [f.name, ...(f.kurzname && f.kurzname !== f.name && f.kurzname.trim().length >= 2 ? [f.kurzname] : [])];
      const questions = Q[lang].core.flatMap(t => names.map(n => fill(t, n)));
      emitCard({ id: 'fig:' + f.fig_id + ':core', kind: 'figure', unit, core: true, subject: f.name,
        fields: { typ: f.typ || null, beruf: beruf || null, beschreibung: desc || null } },
      { task: 'figureCore', questions, answers });
    }

    // ── Einzelattribute ───────────────────────────────────────────────
    if (beruf) {
      emitCard({ id: 'fig:' + f.fig_id + ':beruf', kind: 'figureAttr', unit, core: true, subject: f.name, fields: { beruf } }, {
        task: 'figureAttr',
        questions: Q[lang].beruf.map(t => fill(t, f.name)),
        answers: isStatus(beruf)
          ? (langIsEn ? [`${f.name} is ${beruf}.`, `${f.name} is currently ${beruf}.`] : [`${f.name} ist ${beruf}.`, `Zurzeit ist ${f.name} ${beruf}.`])
          : langIsEn
            ? [`${f.name} works as ${beruf}.`, `By profession, ${f.name} is ${beruf}.`, `${f.name}'s job: ${beruf}.`]
            : [`${f.name} arbeitet als ${beruf}.`, `Von Beruf ist ${f.name} ${beruf}.`, `${f.name} verdient das Geld als ${beruf}.`],
      });
    }
    const year = birthYear(f, eventsByFigPk);
    if (year) {
      emitCard({ id: 'fig:' + f.fig_id + ':geburt', kind: 'figureAttr', unit, core: true, subject: f.name, fields: { geburtsjahr: year } }, {
        task: 'figureAttr',
        questions: Q[lang].birth.map(t => fill(t, f.name)),
        answers: langIsEn
          ? [`${f.name} was born in ${year}.`, `${f.name} came into the world in ${year}.`, `${f.name}'s year of birth is ${year}.`]
          : [`${f.name} wurde ${year} geboren.`, `${f.name} kam ${year} zur Welt.`, `Das Geburtsjahr von ${f.name} ist ${year}.`],
      });
    }
    const allFam = familyOf(f, relationFacts, langIsEn);
    if (allFam.length) {
      const list = allFam.map(r => `${r.other.name} (${r.noun})`).join(', ');
      const sentences = allFam.map((r, i) => familySentence(f, r, langIsEn, i % 2)).join(' ');
      emitCard({ id: 'fig:' + f.fig_id + ':familie', kind: 'figureAttr', unit, core: true, subject: f.name,
        fields: { familie: allFam.map(r => ({ name: r.other.name, rolle: r.noun })) } }, {
        task: 'figureAttr',
        questions: Q[lang].family.map(t => familyQ(t, f, langIsEn)).filter(Boolean),
        answers: langIsEn
          ? [`To ${f.name}'s family belong: ${list}.`, sentences]
          : [`Zur Familie von ${f.name} gehören: ${list}.`, sentences],
      });
    }
    const schicht = SCHICHT_PROSA[String(f.sozialschicht || '').trim().toLowerCase()];
    if (schicht) {
      const s = schicht[lang];
      emitCard({ id: 'fig:' + f.fig_id + ':schicht', kind: 'figureAttr', unit, core: true, subject: f.name, fields: { sozialschicht: f.sozialschicht } }, {
        task: 'figureAttr',
        questions: Q[lang].schicht.map(t => fill(t, f.name)),
        answers: langIsEn
          ? [`${f.name} comes from ${s}.`, `${f.name} belongs to ${s}.`]
          : [`${f.name} stammt aus ${s}.`, `${f.name} kommt aus ${s}.`],
      });
    }
  }
}

module.exports = { buildFigureCore, countMentions, familyOf };
