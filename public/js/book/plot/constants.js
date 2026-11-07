// Geteilte Konstanten der Plot-Werkstatt — von mehreren Sub-Modulen konsumiert.

// Status = binäre Realisierungsachse (Idee ↔ eingearbeitet). „Verworfen" ist ein
// eigenes Flag (beat.verworfen 0/1), keine Status-Stufe.
export const STATUSES = ['geplant', 'im_buch'];

// Segmente der board-weiten Status-Verteilungsleiste: die zwei Status + die
// Verwerfen-Achse als drittes Segment (verworfene Beats, unabhängig vom Status).
export const DIST_SEGMENTS = ['geplant', 'im_buch', 'verworfen'];

// Akt-Farbpalette: Schlüssel referenzieren die theme-aware --palette-*-Tokens
// (tokens/colors.css, geteilt mit der Figuren-Palette). In plot_acts.farbe wird
// nur der Schlüssel gespeichert; actAccent() baut daraus die CSS-Variable und
// fällt bei unbekanntem/leerem Wert auf den Karten-Akzent zurück (kein Inline-Hue).
export const ACT_PALETTE = ['blue', 'green', 'amber', 'orange', 'red', 'wine', 'pink', 'purple', 'brown', 'gray'];

// Intensität → vertikale Position im Spannungsband (10–90 %, etwas Rand oben/unten).
export const _intensityBottomPct = (i) => 10 + ((i - 1) / 4) * 80;

// Kuratierte Typen der gerichteten Beat-zu-Beat-Beziehungen (from --typ--> to).
// `typ` ist serverseitig Freitext (analog figure_relations); dies ist die im
// Frontend angebotene Auswahl. Zwei Familien: Setup/Payoff (bereitet-vor/zahlt-ein)
// + Kausalität (fuehrt-zu/motiviert/blockiert/spiegelt). Labels via i18n
// (plot.relation.type.<typ>) — hier nur die stabilen Schlüssel + Reihenfolge.
export const BEAT_REL_TYPES = ['bereitet-vor', 'zahlt-ein', 'fuehrt-zu', 'motiviert', 'blockiert', 'spiegelt'];

// Setup/Payoff sind dieselbe Aussage aus zwei Richtungen: «A bereitet B vor» ist
// «B zahlt auf A ein». Wer eine Kante auf Dubletten prüft (Plot-Chat-Vorschläge,
// Übernahme), prüft auch die Gegenrichtung.
const BEAT_REL_INVERSE = { 'bereitet-vor': 'zahlt-ein', 'zahlt-ein': 'bereitet-vor' };

/** Sagen die Kanten a und b ({ from, to, typ }) dasselbe? */
export function sameBeatRelation(a, b) {
  if (a.typ === b.typ && a.from === b.from && a.to === b.to) return true;
  return BEAT_REL_INVERSE[a.typ] === b.typ && a.from === b.to && a.to === b.from;
}

// Beat-Titel normalisieren für den Abgleich Befund ↔ Beat (gleiche Vertragsbasis
// wie der Consistency-Job, der den Beat nur per Titel-String referenziert). EINE
// Quelle für derived.js (Index/Match) und ai.js (Sprung) — divergierte sonst still.
export const normTitle = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Beat-Verankerung: Soll (status) gegen Ist (Fundstellen im Text) klassifizieren.
// Reine Funktion (kein Alpine-Kontext) → unit-testbar. Verankert werden „im Buch"-
// UND „geplant"-Beats (siehe routes/jobs/beat-anchor.js) — für geplante aber nur
// Fundstellen oberhalb der hohen Promotion-Schwelle (plot.anchor.promote_min_score),
// damit das Board nicht mit schwachen Treffern geflutet wird. Verworfene Beats
// werden nie verankert. Werte:
//   'confirmed'  im_buch + Fundstellen  → passt (grün)
//   'drift'      im_buch + 0 Fundstellen → Warnung: als eingearbeitet markiert,
//                aber im Text nicht auffindbar (rot)
//   'promote'    geplant + Fundstellen  → offenbar schon geschrieben; Vorschlag,
//                den Beat auf „im Buch" zu setzen (amber)
//   'none'       geplant ohne Fundstellen / verworfen → kein Badge
// occCount = plot_beat_occurrences-Zahl des Beats (0 wenn nie/nicht verankert).
// anchored = wurde für dieses Buch überhaupt je verankert (beatAnchorKnown)? Ohne
// Lauf heisst „0 Fundstellen" nur „unbekannt", nicht „nicht im Text" — dann kein
// rotes 'drift', sondern 'none'.
export function classifyBeatAnchor(status, occCount, verworfen, anchored = true) {
  if (verworfen) return 'none';
  const has = (occCount || 0) > 0;
  if (status === 'im_buch') return has ? 'confirmed' : (anchored ? 'drift' : 'none');
  if (status === 'geplant') return has ? 'promote' : 'none';
  return 'none';
}

// Ist der Verankerungs-Index dieses Buchs bekannt (mindestens ein Anchor-Lauf)?
// Primär das Payload-Feld `beatAnchor.ranAt` (Zeitpunkt des jüngsten Laufs, null =
// nie gelaufen), sobald der Server es liefert. Ohne das Feld die Heuristik: trägt
// kein einziger Beat eine Fundstelle, gilt der Index als nie erhoben — dieselbe
// Regel wie `_anchorContext` im Consistency-Job (leerer Index = „unbekannt").
export function beatAnchorKnown(beatAnchor, beats) {
  if (beatAnchor && Object.prototype.hasOwnProperty.call(beatAnchor, 'ranAt')) return !!beatAnchor.ranAt;
  return (beats || []).some(b => (b?.occ_count || 0) > 0);
}

// Felder, die nur GET /plot an einen Beat hängt (Verankerungs-Index), nicht die
// Einzel-Beat-Antwort von PATCH. Fehlen sie in der Antwort, übernimmt
// mergeBeatRow sie vom bisherigen Board-Stand — sonst kippt das Anker-Badge
// nach jedem Speichern auf 'drift'.
export const BEAT_GET_ONLY_FIELDS = ['occ_count', 'occ_top'];

// Pure: Server-Antwort (updated) über den bisherigen Board-Beat (cur) legen; nur
// die GET-only-Felder, die der Antwort fehlen, werden vom alten Stand geerbt.
export function mergeBeatRow(cur, updated) {
  if (!updated || !cur) return updated;
  const merged = { ...updated };
  for (const k of BEAT_GET_ONLY_FIELDS) {
    if (!(k in updated) && k in cur) merged[k] = cur[k];
  }
  return merged;
}

// Pure: Beat-Feld-Snapshots (PATCH-Form, _beatFieldSnapshot) inhaltlich gleich?
// Arrays als Mengen (die Server-Links sind ungeordnet), IDs typ-tolerant.
export function beatFieldsEqual(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const norm = (v) => (v === undefined || v === '' ? null : v);
  for (const k of keys) {
    const va = a[k], vb = b[k];
    if (Array.isArray(va) || Array.isArray(vb)) {
      const sa = (va || []).map(String).sort();
      const sb = (vb || []).map(String).sort();
      if (sa.length !== sb.length || sa.some((x, i) => x !== sb[i])) return false;
      continue;
    }
    const na = norm(va), nb = norm(vb);
    if (na === nb) continue;
    if (na != null && nb != null && String(na) === String(nb)) continue;
    return false;
  }
  return true;
}

// Board-Lesereihenfolge (verbindliche Regel, geteilt von Referenz-Plan und allen
// Konsumenten, die „den Plan von vorn nach hinten" lesen): Lane für Lane —
// Stränge nach `position`, die „ohne Strang"-Lane zuletzt (wie threadLanes()).
// Die Akte einer Lane sind die strang-eigenen Akte (nach position), falls der
// Strang welche hat, sonst die geteilten (nach position); innerhalb des Akts
// `sort_order`, dann `id`. Beats mit unbekanntem Strang zählen zu „ohne Strang".
// Pure, filtert nichts.
export function beatReadingOrder({ acts = [], threads = [], beats = [] } = {}) {
  const tSorted = [...(threads || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const laneIdx = new Map(tSorted.map((t, i) => [t.id, i]));
  const noneLane = tSorted.length;
  const byPos = (a, b) => (a.position ?? 0) - (b.position ?? 0);
  const shared = (acts || []).filter(a => a.thread_id == null).sort(byPos);
  const ownBy = new Map();
  for (const a of (acts || [])) {
    if (a.thread_id == null) continue;
    if (!ownBy.has(a.thread_id)) ownBy.set(a.thread_id, []);
    ownBy.get(a.thread_id).push(a);
  }
  for (const list of ownBy.values()) list.sort(byPos);
  const actIdxFor = (tid) => {
    const list = (tid != null && ownBy.get(tid)) || shared;
    return new Map(list.map((a, i) => [a.id, i]));
  };
  const cache = new Map();
  const key = (b) => {
    const tid = (b.thread_id != null && laneIdx.has(b.thread_id)) ? b.thread_id : null;
    const lane = tid == null ? noneLane : laneIdx.get(tid);
    if (!cache.has(lane)) cache.set(lane, actIdxFor(tid));
    const ai = cache.get(lane).get(b.act_id);
    return [lane, ai == null ? Number.MAX_SAFE_INTEGER : ai];
  };
  return [...(beats || [])]
    .map(b => ({ b, k: key(b) }))
    .sort((x, y) => (x.k[0] - y.k[0]) || (x.k[1] - y.k[1])
      || ((x.b.sort_order ?? 0) - (y.b.sort_order ?? 0)) || (x.b.id - y.b.id))
    .map(x => x.b);
}
