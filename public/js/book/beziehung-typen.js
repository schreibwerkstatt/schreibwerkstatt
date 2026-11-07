// Beziehungstypen zwischen Figuren (`figure_relations.typ`) — SSoT für die
// Komplettanalyse-Prompts und -Schemas, den Figurengraph (graph/constants.js) und
// die Bereinigung der KI-Ausgabe vor dem Speichern (Server über lib/esm-bridge.js).
// Ein neuer Typ braucht ausserdem Styling in graph/constants.js (`BZ`, `BZ_SOZIO_CAT`,
// ggf. `DIRECTED_TYPES`), einen Nähe-Standard (`NAEHE_DEFAULT_BY_TYP` unten), ein
// Rollenwort für den Finetune-Export (`ROLE_DE`/`ROLE_EN` in
// routes/jobs/finetune-export/samples/core-facts/words.js) und `figuren.bz.<typ>` in
// beiden Locales.

// Reihenfolge ist Prompt-Text: sie landet als «a|b|c»-Liste im Schema-Beispiel.
export const RELATION_TYPES = [
  'elternteil', 'geschwister', 'kind', 'verwandt', 'freund', 'feind', 'kollege', 'bekannt',
  'liebesbeziehung', 'ehepartner', 'ex_partner', 'rivale', 'mentor', 'schuetzling',
  'patronage', 'geschaeft', 'verbuendete', 'komplize', 'vorgesetzter', 'untergebener', 'andere',
];

// Typen mit Richtung (die Rolle von «zu» gegenüber «von»).
const DIRECTED = new Set(['elternteil', 'kind', 'mentor', 'schuetzling', 'patronage', 'vorgesetzter', 'untergebener']);

// Gegenläufige Paare: «A –elternteil→ B» und «B –kind→ A» sind dieselbe Aussage, nur
// aus der anderen Perspektive. Kanonisch ist die Form, deren «von» die übergeordnete
// Seite ist (Elternteil, Mentor, Vorgesetzter) — ihr Typ beschreibt die Rolle von «zu».
const CANONICAL_INVERSE = { elternteil: 'kind', mentor: 'schuetzling', vorgesetzter: 'untergebener' };

/** Gegenläufige Typen in beide Richtungen (A elternteil B ≡ B kind A). SSoT; der
 *  synchrone CJS-Spiegel in db/figures/refs.js (`RELATION_INVERSES`, für relationKey
 *  im Write-Pfad) ist durch tests/unit/beziehung-typen.test.mjs daran gebunden. */
export const RELATION_INVERSES = Object.fromEntries(Object.entries(CANONICAL_INVERSE)
  .flatMap(([a, b]) => [[a, b], [b, a]]));

/** Bringt eine gerichtete Beziehung in ihre kanonische Form, damit beide Perspektiven
 *  derselben Aussage zusammenfallen. `flipped`: von/zu wurden getauscht (Werte, die
 *  sich auf die Richtung beziehen — etwa ein Machtverhältnis —, kehren ihr Vorzeichen). */
export function canonicalRelation(from, to, typ) {
  const inverse = CANONICAL_INVERSE[typ];
  return inverse
    ? { from: to, to: from, typ: inverse, flipped: true }
    : { from, to, typ, flipped: false };
}

// Varianten, die Modelle statt des Listenwerts schreiben. Nur eindeutige Fälle — die
// Rolle von «zu» bleibt erhalten («vater» ⇒ «zu» ist Elternteil). Entferntere
// Verwandtschaft (Tante, Onkel, Cousin, Grosseltern, Schwager, Schwiegereltern) ist
// «verwandt», ungerichtet; das genaue Wort bleibt in der Beschreibung.
const SYNONYMS = {
  verwandte: 'verwandt', verwandter: 'verwandt', verwandtschaft: 'verwandt',
  tante: 'verwandt', onkel: 'verwandt', cousin: 'verwandt', cousine: 'verwandt',
  neffe: 'verwandt', nichte: 'verwandt', enkel: 'verwandt', enkelin: 'verwandt',
  grossvater: 'verwandt', grossmutter: 'verwandt', grosseltern: 'verwandt', opa: 'verwandt', oma: 'verwandt',
  schwager: 'verwandt', schwaegerin: 'verwandt',
  schwiegervater: 'verwandt', schwiegermutter: 'verwandt', schwiegereltern: 'verwandt',
  schwiegersohn: 'verwandt', schwiegertochter: 'verwandt',
  vater: 'elternteil', mutter: 'elternteil', eltern: 'elternteil',
  sohn: 'kind', tochter: 'kind',
  bruder: 'geschwister', schwester: 'geschwister',
  freundin: 'freund', feindin: 'feind', kollegin: 'kollege',
  bekannte: 'bekannt', bekannter: 'bekannt', bekanntschaft: 'bekannt',
  liebe: 'liebesbeziehung', geliebte: 'liebesbeziehung', geliebter: 'liebesbeziehung', affaere: 'liebesbeziehung',
  ehe: 'ehepartner', ehefrau: 'ehepartner', ehemann: 'ehepartner', ehepartnerin: 'ehepartner',
  ex: 'ex_partner', ex_partnerin: 'ex_partner', expartner: 'ex_partner',
  rival: 'rivale', rivalin: 'rivale',
  mentorin: 'mentor',
  geschaeftspartner: 'geschaeft', geschaeftspartnerin: 'geschaeft',
  verbuendeter: 'verbuendete', komplizin: 'komplize',
  vorgesetzte: 'vorgesetzter', chef: 'vorgesetzter', chefin: 'vorgesetzter',
  untergebene: 'untergebener', angestellte: 'untergebener', angestellter: 'untergebener',
};

const _VALID = new Set(RELATION_TYPES);
const GENERIC_VERWANDT = new Set(['verwandt', 'verwandte', 'verwandter', 'verwandtschaft']);

function _key(s) {
  return String(s || '').normalize('NFC').toLowerCase().trim()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[\s-]+/g, '_');
}

function _one(part) {
  const k = _key(part);
  if (_VALID.has(k)) return k;
  return SYNONYMS[k] || null;
}

/** Bildet einen KI-Typwert auf genau einen Listenwert ab.
 *  `{ typ, original }` — `original` ist der Rohwert, wenn er nicht schon gültig war
 *  (für die Beschreibung, damit «Tante» nicht spurlos zu «andere» wird), sonst null.
 *  Mehrere Werte («andere|bekannt», vom Schema-Beispiel abgeschrieben): «andere» zählt
 *  nur, wenn sonst nichts bleibt; bleiben mehrere verschiedene, gilt der erste — ausser
 *  einer davon ist gerichtet, dann ist die Richtung offen und es wird «andere». */
export function normalizeRelationTyp(raw) {
  const s = String(raw ?? '').trim();
  if (_VALID.has(s)) return { typ: s, original: null };
  const parts = s.split(/[|/,;]+/).map(_one).filter(Boolean);
  const specific = [...new Set(parts.filter(t => t !== 'andere'))];
  let typ = 'andere';
  if (specific.length === 1) typ = specific[0];
  else if (specific.length > 1 && !specific.some(t => DIRECTED.has(t))) typ = specific[0];
  const known = parts.length > 0 && s.split(/[|/,;]+/).every(p => _one(p));
  // «Tante» → verwandt ist bekannt, aber verlustbehaftet: das genaue Wort ist die
  // eigentliche Auskunft und gehört in die Beschreibung.
  const kinWord = typ === 'verwandt' && !GENERIC_VERWANDT.has(_key(s));
  return { typ, original: s && (!known || kinWord) ? s : null };
}

/** Bereinigt `typ` einer Beziehungsliste in place (Form egal: `{figur_id,typ,…}` oder
 *  `{von,zu,typ,…}`). Ein unbekannter Rohwert wandert in die leere Beschreibung.
 *  Gibt die Zahl geänderter Einträge zurück. */
export function normalizeRelationTypes(list) {
  let changed = 0;
  for (const bz of (list || [])) {
    if (!bz) continue;
    const { typ, original } = normalizeRelationTyp(bz.typ);
    if (typ === bz.typ) continue;
    bz.typ = typ;
    if (original && !bz.beschreibung) bz.beschreibung = original;
    changed++;
  }
  return changed;
}

// ── Emotionale Nähe (`figure_relations.naehe`, −2 … +2) ──────────────────────
// Gespeichert ist, wie die Beziehung im Text GELEBT wird (Komplettanalyse, Job
// `figuren-naehe`). Fehlt der Wert, gilt der Standard des Typs — eine Schätzung,
// die bei einer «versteinerten Ehe» danebenliegt; darum zeigt die Oberfläche, ob
// ein Wert eingeschätzt oder nur angenommen ist (`naeheOf().geschaetzt`).
export const NAEHE_MIN = -2;
export const NAEHE_MAX = 2;
export const NAEHE_DEFAULT_BY_TYP = {
  ehepartner: 1, liebesbeziehung: 2, elternteil: 1, kind: 1, geschwister: 1, verwandt: 1,
  freund: 1, verbuendete: 1, mentor: 1, schuetzling: 1,
  bekannt: 0, kollege: 0, geschaeft: 0, vorgesetzter: 0, untergebener: 0,
  patronage: 0, komplize: 0, andere: 0,
  ex_partner: -1, rivale: -1, feind: -2,
};

/** Nähe einer Beziehung: der gespeicherte Wert, sonst der Typ-Standard.
 *  `{ wert, geschaetzt }` — `geschaetzt` = vom Text eingeschätzt, nicht angenommen. */
export function naeheOf(bz) {
  const raw = bz?.naehe;
  if (raw != null && raw !== '' && Number.isFinite(Number(raw))) {
    const n = Math.max(NAEHE_MIN, Math.min(NAEHE_MAX, Math.round(Number(raw))));
    return { wert: n, geschaetzt: true };
  }
  const typ = normalizeRelationTyp(bz?.typ).typ;
  return { wert: NAEHE_DEFAULT_BY_TYP[typ] ?? 0, geschaetzt: false };
}
