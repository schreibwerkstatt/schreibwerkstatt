'use strict';
// Deterministische Buch-Befund-Engine (read-time, PURE — kein DB, kein KI-Call).
//
// Verdichtet die bereits extrahierten Katalog-Zeilen (Figuren-Präsenz pro Kapitel,
// Szenen-Ko-Präsenz, Lebensereignisse, Beziehungen, Schauplätze, Kapitel-Erzählprofil)
// zu strukturellen Schlüssen, die die deskriptive Komplettanalyse selbst nicht zieht:
// «Figur X verschwindet für 18 Kapitel», «X und der Antagonist teilen nie eine Szene»,
// «Pacing sackt in Kap. 12–16 ab», «Motiv Y wird eingeführt und fallengelassen».
//
// Alle Befunde sind falsifizierbar (aus Zeilen berechnet, nicht vom Modell erfunden) —
// die KI-Synthese obendrauf (routes/jobs/komplett/phases/erzaehlprofil.js) darf sie nur
// benennen und priorisieren, nie neue behaupten. Rein rückwärtsgewandt / überwachend.
//
// Eingabe: das von db/narrative-report.js gesammelte Roh-Objekt (siehe computeNarrativeReport).
// Ausgabe: ein serialisierbares Befund-Objekt für die Erzählprofil-Karte + KI-Synthese.

// ── Schwellen (zentral, damit Tuning an einer Stelle sitzt) ──────────────────────
const NARRATIVE_REPORT_THRESHOLDS = {
  MAIN_FIGURE_MIN_CHAPTERS: 3,      // Präsenz in ≥3 Kapiteln ⇒ «Hauptfigur» (Rest ist Rauschen)
  DISAPPEAR_MIN_GAP_ABS: 5,         // Absenz-Lücke ≥ max(ABS, FRACTION·Kapitel) ⇒ «verschwindet»
  DISAPPEAR_MIN_GAP_FRACTION: 0.2,
  FLAT_ARC_MIN_COVERAGE: 0.4,       // Präsenz in ≥40% der Kapitel + 0 Ereignisse ⇒ «statisch/flach»
  ENCOUNTER_TOP_K: 8,               // Begegnungslücken nur zwischen den Top-K-Figuren nach Präsenz
  ENCOUNTER_MAX_OUT: 15,            // max. gemeldete Begegnungslücken
  PACING_SAG_MIN_RUN: 3,            // ≥3 Kapitel in Folge …
  PACING_SAG_MAX_INTENSITY: 2,      // … mit Intensität ≤2 ⇒ Sag
  PACING_PEAK_MIN: 4,               // kein Kapitel ≥4 ⇒ «kein Höhepunkt»
  PACING_FLAT_SPREAD: 1,            // max−min ≤1 ⇒ «flache Kurve»
  LOW_CONF_THRESHOLD: 0.6,          // POV-Konfidenz < 0.6 …
  LOW_CONF_MIN_RUN: 2,              // … in ≥2 Kapiteln in Folge ⇒ wacklige Erzählhaltung
  PRESENCE_BAND_MAX_FIGURES: 14,    // Präsenz-Band: nur die N präsentesten Hauptfiguren als Zeilen
  EVENT_DESERT_MIN_RUN: 5,          // ≥5 Kapitel ohne datiertes Ereignis ⇒ Ereignis-Wüste
  DROPPED_MOTIF_FIRST_FRACTION: 1 / 3, // Motiv im ersten Drittel eingeführt …
  DROPPED_MOTIF_LAST_FRACTION: 1 / 2,  // … und nie in der zweiten Hälfte ⇒ fallengelassen
  MIN_CHAPTERS_FOR_SPAN_FINDINGS: 6,   // Motiv-/Schauplatz-Spannen erst ab genug Kapiteln
  MIN_CHAPTERS_FOR_REPORT: 12,         // darunter kein Befund (Gate in db/narrative-report.js)
};

const T = NARRATIVE_REPORT_THRESHOLDS;

const _norm = (s) => String(s || '').trim().toLowerCase();
const _pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * @param {object} input
 *   input.chapters   [{ chapter_id, kapitel, sort_order }] — geordnete Kapitel-Achse (Buchreihenfolge)
 *   input.figures    [{ id, name }] — nicht-stale Figuren des Buchs
 *   input.appearances [{ figure_id, chapter_id }] — Präsenz pro Kapitel (figure_appearances)
 *   input.scenes     [{ id, chapter_id }] — nicht-stale Szenen
 *   input.sceneFigures [{ scene_id, figure_id }]
 *   input.events     [{ figure_id, chapter_id }] — Lebensereignisse
 *   input.relations  [{ from_fig_id, to_fig_id, typ }]
 *   input.locations  [{ id, name }]
 *   input.locationChapters [{ location_id, chapter_id }]
 *   input.narrative  [{ chapter_id, intensitaet, pov_konfidenz, pov_abweichung, tempus_abweichung }]
 *   input.themes     [{ chapter_id, thema, typ }]
 * @returns {object} Befund
 */
function computeNarrativeReport(input) {
  const chapters = Array.isArray(input?.chapters) ? input.chapters : [];
  const n = chapters.length;
  if (!n) return _empty();

  // Kapitel-Achse: chapter_id → Index; Index → Anzeigename.
  const idxById = new Map();
  chapters.forEach((c, i) => { if (c.chapter_id != null) idxById.set(c.chapter_id, i); });
  const kapAt = (i) => (i >= 0 && i < n ? (chapters[i].kapitel || `#${i + 1}`) : null);
  const chIdAt = (i) => (i >= 0 && i < n ? (chapters[i].chapter_id ?? null) : null);

  const figName = new Map((input.figures || []).map(f => [f.id, f.name]));
  // figures.id → öffentliche Kennung fig_id (Katalog-`id` im Frontend, Ziel der Verweise).
  const figPub = new Map((input.figures || []).map(f => [f.id, f.fig_id ?? null]));

  const mainFigures = [..._presenceByFigure(input, idxById).entries()]
    .filter(([fid, idxs]) => figName.has(fid) && idxs.length >= T.MAIN_FIGURE_MIN_CHAPTERS).length;
  return {
    chapterCount: n,
    // Welche Befunde überhaupt berechnet wurden. Ein leeres Array heisst «geprüft,
    // unauffällig»; `false` hier heisst «zu wenig Daten» — die KI-Synthese bekommt
    // nicht berechnete Abschnitte gar nicht erst zu sehen (siehe phases/erzaehlprofil.js).
    computed: {
      encounters: mainFigures >= 2,
      spans: n >= T.MIN_CHAPTERS_FOR_SPAN_FINDINGS,
      eventDeserts: n >= T.MIN_CHAPTERS_FOR_SPAN_FINDINGS && (input.events || []).some(e => idxById.has(e.chapter_id)),
    },
    presenceBand: _presenceBand(input, { n, idxById, kapAt, chIdAt, figName, figPub }),
    arcs: _arcs(input, { n, idxById, kapAt, chIdAt, figName, figPub }),
    encounters: _encounters(input, { idxById, figName, figPub }),
    pacing: _pacing(input, { n, idxById, kapAt, chIdAt }),
    droppedMotifs: _droppedMotifs(input, { n, idxById, kapAt }),
    locations: _locations(input, { n, idxById, kapAt }),
    pov: _pov(input, { n, idxById, kapAt, chIdAt }),
    eventDeserts: _eventDeserts(input, { n, idxById, kapAt, chIdAt }),
  };
}

function _empty() {
  return {
    chapterCount: 0, computed: { encounters: false, spans: false, eventDeserts: false }, presenceBand: { chapters: [], figures: [] }, arcs: [], encounters: [],
    pacing: { curve: [], sags: [], flags: [], peakKap: null, peakIntensitaet: null },
    droppedMotifs: [], locations: { oneOff: [], abandoned: [] },
    pov: { deviationCount: 0, lowConfidenceRuns: [] }, eventDeserts: [],
  };
}

// Präsenz-Indizes pro Figur (sortiert, dedupliziert) aus figure_appearances.
function _presenceByFigure(input, idxById) {
  const byFig = new Map();
  for (const a of (input.appearances || [])) {
    const idx = idxById.get(a.chapter_id);
    if (idx == null) continue;
    if (!byFig.has(a.figure_id)) byFig.set(a.figure_id, new Set());
    byFig.get(a.figure_id).add(idx);
  }
  const out = new Map();
  for (const [fid, set] of byFig) out.set(fid, [...set].sort((x, y) => x - y));
  return out;
}

// Präsenz-Band: pro Hauptfigur (Top-N nach Präsenz) ein 0/1-Vektor über die Kapitel-
// Achse — visuelle Übersicht «wer ist wann auf der Bühne». Flags markieren auffällige
// Zeilen (verschwindet / statisch), damit das Band nicht nur Balken, sondern Befund ist.
function _presenceBand(input, { n, idxById, kapAt, chIdAt, figName, figPub }) {
  const presence = _presenceByFigure(input, idxById);
  const eventCountByFig = new Map();
  for (const e of (input.events || [])) {
    eventCountByFig.set(e.figure_id, (eventCountByFig.get(e.figure_id) || 0) + 1);
  }
  const disappearGate = Math.max(T.DISAPPEAR_MIN_GAP_ABS, Math.round(T.DISAPPEAR_MIN_GAP_FRACTION * n));
  const ranked = [...presence.entries()]
    .filter(([fid, idxs]) => figName.has(fid) && idxs.length >= T.MAIN_FIGURE_MIN_CHAPTERS)
    .sort((a, b) => b[1].length - a[1].length || (figName.get(a[0]) || '').localeCompare(figName.get(b[0]) || ''))
    .slice(0, T.PRESENCE_BAND_MAX_FIGURES);

  const figures = ranked.map(([fid, idxs]) => {
    const set = new Set(idxs);
    const present = Array.from({ length: n }, (_, i) => (set.has(i) ? 1 : 0));
    let maxGap = 0;
    for (let k = 1; k < idxs.length; k++) maxGap = Math.max(maxGap, idxs[k] - idxs[k - 1] - 1);
    const coverage = idxs.length / n;
    const flags = [];
    if (maxGap >= disappearGate) flags.push('disappears');
    if (coverage >= T.FLAT_ARC_MIN_COVERAGE && (eventCountByFig.get(fid) || 0) === 0) flags.push('static');
    return { id: fid, figId: figPub.get(fid) ?? null, name: figName.get(fid), present, presentCount: idxs.length, flags };
  });
  const chapters = Array.from({ length: n }, (_, i) => ({ chapter_id: chIdAt(i), kap: kapAt(i) }));
  return { chapters, figures };
}

// 1+3+«statisch»: Präsenzbogen je Hauptfigur + Absenz-Lücken + flache/statische Flags.
function _arcs(input, { n, idxById, kapAt, chIdAt, figName, figPub }) {
  const presence = _presenceByFigure(input, idxById);
  const eventCountByFig = new Map();
  for (const e of (input.events || [])) {
    eventCountByFig.set(e.figure_id, (eventCountByFig.get(e.figure_id) || 0) + 1);
  }
  const disappearGate = Math.max(T.DISAPPEAR_MIN_GAP_ABS, Math.round(T.DISAPPEAR_MIN_GAP_FRACTION * n));
  const arcs = [];
  for (const [fid, idxs] of presence) {
    if (idxs.length < T.MAIN_FIGURE_MIN_CHAPTERS) continue; // nur Hauptfiguren
    const name = figName.get(fid);
    if (!name) continue;
    const firstIdx = idxs[0];
    const lastIdx = idxs[idxs.length - 1];
    const coverage = idxs.length / n;
    const eventCount = eventCountByFig.get(fid) || 0;

    // Grösste zusammenhängende Absenz-Lücke INNERHALB der Auftritts-Spanne.
    let longestGap = null;
    for (let k = 1; k < idxs.length; k++) {
      const gapLen = idxs[k] - idxs[k - 1] - 1;
      if (gapLen > 0 && (!longestGap || gapLen > longestGap.len)) {
        longestGap = { len: gapLen, fromIdx: idxs[k - 1] + 1, toIdx: idxs[k] - 1 };
      }
    }

    const flags = [];
    if (longestGap && longestGap.len >= disappearGate) flags.push('disappears');
    if (coverage >= T.FLAT_ARC_MIN_COVERAGE && eventCount === 0) flags.push('static');

    arcs.push({
      id: fid,
      figId: figPub.get(fid) ?? null,
      name,
      presentCount: idxs.length,
      coverage: Math.round(coverage * 100) / 100,
      firstChapterId: chIdAt(firstIdx),
      firstKap: kapAt(firstIdx),
      lastChapterId: chIdAt(lastIdx),
      lastKap: kapAt(lastIdx),
      eventCount,
      longestGap: longestGap
        ? { len: longestGap.len, fromKap: kapAt(longestGap.fromIdx), toKap: kapAt(longestGap.toIdx), fromChapterId: chIdAt(longestGap.fromIdx) }
        : null,
      flags,
    });
  }
  // Auffällige (mit Flag) zuerst, dann nach Präsenz absteigend.
  arcs.sort((a, b) => (b.flags.length - a.flags.length) || (b.presentCount - a.presentCount) || a.name.localeCompare(b.name));
  return arcs;
}

// 2: Begegnungslücken — Top-Figuren-Paare, die NIE eine Szene teilen; deklarierte
// Beziehung ohne gemeinsame Szene zuerst (Beziehung behauptet, nie gezeigt).
function _encounters(input, { idxById, figName, figPub }) {
  const presence = _presenceByFigure(input, idxById);
  // Top-K Figuren nach Präsenz.
  const ranked = [...presence.entries()]
    .filter(([fid]) => figName.has(fid) && presence.get(fid).length >= T.MAIN_FIGURE_MIN_CHAPTERS)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, T.ENCOUNTER_TOP_K)
    .map(([fid]) => fid);
  const rankSet = new Set(ranked);
  if (ranked.length < 2) return [];

  // Ko-Präsenz aus Szenen: Figuren, die eine Szene teilen.
  const figsByScene = new Map();
  for (const sf of (input.sceneFigures || [])) {
    if (!figsByScene.has(sf.scene_id)) figsByScene.set(sf.scene_id, []);
    figsByScene.get(sf.scene_id).push(sf.figure_id);
  }
  const together = new Set();
  for (const figs of figsByScene.values()) {
    for (let i = 0; i < figs.length; i++) {
      for (let j = i + 1; j < figs.length; j++) together.add(_pairKey(figs[i], figs[j]));
    }
  }

  // Deklarierte Beziehungen (beide Richtungen) für die Priorisierung.
  const relByPair = new Map();
  for (const r of (input.relations || [])) {
    if (rankSet.has(r.from_fig_id) && rankSet.has(r.to_fig_id)) {
      relByPair.set(_pairKey(r.from_fig_id, r.to_fig_id), r.typ || null);
    }
  }

  const presCount = (fid) => presence.get(fid)?.length || 0;
  const out = [];
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i], b = ranked[j];
      const key = _pairKey(a, b);
      if (together.has(key)) continue; // sie treffen sich
      out.push({
        aFigId: figPub.get(a) ?? null,
        aName: figName.get(a),
        bFigId: figPub.get(b) ?? null,
        bName: figName.get(b),
        hasRelation: relByPair.has(key),
        relTyp: relByPair.get(key) || null,
        combinedPresence: presCount(a) + presCount(b),
      });
    }
  }
  // Beziehung-behauptet-nie-gezeigt zuerst, dann die präsentesten Paare.
  out.sort((x, y) => (Number(y.hasRelation) - Number(x.hasRelation)) || (y.combinedPresence - x.combinedPresence));
  return out.slice(0, T.ENCOUNTER_MAX_OUT);
}

// 4: Pacing-Struktur aus der Intensitäts-Kurve (chapter_narrative_profile.intensitaet).
function _pacing(input, { n, idxById, kapAt, chIdAt }) {
  const byIdx = new Array(n).fill(null);
  for (const p of (input.narrative || [])) {
    const idx = idxById.get(p.chapter_id);
    if (idx != null && Number.isFinite(p.intensitaet)) byIdx[idx] = p.intensitaet;
  }
  const curve = byIdx.map((v, i) => ({ kap: kapAt(i), chapter_id: chIdAt(i), intensitaet: v }));

  // Sag-Läufe: ≥MIN_RUN Kapitel in Folge mit Intensität ≤MAX (null bricht den Lauf).
  const sags = [];
  let runStart = -1;
  const flush = (endIdx) => {
    if (runStart >= 0 && endIdx - runStart >= T.PACING_SAG_MIN_RUN) {
      sags.push({ fromKap: kapAt(runStart), toKap: kapAt(endIdx - 1), fromChapterId: chIdAt(runStart), len: endIdx - runStart });
    }
    runStart = -1;
  };
  for (let i = 0; i < n; i++) {
    const v = byIdx[i];
    if (v != null && v <= T.PACING_SAG_MAX_INTENSITY) { if (runStart < 0) runStart = i; }
    else flush(i);
  }
  flush(n);

  const known = byIdx.filter(v => v != null);
  const flags = [];
  let peakIntensitaet = null, peakIdx = -1;
  if (known.length) {
    const max = Math.max(...known), min = Math.min(...known);
    peakIntensitaet = max;
    peakIdx = byIdx.indexOf(max);
    const firstHalf = byIdx.slice(0, Math.floor(n / 2)).filter(v => v != null);
    if (firstHalf.length && Math.max(...firstHalf) < T.PACING_PEAK_MIN) flags.push('monotone_first_half');
    if (max < T.PACING_PEAK_MIN) flags.push('no_peak');
    if (max - min <= T.PACING_FLAT_SPREAD) flags.push('flat');
  }
  return { curve, sags, flags, peakKap: peakIdx >= 0 ? kapAt(peakIdx) : null, peakIntensitaet };
}

// 5: Fallengelassene Motive — im ersten Drittel eingeführt, in der 2. Hälfte nie wieder.
// Nur Themen, die in ≥2 Kapiteln vorkommen: ein einmal gesetztes Symbol ist kein
// fallengelassenes Motiv (Themen sind Freitext pro Kapitel — Einzeltreffer sind die Regel).
function _droppedMotifs(input, { n, idxById, kapAt }) {
  if (n < T.MIN_CHAPTERS_FOR_SPAN_FINDINGS) return [];
  const firstGate = Math.ceil(n * T.DROPPED_MOTIF_FIRST_FRACTION);
  const lastGate = Math.ceil(n * T.DROPPED_MOTIF_LAST_FRACTION);
  const byThema = new Map();
  for (const th of (input.themes || [])) {
    const idx = idxById.get(th.chapter_id);
    if (idx == null) continue;
    const key = _norm(th.thema);
    if (!key) continue;
    if (!byThema.has(key)) byThema.set(key, { thema: th.thema, typ: th.typ || null, idxs: new Set() });
    byThema.get(key).idxs.add(idx);
  }
  const out = [];
  for (const { thema, typ, idxs } of byThema.values()) {
    const arr = [...idxs].sort((a, b) => a - b);
    const firstIdx = arr[0], lastIdx = arr[arr.length - 1];
    if (arr.length >= 2 && firstIdx < firstGate && lastIdx < lastGate) {
      out.push({ thema, typ, count: arr.length, firstKap: kapAt(firstIdx), lastKap: kapAt(lastIdx) });
    }
  }
  out.sort((a, b) => b.count - a.count || a.thema.localeCompare(b.thema));
  return out;
}

// 6: Schauplatz-Nutzung — Einmal-Orte + früh eingeführte, nie wiederkehrende Schauplätze.
function _locations(input, { n, idxById, kapAt }) {
  const locName = new Map((input.locations || []).map(l => [l.id, l.name]));
  // locations.id → öffentliche Kennung loc_id (Katalog-`id` im Frontend, Ziel der Verweise).
  const locPub = new Map((input.locations || []).map(l => [l.id, l.loc_id ?? null]));
  const byLoc = new Map();
  for (const lc of (input.locationChapters || [])) {
    const idx = idxById.get(lc.chapter_id);
    if (idx == null) continue;
    if (!byLoc.has(lc.location_id)) byLoc.set(lc.location_id, new Set());
    byLoc.get(lc.location_id).add(idx);
  }
  const oneOff = [];
  const abandoned = [];
  const spanFindings = n >= T.MIN_CHAPTERS_FOR_SPAN_FINDINGS;
  const firstGate = Math.ceil(n * T.DROPPED_MOTIF_FIRST_FRACTION);
  const lastGate = Math.ceil(n * T.DROPPED_MOTIF_LAST_FRACTION);
  for (const [lid, set] of byLoc) {
    const name = locName.get(lid);
    if (!name) continue;
    const arr = [...set].sort((a, b) => a - b);
    if (arr.length === 1) { oneOff.push({ id: locPub.get(lid), name }); continue; }
    if (spanFindings && arr[0] < firstGate && arr[arr.length - 1] < lastGate) {
      abandoned.push({ id: locPub.get(lid), name, firstKap: kapAt(arr[0]), lastKap: kapAt(arr[arr.length - 1]), count: arr.length });
    }
  }
  oneOff.sort((a, b) => a.name.localeCompare(b.name));
  abandoned.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { oneOff, abandoned };
}

// 7: POV-Disziplin — Abweichungs-Zähler + Läufe niedriger POV-Konfidenz.
function _pov(input, { n, idxById, kapAt, chIdAt }) {
  const conf = new Array(n).fill(null);
  let deviationCount = 0;
  for (const p of (input.narrative || [])) {
    const idx = idxById.get(p.chapter_id);
    if (idx == null) continue;
    if (p.pov_abweichung || p.tempus_abweichung) deviationCount++;
    if (typeof p.pov_konfidenz === 'number' && isFinite(p.pov_konfidenz)) conf[idx] = p.pov_konfidenz;
  }
  const lowConfidenceRuns = [];
  let runStart = -1;
  const flush = (endIdx) => {
    if (runStart >= 0 && endIdx - runStart >= T.LOW_CONF_MIN_RUN) {
      lowConfidenceRuns.push({ fromKap: kapAt(runStart), toKap: kapAt(endIdx - 1), fromChapterId: chIdAt(runStart), len: endIdx - runStart });
    }
    runStart = -1;
  };
  for (let i = 0; i < n; i++) {
    const c = conf[i];
    if (c != null && c < T.LOW_CONF_THRESHOLD) { if (runStart < 0) runStart = i; }
    else flush(i);
  }
  flush(n);
  return { deviationCount, lowConfidenceRuns };
}

// 8: Ereignis-Wüsten — Läufe von ≥MIN_RUN Kapiteln ohne datiertes Lebensereignis.
function _eventDeserts(input, { n, idxById, kapAt, chIdAt }) {
  if (n < T.MIN_CHAPTERS_FOR_SPAN_FINDINGS) return [];
  const has = new Array(n).fill(false);
  for (const e of (input.events || [])) {
    const idx = idxById.get(e.chapter_id);
    if (idx != null) has[idx] = true;
  }
  // Nur sinnvoll, wenn das Buch überhaupt datierte Ereignisse hat.
  if (!has.some(Boolean)) return [];
  const deserts = [];
  let runStart = -1;
  const flush = (endIdx) => {
    if (runStart >= 0 && endIdx - runStart >= T.EVENT_DESERT_MIN_RUN) {
      deserts.push({ fromKap: kapAt(runStart), toKap: kapAt(endIdx - 1), fromChapterId: chIdAt(runStart), len: endIdx - runStart });
    }
    runStart = -1;
  };
  for (let i = 0; i < n; i++) {
    if (!has[i]) { if (runStart < 0) runStart = i; }
    else flush(i);
  }
  flush(n);
  return deserts;
}

module.exports = { computeNarrativeReport, NARRATIVE_REPORT_THRESHOLDS };
