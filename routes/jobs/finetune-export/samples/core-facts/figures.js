'use strict';

const { nameRegex } = require('../../lib/names');
const { eventWhen } = require('../author-chat/event-data');
const { SCHICHT_PROSA } = require('../author-chat/figures');
const {
  genderOf, genitive, roleNoun, possessive, figureTypePhrase, pronoun, firstSentences, inverseTyp, datOf,
  roleArticle, berufHead, jobInSentence, isStatus, ownBirthYear, FAMILY_TYPES, PLACEHOLDER_NAME,
} = require('./words');
const { declineName, fillCase, stripQualifier } = require('./naming');

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

// Fragen mit Kasus-Platzhaltern (naming.js#fillCase): `{n}` Nominativ,
// `{n:akk}`, `{n:dat}` — «Was weisst du über Herrn Koch?», «Erzähl mir kurz
// vom Fahrer des Mercedes.».
//
// `core` sind die Porträt-Fragen, direkte wie umgangssprachliche. Dieselben
// Vorlagen fragen in reader/refusals.js nach erfundenen Namen
// (Kontrastpaare): das Modell soll am Namen entscheiden, nicht an der Frageform.
const Q = {
  de: {
    core: ['Wer ist {n}?', 'Erzähl mir kurz von {n:dat}.', 'Was weisst du über {n:akk}?', 'Was für eine Figur ist {n}?', 'Stell mir {n:akk} kurz vor.',
      'Kannst du mir sagen, wer {n} ist?', 'Beschreib mir {n:akk} in ein paar Sätzen.', 'Was ist {n} für ein Mensch?',
      'Wer ist eigentlich {n}?', 'Erzähl mir etwas über {n:akk}.', '{n} – wer ist das?', 'Welche Rolle spielt {n} in deiner Geschichte?',
      'Stell mir {n:akk} vor.'],
    beruf: ['Was macht {n} beruflich?', 'Welchen Beruf hat {n}?', 'Als was arbeitet {n}?'],
    birth: ['Wann wurde {n} geboren?', 'In welchem Jahr kam {n} zur Welt?', 'Wann ist {n} geboren?'],
    family: ['Wer gehört zur Familie von {n:dat}?', 'Mit wem ist {n} verwandt?', 'Wie sieht die Familie von {n:dat} aus?'],
    schicht: ['Aus welcher Schicht stammt {n}?', 'Aus welchem Milieu kommt {n}?', 'In welchen Verhältnissen lebt {n}?'],
  },
  en: {
    core: ['Who is {n}?', 'Tell me briefly about {n}.', 'What do you know about {n}?', 'What kind of character is {n}?', 'Introduce {n} to me.',
      'Can you tell me who {n} is?', 'Describe {n} to me in a few sentences.', 'What sort of person is {n}?',
      'Who is {n}, actually?', 'Tell me something about {n}.', '{n} – who is that?', 'What role does {n} play in your story?',
      'Present {n} to me.'],
    beruf: ['What does {n} do for a living?', "What is {n}'s job?", 'What does {n} work as?'],
    birth: ['When was {n} born?', 'In which year was {n} born?', "What is {n}'s year of birth?"],
    family: ["Who belongs to {n}'s family?", 'Who is {n} related to?', "What is {n}'s family like?"],
    schicht: ['Which social class does {n} come from?', 'What milieu does {n} come from?', 'What background does {n} have?'],
  },
};

// Familien-Sätze einer Figur aus den Beziehungsfakten (relations.js):
// [{ other, noun, g, typ }] — `noun` ist die Rolle der ANDEREN Figur.
// `types`: welche Beziehungstypen zählen (Standard: Familie).
function familyOf(f, relationFacts, langIsEn, types = FAMILY_TYPES) {
  const out = [];
  for (const r of relationFacts) {
    if (!types.has(r.typ) && !types.has(inverseTyp(r.typ))) continue;
    let other, typ;
    if (r.a.fig_id === f.fig_id) { other = r.b; typ = r.typ; }
    else if (r.b.fig_id === f.fig_id) { other = r.a; typ = inverseTyp(r.typ); }
    else continue;
    if (!types.has(typ)) continue;
    const role = roleNoun(typ, genderOf(other), langIsEn);
    if (role) out.push({ other, typ, ...role });
  }
  return out;
}

// Engste Beziehungen fürs Porträt: Partner, Eltern, Kinder, Geschwister,
// Freunde — in dieser Reihenfolge.
const CLOSE_ORDER = ['ehepartner', 'liebesbeziehung', 'elternteil', 'kind', 'geschwister', 'freund'];
const CLOSE_TYPES = new Set(CLOSE_ORDER);
function closestRelations(f, relationFacts, langIsEn, n = 2) {
  return familyOf(f, relationFacts, langIsEn, CLOSE_TYPES)
    .sort((a, b) => CLOSE_ORDER.indexOf(a.typ) - CLOSE_ORDER.indexOf(b.typ))
    .slice(0, n);
}

// «Seine Mutter ist Gisela.» / «Gisela ist Stefans Mutter.»
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
  return gen ? `${rel.other.name} ist ${gen} ${rel.noun}.` : `${rel.other.name} ist ${roleArticle(rel.typ, rel.g, false)} ${rel.noun} von ${datOf(f.name)}.`;
}

// Zwei Beziehungen in einem Satz: «Seine Mutter ist Gisela, sein Bruder Adrian.»
function relationsSentence(f, rels, langIsEn, form) {
  if (rels.length < 2) return rels.length ? familySentence(f, rels[0], langIsEn, form) : '';
  const g = genderOf(f);
  const [p1, p2] = rels.map(r => possessive(g, r.g, langIsEn));
  if (form === 0 && p1 && p2) {
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    return langIsEn
      ? `${cap(p1)} ${rels[0].noun} is ${rels[0].other.name}, ${p2} ${rels[1].noun} ${rels[1].other.name}.`
      : `${cap(p1)} ${rels[0].noun} ist ${rels[0].other.name}, ${p2} ${rels[1].noun} ${rels[1].other.name}.`;
  }
  // Ein Satz: «Renate ist Stefans Ehefrau, Gisela seine Mutter.»
  const gen = genitive(f.name, langIsEn);
  const own = (r, p) => (p || gen ? `${p || gen} ${r.noun}` : null);
  const [o1, o2] = [own(rels[0], gen), own(rels[1], p2)];
  if (o1 && o2) return langIsEn ? `${rels[0].other.name} is ${o1}, ${rels[1].other.name} ${o2}.` : `${rels[0].other.name} ist ${o1}, ${rels[1].other.name} ${o2}.`;
  return familySentence(f, rels[0], langIsEn, 1);
}

const birthYear = (f, eventsByFigPk) => ownBirthYear(f, eventsByFigPk);

// Wichtigster persönlicher Wendepunkt: nur `typ = persoenlich`, nie
// Weltgeschehen (`extern`, Untertyp `extern_*`) und nie die Geburt. Das
// Datenmodell kennt kein Gewicht; Rang nach Untertyp (Wendepunkt vor Verlust,
// Trennung … vor Sonstigem), dann Ereignisse mit Bedeutung, dann das erste
// im Zeitstrahl.
const TURN_RANK = { wendepunkt: 0, verlust: 1, tod: 1, trennung: 1, hochzeit: 1, liebe: 2, konflikt: 2, sieg: 2, krankheit: 2, entdeckung: 2, umzug: 3, reise: 3 };
function turningPoint(f, names, eventsByFigPk, langIsEn) {
  const evs = (eventsByFigPk.get(f.pk) || []).filter(e => e.ereignis
    && String(e.typ || 'persoenlich') !== 'extern' && !/^extern/.test(String(e.subtyp || '')) && e.subtyp !== 'geburt');
  if (!evs.length) return null;
  const rank = (e) => (TURN_RANK[e.subtyp] ?? 4) * 2 + (e.bedeutung ? 0 : 1);
  const ev = evs.map((e, i) => [e, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])[0][0];
  // Datum nur, wenn es sicher ist: ein aus dem Kontext erschlossenes Jahr
  // gehört nicht als Fakt ins Porträt.
  const when = ev.datum_unsicher ? '' : stripQualifier(eventWhen(ev, langIsEn).when || '');
  const text = String(ev.ereignis).trim().replace(/[.\s]+$/, '');
  const bed = String(ev.bedeutung || '').trim();
  return {
    text, when,
    // Satzbeginn mit dem Namen («Mario wechselt an die Frohheim-Schule …»):
    // der Titel ist selbst ein Satz.
    isSentence: names.some(n => text.startsWith(n + ' ')),
    // Bedeutung nur, wenn sie ein ganzer Satz über die Figur ist.
    meaning: /^(Er|Sie|Ihr|Ihm|Ihn|Sein|Seine|He|She|His|Her)\b/.test(bed) && /[.!?]$/.test(bed) ? bed : '',
  };
}

function turningSentences(tp, subject, langIsEn) {
  const at = tp.when ? ` (${tp.when})` : '';
  if (tp.isSentence) return [`${tp.text}${at}.`];
  return langIsEn
    ? [`A turning point for ${subject} is «${tp.text}»${at}.`, `«${tp.text}»${at} changes things for ${subject}.`]
    : [`Zum Wendepunkt für ${subject} wird «${tp.text}»${at}.`, `Einschneidend für ${subject} ist «${tp.text}»${at}.`];
}

// Werdegang aus dem freien Berufsfeld: «Stefan ist Polymechaniker – zuerst im
// Stahlwerk Gerlafingen, ab 1988 Facharbeiter …». Nur, wenn das Feld mit dem
// Beruf beginnt und mehr trägt als ihn.
function careerSentences(f, head, langIsEn) {
  const raw = String(f.beruf || '').trim().replace(/[.\s]+$/, '');
  if (!head || raw.length <= head.length + 3 || raw.length > 220 || !raw.toLowerCase().startsWith(head.toLowerCase())) return [];
  const rest = raw.slice(head.length).replace(/^[\s,;]+/, '').replace(/^\(([^)]*)\)\s*[;,]?\s*/, '$1; ');
  if (rest.length < 6) return [];
  return [langIsEn ? `${f.name} is ${head} – ${rest}.` : `${f.name} ist ${head} – ${rest}.`];
}

const corePerTierOf = (opts, tier) => {
  const map = { main: 8, side: 4, minor: 1, ...(opts.corePerTier || {}) };
  return Math.max(1, Math.round(Number(map[tier]) || 1));
};

function buildFigureCore(ctx, emitCard, relationFacts) {
  const {
    langIsEn, displayName, figRows, eligibleFigIds, opts,
    eventsByFigPk, appearancesByFigPk, figsByLocPk, locRows,
  } = ctx;
  const nameInfoOf = (f) => ctx.figNameInfo?.get(f.fig_id) || { name: f.name, role: false, proper: true, aliases: [f.name] };
  const lang = langIsEn ? 'en' : 'de';
  const locsByFig = new Map();
  for (const l of locRows) {
    for (const id of (figsByLocPk.get(l.pk) || [])) {
      if (!locsByFig.has(id)) locsByFig.set(id, []);
      locsByFig.get(id).push(l.name);
    }
  }

  for (const f0 of figRows) {
    if (!eligibleFigIds.has(f0.fig_id) || PLACEHOLDER_NAME.test(f0.name)) continue;
    const info = nameInfoOf(f0);
    const f = { ...f0, name: info.name };
    const g = genderOf(f);
    const tier = ctx.tierByFig?.get(f.fig_id) || 'minor';
    const unit = 'fig:' + f.fig_id;
    const decl = { gender: g, role: info.role, langIsEn };
    const nom = declineName(f.name, 'nom', decl) || f.name;
    const dat = declineName(f.name, 'dat', decl) || f.name;
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    // Nutzernamen in Kleinschrift («madame_phantasma») nie am Satzanfang.
    const lowerStart = !/^\p{Lu}/u.test(nom) && !info.role;
    const Nom = info.role ? cap(nom) : nom;
    const pron = pronoun(g, langIsEn);
    const later = pron || Nom;
    const typePhrase = figureTypePhrase(f.typ, g, langIsEn);
    const desc = firstSentences(f.beschreibung, 1);
    const beruf = jobInSentence(berufHead(f.beruf));
    const ch = (appearancesByFigPk.get(f.pk) || []).find(Boolean);
    const loc = (locsByFig.get(f.fig_id) || [])[0];
    const tp = turningPoint(f, [f.name, ...info.aliases], eventsByFigPk, langIsEn);
    const rels = info.proper ? closestRelations(f, relationFacts, langIsEn) : [];

    // Bausteine in fester Priorität: Rolle im Buch → engste Beziehungen →
    // Beruf/Ort → persönlicher Wendepunkt. Je Baustein zwei Formulierungen.
    const identity = [];
    if (typePhrase) {
      identity.push(langIsEn
        ? `${Nom} is ${typePhrase} in «${displayName}»${ch ? ` and appears above all in the chapter «${ch}»` : ''}.`
        : `${Nom} ist ${typePhrase} in «${displayName}»${ch ? ` und tritt vor allem im Kapitel «${ch}» auf` : ''}.`);
      identity.push(langIsEn
        ? `In «${displayName}», ${nom} is ${typePhrase}${ch ? `; you meet ${f.name} most often in the chapter «${ch}»` : ''}.`
        : `In «${displayName}» ist ${nom} ${typePhrase}${ch ? `; am häufigsten begegnet man ${dat} im Kapitel «${ch}»` : ''}.`);
      if (lowerStart) identity.shift();
    } else if (ch) {
      identity.push(langIsEn ? `In «${displayName}», ${nom} appears above all in the chapter «${ch}».`
        : `In «${displayName}» tritt ${nom} vor allem im Kapitel «${ch}» auf.`);
    }
    const relBlock = rels.length ? [relationsSentence(f, rels, langIsEn, 0), relationsSentence(f, rels, langIsEn, 1)] : null;
    const jobBlock = beruf
      ? (isStatus(beruf)
        ? [langIsEn ? `${later} is ${beruf}.` : `${later} ist ${beruf}.`]
        : langIsEn
          ? [`${later} works as ${beruf}${loc ? ` and is closely tied to «${loc}»` : ''}.`, `By profession, ${pron ? pron.toLowerCase() : f.name} is ${beruf}.`]
          : [`${later} arbeitet als ${beruf}${loc ? ` und ist eng mit «${loc}» verbunden` : ''}.`, `Von Beruf ist ${pron ? pron.toLowerCase() : Nom} ${beruf}.`])
      : loc
        ? (langIsEn
          ? [`${later} is closely tied to the setting «${loc}».`, `The setting «${loc}» belongs to ${f.name}'s story.`]
          : [`Mit ${dat} verbunden ist vor allem der Schauplatz «${loc}».`, `Der Schauplatz «${loc}» gehört zur Geschichte von ${dat}.`])
        : null;
    const tpBlock = tp ? turningSentences(tp, langIsEn ? f.name : dat, langIsEn) : null;
    const descBlock = desc && !desc.startsWith(f.name + ':') ? desc : null;

    if (identity.length || relBlock || jobBlock || tpBlock || descBlock) {
      // Antwortvarianten: 2–4 Sätze in fester Reihenfolge (Rolle → Beziehungen
      // → Beruf/Ort → Wendepunkt). Die Varianten kombinieren die Formulierungen
      // der Bausteine; jede zweite Hälfte setzt die Beschreibung an die Stelle
      // von Beruf/Ort. Verschiedene Antworten, damit `maxPerAnswer` keine
      // Variante streicht.
      const answers = [];
      const at = (b, i) => (b ? b[i % b.length] : null);
      for (let v = 0; v < 8; v++) {
        const useDesc = descBlock && v >= 4;
        const parts = [
          identity.length ? identity[v % identity.length] : null,
          useDesc ? descBlock : null,
          at(relBlock, v >> 1),
          useDesc ? null : at(jobBlock, v + 1),
          at(tpBlock, (v >> 1) + v),
        ].filter(Boolean);
        if (!parts.length) continue;
        if (!identity.length && !parts[0].includes(f.name)) parts.unshift(`${Nom} gehört zu den Figuren von «${displayName}».`);
        // Die Bedeutung des Wendepunkts als eigener Satz, solange Platz ist.
        if (tpBlock && tp.meaning && parts.length < 4 && tpBlock.includes(parts[parts.length - 1])) parts.push(tp.meaning);
        answers.push(parts.slice(0, 4).join(' '));
      }
      const names = info.role ? [f.name] : info.aliases;
      const questions = Q[lang].core.flatMap(t => names.map(n => fillCase(t, n, decl))).filter(Boolean);
      emitCard({ id: 'fig:' + f.fig_id + ':core', kind: 'figure', unit, core: true, tier, subject: f.name,
        fields: { typ: f.typ || null, beruf: beruf || null, beschreibung: desc || null } },
      { task: 'figureCore', questions, answers, count: corePerTierOf(opts, tier) });
    }

    // Rollenfiguren tragen keine Einzelattribute: «Bademeister der Badi Olten
    // kommt aus der Arbeiterschicht» ist weder Satz noch Leserfrage.
    if (!info.proper) continue;
    const q = (key) => Q[lang][key].map(t => fillCase(t, f.name, decl)).filter(Boolean);

    // ── Einzelattribute ───────────────────────────────────────────────
    if (beruf) {
      emitCard({ id: 'fig:' + f.fig_id + ':beruf', kind: 'figureAttr', unit, core: true, tier, subject: f.name, fields: { beruf } }, {
        task: 'figureAttr',
        questions: q('beruf'),
        answers: [...(isStatus(beruf)
          ? (langIsEn ? [`${f.name} is ${beruf}.`, `${f.name} is currently ${beruf}.`] : [`${f.name} ist ${beruf}.`, `Zurzeit ist ${f.name} ${beruf}.`])
          : langIsEn
            ? [`${f.name} works as ${beruf}.`, `By profession, ${f.name} is ${beruf}.`, `${f.name} earns a living as ${beruf}.`]
            : [`${f.name} arbeitet als ${beruf}.`, `Von Beruf ist ${f.name} ${beruf}.`, `${f.name} verdient das Geld als ${beruf}.`]),
          ...careerSentences(f, beruf, langIsEn)],
      });
    }
    const year = birthYear(f, eventsByFigPk);
    if (year) {
      emitCard({ id: 'fig:' + f.fig_id + ':geburt', kind: 'figureAttr', unit, core: true, tier, subject: f.name, fields: { geburtsjahr: year } }, {
        task: 'figureAttr',
        questions: q('birth'),
        answers: langIsEn
          ? [`${f.name} was born in ${year}.`, `${f.name} came into the world in ${year}.`, `${f.name}'s year of birth is ${year}.`]
          : [`${f.name} wurde ${year} geboren.`, `${f.name} kam ${year} zur Welt.`, `Das Geburtsjahr von ${datOf(f.name)} ist ${year}.`],
      });
    }
    const allFam = familyOf(f, relationFacts, langIsEn);
    if (allFam.length) {
      // Ganze Sätze («Rudolfs Ehefrau ist Johanna.»), nie «gehören: A (Ehefrau)».
      const sentences = allFam.map((r, i) => familySentence(f, r, langIsEn, i % 2)).join(' ');
      const sentences2 = allFam.map((r, i) => familySentence(f, r, langIsEn, (i + 1) % 2)).join(' ');
      emitCard({ id: 'fig:' + f.fig_id + ':familie', kind: 'figureAttr', unit, core: true, tier, subject: f.name,
        fields: { familie: allFam.map(r => ({ name: r.other.name, rolle: r.noun })) } }, {
        task: 'figureAttr',
        questions: q('family'),
        answers: [sentences, sentences2],
      });
    }
    const schicht = SCHICHT_PROSA[String(f.sozialschicht || '').trim().toLowerCase()];
    if (schicht) {
      const s = schicht[lang];
      emitCard({ id: 'fig:' + f.fig_id + ':schicht', kind: 'figureAttr', unit, core: true, tier, subject: f.name, fields: { sozialschicht: f.sozialschicht } }, {
        task: 'figureAttr',
        questions: q('schicht'),
        answers: langIsEn
          ? [`${f.name} comes from ${s}.`, `${f.name} belongs to ${s}.`]
          : [`${f.name} stammt aus ${s}.`, `${f.name} kommt aus ${s}.`],
      });
    }
  }
}

module.exports = { buildFigureCore, countMentions, familyOf, familySentence, turningPoint, turningSentences, birthYear, careerSentences, PORTRAIT_QUESTIONS: Q };
