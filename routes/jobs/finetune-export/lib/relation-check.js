'use strict';

// Konsistenzprüfung der Figurenbeziehungen vor dem Export (docs/finetuning.md#beziehungsprüfung).
// Ein falscher Verwandtschaftsfakt, in vielen Varianten gelernt, ist das
// Teuerste, was das Set enthalten kann. Darum werden die Beziehungsdaten als
// Graph gelesen und gegen Regeln und gegen die Texte der Analyse geprüft.
// Jeder Treffer nennt die Figuren, die Regel, die Quellen (Beziehungs-ID,
// Ereignis-ID, Biografiefeld) und einen Ausschnitt. Die betroffenen Paare
// fallen bis zur Klärung aus allen Fakten-Aufgaben (`pairs`). Korrigiert wird
// nichts: der Autor entscheidet.
//
// Regeln (`rule`):
//   maxParents         — mehr als ein Vater oder eine Mutter (Geschlecht aus
//                        `figures.geschlecht`; ohne Geschlecht: mehr als zwei
//                        Eltern). Ehe-Beziehungen der Mutter zu den
//                        konkurrierenden Vätern gehören zum selben Widerspruch;
//   parentIsKin        — ein Elternteil ist zugleich Geschwister oder Partner;
//   spouseAsymmetric   — ein Paar ist Ehepartner und zugleich etwas anderes;
//   pairConflict       — zwei verschiedene spezifische Typen auf einem Paar;
//   familyAndFriend    — Familie und zugleich Freund/Bekannter;
//   siblingsNoParent   — Geschwister ohne gemeinsames Elternteil, obwohl bei
//                        beiden Eltern erfasst sind;
//   generationGap      — Elternteil laut Geburtsjahr keine 14 Jahre älter;
//   peerAgeGap         — Freundschaft unter Gleichaltrigen (Beschreibung nennt
//                        Schule, Klasse, Clique, Kindheit …), die Geburtsjahre
//                        liegen aber mehr als 5 Jahre auseinander — oft zwei
//                        gleichnamige Figuren, die zu einer verschmolzen sind;
//   duplicateDescription — dieselbe Beschreibung auf zwei Beziehungen
//                        gleichen Typs mit einer gemeinsamen Figur (kopiert);
//   textContradiction  — eine Beziehungsbeschreibung, ein Ereignis oder eine
//                        Biografie nennt ein Verwandtschaftswort, das zum
//                        Graphen nicht passt («Schwager», wo die Daten
//                        «Schwiegervater» ergeben; «vom grossen Bruder», wo
//                        die Daten «Sohn» sagen). Heuristisch über die
//                        Verwandtschaftswörter;
//   genderMismatch     — die Beschreibung nennt die Rolle des Ziels mit einem
//                        Geschlecht, das nicht zur Zielfigur passt («Der Vater
//                        …» auf der Elternteil-Kante zu einer Frau);
//   foreignName        — die Beschreibung nennt statt des Ziels eine andere
//                        Figur, zu der die Ausgangsfigur dieselbe Beziehung
//                        hat («… Peter sich fügt» auf der Ehe-Kante zu Adrian,
//                        während eine Ehe-Kante zu Peter besteht);
//   foreignTarget      — die Beschreibung nennt statt des Ziels genau eine
//                        andere Figur, zu der die Ausgangsfigur gar keine
//                        Beziehung hat: das Ziel ist verrutscht («Er kennt
//                        Sarahs Mutter …» auf der Kante zu Peter). Rollenfiguren
//                        zählen auch über ihr Kopfwort («Der Nervenarzt …»).
//
// Feiner sperren: `maxParents` und `duplicateDescription` nennen Alternativen
// («einer der beiden Väter ist falsch»). Belegt eine unabhängige Regel genau
// einen Teil davon, fällt nur dieser Teil aus; die übrigen Paare stehen in
// `kept` und bleiben im Set. Gemeldet wird der Konflikt trotzdem.

const { ownBirthYear } = require('../samples/core-facts/words');

const HEDGE = /\b(wahrscheinlich|vermutlich|möglicherweise|vielleicht|unklar|eventuell|anscheinend|probably|possibly|perhaps|unclear|apparently)\b/i;

const FAMILY = new Set(['elternteil', 'kind', 'geschwister', 'ehepartner', 'ex_partner']);
const PARTNERISH = new Set(['geschwister', 'ehepartner', 'ex_partner', 'liebesbeziehung']);
const FRIENDISH = new Set(['freund', 'bekannt']);
const WEAK = new Set(['bekannt', 'andere']);
const MIN_PARENT_GAP = 14;
// Gleichaltrige: Schulfreunde, Clique, Kindheitsfreunde. Nur mit einem solchen
// Wort in der Beschreibung — eine Freundschaft allein sagt nichts übers Alter.
const MAX_PEER_GAP = 5;
const PEER_MARK = /(schul|klasse|mitschüler|kindergarten|kindheit|jugendfreund|spielkamerad|clique|jahrgang|gleichaltrig|altersgenoss|classmate|school|childhood|same age)/i;

// Verwandtschaftswort (ein Token, kleingeschrieben) → Rolle der genannten
// Person gegenüber der anderen.
const KIN_TOKENS = [
  [/^(vater|vaters|väter|vätern|mutter|mütter|müttern|eltern|elternteil|papa|mama|father|fathers|mother|mothers|parent|parents)$/, 'elternteil'],
  [/^(sohn|sohnes|sohns|söhne|söhnen|tochter|töchter|töchtern|son|sons|daughter|daughters)$/, 'kind'],
  [/^(bruder|bruders|brüder|brüdern|schwester|schwestern|brother|brothers|sister|sisters)$/, 'geschwister'],
  [/^(ehemann|ehemanns|ehefrau|gatte|gatten|gattin|husband|wife)$/, 'ehepartner'],
  [/^(schwiegervater|schwiegervaters|schwiegermutter|schwiegereltern|father-in-law|mother-in-law|parents-in-law)$/, 'schwiegerelternteil'],
  [/^(schwiegersohn|schwiegertochter|son-in-law|daughter-in-law)$/, 'schwiegerkind'],
  [/^(schwager|schwagers|schwäger|schwägerin|brother-in-law|sister-in-law)$/, 'schwager'],
  [/^(grossvater|großvater|grossmutter|großmutter|grosseltern|großeltern|opa|oma|grandfather|grandmother|grandparents?)$/, 'grosselternteil'],
  [/^(enkel|enkels|enkelin|enkelkind|enkelkinder|grandson|granddaughter|grandchild|grandchildren)$/, 'enkel'],
  [/^(onkel|tante|uncle|aunt)$/, 'onkel'],
  [/^(neffe|neffen|nichte|nephew|niece)$/, 'neffe'],
];
const kinOf = (tok) => (KIN_TOKENS.find(([re]) => re.test(tok)) || [])[1] || null;

// Geschlecht eines Verwandtschaftsworts (Token aus KIN_TOKENS), sonst null
// («Eltern», «Enkel»). Weiblich zuerst: «schwägerin» beginnt wie «schwäger».
const FEMALE_KIN = /^(mutter|mütter|mama|mother|tochter|töchter|daughter|schwester|sister|ehefrau|gattin|wife|schwiegermutter|schwiegertochter|mother-in-law|daughter-in-law|sister-in-law|schwägerin|grossmutter|großmutter|oma|grandmother|granddaughter|enkelin|tante|aunt|nichte|niece)/;
const MALE_KIN = /^(vater|väter|papa|father|sohn|söhn|son|bruder|brüder|brother|ehemann|gatte|husband|schwiegervater|schwiegersohn|father-in-law|son-in-law|brother-in-law|schwager|schwäger|grossvater|großvater|opa|grandfather|grandson|onkel|uncle|neffe|nephew)/;
const kinGender = (tok) => (FEMALE_KIN.test(tok) ? 'f' : MALE_KIN.test(tok) ? 'm' : null);

// Regeln, deren Treffer ein bestimmtes Paar belasten, und Regeln, die nur
// Alternativen nennen (siehe «Feiner sperren» oben).
const PAIR_EVIDENCE = new Set(['parentIsKin', 'spouseAsymmetric', 'pairConflict', 'familyAndFriend',
  'siblingsNoParent', 'generationGap', 'peerAgeGap', 'textContradiction', 'genderMismatch', 'foreignName', 'foreignTarget']);
const ALTERNATIVES = new Set(['maxParents', 'duplicateDescription']);
const INVERSE_ROLE = { elternteil: 'kind', kind: 'elternteil' };

// Wörter vor einem Verwandtschaftswort, die auf eine ANDERE Person zeigen
// («vom grossen Bruder», «mit seiner Mutter») — anders als «wird Mutter»,
// das die Figur selbst meint.
const OTHER_MARK = new Set(['vom', 'von', 'zum', 'zur', 'dem', 'den', 'der', 'des', 'mit', 'sein', 'seine', 'seinem',
  'seinen', 'seiner', 'seines', 'ihr', 'ihre', 'ihrem', 'ihren', 'ihrer', 'ihres', 'his', 'her', 'their', 'the']);

const tokenize = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
const splitSentences = (s) => String(s || '').split(/(?<=[.!?;])\s+/).map(x => x.trim()).filter(Boolean);
const pairKey = (a, b) => [a, b].sort().join('|');
const wordRe = (name) => new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');

// Geburtsjahr: eigenes Geburts-Ereignis, sonst das Jahr im Steckbrief-Feld
// `geburtstag` («1964», «12. Mai 1964»). Ohne den Steckbrief blieben Figuren ohne
// Geburts-Ereignis aus beiden Altersregeln heraus, obwohl die Alters-Tabelle mit
// genau diesem Jahr rechnet.
const birthYearOf = (f, eventsByFigPk) => {
  const ev = ownBirthYear(f, eventsByFigPk, { sure: false });
  if (ev) return ev;
  const m = String(f?.geburtstag || '').match(/(?<!\d)(\d{4})(?!\d)/);
  return m ? Number(m[1]) : null;
};

function genderOf(f) {
  const g = String(f?.geschlecht || '').trim().toLowerCase();
  if (/plural|gruppe|familie|\//.test(g)) return 'n';
  if (/^(männlich|maennlich|male)\b/.test(g)) return 'm';
  if (/^(weiblich|female)\b/.test(g)) return 'f';
  return 'n';
}

// Namensformen je Figur als Tokens («stefan», «stefans»). Ein Token, das
// mehrere Figuren tragen, zählt für keine.
function nameForms(figRows) {
  const owners = new Map();
  for (const f of figRows) {
    for (const n of [f.name, f.kurzname]) {
      for (const w of String(n || '').replace(/\([^)]*\)/g, ' ').split(/\s+/)) {
        if (w.length < 3 || !/^\p{Lu}/u.test(w)) continue;
        const base = w.toLowerCase();
        for (const form of [base, base + 's', base + "'s", base + "'"]) {
          if (!owners.has(form)) owners.set(form, new Set());
          owners.get(form).add(f.fig_id);
        }
      }
    }
  }
  const out = new Map();
  for (const [form, ids] of owners) if (ids.size === 1) out.set(form, [...ids][0]);
  return out;
}

// Beziehungen als Aussagen: `to` hat gegenüber `from` die Rolle `typ`.
function statementsOf(ctx) {
  const { figRelRows = [], figById, relTypes } = ctx;
  const out = [];
  for (const r of figRelRows) {
    const A = figById.get(r.from_fig_id), B = figById.get(r.to_fig_id);
    if (!A || !B || A.fig_id === B.fig_id) continue;
    const typ = relTypes ? relTypes.normalizeRelationTyp(r.typ).typ : String(r.typ || '').trim().toLowerCase();
    out.push({ from: A.fig_id, to: B.fig_id, typ, relId: r.rel_id ?? null, desc: String(r.beschreibung || '').trim() });
  }
  return out;
}

function buildGraph(stmts) {
  const parents = new Map(), spouses = new Map(), sibs = new Map();
  const parentSrc = new Map(); // child|parent → [stmt]
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const s of stmts) {
    if (s.typ === 'elternteil' || s.typ === 'kind') {
      const [child, parent] = s.typ === 'elternteil' ? [s.from, s.to] : [s.to, s.from];
      add(parents, child, parent);
      const k = child + '|' + parent;
      if (!parentSrc.has(k)) parentSrc.set(k, []);
      parentSrc.get(k).push(s);
    } else if (s.typ === 'ehepartner' || s.typ === 'ex_partner') {
      add(spouses, s.from, s.to); add(spouses, s.to, s.from);
    } else if (s.typ === 'geschwister') {
      add(sibs, s.from, s.to); add(sibs, s.to, s.from);
    }
  }
  const children = new Map();
  for (const [c, ps] of parents) for (const p of ps) add(children, p, c);
  const get = (m, x) => m.get(x) || new Set();
  const siblingsOf = (x) => {
    const out = new Set(get(sibs, x));
    for (const p of get(parents, x)) for (const c of get(children, p)) if (c !== x) out.add(c);
    return out;
  };
  // Rollen von y gegenüber x, wie sie aus dem Graphen folgen.
  const labels = (x, y) => {
    const L = new Set();
    const any = (set, fn) => [...set].some(fn);
    if (get(parents, x).has(y)) L.add('elternteil');
    if (get(children, x).has(y)) L.add('kind');
    if (siblingsOf(x).has(y)) L.add('geschwister');
    if (get(spouses, x).has(y)) L.add('ehepartner');
    if (any(get(spouses, x), s => get(parents, s).has(y))) L.add('schwiegerelternteil');
    if (any(get(children, x), c => get(spouses, c).has(y))) L.add('schwiegerkind');
    if (any(get(spouses, x), s => siblingsOf(s).has(y)) || any(siblingsOf(x), b => get(spouses, b).has(y))) L.add('schwager');
    if (any(get(parents, x), p => get(parents, p).has(y))) L.add('grosselternteil');
    if (any(get(children, x), c => get(children, c).has(y))) L.add('enkel');
    if (any(get(parents, x), p => siblingsOf(p).has(y))) L.add('onkel');
    if (any(siblingsOf(x), b => get(children, b).has(y))) L.add('neffe');
    return L;
  };
  return { parents, children, spouses, parentSrc, siblingsOf, labels, get };
}

function checkRelations(ctx) {
  const { figRows = [], figById, eventsByFigPk } = ctx;
  const tierOf = (id) => ctx.tierByFig?.get(id) || 'minor';
  const nameOf = (id) => ctx.figNameInfo?.get(id)?.name || figById.get(id)?.name || id;
  const stmts = statementsOf(ctx);
  const G = buildGraph(stmts);
  const forms = nameForms(figRows);
  const conflicts = [];
  const seen = new Set();
  // Quelle → lesbare Angabe für die Konfliktliste (Namen statt IDs):
  // { kind: 'relation', from, to, typ } · { kind: 'event', fig, title } · { kind: 'bio', fig, field }.
  const relByKey = new Map(stmts.map(s => [s.relId != null ? String(s.relId) : `${s.from}>${s.to}`, s]));
  const eventById = new Map();
  for (const f of figRows) {
    for (const e of eventsByFigPk?.get(f.pk) || []) if (e.id != null) eventById.set(String(e.id), { e, fig: f.fig_id });
  }
  const refOf = (src) => {
    const [kind, rest = ''] = [src.slice(0, src.indexOf(':')), src.slice(src.indexOf(':') + 1)];
    if (kind === 'relation') {
      const s = relByKey.get(rest);
      return s ? { kind, from: nameOf(s.from), to: nameOf(s.to), typ: s.typ } : null;
    }
    if (kind === 'event') {
      const hit = eventById.get(rest);
      if (hit) return { kind, fig: nameOf(hit.fig), title: String(hit.e.ereignis || '').trim() };
      const m = rest.match(/^([^:]+):(.*)$/);
      return m ? { kind, fig: nameOf(m[1]), title: m[2].trim() } : null;
    }
    if (kind === 'bio') {
      const dot = rest.lastIndexOf('.');
      return dot > 0 ? { kind, fig: nameOf(rest.slice(0, dot)), field: rest.slice(dot + 1) } : null;
    }
    return null;
  };
  // `extra`: regelspezifische Zusätze, etwa `retarget` ({ relId, to }: vorgeschlagenes
  // neues Ziel einer verrutschten Kante, fig_id) für den Umhängen-Knopf der Karte.
  const report = (rule, figIds, sources, snippet, pairs, extra = {}) => {
    const ids = [...new Set(figIds)];
    const key = rule + '|' + [...ids].sort().join(',') + '|' + [...sources].sort().join(',');
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push({
      rule, figIds: ids, figures: ids.map(nameOf),
      sources: [...new Set(sources)],
      refs: [...new Set(sources)].map(refOf).filter(Boolean),
      snippet: String(snippet || '').slice(0, 240),
      pairs: [...new Set(pairs.map(([a, b]) => pairKey(a, b)))],
      main: ids.some(id => tierOf(id) === 'main'),
      ...extra,
    });
  };
  const relSrc = (s) => (s.relId != null ? `relation:${s.relId}` : `relation:${s.from}>${s.to}`);
  const byPair = new Map();
  for (const s of stmts) {
    const k = pairKey(s.from, s.to);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(s);
  }

  // ── Eltern ────────────────────────────────────────────────────────────
  for (const [child, ps] of G.parents) {
    const list = [...ps];
    const byGender = { m: [], f: [], n: [] };
    for (const p of list) byGender[genderOf(figById.get(p))].push(p);
    const clash = [byGender.m, byGender.f].filter(g => g.length > 1);
    // Ohne Geschlecht lässt sich nur «mehr als zwei Eltern» erkennen.
    if (!clash.length && byGender.n.length && list.length > 2) clash.push(list);
    for (const group of clash) {
      const src = group.flatMap(p => G.parentSrc.get(child + '|' + p) || []);
      const pairs = group.map(p => [child, p]);
      const spouseSrc = [];
      // Die übrigen Eltern, die mit mehreren der konkurrierenden verheiratet sind.
      for (const other of list.filter(p => !group.includes(p))) {
        const married = group.filter(p => G.get(G.spouses, other).has(p));
        if (married.length < 2) continue;
        for (const p of married) {
          pairs.push([other, p]);
          spouseSrc.push(...(byPair.get(pairKey(other, p)) || []).filter(s => s.typ === 'ehepartner' || s.typ === 'ex_partner'));
        }
      }
      report('maxParents', [child, ...group, ...spouseSrc.flatMap(s => [s.from, s.to])],
        [...src, ...spouseSrc].map(relSrc), src.map(s => s.desc).filter(Boolean)[0] || '', pairs);
    }
    for (const p of list) {
      const kin = (byPair.get(pairKey(child, p)) || []).filter(s => PARTNERISH.has(s.typ));
      if (kin.length) {
        report('parentIsKin', [child, p], [...(G.parentSrc.get(child + '|' + p) || []), ...kin].map(relSrc),
          kin[0].desc, [[child, p]]);
      }
    }
    // Generationenabstand
    const cy = birthYearOf(figById.get(child) || {}, eventsByFigPk);
    for (const p of list) {
      const py = birthYearOf(figById.get(p) || {}, eventsByFigPk);
      if (cy && py && cy - py < MIN_PARENT_GAP) {
        report('generationGap', [child, p], (G.parentSrc.get(child + '|' + p) || []).map(relSrc),
          `${nameOf(p)} *${py}, ${nameOf(child)} *${cy}`, [[child, p]]);
      }
    }
  }

  // ── Gleichaltrige Freunde ───────────────────────────────────────────
  for (const s of stmts) {
    if (s.typ !== 'freund' || !PEER_MARK.test(s.desc)) continue;
    const ay = birthYearOf(figById.get(s.from) || {}, eventsByFigPk);
    const by = birthYearOf(figById.get(s.to) || {}, eventsByFigPk);
    if (ay && by && Math.abs(ay - by) > MAX_PEER_GAP) {
      report('peerAgeGap', [s.from, s.to], [relSrc(s)],
        `${nameOf(s.from)} *${ay}, ${nameOf(s.to)} *${by}: ${s.desc}`, [[s.from, s.to]]);
    }
  }

  // ── Paare mit mehreren Aussagen ─────────────────────────────────────
  for (const [k, ss] of byPair) {
    const types = [...new Set(ss.map(s => (s.typ === 'kind' || s.typ === 'elternteil' ? 'eltern-kind' : s.typ)))];
    const strong = types.filter(t => !WEAK.has(t));
    const [a, b] = k.split('|');
    const fam = strong.filter(t => t === 'eltern-kind' || FAMILY.has(t));
    if (fam.length && types.some(t => FRIENDISH.has(t))) {
      report('familyAndFriend', [a, b], ss.map(relSrc), ss.find(s => FRIENDISH.has(s.typ))?.desc, [[a, b]]);
      continue;
    }
    // Gerichtete Aussagen in beiden Richtungen («A Elternteil von B» und «B
    // Elternteil von A») sind ebenfalls unvereinbar.
    const dirs = new Set(ss.filter(s => s.typ === 'elternteil' || s.typ === 'kind')
      .map(s => (s.typ === 'elternteil' ? s.to + '>' + s.from : s.from + '>' + s.to)));
    if (strong.length > 1 || dirs.size > 1) {
      report(strong.includes('ehepartner') ? 'spouseAsymmetric' : 'pairConflict', [a, b], ss.map(relSrc),
        ss.map(s => s.desc).filter(Boolean)[0] || '', [[a, b]]);
    }
  }

  // ── Geschwister ohne gemeinsames Elternteil ─────────────────────────
  for (const s of stmts.filter(x => x.typ === 'geschwister')) {
    const pa = G.get(G.parents, s.from), pb = G.get(G.parents, s.to);
    if (pa.size && pb.size && ![...pa].some(p => pb.has(p))) {
      report('siblingsNoParent', [s.from, s.to, ...pa, ...pb], [relSrc(s)], s.desc, [[s.from, s.to]]);
    }
  }

  // ── Kopierte Beschreibung ────────────────────────────────────────────
  const byDesc = new Map();
  for (const s of stmts) {
    const d = s.desc.toLowerCase().replace(/\s+/g, ' ');
    if (d.length < 30 || s.typ === 'andere') continue;
    const k = s.typ + '|' + d;
    if (!byDesc.has(k)) byDesc.set(k, []);
    byDesc.get(k).push(s);
  }
  for (const ss of byDesc.values()) {
    if (ss.length < 2) continue;
    for (let i = 0; i < ss.length; i++) {
      for (let j = i + 1; j < ss.length; j++) {
        const [x, y] = [ss[i], ss[j]];
        const shared = [x.from, x.to].filter(id => id === y.from || id === y.to);
        if (shared.length !== 1) continue;
        report('duplicateDescription', [x.from, x.to, y.from, y.to], [relSrc(x), relSrc(y)], x.desc,
          [[x.from, x.to], [y.from, y.to]]);
      }
    }
  }

  // ── Verwandtschaftswörter in den Texten ─────────────────────────────
  // `x`: Figur, deren Text es ist; `others`: genannte Figuren; `labels`:
  // gefundene Rollen. Widerspruch, wenn der Graph für jede genannte Figur
  // eine Verwandtschaft kennt, aber keine davon zum Wort passt.
  // `kinLabels`: Rolle → Geschlechter der Wörter (null = ohne Geschlecht, «Eltern»).
  // Belastet werden nur genannte Figuren, deren Geschlecht zum Wort passt: «zwischen
  // den Brüdern» meint nicht die Ehefrau, die im selben Ereignis steht.
  const checkText = (x, others, kinLabels, source, snippet) => {
    if (!kinLabels.size || !others.length || others.length > 3) return;
    const known = others.map(y => ({ y, L: new Set([...G.labels(x, y), ...G.labels(y, x)]) })).filter(o => o.L.size);
    if (!known.length) return;
    for (const [lab, genders] of kinLabels) {
      if (known.some(o => o.L.has(lab))) continue;
      const fits = known.filter(o => {
        const g = genderOf(figById.get(o.y));
        return g === 'n' || genders.has(null) || genders.has(g);
      });
      if (!fits.length) continue;
      const pairs = fits.map(o => [x, o.y]);
      const relSources = fits.flatMap(o => (byPair.get(pairKey(x, o.y)) || []).map(relSrc));
      report('textContradiction', [x, ...fits.map(o => o.y)], [source, ...relSources], snippet, pairs);
    }
  };
  const addKin = (labs, tok) => {
    const lab = kinOf(tok);
    if (!labs.has(lab)) labs.set(lab, new Set());
    labs.get(lab).add(kinGender(tok));
  };
  const mentioned = (toks, exclude) => [...new Set(toks.map(t => forms.get(t)).filter(id => id && !exclude.includes(id)))];
  const kinAt = (toks, i) => kinOf(toks[i]);
  // Strenger als `mentioned`: nur ganzer Name (ohne Klammerzusatz) oder Kurzname,
  // den keine zweite Figur trägt — ein Namensteil wie «Bifang» aus «Deutschlehrerin
  // am Bifang» ist meist ein Ort.
  const fullNames = new Map();
  for (const f of figRows) {
    for (const n of new Set([f.name, f.kurzname].map(x => String(x || '').replace(/\([^)]*\)/g, ' ').trim()))) {
      if (n.length < 3) continue;
      const k = n.toLowerCase();
      fullNames.set(k, fullNames.has(k) && fullNames.get(k).id !== f.fig_id ? { id: null } : { id: f.fig_id, re: wordRe(n) });
    }
  }
  const namedIn = (text) => [...new Set([...fullNames.values()].filter(e => e.id && e.re.test(text)).map(e => e.id))];
  // Kopfwort einer Rollenfigur («Nervenarzt an der Musterung in Brugg» → «Nervenarzt»):
  // erstes Wort eines mehrteiligen Namens, ab sechs Zeichen und nur bei einer Figur,
  // im Text mit bestimmtem Artikel («Der Nervenarzt …») — ohne Artikel ist es meist
  // das Gattungswort («besuchen Prostituierte»). Kurze Anreden («Herr», «Alte») und
  // geteilte Rollen («Deutschlehrerin am Bifang» / «… der Kantonsschule») zählen nicht.
  const heads = new Map();
  for (const f of figRows) {
    const words = String(f.name || '').replace(/\([^)]*\)/g, ' ').trim().split(/\s+/);
    if (words.length < 2 || words[0].length < 6 || !/^\p{Lu}/u.test(words[0])) continue;
    const k = words[0].toLowerCase();
    const esc = words[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:[Dd](?:er|ie|as|em|en|es))\\s+${esc}(?![\\p{L}\\p{N}])`, 'u');
    heads.set(k, heads.has(k) && heads.get(k).id !== f.fig_id ? { id: null } : { id: f.fig_id, re });
  }
  const headsIn = (text) => [...new Set([...heads.values()].filter(e => e.id && e.re.test(text)).map(e => e.id))];
  // Ganzer Name in seiner Schreibung (`possessive`: auch «Renates»): «nicht ernst
  // nimmt» nennt Ernst nicht. Ein Kurzname, der nur das Kopfwort einer Rollenfigur
  // ist («Prostituierte» zu «Prostituierte von der Haslistrasse»), zählt hier nicht —
  // für ihn gilt headsIn mit Artikel.
  const namedExactly = (id, text, { possessive = false } = {}) => {
    const f = figById.get(id);
    if (!f) return false;
    const full = String(f.name || '').replace(/\([^)]*\)/g, ' ').trim();
    const words = full.split(/\s+/);
    return [...new Set([full, String(f.kurzname || '').trim()])].some(n => {
      if (n.length < 3) return false;
      if (words.length >= 2 && !n.includes(' ') && n === words[0] && n !== full) return false;
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const suffix = possessive ? "(?:s|'s|')?" : '';
      return new RegExp(`(?<![\\p{L}\\p{N}])${esc}${suffix}(?![\\p{L}\\p{N}])`, 'u').test(text);
    });
  };

  // Beziehungsbeschreibung: das Paar steht fest; nur ohne weitere genannte Figur.
  for (const s of stmts) {
    if (!s.desc || HEDGE.test(s.desc)) continue;
    const toks = tokenize(s.desc);
    if (mentioned(toks, [s.from, s.to]).length) continue;
    const labs = new Set(toks.map(kinOf).filter(Boolean));
    if (!labs.size) continue;
    const L = new Set([...G.labels(s.from, s.to), ...G.labels(s.to, s.from)]);
    if (!L.size) continue;
    for (const lab of labs) {
      if (L.has(lab)) continue;
      report('textContradiction', [s.from, s.to], [relSrc(s)], s.desc, [[s.from, s.to]]);
    }
  }

  // Rolle, die `s` der Figur gegenüber `owner` gibt (die andere Seite des Paars).
  const roleToward = (s, owner) => (s.from === owner ? s.typ : (INVERSE_ROLE[s.typ] || s.typ));
  for (const s of stmts) {
    if (!s.desc || HEDGE.test(s.desc)) continue;
    const toks = tokenize(s.desc);

    // Geschlecht des Rollenworts gegen das Ziel. Ein Wort direkt bei einer dritten
    // Figur («Manfreds Vater») meint deren Verwandten und zählt nicht.
    const target = genderOf(figById.get(s.to));
    if (target !== 'n') {
      const genders = new Set();
      toks.forEach((t, i) => {
        const g = kinGender(t);
        if (!g || kinOf(t) !== s.typ) return;
        for (let j = Math.max(0, i - 2); j <= Math.min(toks.length - 1, i + 2); j++) {
          const id = forms.get(toks[j]);
          if (id && id !== s.from && id !== s.to) return;
        }
        genders.add(g);
      });
      if (genders.size === 1 && !genders.has(target)) {
        report('genderMismatch', [s.from, s.to], [relSrc(s)], s.desc, [[s.from, s.to]]);
      }
    }

    // Fremder Name: die Beschreibung nennt das Ziel nicht, wohl aber genau eine
    // andere Figur — mit ganzem Namen, sonst über das Kopfwort einer Rollenfigur.
    // Hat die Ausgangsfigur zu ihr dieselbe Beziehung, ist die Kante eine Kopie
    // (foreignName); hat sie zu ihr gar keine, ist das Ziel verrutscht (foreignTarget).
    const named = namedIn(s.desc);
    const headed = headsIn(s.desc);
    if (named.includes(s.to) || headed.includes(s.to) || mentioned(toks, []).includes(s.to)
      || namedExactly(s.to, s.desc, { possessive: true })) continue;
    let others = named.filter(id => id !== s.to && id !== s.from);
    if (!others.length) others = headed.filter(id => id !== s.to && id !== s.from);
    if (others.length !== 1) continue;
    const role = roleToward(s, s.from);
    const pairRels = byPair.get(pairKey(s.from, others[0])) || [];
    const twin = pairRels.filter(x => roleToward(x, s.from) === role);
    if (twin.length) {
      report('foreignName', [s.from, s.to, others[0]], [relSrc(s), ...twin.map(relSrc)], s.desc, [[s.from, s.to]]);
    } else if (!pairRels.length && (headed.includes(others[0]) || namedExactly(others[0], s.desc))) {
      report('foreignTarget', [s.from, s.to, others[0]], [relSrc(s)], s.desc, [[s.from, s.to]],
        s.relId != null ? { retarget: { relId: s.relId, to: others[0], toName: nameOf(others[0]) } } : {});
    }
  }

  for (const f of figRows) {
    // Ereignisse der Figur: Verwandtschaftswort mit Verweis auf eine andere
    // Person («vom grossen Bruder»), genannte Figuren aus Titel und Bedeutung.
    for (const e of eventsByFigPk?.get(f.pk) || []) {
      const text = `${e.ereignis || ''} ${e.bedeutung || ''}`;
      if (HEDGE.test(text)) continue;
      const toks = tokenize(text);
      const labs = new Map();
      toks.forEach((t, i) => {
        if (kinAt(toks, i) && [toks[i - 1], toks[i - 2]].some(w => OTHER_MARK.has(w))) addKin(labs, t);
      });
      checkText(f.fig_id, mentioned(toks, [f.fig_id]), labs,
        e.id != null ? `event:${e.id}` : `event:${f.fig_id}:${e.ereignis}`, text.trim());
    }
    // Biografie: Satz für Satz, Verwandtschaftswort direkt bei einem Namen
    // («Stefans Bruder», «seinem Bruder Stefan»).
    for (const field of ['beschreibung', 'hintergrund']) {
      for (const sent of splitSentences(f[field])) {
        if (HEDGE.test(sent)) continue;
        const toks = tokenize(sent);
        const labs = new Map();
        const near = new Set();
        toks.forEach((t, i) => {
          if (!kinOf(t)) return;
          for (let j = Math.max(0, i - 3); j <= Math.min(toks.length - 1, i + 2); j++) {
            const id = forms.get(toks[j]);
            if (id && id !== f.fig_id) { near.add(id); addKin(labs, t); }
          }
        });
        checkText(f.fig_id, [...near], labs, `bio:${f.fig_id}.${field}`, sent);
      }
    }
  }

  // ── Feiner sperren ───────────────────────────────────────────────────
  const evidence = new Set(conflicts.filter(c => PAIR_EVIDENCE.has(c.rule)).flatMap(c => c.pairs));
  for (const c of conflicts) {
    if (!ALTERNATIVES.has(c.rule)) continue;
    const suspect = c.pairs.filter(p => evidence.has(p));
    if (!suspect.length || suspect.length === c.pairs.length) continue;
    c.kept = c.pairs.filter(p => !evidence.has(p)).map(p => p.split('|').map(nameOf));
    c.pairs = suspect;
  }

  const pairs = new Set(conflicts.flatMap(c => c.pairs));
  return { conflicts, pairs, mainCount: conflicts.filter(c => c.main).length };
}

module.exports = { checkRelations, buildGraph, statementsOf, KIN_TOKENS, kinOf, pairKey };
