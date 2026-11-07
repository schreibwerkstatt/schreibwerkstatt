// Berufsweg und Hobbys der Figuren — die reine Rechenschicht
// (docs/figur-lebenslauf.md «Berufsweg und Hobbys»). Ohne Alpine, ohne Fetch.
//
// EIN ORT für «was tat die Figur am Stichtag»: Steckbrief, Alterstabelle,
// Lebenslauf und das Buch-Chat-Werkzeug `get_figure_age` (Server über
// lib/esm-bridge.js#figureStationen) rechnen hier. Eine zweite Variante liesse
// Tabelle und Chat für dieselbe Figur Verschiedenes sagen.
//
// Zeitraum = Jahr + optional Monat, beidseitig offen. bis leer heisst «läuft
// noch oder Ende unbekannt» — am Stichtag zählt die Station dann als aktiv,
// sobald sie begonnen hat. Ohne Beginn ist der Start unbekannt: aktiv nur bis
// zum Ende, und das Ergebnis trägt `unsicher`. Ohne beides ist die Station
// undatiert und am Stichtag nie aktiv (sie steht trotzdem im Steckbrief).

export const STATION_KINDS = ['berufe', 'hobbys'];
export const JOB_ARTEN = ['ausbildung', 'beruf'];
export const STATION_GRENZEN = { minJahr: 1000, maxJahr: 2999, textMax: 200, notizMax: 1000 };

const _int = (v) => (Number.isInteger(v) ? v : null);
const _monat = (v) => (Number.isInteger(v) && v >= 1 && v <= 12 ? v : null);

/** Hat die Station überhaupt eine Jahresangabe? */
export function stationDatiert(s) {
  return _int(s?.von_jahr) != null || _int(s?.bis_jahr) != null;
}

// Vergleich (jahr, monat?) gegen (jahr, monat?): ohne Monat auf einer Seite gilt
// das ganze Jahr als Treffer — «1998» liegt in «seit 5/1998».
function _cmp(aJ, aM, bJ, bM) {
  if (aJ !== bJ) return aJ < bJ ? -1 : 1;
  if (aM == null || bM == null) return 0;
  return aM === bM ? 0 : (aM < bM ? -1 : 1);
}

/** Ist die Station am Stichtag aktiv? → { aktiv, unsicher } oder null (undatiert). */
export function stationAm(s, { jahr, monat = null } = {}) {
  if (!stationDatiert(s) || !Number.isInteger(jahr)) return null;
  const m = _monat(monat);
  const vJ = _int(s.von_jahr), bJ = _int(s.bis_jahr);
  const nachBeginn = vJ == null ? true : _cmp(jahr, m, vJ, _monat(s.von_monat)) >= 0;
  const vorEnde = bJ == null ? true : _cmp(jahr, m, bJ, _monat(s.bis_monat)) <= 0;
  return { aktiv: nachBeginn && vorEnde, unsicher: vJ == null };
}

/** Aktive Stationen einer Liste am Stichtag (nur status 'aktiv', Vorschläge nie). */
export function stationenAm(list, stichtag) {
  const out = [];
  for (const s of list || []) {
    if (s?.status && s.status !== 'aktiv') continue;
    const r = stationAm(s, stichtag);
    if (r?.aktiv) out.push({ ...s, unsicher: r.unsicher });
  }
  return out;
}

const _datum = (j, m) => (m ? `${String(m).padStart(2, '0')}.${j}` : String(j));

/** Zeitraum als Text: «1998–2004», «seit 1998», «bis 2004», '' undatiert. */
export function stationZeitraum(s, t) {
  const vJ = _int(s?.von_jahr), bJ = _int(s?.bis_jahr);
  const von = vJ != null ? _datum(vJ, _monat(s.von_monat)) : null;
  const bis = bJ != null ? _datum(bJ, _monat(s.bis_monat)) : null;
  if (von && bis) return von === bis ? von : t('figuren.stationen.zeitraum', { von, bis });
  if (von) return t('figuren.stationen.seit', { von });
  if (bis) return t('figuren.stationen.bis', { bis });
  return '';
}

/** Haupttext der Station: Tätigkeit (bei Berufen mit Arbeitgeber) bzw. Hobby. */
export function stationTitel(kind, s) {
  if (kind === 'hobbys') return String(s?.hobby || '');
  const t = String(s?.taetigkeit || '');
  return s?.arbeitgeber ? `${t} (${s.arbeitgeber})` : t;
}

/** Felder eines Entwurfs/Requests normalisieren. Liefert { fields } oder
 *  { fehler: feld } — der Server antwortet damit 400, der Browser zeigt es an. */
export function normalizeStation(kind, raw) {
  if (!STATION_KINDS.includes(kind)) return { fehler: 'kind' };
  const G = STATION_GRENZEN;
  const txt = (v, max = G.textMax) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, max) : null;
  };
  const main = kind === 'berufe' ? 'taetigkeit' : 'hobby';
  const fields = { [main]: txt(raw?.[main]) };
  if (!fields[main]) return { fehler: main };
  if (kind === 'berufe') {
    const art = raw?.art == null || raw.art === '' ? 'beruf' : String(raw.art);
    if (!JOB_ARTEN.includes(art)) return { fehler: 'art' };
    fields.art = art;
    fields.arbeitgeber = txt(raw?.arbeitgeber);
  }
  fields.ort = txt(raw?.ort);
  fields.notiz = txt(raw?.notiz, G.notizMax);
  for (const k of ['von_jahr', 'bis_jahr']) {
    const v = raw?.[k];
    if (v == null || v === '') { fields[k] = null; continue; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < G.minJahr || n > G.maxJahr) return { fehler: k };
    fields[k] = n;
  }
  for (const k of ['von_monat', 'bis_monat']) {
    const v = raw?.[k];
    if (v == null || v === '') { fields[k] = null; continue; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 12) return { fehler: k };
    fields[k] = n;
  }
  // Ein Monat ohne Jahr ist keine Angabe.
  if (fields.von_jahr == null) fields.von_monat = null;
  if (fields.bis_jahr == null) fields.bis_monat = null;
  if (fields.von_jahr != null && fields.bis_jahr != null
      && _cmp(fields.bis_jahr, fields.bis_monat, fields.von_jahr, fields.von_monat) < 0) {
    return { fehler: 'bis_jahr' };
  }
  return { fields };
}

/** Lebenslauf-Einträge einer Figur: Beginn und Ende jeder datierten, aktiven
 *  Station als eigener Eintrag (Ende nur, wenn es eines gibt). */
export function stationenAlsEreignisse(kind, list) {
  const out = [];
  for (const s of list || []) {
    if (s?.status && s.status !== 'aktiv') continue;
    const titel = stationTitel(kind, s);
    if (_int(s.von_jahr) != null) {
      out.push({ jahr: s.von_jahr, monat: _monat(s.von_monat), station: kind, phase: 'beginn', titel, page_id: s.page_id ?? null });
    }
    if (_int(s.bis_jahr) != null && s.bis_jahr !== s.von_jahr) {
      out.push({ jahr: s.bis_jahr, monat: _monat(s.bis_monat), station: kind, phase: 'ende', titel, page_id: s.page_id ?? null });
    }
  }
  return out;
}
