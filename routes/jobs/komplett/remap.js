'use strict';
const {
  db, saveZeitstrahlEvents, updateFigurenEvents, saveContinuityCheck,
  saveFaktencheckIssues, faktenfehlerIssues,
} = require('../../../db/schema');
const { _modelName } = require('../shared');
const { _refToString, _stelleQuote } = require('./utils');
const { NOW_ISO_SQL } = require('../../../db/now');
const { matchScenes, dedupeScenesWithinRun } = require('../../../lib/entity-match');
const searchIndex = require('../../../lib/search');
const { buildPageIndex, buildFactIndex, locateStelle, quotesFabricated } = require('../../../lib/continuity-evidence');
const { ATTR_SOURCE } = require('./attribute-check');
const { isUngroupedChapterName } = require('../../../lib/ungrouped-chapter');

/** Mappt Szenen-Klarnamen (aus Phase 1) auf konsolidierte Figuren-/Ort-IDs.
 *  Nicht auflösbare Namen (KI-Halluzination, Tippfehler, in Phase 2/3 wegkonsolidiert)
 *  werden gedroppt und – wenn `log` übergeben – aggregiert geloggt (sonst still). */
function remapSzenen(chSzenen, figNameToId, figNameToIdLower, ortNameToId, ortNameToIdLower, chNameToId, log = null) {
  const szenen = [];
  const droppedFig = new Set();
  const droppedOrt = new Set();
  for (const { kapitel, szenen: chSz } of (chSzenen || [])) {
    for (const s of (chSz || [])) {
      // Wie bei `seite` kann die KI auch beim Kapitel den ##-Präfix mitliefern.
      const rawKapitel = (s.kapitel || '').replace(/^#{1,6}\s+/, '').trim();
      const effKapitel = (rawKapitel && chNameToId[rawKapitel] != null) ? rawKapitel : kapitel;
      // LLM-Halluzination 1: Markdown-Header-Präfix («### Seitentitel» statt
      // «Seitentitel») – wortwörtlich aus der User-Message kopiert.
      // LLM-Halluzination 2: Kapitelname als Seitentitel zurückgegeben, weil der
      // echte Titel nicht erkannt wurde. Oder der Ersatzname für Abschnitte ohne Kapitel.
      // In beiden Fällen `seite` nullen / strippen, damit der page_id-Lookup
      // unten trifft.
      let effSeite = (s.seite || '').replace(/^#{1,6}\s+/, '').trim() || null;
      if (effSeite && (effSeite === effKapitel || isUngroupedChapterName(effSeite))) {
        effSeite = null;
      }
      szenen.push({
        kapitel: effKapitel,
        seite: effSeite,
        titel: s.titel || '(unbekannt)',
        wertung: s.wertung || null,
        kommentar: s.kommentar || null,
        fig_ids: (s.figuren_namen || []).map(n => {
          const name = _refToString(n);
          if (!name) return null;
          const id = figNameToId[name] || figNameToIdLower[name.toLowerCase()] || null;
          if (!id) droppedFig.add(name);
          return id;
        }).filter(Boolean),
        ort_ids: (s.orte_namen || []).map(n => {
          const name = _refToString(n);
          if (!name) return null;
          const id = ortNameToId[name] || ortNameToIdLower[name.toLowerCase()] || null;
          if (!id) droppedOrt.add(name);
          return id;
        }).filter(Boolean),
        sort_order: szenen.length,
      });
    }
  }
  if (log) {
    const sample = (set) => [...set].slice(0, 8).join(', ') + (set.size > 8 ? ' …' : '');
    if (droppedFig.size) log.warn(`Szenen-Remap: ${droppedFig.size} Figuren-Name(n) ohne ID ignoriert: ${sample(droppedFig)}`);
    if (droppedOrt.size) log.warn(`Szenen-Remap: ${droppedOrt.size} Ort-Name(n) ohne ID ignoriert: ${sample(droppedOrt)}`);
  }
  return szenen;
}

/** Mappt Assignments auf konsolidierte Figuren-IDs, dedupliziert und sortiert. */
function remapAssignments(chAssignments, figNameToId, figNameToIdLower, chNameToId, log, jobId) {
  const mergedEvtMap = new Map();
  let dropped = 0;

  for (const { kapitel, assignments: chAss } of (chAssignments || [])) {
    for (const assignment of (chAss || [])) {
      // figur_name kann als Objekt statt String kommen (KI-Drift) → _refToString,
      // sonst wirft .toLowerCase() und der gesamte Job failt nach gespeichertem Katalog.
      const figName = _refToString(assignment.figur_name);
      const figId = (figName && (figNameToId[figName] || figNameToIdLower[figName.toLowerCase()])) || null;
      if (!figId) {
        dropped++;
        log.warn(`Assignment «${figName ?? '(ohne Name)'}» (${assignment.lebensereignisse?.length || 0} Ereignisse) – keine Figuren-ID.`);
        continue;
      }
      if (!mergedEvtMap.has(figId)) mergedEvtMap.set(figId, []);
      for (const ev of (assignment.lebensereignisse || [])) {
        const evKap = (ev.kapitel || '').replace(/^#{1,6}\s+/, '').trim();
        const evSeite = (ev.seite || '').replace(/^#{1,6}\s+/, '').trim();
        mergedEvtMap.get(figId).push({
          ...ev,
          kapitel: (evKap && chNameToId[evKap] != null) ? evKap : kapitel,
          seite: evSeite || null,
        });
      }
    }
  }
  if (dropped > 0) log.warn(`${dropped} Assignments ohne Figuren-ID ignoriert.`);

  const allAssignments = [];
  for (const [fig_id, events] of mergedEvtMap) {
    const seen = new Set();
    const deduped = [];
    for (const ev of events) {
      const key = [ev.datum_year, ev.datum_month, ev.datum_day, (ev.ereignis || '').trim().toLowerCase()].join('||');
      if (!seen.has(key)) { seen.add(key); deduped.push(ev); }
    }
    allAssignments.push({ fig_id, lebensereignisse: deduped });
  }
  return allAssignments;
}

/** Match-Planung Szenen (NUR LESEND) — SSoT fuer beide Seiten: `saveSzenenAndEvents`
 *  ruft sie selbst, und der Job ruft sie VOR dem Speichern, um die unsicheren Paare vom
 *  KI-Judge beurteilen zu lassen. `resolved` sind die auf chapterId/pageId aufgeloesten
 *  Szenen (siehe resolveSzenenForSave), `locIdToDbId` die loc_id→locations.id-Map des
 *  Laufs. `hint` = Map(sceneHintKey → figure_scenes.id) der bestaetigten Paare. */
function planSzenenMatch(bookIdInt, email, resolved, locIdToDbId, hint = null) {
  const existing = db.prepare(
    'SELECT id, chapter_id, page_id, titel FROM figure_scenes WHERE book_id = ? AND user_email IS ?'
  ).all(bookIdInt, email);
  // Indizien fuers Matching (lib/entity-match.js#sceneEvidence): die Seite ist das
  // staerkste Signal, dazu die beteiligten Figuren/Orte. Bestand haelt INTEGER-ids,
  // die neuen Szenen fig_id/loc_id-Strings des Laufs — beide Seiten auf die
  // Bestands-ids bringen, sonst findet der Vergleich nie eine Ueberschneidung.
  const exFigRows = db.prepare(`
    SELECT sf.scene_id AS sid, sf.figure_id AS fid FROM scene_figures sf
    JOIN figure_scenes fs ON fs.id = sf.scene_id
    WHERE fs.book_id = ? AND fs.user_email IS ?`).all(bookIdInt, email);
  const exLocRows = db.prepare(`
    SELECT sl.scene_id AS sid, sl.location_id AS lid FROM scene_locations sl
    JOIN figure_scenes fs ON fs.id = sl.scene_id
    WHERE fs.book_id = ? AND fs.user_email IS ?`).all(bookIdInt, email);
  const exBridges = new Map();
  const bucket = (sid) => {
    if (!exBridges.has(sid)) exBridges.set(sid, { figures: [], locations: [] });
    return exBridges.get(sid);
  };
  for (const r of exFigRows) bucket(r.sid).figures.push(r.fid);
  for (const r of exLocRows) bucket(r.sid).locations.push(r.lid);
  const exCands = existing.map(ex => {
    const b = exBridges.get(ex.id) || { figures: [], locations: [] };
    return { ...ex, figures: b.figures, locations: b.locations };
  });
  const figRows = db.prepare(
    'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookIdInt, email);
  const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
  const incoming = resolved.map(s => ({
    titel: s.titel, chapterId: s.chapterId, pageId: s.pageId,
    figures: (s.fig_ids || []).map(f => figIdToRowId[f]).filter(v => v != null),
    locations: (s.ort_ids || []).map(l => locIdToDbId[l]).filter(Boolean),
  }));
  const plan = matchScenes(exCands, incoming, { hint });
  return { ...plan, existing };
}

/** Loest Szenen auf chapterId/pageId auf und dedupliziert Varianten desselben Laufs.
 *  Geteilt zwischen Match-Planung (Job) und Speichern — beide muessen auf DERSELBEN
 *  Szenenliste arbeiten, sonst zeigen die geplanten Indizes ins Leere. */
function resolveSzenenForSave(szenen, idMaps) {
  const resolvedRaw = szenen.map(s => {
    const chapterId = idMaps.chNameToId[s.kapitel] ?? null;
    const pageId = s.seite
      ? (idMaps.pageNameToIdByChapter[chapterId ?? 0]?.[s.seite] ?? null)
      : null;
    return { ...s, chapterId, pageId };
  });
  // Within-Run-Dedup: bisher gab es nur den EXAKTEN `titel|kapitel`-Schluessel im
  // Szenen-Backfill — zwei Titel-Varianten derselben Szene aus zwei Extraktions-
  // Paessen («Ankunft» / «Ankunft am Bahnhof», gleiche Seite) landeten als zwei
  // Szenen und beim naechsten Lauf als stale-Dublette. Konservativ (Kapitel gleich +
  // Titel-Teilmenge bzw. Seiten-Indiz), Pendant zu dedupeLocationsWithinRun.
  return dedupeScenesWithinRun(resolvedRaw);
}

/** Speichert Szenen und Figuren-Events in die DB. Gibt { szenenCount, eventsCount } zurück. */
function saveSzenenAndEvents(bookIdInt, email, szenen, assignments, locIdToDbId, idMaps, log, jobId, opts = {}) {
  // Teil-Lauf: die beiden Schritte teilen sich diesen Schreibpfad, sind aber
  // einzeln abwählbar. `writeSzenen: false` MUSS die Szenen-Transaktion ganz
  // auslassen — mit leerer Liste würde ihr Reconcile jede bestehende Szene als
  // verschwunden markieren (stale=1), also genau den Bestand entwerten, den das
  // Abwählen schützen soll.
  const writeSzenen = opts.writeSzenen !== false;
  const writeEvents = opts.writeEvents !== false;
  if (writeSzenen) db.transaction(() => {
    // Reconcile statt DELETE+INSERT, damit figure_scenes.id (und FK-Refs darauf:
    // research_item_links.scene_id, scene_locations) ueber Re-Analysen stabil bleibt.
    // figure_scenes hat keinen lauf-stabilen Identifier → Match ueber matchScenes (pro
    // Kapitel: exakter Titel → Token-Teilmenge des Titels), damit leichte Titel-Varianten
    // zwischen Laeufen nicht als stale-Dublette akkumulieren; re-detektiert behaelt id +
    // stale=0, verschwundene → stale=1 statt Loeschen. Spiegelt das figures-/locations-
    // Reconcile-Netz.
    // Eingehende Szenen vorab auf chapter_id/page_id aufloesen (fuer Match-Key + Save).
    // Aufloesen + Within-Run-Dedup: der Job hat (falls er geplant hat) auf genau
    // dieser Liste geplant — siehe resolveSzenenForSave.
    const { szenen: resolved, unsure: dedupUnsure } = opts.resolved || resolveSzenenForSave(szenen, idMaps);
    if (szenen.length !== resolved.length) {
      log.info(`Szenen-Within-Run-Dedup: ${szenen.length - resolved.length} Titel-Variante(n) derselben Szene verschmolzen.`);
    }
    // Within-Run-Verdachtsfaelle bleiben getrennt (Begruendung wie bei den Orten in
    // phases/orte.js): der Judge-Hint zeigt auf eine Bestands-Zeile, nicht auf einen
    // zweiten Eintrag desselben Laufs.
    if (dedupUnsure?.length) {
      log.info(`Szenen-Within-Run: ${dedupUnsure.length} aehnliche Titel-Paar(e) bewusst getrennt gelassen.`);
    }
    const sceneMatch = planSzenenMatch(bookIdInt, email, resolved, locIdToDbId, opts.matchHint || null);
    const existing = sceneMatch.existing;
    const matchOf = sceneMatch.matchOf;                // resolvedIndex → existingId
    const usedExisting = new Set(matchOf.values());
    // Verschwundene → stale=1 (Refs bleiben), statt Loeschen.
    const markStale = db.prepare('UPDATE figure_scenes SET stale = 1 WHERE id = ?');
    for (const ex of existing) if (!usedExisting.has(ex.id)) markStale.run(ex.id);

    const ins = db.prepare(`INSERT INTO figure_scenes
      (book_id, user_email, titel, wertung, kommentar, chapter_id, page_id, sort_order, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ${NOW_ISO_SQL})`);
    const upd = db.prepare(`UPDATE figure_scenes
      SET titel=?, wertung=?, kommentar=?, chapter_id=?, page_id=?, sort_order=?, stale=0, updated_at=${NOW_ISO_SQL}
      WHERE id=?`);
    const delSf = db.prepare('DELETE FROM scene_figures WHERE scene_id = ?');
    const delSl = db.prepare('DELETE FROM scene_locations WHERE scene_id = ?');
    // scene_figures.figure_id ist INTEGER (figures.id) seit Mig 73 — Lookup TEXT → INT.
    const figRows = db.prepare(
      'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookIdInt, email);
    const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
    const insSf = db.prepare('INSERT OR IGNORE INTO scene_figures (scene_id, figure_id) VALUES (?, ?)');
    const insSl = db.prepare('INSERT OR IGNORE INTO scene_locations (scene_id, location_id) VALUES (?, ?)');
    for (let i = 0; i < resolved.length; i++) {
      const s = resolved[i];
      const existingId = matchOf.get(i);
      let sceneId;
      if (existingId != null) {
        upd.run(s.titel, s.wertung, s.kommentar, s.chapterId, s.pageId, s.sort_order, existingId);
        sceneId = existingId;
        // Analyse-Bridges neu schreiben (CASCADE-Kinder ohne externe Refs).
        delSf.run(sceneId);
        delSl.run(sceneId);
      } else {
        const r = ins.run(
          bookIdInt, email,
          s.titel, s.wertung, s.kommentar,
          s.chapterId, s.pageId,
          s.sort_order,
        );
        sceneId = r.lastInsertRowid;
      }
      for (const fid of s.fig_ids) {
        const rowId = figIdToRowId[fid];
        if (rowId != null) insSf.run(sceneId, rowId);
      }
      for (const locIdStr of s.ort_ids) {
        const dbLocId = locIdToDbId[locIdStr];
        if (dbLocId) insSl.run(sceneId, dbLocId);
      }
    }
  })();

  const eventsCount = writeEvents ? assignments.reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0) : 0;
  if (eventsCount > 0) {
    saveZeitstrahlEvents(bookIdInt, email, []);
    updateFigurenEvents(bookIdInt, assignments, email, idMaps);
  }
  // `figure_appearances` baut der Job selbst neu auf, gleich nach diesem Aufruf
  // (rebuildFigureAppearances) — dort liegt die konsolidierte Figuren-Liste, die als
  // dritte Quelle dazugehört. Hier wird der Index absichtlich nicht angefasst.
  // figure_scenes neu indexieren — Full-Replace pro Buch (kind/book
  // droppen, dann Re-Upsert aller aktuellen Rows).
  if (writeSzenen) {
    searchIndex.removeKindForBook('scene', bookIdInt);
    const sceneRows = db.prepare('SELECT id FROM figure_scenes WHERE book_id = ?').all(bookIdInt);
    for (const r of sceneRows) searchIndex.upsertScene(r.id);
  }
  // Figuren wurden im selben Job-Run via saveFigurenToDb persistiert — die
  // figures-Daten haben sich potentiell geaendert (Beschreibungen, Namen).
  searchIndex.removeKindForBook('figure', bookIdInt);
  const figRows = db.prepare('SELECT id FROM figures WHERE book_id = ?').all(bookIdInt);
  for (const f of figRows) searchIndex.upsertFigure(f.id);
  searchIndex.removeKindForBook('location', bookIdInt);
  const locRows = db.prepare('SELECT id FROM locations WHERE book_id = ?').all(bookIdInt);
  for (const l of locRows) searchIndex.upsertLocation(l.id);
  log.info(`${writeSzenen ? szenen.length : 0} Szenen, ${eventsCount} Ereignisse gespeichert.`);
  return { szenenCount: writeSzenen ? szenen.length : 0, eventsCount };
}

// Server-Spiegel von KONTINUITAET_TYPEN (public/js/prompts/komplett/schema-strings.js,
// ESM — hier kein Import möglich) plus `faktenfehler` (Faktencheck-Job). Ein unbekannter
// typ (Freitext-Pfad ohne Schema-Zwang) wird beim Speichern zu `sonstiges` — sonst
// rendert die Karte einen rohen Key ohne Label. Drift-Test:
// tests/unit/kontinuitaet-typen-drift.test.mjs.
const KONTINUITAET_TYPEN = [
  'figur', 'name', 'zeitlinie', 'zeitluecke', 'ort', 'objekt', 'verhalten',
  'soziolekt', 'erzaehlform', 'anachronismus', 'sonstiges', 'faktenfehler',
];
const _TYP_SET = new Set(KONTINUITAET_TYPEN);
function _normTyp(typ) {
  const t = typeof typ === 'string' ? typ.trim().toLowerCase() : '';
  return _TYP_SET.has(t) ? t : 'sonstiges';
}

// Form-Härtung: das Modell liefert gelegentlich einen String statt einer Liste, null-
// Einträge oder eine Nicht-URL als Quelle. Nichts davon darf den Save werfen lassen
// oder als Müll in der Karte landen.
function _asList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) return [v];
  return [];
}
function _str(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return _refToString(v) || '';
  return v == null ? '' : String(v);
}
function _httpUrl(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^https?:\/\//i.test(s) ? s : null;
}

// Selbst-Entwarnung: massgeblich ist ausschliesslich das Pflichtfeld `entwarnung`
// (SCHEMA_KONTINUITAET_PROBLEME, PROBLEME_RULES in public/js/prompts/komplett/schema-
// strings.js). Kein Text-Fallback über die Prosa: ein Muster wie «bis Kapitel 5 konsistent»
// steht genauso in echten Befunden, und ein verworfener Befund ist jetzt sichtbar
// (Karte «Verworfen») — ein übersehenes Feld kostet einen Klick, ein falscher Regex-
// Treffer kostete einen echten Fehler. Der String «true» zählt mit: Provider-Pfade ohne
// Schema-Zwang liefern Booleans gelegentlich als Text.
function _isEntwarnung(p) {
  return p?.entwarnung === true || (typeof p?.entwarnung === 'string' && p.entwarnung.trim().toLowerCase() === 'true');
}

/** Speichert Kontinuitätsprüfung in die DB (eine Zeile pro Issue + Bridge-Tabellen
 *  für Figuren-/Kapitel-Referenzen). Gibt normalizedIssues (die offenen Befunde)
 *  zurück, oder null bei ungültiger Antwort.
 *
 *  Verworfen wird nie still: Selbst-Entwarnungen (`entwarnung`), Befunde mit erfundenem
 *  Zitat und die von der Verify-Stufe abgelehnten (`kontResult.verworfen`, siehe
 *  job-shared.js#verifyKontinuitaetProbleme) landen mit Grund als verworfene Zeilen im
 *  selben Check (db/continuity.js, `discard_reason`).
 *
 *  opts.pageContents: geladene Seiten ({id,title,chapter,chapter_id,text}) — Basis der
 *    Beleg-Prüfung und der Seiten-Anker (page_a_id/page_b_id).
 *  opts.requireQuoteEvidence: Zitate sind wörtliche Buchsätze (Single-Pass) → ein
 *    Befund mit einem im Buch nicht auffindbaren Zitat gilt als erfunden. Satzzeichen-
 *    Abweichungen zählen nicht (quote-verify `ignorePunctuation`).
 *  opts.chapterFacts: Multi-Pass-Fakten ({kapitel,fakten[{fakt,seite}]}) — dort zitiert
 *    das Modell Fakten statt Buchsätzen; der Seitenname des Fakts liefert den Anker.
 *  opts.stats: optionales Objekt, in das `discarded` (Anzahl verworfener Befunde dieses
 *    Laufs) geschrieben wird — fürs Job-Result. */
function saveKontinuitaetResult(bookIdInt, email, kontResult, figNameToId, chNameToId, effectiveProvider, log, opts = {}) {
  const { pageContents = null, requireQuoteEvidence = false, chapterFacts = null, stats = null } = opts;
  if (typeof kontResult?.zusammenfassung === 'undefined') return null;
  const isObj = (p) => p && typeof p === 'object' && !Array.isArray(p);
  const rawProbleme = (Array.isArray(kontResult.probleme) ? kontResult.probleme : []).filter(isObj);
  const discarded = [];
  // Verify-Verwürfe (Multi-Pass) kommen vom Aufrufer mit Grund.
  for (const v of (Array.isArray(kontResult.verworfen) ? kontResult.verworfen : [])) {
    if (isObj(v?.problem)) discarded.push({ p: v.problem, reason: 'verify', detail: _str(v.grund) || null });
  }
  let filtered = [];
  for (const p of rawProbleme) {
    if (_isEntwarnung(p)) discarded.push({ p, reason: 'entwarnung', detail: null });
    else filtered.push(p);
  }
  const selfCancelled = discarded.filter(d => d.reason === 'entwarnung').length;
  if (selfCancelled > 0) log.warn(`Kontinuität: ${selfCancelled} Selbst-Entwarnung(en) verworfen (als «verworfen» gespeichert).`);
  const kapOf = (p) => _asList(p.kapitel).map(_refToString).filter(Boolean);

  const pages = buildPageIndex(pageContents);
  // Beleg-Prüfung NUR für Single-Pass-Pfade (voller Buchtext im Prompt, Zitat-Pflicht
  // ist wörtlich). Der Multi-Pass-Fakten-Pfad zitiert Fakt-Aussagen, nicht den Buchtext
  // → dort hat die separate Verify-Stufe den Originaltext geprüft.
  if (requireQuoteEvidence && pages.length) {
    const hayNorm = pages.map(p => p.norm).join(' ');
    const hayLoose = pages.map(p => p.loose).join(' ');
    // Befunde des Attribut-Detektors (F4, attribute-check.js, `_source: 'attr'`) tragen
    // synthetische Stellen («Geburtsjahr: 1952 (Kapitel 3)», Szenentitel, Attributwerte
    // mit Anführungszeichen) — kein Buchzitat, also auch nichts, was erfunden sein könnte.
    // Ein Zitat unter der Mindestgrösse (_stelleQuote) gilt als «kein Zitat»: weder
    // Beleg noch Fabrikations-Nachweis.
    const kept = [];
    let evDropped = 0;
    for (const p of filtered) {
      const kapitel = kapOf(p);
      const fabricated = p._source !== ATTR_SOURCE && quotesFabricated(
        [_stelleQuote(_str(p.stelle_a), { kapitel }), _stelleQuote(_str(p.stelle_b), { kapitel })],
        hayNorm, { hayLoose });
      if (fabricated) { discarded.push({ p, reason: 'zitat', detail: null }); evDropped++; }
      else kept.push(p);
    }
    filtered = kept;
    if (evDropped > 0) log.warn(`Kontinuität: ${evDropped} Problem(e) mit erfundenem Beleg-Zitat (nicht im Buchtext) verworfen (als «verworfen» gespeichert).`);
  }

  const facts = chapterFacts ? buildFactIndex(chapterFacts) : null;
  const anchor = (stelle, kapitel) => {
    const page = locateStelle(_refToString(stelle) || '', _stelleQuote(stelle, { kapitel }), pages, { kapitel, facts });
    return page ? page.id : null;
  };
  const toIssue = (p) => {
    const kapitel = kapOf(p);
    const stelleA = _str(p.stelle_a);
    const stelleB = _str(p.stelle_b);
    return {
      schwere: p.schwere, typ: _normTyp(p.typ), beschreibung: _str(p.beschreibung),
      stelle_a: stelleA, stelle_b: stelleB, empfehlung: _str(p.empfehlung),
      quelle: _httpUrl(p.quelle),
      page_a_id: anchor(stelleA, kapitel),
      page_b_id: anchor(stelleB, kapitel),
      figuren: _asList(p.figuren).map(_refToString).filter(Boolean),
      kapitel,
    };
  };
  const issues = filtered.map(toIssue);
  const discardedIssues = discarded.map(d => ({ ...toIssue(d.p), discard: { reason: d.reason, detail: d.detail } }));
  const { normalizedIssues } = saveContinuityCheck(
    bookIdInt, email, kontResult.zusammenfassung || '',
    _modelName(effectiveProvider), issues, figNameToId, chNameToId, discardedIssues,
  );
  if (stats && typeof stats === 'object') stats.discarded = (stats.discarded || 0) + discardedIssues.length;
  const carried = normalizedIssues.filter(i => i.resolved || i.dismissed).length;
  log.info(`Kontinuitätsprüfung gespeichert (${normalizedIssues.length} Probleme${carried ? `, Triage von ${carried} übernommen` : ''}${discardedIssues.length ? `, ${discardedIssues.length} verworfen` : ''}).`);
  // Faktencheck-Befunde aus dem Urteils-Cache in den neuen Check nachziehen — sonst
  // verdeckte jeder Kontinuitätslauf (Komplettanalyse wie Standalone) die belegten
  // Abweichungen bis zum nächsten Faktencheck. Kein KI-Call, keine Web-Suche.
  const faktenfehler = faktenfehlerIssues(bookIdInt, email);
  if (faktenfehler.length) {
    const { normalizedIssues: ff } = saveFaktencheckIssues(
      bookIdInt, email, _modelName(effectiveProvider), faktenfehler, {}, chNameToId);
    normalizedIssues.push(...ff);
    log.info(`${ff.length} Faktenfehler aus dem Faktencheck übernommen.`);
  }
  return normalizedIssues;
}

module.exports = {
  planSzenenMatch, resolveSzenenForSave, remapSzenen, remapAssignments, saveSzenenAndEvents, saveKontinuitaetResult, _isEntwarnung,
  KONTINUITAET_TYPEN };
