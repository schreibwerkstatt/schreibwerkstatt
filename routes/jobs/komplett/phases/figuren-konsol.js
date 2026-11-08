'use strict';
// Phase 2, Teil-Konsolidierung der Figuren: passt die Figurenliste nicht in EINEN Call,
// wird sie in Teilen konsolidiert statt ganz auf den regelbasierten Fallback zu fallen.
//
// **Why:** Der Konsolidierungs-Call gibt die ganze Figurenliste neu aus. Auf Modellen mit
// adaptivem Denken zählt das Reasoning gegen dasselbe `max_tokens` wie das JSON — bei
// ~120 Figuren aus sechs Kapiteln reichten 128K Output nicht mehr, der Call truncierte
// nach einer Viertelstunde, und das Buch verlor die KI-Zusammenführung ganz.
//
// Aufteilung: Figuren, die einen Namensbestandteil teilen («Hans», «Hans Meier»,
// «Frau Meier»), landen im selben Teil — genau unter ihnen sucht die Konsolidierung
// Dubletten. Was der Pre-Merge schon zusammengelegt hat, ist ohnehin eine Figur. Die
// Teile tragen je ihren eigenen ID-Raum; Beziehungen werden darum über den Zielnamen
// gebunden (rebindBeziehungenByName), und Kanten zu Figuren eines ANDEREN Teils, die
// das Modell nicht sehen konnte, werden aus der Eingabe übernommen.
const { normName, nameTokens } = require('../../../../lib/name-normalize');
const { updateJob, retryOnTransientAi, settledAll, i18nError, i18nErrText } = require('../../shared');
const { rebindBeziehungenByName, relationDescKey, nameFitsFigure } = require('../figuren-merge');
const { COST_LABEL, costTier } = require('../cost-labels');

/** Anteil des Output-Caps, den das JSON einer Konsolidierung höchstens belegen darf.
 *  Der Rest gehört dem adaptiven Denken (gleiches Budget) und der Schätz-Unschärfe. */
const KONSOL_SINGLE_RESERVE = 0.5;
/** Ziel je Teil: deutlich darunter, damit ein Teil auch bei viel Reasoning durchläuft. */
const KONSOL_BATCH_RESERVE = 0.35;
const KONSOL_CONCURRENCY = 3;

function _figSize(f) {
  return JSON.stringify(f || {}).length;
}

/** Teilt pre-gemergte Kapitel-Figuren in Teile von höchstens `maxChars` (JSON-Länge).
 *  Gibt Teile im Kapitel-Format zurück ([{ kapitel, figuren }]), damit der bestehende
 *  Prompt-Builder sie unverändert lesen kann. Rein, deterministisch. */
function planKonsolBatches(chapterFiguren, maxChars) {
  const entries = [];
  (chapterFiguren || []).forEach((cf, ci) => {
    for (const f of (cf.figuren || [])) entries.push({ ci, f, size: _figSize(f) });
  });
  // Union-Find über geteilte Namensbestandteile (Name + Kurzname).
  const parent = entries.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byToken = new Map();
  entries.forEach((e, i) => {
    const toks = new Set([...nameTokens(e.f.name), ...nameTokens(e.f.kurzname)]);
    for (const t of toks) {
      if (byToken.has(t)) parent[find(i)] = find(byToken.get(t));
      else byToken.set(t, i);
    }
  });
  const groups = new Map();
  entries.forEach((e, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(e);
  });
  // Grösste Gruppen zuerst (First-Fit-Decreasing); eine Gruppe über dem Ziel wird in
  // Namensreihenfolge zerlegt — ihre Teile bleiben dann wenigstens beieinander sortiert.
  const units = [];
  for (const g of groups.values()) {
    const total = g.reduce((s, e) => s + e.size, 0);
    if (total <= maxChars) { units.push({ entries: g, size: total }); continue; }
    const sorted = [...g].sort((a, b) => normName(a.f.name).localeCompare(normName(b.f.name)));
    let cur = { entries: [], size: 0 };
    for (const e of sorted) {
      if (cur.entries.length && cur.size + e.size > maxChars) { units.push(cur); cur = { entries: [], size: 0 }; }
      cur.entries.push(e); cur.size += e.size;
    }
    if (cur.entries.length) units.push(cur);
  }
  units.sort((a, b) => b.size - a.size);
  const bins = [];
  for (const u of units) {
    const bin = bins.find(b => b.size + u.size <= maxChars);
    if (bin) { bin.entries.push(...u.entries); bin.size += u.size; }
    else bins.push({ entries: [...u.entries], size: u.size });
  }
  // Zurück ins Kapitel-Format, Kapitelreihenfolge und Reihenfolge innerhalb erhalten.
  return bins.map(bin => {
    const perCh = new Map();
    for (const e of bin.entries) {
      if (!perCh.has(e.ci)) perCh.set(e.ci, []);
      perCh.get(e.ci).push(e.f);
    }
    return [...perCh.keys()].sort((a, b) => a - b)
      .map(ci => ({ kapitel: chapterFiguren[ci].kapitel, figuren: perCh.get(ci) }));
  });
}

/** Führt die Ergebnisse der Teile zu einer Liste mit global eindeutigen ids zusammen.
 *  `parts[i] = { input, figuren }` — `figuren` aus der KI-Konsolidierung des Teils oder,
 *  wenn sie scheiterte, die Eingabe selbst. Mutiert die Eingaben nicht. */
function _inputNames(input) {
  const names = new Set();
  for (const cf of input) for (const g of (cf.figuren || [])) {
    for (const nm of [g.name, g.kurzname]) { const k = normName(nm); if (k) names.add(k); }
  }
  return names;
}

/** Beschreibung → Zielnamen der Eingabe-Kanten eines Teils. Ziel ohne `name` (Kante
 *  innerhalb desselben Kapitels) über die Kapitel-ids aufgelöst. */
function _inputTargetsByDesc(input) {
  const out = new Map();
  for (const cf of input) {
    const nameById = new Map((cf.figuren || []).map(g => [String(g.id), g.name]));
    for (const g of (cf.figuren || [])) for (const bz of (g.beziehungen || [])) {
      const k = relationDescKey(bz?.beschreibung);
      const name = bz?.name || nameById.get(String(bz?.figur_id ?? ''));
      if (!k || !name) continue;
      if (!out.has(k)) out.set(k, new Map());
      out.get(k).set(normName(name), name);
    }
  }
  return out;
}

/** Namensliste fürs Log: die ersten acht, Rest als «…». */
function sampleNames(names) {
  return names.slice(0, 8).join(', ') + (names.length > 8 ? ' …' : '');
}

/** Erhaltungsprüfung nach einem Konsolidierungs-Call: jede Eingabefigur, die in der
 *  Ausgabe keine Spur hat, wird aus der Eingabe übernommen.
 *
 *  **Why:** das Modell lässt Randfiguren mit einer einzigen Szene still weg; der Backfill
 *  aus Szenen/Events (figuren-merge/nachlauf.js) greift erst ab zwei Vorkommen. Die Figur
 *  fehlte dann im Katalog, und der Szenen-Remap verwarf ihre Verknüpfungen.
 *
 *  Spur = Name oder Kurzname einer Ausgabefigur, ein Eintrag in deren `quellnamen`
 *  (Zusammenführung unter neuem Namen), oder die Namensbestandteile der Eingabe stecken in
 *  einem Ausgabenamen («Herr Koch» → «Herr Koch (Primarlehrer)»). Übernommene Figuren
 *  tragen keine id (die vergibt der Aufrufer); ihre Kanten behalten nur den Zielnamen,
 *  weil die chunk-lokale figur_id in der ID-Welt der Ausgabe eine fremde Figur träfe.
 *  Entfernt `quellnamen` aus der Ausgabe. Mutiert `figuren` (append), liefert die Namen
 *  der übernommenen Figuren. Konsumenten: mergeKonsolParts (Teile), phases/figuren.js
 *  (Einzel-Call). */
function restoreOmittedFiguren(input, figuren) {
  const covered = new Set();
  const outTokens = [];
  const addName = (nm) => {
    const k = normName(nm);
    if (!k) return;
    covered.add(k);
    const t = nameTokens(nm);
    if (t.length) outTokens.push(t);
  };
  for (const f of (figuren || [])) {
    if (!f) continue;
    addName(f.name);
    addName(f.kurzname);
    for (const q of (Array.isArray(f.quellnamen) ? f.quellnamen : [])) addName(q);
    delete f.quellnamen;
  }
  const isCovered = (g) => {
    const keys = [g.name, g.kurzname].map(normName).filter(Boolean);
    if (!keys.length || keys.some(k => covered.has(k))) return true;
    const tk = nameTokens(g.name);
    return tk.length > 0 && outTokens.some(ot => tk.every(t => ot.includes(t)));
  };
  const restored = [];
  const seen = new Set();
  for (const cf of (input || [])) for (const g of (cf.figuren || [])) {
    const key = normName(g?.name);
    if (!key || seen.has(key) || isCovered(g)) continue;
    seen.add(key);
    const { id: _id, ...rest } = g;
    figuren.push({
      ...rest,
      beziehungen: (g.beziehungen || [])
        .filter(bz => bz && bz.name)
        .map(({ figur_id: _fid, ...bz }) => bz),
    });
    restored.push(g.name);
  }
  return restored;
}

function mergeKonsolParts(parts, log) {
  const out = [];
  let n = 0;
  let foreign = 0;
  let retargeted = 0;
  let carriedDup = 0;
  const restoredNames = [];
  const inputByPart = parts.map(p => _inputNames(p.input));
  for (const [pi, { input, figuren }] of parts.entries()) {
    restoredNames.push(...restoreOmittedFiguren(input, figuren));
    const figById = new Map();
    for (const f of (figuren || [])) if (f?.id != null && f.name) figById.set(String(f.id), f);
    // Zielname einer KI-Kante. Trägt sie den Rohnamen («Sebastian»), das Modell hat die
    // Figur hinter der id aber umbenannt, um Namensvettern zu trennen («Sebastian
    // (Mitlehrling)»), gilt der Ausgabe-Name — sonst bände der Rohname an den Vetter.
    const targetName = (bz) => {
      const byId = figById.get(String(bz.figur_id ?? ''));
      if (!bz.name) return byId?.name || null;
      return byId && byId.name !== bz.name && nameFitsFigure(bz.name, byId) ? byId.name : bz.name;
    };
    const inPart = inputByPart[pi];
    // Steht die Beschreibung einer KI-Kante wörtlich auf einer Eingabe-Kante zu genau
    // EINER Figur aus einem ANDEREN Teil, gilt deren Ziel: dieses Ziel hat im Teil keine
    // id, und eine erfundene trifft eine Figur des eigenen Teils (der Vater landet beim
    // Bruder). Ohne Korrektur übernähme der Schritt unten zusätzlich die echte Kante aus
    // der Eingabe — dieselbe Beschreibung stünde auf zwei Figuren. Ziele im eigenen Teil
    // bleiben: die hat das Modell gesehen und womöglich bewusst zusammengeführt.
    const targetsByDesc = _inputTargetsByDesc(input);
    const fixTarget = (name, desc) => {
      const targets = targetsByDesc.get(relationDescKey(desc));
      if (!targets || targets.size !== 1 || targets.has(normName(name))) return name;
      const [key, target] = [...targets.entries()][0];
      if (inPart.has(key)) return name;
      // «Herr Koch (Primarlehrer)» für den Eingabenamen «Herr Koch» ist dasselbe Ziel, nur
      // von Namensvettern unterschieden — der Rohname wäre wieder mehrdeutig.
      if (nameFitsFigure(target, { name })) return name;
      retargeted++;
      return target;
    };
    // Eine Ausgabe-Figur, deren Name nicht in diesem Teil, wohl aber in einem anderen
    // steht, hat das Modell aus einem Beziehungsziel erfunden — der andere Teil liefert
    // sie mit vollem Steckbrief. Neue kanonische Namen (in keinem Teil) bleiben.
    const ownedElsewhere = (f) => {
      const keys = [f?.name, f?.kurzname].map(normName).filter(Boolean);
      if (!keys.length || keys.some(k => inPart.has(k))) return false;
      return inputByPart.some((s, j) => j !== pi && keys.some(k => s.has(k)));
    };
    const kept = (figuren || []).filter(f => {
      if (!ownedElsewhere(f)) return true;
      foreign++;
      return false;
    });
    const partOut = kept.map(f => {
      const beziehungen = (f.beziehungen || []).map(bz => {
        if (!bz) return null;
        const name = targetName(bz);
        return name ? { ...bz, name: fixTarget(name, bz.beschreibung) } : null;
      }).filter(Boolean);
      return { ...f, id: 'fig_' + (++n), beziehungen };
    });
    // Kanten zu Figuren anderer Teile aus der Eingabe übernehmen: das Modell kannte deren
    // ids nicht und hat sie im Zweifel weggelassen.
    const outByName = new Map();
    for (const f of partOut) {
      for (const nm of [f.name, f.kurzname]) { const k = normName(nm); if (k && !outByName.has(k)) outByName.set(k, f); }
    }
    for (const cf of input) for (const g of (cf.figuren || [])) {
      const owner = outByName.get(normName(g.name)) || outByName.get(normName(g.kurzname));
      if (!owner) continue;
      for (const bz of (g.beziehungen || [])) {
        const k = normName(bz?.name);
        if (!k || inPart.has(k)) continue;
        if (owner.beziehungen.some(b => normName(b.name) === k)) continue;
        // Dieselbe Beschreibung steht schon auf einer Kante des Besitzers: das Modell
        // hat das Ziel umbenannt («Herr Koch» → «Herr Koch (Primarlehrer)»), die
        // Rohnamen-Kante wäre eine Kopie an den Namensvetter.
        const dk = relationDescKey(bz.beschreibung);
        if (dk && owner.beziehungen.some(b => relationDescKey(b.beschreibung) === dk)) { carriedDup++; continue; }
        owner.beziehungen.push({ ...bz });
      }
    }
    out.push(...partOut);
  }
  if (restoredNames.length) log?.info(`Figuren-Teile: ${restoredNames.length} von der KI weggelassene Figur(en) aus der Eingabe übernommen: ${sampleNames(restoredNames)}.`);
  if (foreign) log?.info(`Figuren-Teile: ${foreign} Figur(en) verworfen, die nur als Beziehungsziel aus einem anderen Teil stammten.`);
  if (retargeted) log?.info(`Figuren-Teile: ${retargeted} Beziehungs-Ziel(e) über die Eingabe-Beschreibung korrigiert.`);
  if (carriedDup) log?.info(`Figuren-Teile: ${carriedDup} Eingabe-Kante(n) nicht übernommen, die Beschreibung steht schon auf einer KI-Kante.`);
  rebindBeziehungenByName(out, log);
  return out;
}

/** Konsolidiert die Teile parallel. Ein Teil, der truncierte, wird einmal halbiert; was
 *  dann noch scheitert, geht regelbasiert (als Eingabe) in das Ergebnis ein. Wirft nur,
 *  wenn KEIN Teil durchkam — dann ist der Fallback des Aufrufers ehrlicher. */
async function runKonsolBatched(ctx, preMerged, { cap, charsPerToken, fromPct, toPct }) {
  const { jobId, bookName, call, tok, log, prompts, sys } = ctx;
  const maxChars = Math.max(20000, Math.floor(cap * KONSOL_BATCH_RESERVE * charsPerToken));
  const batches = planKonsolBatches(preMerged, maxChars);
  const count = (b) => b.reduce((s, cf) => s + (cf.figuren || []).length, 0);
  log.info(`Phase-2-Figuren-Konsolidierung in ${batches.length} Teilen (${batches.map(count).join('+')} Figuren, Ziel ≤${maxChars} Zeichen je Teil).`);
  updateJob(jobId, { statusText: 'job.phase.consolidatingFigurenParts', statusParams: { n: batches.length } });

  const konsol = (input, label) => retryOnTransientAi(() => call(jobId, tok,
    prompts.buildFiguresBasisConsolidationPrompt(bookName, input, sys.BUCH_KONTEXT || '', { teil: true }),
    sys.SYSTEM_FIGUREN_BLOCKS, fromPct, toPct, undefined, 0.2, cap, prompts.SCHEMA_FIGUREN_KONSOL,
    costTier(COST_LABEL.figuren),
  ), { log, label }).then(res => {
    if (!Array.isArray(res?.figuren)) throw i18nError('job.error.figurenMissing');
    return res.figuren;
  });

  const runPart = async (input, i) => {
    const label = `Figuren-Teil ${i + 1}/${batches.length}`;
    try {
      return [{ input, figuren: await konsol(input, label), ok: true }];
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      const halves = e?.message === 'job.error.aiTruncated' && count(input) > 1
        ? planKonsolBatches(input, Math.ceil(input.reduce((s, cf) => s + cf.figuren.reduce((t, f) => t + _figSize(f), 0), 0) / 2))
        : null;
      if (halves && halves.length > 1) {
        log.warn(`${label} – Truncation, Retry in ${halves.length} kleineren Teilen.`);
        const res = [];
        for (const [hi, h] of halves.entries()) {
          try { res.push({ input: h, figuren: await konsol(h, `${label}.${hi + 1}`), ok: true }); }
          catch (e2) {
            if (e2.name === 'AbortError') throw e2;
            log.warn(`${label}.${hi + 1} übersprungen (${i18nErrText(e2)}) – regelbasiert übernommen.`);
            res.push({ input: h, figuren: h.flatMap(cf => cf.figuren || []), ok: false });
          }
        }
        return res;
      }
      log.warn(`${label} übersprungen (${i18nErrText(e)}) – regelbasiert übernommen.`);
      return [{ input, figuren: input.flatMap(cf => cf.figuren || []), ok: false }];
    }
  };

  const settled = await settledAll(batches.map((b, i) => () => runPart(b, i)), { concurrency: KONSOL_CONCURRENCY });
  const aborted = settled.find(r => r.status === 'rejected' && r.reason?.name === 'AbortError');
  if (aborted) throw aborted.reason;
  const failed = settled.find(r => r.status === 'rejected');
  if (failed) throw failed.reason;
  const parts = settled.flatMap(r => r.value);
  const okParts = parts.filter(p => p.ok).length;
  if (!okParts) throw i18nError('job.error.figurenMissing');
  const figuren = mergeKonsolParts(parts, log);
  log.info(`Phase-2-Figuren-Konsolidierung: ${okParts}/${parts.length} Teile per KI, ${figuren.length} Figuren.`);
  return { figuren, degraded: okParts < parts.length };
}

module.exports = {
  KONSOL_SINGLE_RESERVE, KONSOL_BATCH_RESERVE,
  planKonsolBatches, mergeKonsolParts, runKonsolBatched, restoreOmittedFiguren, sampleNames,
};
