'use strict';

const {
  genderOf, genitive, roleNoun, inverseTyp, roleStatement, possessive, firstSentences,
  roleArticle, descFitsType, UNIQUE_ROLES, PLACEHOLDER_NAME,
} = require('./words');

// Beziehungen als Kernfakten, in BEIDEN Fragerichtungen und mit ausgeschriebener
// Rolle («Gisela ist Stefans Mutter»), nie als Präfix «Elternteil: …».
//
// `figure_relations.typ` beschreibt die Rolle von «zu» gegenüber «von»
// (public/js/book/beziehung-typen.js). Altbestand trägt Rohwerte
// («andere|bekannt», «vorgesetzte») und beide Perspektiven derselben Aussage;
// `normalizeRelationTyp` + `canonicalRelation` bringen sie auf eine Form.
// Ein Paar mit unvereinbaren Aussagen — zwei verschiedene spezifische Typen,
// oder eine Beschreibung, die eine andere Verwandtschaft nennt als der Typ
// («Enkelin Antonie» bei `kind`, «seine Schwägerin» bei `freund`) — bekommt
// keinen Kernfakt (`relationConflicts`): ein falscher Fakt in mehreren
// Varianten ist teurer als ein fehlender. Platzhalter-Figuren («(unnamed)»)
// fallen ganz weg.

// Vermutungen der Analyse («wahrscheinlich sein Sohn», «nicht direkt») sind
// kein Fakt — eine solche Beschreibung zählt nicht.
const HEDGE = /\b(wahrscheinlich|vermutlich|möglicherweise|vielleicht|unklar|nicht direkt|eventuell|anscheinend|probably|possibly|perhaps|unclear|not directly|apparently)\b/i;

const DIRECTED = new Set(['elternteil', 'kind', 'mentor', 'schuetzling', 'vorgesetzter', 'untergebener', 'patronage']);
const WEAK = new Set(['bekannt', 'andere']);

// → { facts: [{ key, a, b, typ, desc, descFrom, core }], conflicts }
//   `typ` ist die Rolle von b gegenüber a; `typ = 'andere'` = nur Beschreibung.
function collectRelationFacts(ctx) {
  const { figRelRows, figById, relTypes, eligibleFigIds } = ctx;
  const byPair = new Map();
  for (const r of figRelRows) {
    const A = figById.get(r.from_fig_id), B = figById.get(r.to_fig_id);
    if (!A || !B || A.fig_id === B.fig_id) continue;
    if (PLACEHOLDER_NAME.test(A.name) || PLACEHOLDER_NAME.test(B.name)) continue;
    const typ = relTypes ? relTypes.normalizeRelationTyp(r.typ).typ : String(r.typ || '').trim().toLowerCase();
    let st = relTypes ? relTypes.canonicalRelation(A.fig_id, B.fig_id, typ) : { from: A.fig_id, to: B.fig_id, typ };
    if (!DIRECTED.has(st.typ) && st.from > st.to) st = { from: st.to, to: st.from, typ: st.typ };
    const key = [A.fig_id, B.fig_id].sort().join('|');
    if (!byPair.has(key)) byPair.set(key, { stmts: new Map(), descs: [] });
    const g = byPair.get(key);
    g.stmts.set(`${st.from}>${st.to}>${st.typ}`, st);
    const d = String(r.beschreibung || '').trim();
    if (d && !HEDGE.test(d)) g.descs.push({ text: d, from: A.fig_id });
  }
  const facts = [];
  let conflicts = 0;
  for (const [key, g] of byPair) {
    let stmts = [...g.stmts.values()];
    const strong = stmts.filter(s => !WEAK.has(s.typ));
    if (strong.length) stmts = strong;
    else stmts = stmts.filter(s => s.typ === 'bekannt').length ? stmts.filter(s => s.typ === 'bekannt') : stmts;
    if (stmts.length > 1) { conflicts++; continue; }
    const st = stmts[0];
    const desc = g.descs.find(d => d.from === st.from) || g.descs[0] || null;
    if (st.typ !== 'andere' && g.descs.some(d => !descFitsType(d.text, st.typ))) { conflicts++; continue; }
    if (st.typ === 'andere' && !desc) continue;
    const a = figById.get(st.from), b = figById.get(st.to);
    facts.push({
      key, a, b, typ: st.typ,
      desc: desc ? firstSentences(desc.text, 1) : '',
      descFrom: desc ? desc.from : null,
      core: !!(eligibleFigIds?.has(a.fig_id) || eligibleFigIds?.has(b.fig_id)),
    });
  }
  return { facts, conflicts };
}

const QUESTIONS = {
  de: ['Wie steht {x} zu {y}?', 'Was ist {y} für {x}?', 'In welcher Beziehung steht {x} zu {y}?',
       'Wer ist {y} für {x}?', 'Wie ist {x} mit {y} verbunden?'],
  en: ['How does {x} relate to {y}?', 'What is {y} to {x}?', 'What is the relationship between {x} and {y}?',
       'Who is {y} to {x}?', 'How is {x} connected to {y}?'],
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Antworten auf «Wie steht X zu Y?»: Y hat gegenüber X die Rolle `typY`.
function relationAnswers({ X, Y, typY, desc, descFromX }, langIsEn) {
  const gX = genderOf(X), gY = genderOf(Y);
  const RY = roleNoun(typY, gY, langIsEn);
  const RX = roleNoun(inverseTyp(typY), gX, langIsEn);
  const tail = desc && descFromX ? ' ' + desc : '';
  if (!RY || !RX) {
    if (!desc) return [];
    return langIsEn
      ? [`What connects ${X.name} and ${Y.name}: ${desc}`, `About ${X.name} and ${Y.name}, the story tells this: ${desc}`]
      : [`${X.name} und ${Y.name} verbindet Folgendes: ${desc}`, `Über ${X.name} und ${Y.name} erzählt die Geschichte: ${desc}`];
  }
  const typX = inverseTyp(typY);
  const yRole = roleStatement(Y.name, X.name, RY, langIsEn, typY);
  const xRoleFull = roleStatement(X.name, Y.name, RX, langIsEn, typX);
  const poss = possessive(gY, RX.g, langIsEn);
  const xRole = poss ? (langIsEn ? `${X.name} is ${poss} ${RX.noun}` : `${X.name} ist ${poss} ${RX.noun}`) : xRoleFull;
  const genX = genitive(X.name, langIsEn);
  const out = [];
  out.push(yRole + '.' + tail);
  out.push(yRole + '; ' + xRole + '.');
  const art = roleArticle(typY, RY.g, langIsEn);
  // «Stefans Mutter ist Gisela» nur bei Rollen, die man einmal hat.
  const inverted = UNIQUE_ROLES.has(typY);
  if (langIsEn) {
    if (inverted) out.push(cap(genX ? `${genX} ${RY.noun} is ${Y.name}.` : `the ${RY.noun} of ${X.name} is ${Y.name}.`));
    out.push(`In my story, ${yRole}.` + tail);
  } else {
    if (inverted) out.push(cap(genX ? `${genX} ${RY.noun} ist ${Y.name}.` : `${art} ${RY.noun} von ${X.name} ist ${Y.name}.`));
    out.push(`Für ${X.name} ist ${Y.name} ${art} ${RY.noun}.` + tail);
  }
  return out;
}

function buildRelationCore(ctx, emitCard, variantCount) {
  const { langIsEn } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  const { facts, conflicts } = collectRelationFacts(ctx);
  // Pro Richtung mindestens zwei Varianten: die Fakten sollen aus beiden
  // Blickrichtungen abrufbar sein.
  const perDir = Math.max(2, Math.ceil(variantCount / 2));
  const fill = (q, x, y) => q.replace('{x}', x).replace('{y}', y);
  for (const f of facts) {
    const card = {
      id: 'rel:' + f.key, kind: 'relation', unit: 'rel:' + f.key, core: f.core,
      subject: [f.a.name, f.b.name],
      fields: { from: f.a.name, to: f.b.name, typ: f.typ, beschreibung: f.desc },
    };
    // a → b: «Wie steht a zu b?» — b hat gegenüber a die Rolle `typ`.
    emitCard(card, {
      task: 'relationCore', dir: 'ab', count: perDir,
      questions: QUESTIONS[lang].map(q => fill(q, f.a.name, f.b.name)),
      answers: relationAnswers({ X: f.a, Y: f.b, typY: f.typ, desc: f.desc, descFromX: f.descFrom === f.a.fig_id }, langIsEn),
    });
    emitCard(card, {
      task: 'relationCore', dir: 'ba', count: perDir,
      questions: QUESTIONS[lang].map(q => fill(q, f.b.name, f.a.name)),
      answers: relationAnswers({ X: f.b, Y: f.a, typY: f.typ === 'andere' ? 'andere' : inverseTyp(f.typ), desc: f.desc, descFromX: f.descFrom === f.b.fig_id }, langIsEn),
    });
  }
  return { facts, conflicts };
}

module.exports = { buildRelationCore, collectRelationFacts, relationAnswers, QUESTIONS };
