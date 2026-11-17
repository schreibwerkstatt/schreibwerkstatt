'use strict';
// Facetten des Tagebuch-Rückblicks (Themen, Personen, Orte): Namen normalisieren,
// Schreibvarianten zusammenführen, Belege per Textsuche ergänzen und der Verlauf
// über die Monate. Pure (kein DB-/AI-State) — SSoT für Job, Belegprüfung und die
// Verlauf-Route; Zählen und Zusammenführen gehören in den Code, nicht ins Modell.
//
// Personen/Orte tragen `name` (kanonisch) + `aliase` (Schreibweisen im Text).
// Themen tragen `label`; dort gibt es keine Textsuche (ein Thema steht nicht
// wörtlich im Text).

// Höchstzahl Themen je Rückblick (Prompt nennt dieselbe Zahl). Personen/Orte
// bleiben vollständig — die Karte klappt Einzelnennungen ein.
const THEMEN_MAX = 8;
// Kürzere Suchbegriffe träfen zu viel (Silben, Abkürzungen) — sie zählen nur
// über die Belege des Modells.
const MIN_TERM_LEN = 3;

const _str = (v) => String(v == null ? '' : v).trim();
const _key = (s) => _str(s).toLocaleLowerCase('de');

// «Name (Zusatz)» → { name, zusatz }; «Basel / Basel-Stadt» → Name + Alias.
// Der Klammer-Zusatz ist Anzeige (Rolle, Nachname, Art des Orts) und wird NICHT
// gesucht: ein Zusatz wie «Bar» träfe jedes Vorkommen des Worts.
function splitName(raw) {
  let name = _str(raw);
  let zusatz = '';
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(name);
  if (m && _str(m[1])) { name = _str(m[1]); zusatz = _str(m[2]); }
  const parts = name.split(/\s+\/\s+/).map(_str).filter(Boolean);
  return { name: parts[0] || name, slashAliase: parts.slice(1), zusatz };
}

// Normalisiert eine Personen-/Orts-Nennung: Name ohne Klammer, Aliase als
// eindeutige Liste ohne den Namen selbst.
function normalizeNennung(item, key = 'name') {
  const { name, slashAliase, zusatz } = splitName(item?.[key]);
  const seen = new Set([_key(name)]);
  const aliase = [];
  for (const a of [...slashAliase, ...(Array.isArray(item?.aliase) ? item.aliase : [])]) {
    const s = splitName(a).name;
    const k = _key(s);
    if (!s || seen.has(k)) continue;
    seen.add(k);
    aliase.push(s);
  }
  const out = { ...item, [key]: name, aliase };
  const z = [_str(item?.zusatz), zusatz].filter(Boolean)[0];
  if (z) out.zusatz = z; else delete out.zusatz;
  return out;
}

const _keysOf = (item, key) => [item[key], ...(item.aliase || [])].map(_key).filter(Boolean);

// Führt Nennungen zusammen, die einen Namen oder Alias teilen (case-insensitiv):
// Belege und Aliase werden vereinigt, der Name des ersten Treffers bleibt
// kanonisch. Union-Find über die Schlüssel, damit auch Ketten (A~B, B~C)
// verschmelzen. Reihenfolge der Eingabe bleibt erhalten.
function mergeNennungen(items, key = 'name') {
  const recs = [];
  const byKey = new Map();
  const find = (r) => { while (r.into) r = r.into; return r; };
  for (const raw of items || []) {
    const item = key === 'label' ? { ...raw, label: _str(raw?.label) } : normalizeNennung(raw, key);
    if (!item[key]) continue;
    const keys = key === 'label' ? [_key(item.label)] : _keysOf(item, key);
    const hits = [...new Set(keys.map(k => byKey.get(k)).filter(Boolean).map(find))];
    let rec = hits[0];
    if (!rec) {
      rec = { item: { ...item, aliase: key === 'label' ? undefined : [...(item.aliase || [])] }, belege: new Set() };
      recs.push(rec);
    } else {
      for (const other of hits.slice(1)) {
        other.into = rec;
        for (const b of other.belege) rec.belege.add(b);
        if (key !== 'label') rec.item.aliase.push(other.item[key], ...other.item.aliase);
        if (!rec.item.zusatz && other.item.zusatz) rec.item.zusatz = other.item.zusatz;
      }
      if (key !== 'label' && _key(item[key]) !== _key(rec.item[key])) rec.item.aliase.push(item[key]);
      if (key !== 'label') rec.item.aliase.push(...(item.aliase || []));
      if (!rec.item.zusatz && item.zusatz) rec.item.zusatz = item.zusatz;
    }
    for (const b of (Array.isArray(item.belege) ? item.belege : [])) rec.belege.add(_str(b));
    for (const k of keys) byKey.set(k, rec);
  }
  return recs.filter(r => !r.into).map(({ item, belege }) => {
    const out = { ...item, belege: [...belege].filter(Boolean) };
    if (key === 'label') delete out.aliase;
    else {
      // Erste Schreibweise je Schlüssel gewinnt.
      const seen = new Map();
      for (const a of item.aliase) if (_key(a) !== _key(item[key]) && !seen.has(_key(a))) seen.set(_key(a), a);
      out.aliase = [...seen.values()];
    }
    return out;
  });
}

function _escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Regex für einen Namen: ganzes Wort, Gross-/Kleinschreibung wie geschrieben
// (Namen sind Eigennamen — «Frank» soll nicht «frank und frei» treffen),
// Genitiv-s und Apostroph erlaubt.
function _termRe(term) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${_escRe(term)}(?:s|'s|’s|')?(?![\\p{L}\\p{N}])`, 'u');
}

// Tage, an denen einer der Begriffe im Eintragstext vorkommt.
function findTermDays(terms, entries) {
  const res = (terms || []).map(_str).filter(t => [...t].length >= MIN_TERM_LEN).map(_termRe);
  const days = new Set();
  if (!res.length) return days;
  for (const e of entries || []) {
    if (!e?.datum || typeof e.text !== 'string') continue;
    if (res.some(re => re.test(e.text))) days.add(e.datum);
  }
  return days;
}

// Deterministisch zusammengeführte Facetten der Teilrückblicke (Map-Reduce).
// `haeufigkeit` = Zahl der eindeutigen Belegtage; die Belegprüfung zieht später
// noch die Textsuche nach.
function mergeRueckblickFacets(partResults) {
  const all = (k) => (partResults || []).flatMap(p => (Array.isArray(p?.[k]) ? p[k] : []));
  const fin = (arr, key) => arr
    .map(x => {
      const belege = [...new Set(x.belege.map(b => _str(b).slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
      return { ...x, haeufigkeit: belege.length, belege };
    })
    .sort((a, b) => b.haeufigkeit - a.haeufigkeit);
  return {
    themen: fin(mergeNennungen(all('themen'), 'label'), 'label'),
    personen: fin(mergeNennungen(all('personen'), 'name'), 'name'),
    orte: fin(mergeNennungen(all('orte'), 'name'), 'name'),
  };
}

// Verlauf über die Monate: je Facette die über alle Monats-Rückblicke
// zusammengeführten Einträge mit Belegzahl pro Monat. `rows`: jüngster Rückblick
// je Monat { id, zeitraum, entry_count, result }. Themen verschmelzen nur bei
// gleichem Label (der Prompt übernimmt fortgesetzte Labels aus dem Vormonat).
// Zusammengeführt wird vom jüngsten Monat rückwärts: der Name des jüngsten
// Rückblicks wird kanonisch (aktueller Sprachgebrauch), ältere werden Aliase.
function buildRueckblickVerlauf(rows) {
  const months = (rows || [])
    .filter(r => /^\d{4}-\d{2}$/.test(String(r?.zeitraum || '')) && r.result)
    .sort((a, b) => a.zeitraum.localeCompare(b.zeitraum));
  const facet = (arrKey, key) => {
    const tagged = [...months].reverse().flatMap(m => (Array.isArray(m.result[arrKey]) ? m.result[arrKey] : [])
      .map(it => ({ ...it, belege: (it.belege || []).map(b => `${m.zeitraum}|${_str(b).slice(0, 10)}`) })));
    return mergeNennungen(tagged, key)
      .map(it => {
        const perMonth = {};
        for (const b of it.belege) {
          const [z] = b.split('|');
          perMonth[z] = (perMonth[z] || 0) + 1;
        }
        const out = { name: it[key], perMonth, total: it.belege.length, months: Object.keys(perMonth).length };
        if (key !== 'label') out.aliase = it.aliase;
        return out;
      })
      .filter(it => it.total > 0)
      .sort((a, b) => b.months - a.months || b.total - a.total || a.name.localeCompare(b.name));
  };
  return {
    months: months.map(m => ({ zeitraum: m.zeitraum, id: m.id, entries: m.entry_count || 0 })),
    themen: facet('themen', 'label'),
    personen: facet('personen', 'name'),
    orte: facet('orte', 'name'),
  };
}

module.exports = {
  THEMEN_MAX, MIN_TERM_LEN,
  splitName, normalizeNennung, mergeNennungen, findTermDays,
  mergeRueckblickFacets, buildRueckblickVerlauf,
};
