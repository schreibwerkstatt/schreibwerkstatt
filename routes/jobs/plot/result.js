'use strict';
// Plot-Consistency: pure Nachbearbeitung des KI-Outputs + Vorlauf-Auswahl
// (Delta-Check). Ohne DB/KI unit-testbar (tests/unit/plot-consistency-result.test.mjs).
//
// Die Enums (Befund-Typen, Relations-Typen) kommen als Argument aus dem Prompt-
// Modul (public/js/prompts/plot.js) — eine Quelle für Prompt, Schema und Validierung.

const { resolveBeatRefs } = require('./beat-refs');

const SEVERITY = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];
const STATUS_WERTE = ['im_buch', 'geplant'];
const SEIT = ['neu', 'bestehend'];
const FALLBACK_TYP = 'logik';

// Titel-Normalisierung für den Fallback-Match (Modelle, die keinen [#…]-Marker
// zurückgeben, und Alt-Läufe): Gross/Klein, Whitespace, umschliessende Anführungen.
function normTitle(s) {
  return String(s || '').trim().replace(/^[«»"„“”'‚‘’]+|[«»"„“”'‚‘’]+$/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Titel → Beat-ID; ein Titel, den mehrere Beats tragen, ist mehrdeutig und matcht
// gar nicht (sonst gewänne still der letzte gleichnamige Beat).
function buildTitleIndex(beats) {
  const idx = new Map();
  const ambiguous = new Set();
  for (const b of beats || []) {
    const key = normTitle(b.titel);
    if (!key) continue;
    if (idx.has(key) && idx.get(key) !== b.id) ambiguous.add(key);
    else idx.set(key, b.id);
  }
  for (const key of ambiguous) idx.delete(key);
  return idx;
}

function _int(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}

// Aktion eines Befunds validieren. Liefert exakt eine der Vertrags-Formen oder null:
//   { art: 'status', wert: 'im_buch'|'geplant' }
//   { art: 'verwerfen' }
//   { art: 'relation', typ: <relTypes>, ziel_beat_id: <int> }
// Immer bezogen auf `beatId` (den Beat des Befunds). Ungültig/No-Op → null.
function normalizeAktion(raw, { beatId, beatsById, relTypes }) {
  if (!raw || typeof raw !== 'object' || beatId == null) return null;
  const beat = beatsById.get(beatId);
  if (!beat) return null;
  const art = typeof raw.art === 'string' ? raw.art.trim() : '';
  if (art === 'status') {
    if (beat.verworfen) return null;
    const wert = typeof raw.wert === 'string' ? raw.wert.trim() : '';
    if (!STATUS_WERTE.includes(wert) || wert === beat.status) return null;
    return { art: 'status', wert };
  }
  if (art === 'verwerfen') {
    return beat.verworfen ? null : { art: 'verwerfen' };
  }
  if (art === 'relation') {
    const typ = typeof raw.typ === 'string' ? raw.typ.trim() : '';
    const ziel = _int(raw.ziel_beat_id);
    if (!relTypes.includes(typ) || ziel == null || ziel === beatId || !beatsById.has(ziel)) return null;
    return { art: 'relation', typ, ziel_beat_id: ziel };
  }
  return null;
}

// Konflikte des Modells auf den Vertrag bringen: beat_id aufs Board validieren
// (sonst eindeutiger Titel-Match), Schwere/Typ auf die Enums, Aktion validiert,
// Fundstelle deterministisch aus dem Verankerungs-Index, `seit_letztem_lauf` nur
// mit Vorlauf.
function normalizeKonflikte(raw, { beats, belegById = {}, typEnum, relTypes, hasDelta = false }) {
  const beatsById = new Map((beats || []).map(b => [b.id, b]));
  const titleIdx = buildTitleIndex(beats);
  // [#id]-Marker im Freitext → «Titel» (plot/beat-refs.js); die Autorin sieht keine IDs.
  const refs = t => resolveBeatRefs(t, id => beatsById.get(id)?.titel);
  return (Array.isArray(raw) ? raw : [])
    .filter(k => k && typeof k.problem === 'string' && k.problem.trim())
    .map(k => {
      const beat = typeof k.beat === 'string' && k.beat.trim() ? refs(k.beat.trim()).trim() || '—' : '—';
      const rawId = _int(k.beat_id);
      let beatId = rawId != null && beatsById.has(rawId) ? rawId : null;
      if (beatId == null && beat !== '—') beatId = titleIdx.get(normTitle(beat)) ?? null;
      const out = {
        beat,
        beat_id: beatId,
        schwere: SEVERITY.includes(k.schwere) ? k.schwere : 'mittel',
        typ: typEnum.includes(k.typ) ? k.typ : FALLBACK_TYP,
        problem: refs(k.problem.trim()),
        vorschlag: typeof k.vorschlag === 'string' ? refs(k.vorschlag.trim()) : '',
        aktion: normalizeAktion(k.aktion, { beatId, beatsById, relTypes }),
        fundstelle: (beatId != null ? belegById[beatId] : null) || null,
      };
      if (hasDelta) out.seit_letztem_lauf = SEIT.includes(k.seit_letztem_lauf) ? k.seit_letztem_lauf : null;
      return out;
    });
}

// Behobene Befunde des Vorlaufs: kurze Strings. Ohne Vorlauf immer leer — das
// Modell hat dann nichts, wogegen es „erledigt" behaupten könnte.
function normalizeErledigt(raw, hasDelta, beats = []) {
  if (!hasDelta || !Array.isArray(raw)) return [];
  const byId = new Map((beats || []).map(b => [b.id, b.titel]));
  return raw.filter(s => typeof s === 'string' && s.trim())
    .map(s => resolveBeatRefs(s.trim(), byId).slice(0, 300)).slice(0, 40);
}

function _ts(s) {
  if (!s) return NaN;
  const str = String(s);
  // SQLite-„YYYY-MM-DD HH:MM:SS" ohne Zone als UTC lesen.
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : `${str.replace(' ', 'T')}Z`);
}

// Vorlauf-Kontext für den Delta-Check: Befunde des letzten Laufs (kompakt) + die
// seit dessen created_at inhaltlich geänderten/neuen Beats (updated_at > created_at).
// prevRun = getPlotConsistencyRun(...) oder null. Ohne Vorlauf / ohne lesbares
// Ergebnis → null (normaler Lauf).
function buildDeltaContext(prevRun, beats, { maxKonflikte = 30, problemLen = 160 } = {}) {
  const konflikte = prevRun && prevRun.result && Array.isArray(prevRun.result.konflikte)
    ? prevRun.result.konflikte
    : null;
  if (!konflikte) return null;
  const since = _ts(prevRun.created_at);
  const live = new Map((beats || []).map(b => [b.id, b]));
  const kompakt = konflikte
    .filter(k => k && typeof k.problem === 'string' && k.problem.trim())
    .map(k => {
      const id = _int(k.beat_id);
      const known = id != null && live.has(id);
      return {
        beat_id: known ? id : null,
        beat: known ? live.get(id).titel : (typeof k.beat === 'string' && k.beat !== '—' ? `${k.beat} (Beat nicht mehr im Board)` : null),
        typ: typeof k.typ === 'string' ? k.typ : null,
        problem: k.problem.trim().replace(/\s+/g, ' ').slice(0, problemLen),
      };
    });
  const geaendert = Number.isFinite(since)
    ? (beats || []).filter(b => _ts(b.updated_at) > since).map(b => ({ id: b.id, titel: b.titel }))
    : [];
  return {
    runId: prevRun.id ?? null,
    datum: prevRun.created_at ? String(prevRun.created_at).slice(0, 16).replace('T', ' ') : null,
    konflikte: kompakt.slice(0, maxKonflikte),
    konflikteTotal: kompakt.length,
    geaendert,
  };
}

module.exports = {
  normTitle, buildTitleIndex, normalizeAktion, normalizeKonflikte, normalizeErledigt, buildDeltaContext,
};
