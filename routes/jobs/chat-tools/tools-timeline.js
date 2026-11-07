'use strict';
// Temporal-Aggregat-Tools: Kontinuitaetspruefungen + Zeitstrahl-Events.
// Beide bauen auf Subqueries mit MAX(checked_at) bzw. sort_order auf und
// haengen via Bridge-Tabellen (issue_figures/issue_chapters bzw.
// event_chapters/event_pages/event_figures) an figures/pages/chapters.
// Das SQL liegt in db/book-chat/timeline.js.

const {
  getLatestContinuityCheck,
  listContinuityIssuesForCheck,
  listContinuityIssueFigures,
  listContinuityIssueChapters,
  listTimelineEvents,
  listTimelineEventFigures,
  listTimelineEventChapters,
  listTimelineEventPages,
  findDatedEvents,
} = require('../../../db/book-chat/timeline');
const { getFigureRow } = require('../../../db/book-chat/figures');
const { listFigureAges, getFigureAgeScan } = require('../../../db/figure-ages');
const { getBookSettings } = require('../../../db/book-settings');
const { getDescendantChapterIds } = require('../../../db/book-order');
const { birthCandidates, resolveBirth, resolveBirthsForFigures } = require('../../../lib/figure-birth');
const { activeBookSchulsystem } = require('../../../lib/buchtyp');
const { getSchoolPath, listFiguresForSchoolPath } = require('../../../db/figure-school-paths');
const { schoolPath, ageAtModule, figureStationen } = require('../../../lib/esm-bridge');
const { listStationenForFigure } = require('../../../db/figure-stationen');
const { schoolLabel } = require('../../../lib/school-labels');
const { _truncateResult, _findFigure, offeredList, toolHint } = require('./shared');

// ── list_continuity_issues ────────────────────────────────────────────────────

const CONTINUITY_DEFAULT_LIMIT = 30;

function tool_list_continuity_issues(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const check = getLatestContinuityCheck(ctx.bookId, userEmail);
  if (!check) {
    return {
      issues: [],
      hint: 'Kein Kontinuitätscheck vorhanden. Job „Kontinuität" ausführen.',
    };
  }

  const schwereFilter = typeof input?.schwere === 'string' ? input.schwere.toLowerCase() : null;
  const typFilter     = typeof input?.typ === 'string'     ? input.typ.toLowerCase()     : null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id           : null;
  const limit = Math.min(100, Math.max(1, Number.isInteger(input?.limit) ? input.limit : CONTINUITY_DEFAULT_LIMIT));

  let issues = listContinuityIssuesForCheck(check.id);

  if (schwereFilter) issues = issues.filter(i => (i.schwere || '').toLowerCase() === schwereFilter);
  if (typFilter)     issues = issues.filter(i => (i.typ || '').toLowerCase()     === typFilter);

  if (!issues.length) {
    return { check_id: check.id, checked_at: check.checked_at, summary: check.summary || null, issues: [], total: 0 };
  }

  const issueIds = issues.map(i => i.id);

  const figRows = listContinuityIssueFigures(issueIds);
  const chRows = listContinuityIssueChapters(issueIds);

  const figByIssue = new Map();
  for (const r of figRows) {
    if (!r.name) continue;
    if (!figByIssue.has(r.issue_id)) figByIssue.set(r.issue_id, []);
    figByIssue.get(r.issue_id).push({ fig_id: r.fig_id || null, name: r.name });
  }
  const chByIssue = new Map();
  for (const r of chRows) {
    if (!chByIssue.has(r.issue_id)) chByIssue.set(r.issue_id, []);
    chByIssue.get(r.issue_id).push({ chapter_id: r.chapter_id, chapter_name: r.chapter_name || null });
  }

  let enriched = issues.map(i => ({
    issue_id: i.id,
    schwere: i.schwere || null,
    typ: i.typ || null,
    beschreibung: i.beschreibung || null,
    stelle_a: i.stelle_a || null,
    stelle_b: i.stelle_b || null,
    empfehlung: i.empfehlung || null,
    figuren: figByIssue.get(i.id) || [],
    kapitel: chByIssue.get(i.id) || [],
  }));

  if (chapterFilter != null) {
    // Kapitel = Teilbaum: ein Befund im Unterkapitel gehoert auch zum Teil.
    const scope = new Set(getDescendantChapterIds(chapterFilter, { includeSelf: true }));
    enriched = enriched.filter(i => i.kapitel.some(c => scope.has(c.chapter_id)));
  }

  const total = enriched.length;
  const limited = enriched.slice(0, limit);

  return _truncateResult({
    check_id: check.id,
    checked_at: check.checked_at,
    summary: check.summary || null,
    model: check.model || null,
    issues: limited,
    total,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
  });
}

// ── get_timeline ──────────────────────────────────────────────────────────────

const TIMELINE_DEFAULT_LIMIT = 60;

function tool_get_timeline(input, ctx) {
  const userEmail = ctx.userEmail || '';
  let focusFig = null;
  if (input?.figur_id || input?.figur_name) {
    focusFig = _findFigure(input, ctx);
    if (!focusFig) return { error: 'Figur nicht gefunden', errorKey: 'chat.toolError.figureNotFound', hint: 'Prüfe die Figurenliste im System-Prompt.' };
  }
  const typFilter = typeof input?.typ === 'string' ? input.typ.toLowerCase() : null;
  const limit = Math.min(200, Math.max(1, Number.isInteger(input?.limit) ? input.limit : TIMELINE_DEFAULT_LIMIT));

  const events = listTimelineEvents(ctx.bookId, userEmail);

  if (!events.length) {
    return {
      events: [],
      hint: 'Kein Zeitstrahl vorhanden. Komplettanalyse ausführen (Phase 6).',
    };
  }

  const eventIds = events.map(e => e.id);

  const chRows = listTimelineEventChapters(eventIds);
  const pgRows = listTimelineEventPages(eventIds);
  const fgRows = listTimelineEventFigures(eventIds);

  const chByEvt = new Map();
  for (const r of chRows) {
    if (!chByEvt.has(r.event_id)) chByEvt.set(r.event_id, []);
    chByEvt.get(r.event_id).push({ chapter_id: r.chapter_id, chapter_name: r.chapter_name || null });
  }
  const pgByEvt = new Map();
  for (const r of pgRows) {
    if (!pgByEvt.has(r.event_id)) pgByEvt.set(r.event_id, []);
    pgByEvt.get(r.event_id).push({ page_id: r.page_id, page_name: r.page_name || null });
  }
  const fgByEvt = new Map();
  for (const r of fgRows) {
    if (!r.name) continue;
    if (!fgByEvt.has(r.event_id)) fgByEvt.set(r.event_id, []);
    fgByEvt.get(r.event_id).push({ fig_id: r.fig_id || null, name: r.name });
  }

  let enriched = events.map(e => ({
    datum: e.datum,
    ereignis: e.ereignis,
    typ: e.typ || 'persoenlich',
    bedeutung: e.bedeutung || null,
    kapitel: chByEvt.get(e.id) || [],
    seiten:  pgByEvt.get(e.id) || [],
    figuren: fgByEvt.get(e.id) || [],
  }));

  if (typFilter) enriched = enriched.filter(e => (e.typ || '').toLowerCase() === typFilter);
  if (focusFig) {
    enriched = enriched.filter(e => e.figuren.some(f => f.fig_id === focusFig.fig_id));
  }

  const total = enriched.length;
  const limited = enriched.slice(0, limit);

  return _truncateResult({
    ...(focusFig ? { focus: { fig_id: focusFig.fig_id, name: focusFig.name } } : {}),
    events: limited,
    total,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
  });
}

// ── get_figure_age ────────────────────────────────────────────────────────────
// Alter/Jahrgang einer Figur zu einem Jahr bzw. zu datierten Ereignissen. Die Rechnung
// läuft HIER, nicht im Modell: ein Sprachmodell rechnet «1989 − 1961» zuverlässig
// falsch genug, dass eine Altersangabe im Chat nicht mehr belegt ist. Quellen sind die
// vorhandenen Daten (docs/figur-alter.md, docs/figur-lebenslauf.md): Steckbrief-Feld
// `geburtstag`, Geburts-Ereignis im Zeitstrahl, Alters-Index (figure_ages). Kein
// KI-Call, keine Schätzung — fehlt ein Geburtsjahr, sagt das Ergebnis genau das.
// Die Rechnung selbst (`ageAt`) liegt in public/js/book/age-at.js — dieselbe wie der
// Stichtag im Reiter «Alter» der Figuren-Karte.

const AGE_EVENT_LIMIT = 10;
const AGE_BELEGE_LIMIT = 5;

const _monat = (m) => (Number.isInteger(m) && m >= 1 && m <= 12 ? m : null);

// Berufsweg und Hobbys (docs/figur-lebenslauf.md «Berufsweg und Hobbys»): nur
// übernommene/vom Autor erfasste Zeilen, keine offenen Vorschläge. «Am Stichtag»
// rechnet book/figure-stationen.js — dieselbe Rechnung wie die Alterstabelle.
const STATIONEN_LIMIT = 12;
function _stationKurz(kind, s) {
  return {
    ...(kind === 'berufe'
      ? { art: s.art, taetigkeit: s.taetigkeit, ...(s.arbeitgeber ? { arbeitgeber: s.arbeitgeber } : {}) }
      : { hobby: s.hobby }),
    ...(s.ort ? { ort: s.ort } : {}),
    ...(s.von_jahr != null ? { von: s.von_monat ? `${s.von_jahr}-${String(s.von_monat).padStart(2, '0')}` : s.von_jahr } : {}),
    ...(s.bis_jahr != null ? { bis: s.bis_monat ? `${s.bis_jahr}-${String(s.bis_monat).padStart(2, '0')}` : s.bis_jahr } : {}),
    ...(s.notiz ? { notiz: s.notiz } : {}),
  };
}
async function _stationenFor(figureId) {
  const out = {};
  for (const kind of ['berufe', 'hobbys']) {
    const list = listStationenForFigure(kind, figureId, { nurAktiv: true });
    if (list.length) out[kind] = list;
  }
  return out;
}
async function _stationenAm(stationen, jahr, monat) {
  const { stationenAm } = await figureStationen();
  const out = {};
  for (const [kind, list] of Object.entries(stationen)) {
    const am = stationenAm(list, { jahr, monat });
    if (am.length) out[kind] = am.map(s => ({ ..._stationKurz(kind, s), ...(s.unsicher ? { beginn_unbekannt: true } : {}) }));
  }
  return Object.keys(out).length ? out : null;
}

/** Schulstufe-Rechner für eine Figur — null ohne Schulsystem des Buchs oder ohne
 *  Geburt (und ohne Einschulungs-Override). Gerechnet in der Rechenschicht
 *  public/js/book/school-path.js (dieselbe wie Figuren-Karte und Lebenslauf). */
async function _schoolStager(ctx, fig, birth, lang) {
  const stored = await activeBookSchulsystem(ctx.bookId);
  if (!stored) return null;
  const sp = await schoolPath();
  const system = sp.resolveSchulsystem(stored);
  if (!system) return null;
  const path = getSchoolPath(fig.id);
  const figur = path ? { weg: path.weg, einschulung_jahr: path.einschulung_jahr, repetitionen: path.repetitionen } : null;
  if (!birth && figur?.einschulung_jahr == null) return null;
  const fmt = (r) => {
    if (!r) return null;
    const out = { status: r.status, schuljahr: r.schuljahr };
    if (r.status === 'schule') {
      out.stufe = schoolLabel(sp.stufeLabelKey(r.stufe), lang);
      out.klasse = schoolLabel(sp.klasseLabelKey(r.stufe), lang, { n: r.klasse });
      if (r.repetition) out.repetition = true;
    } else if (r.status === 'abgeschlossen') {
      out.letzte_stufe = r.letzte_stufe ? schoolLabel(sp.stufeLabelKey(r.letzte_stufe), lang) : null;
      out.abschluss_jahr = r.abschluss_jahr;
    } else {
      out.einschulung = r.einschulung;
    }
    if (r.unsicher) out.unsicher_alternative = fmt({ ...r.alternative, schuljahr: r.schuljahr });
    return out;
  };
  const args = { geburt: birth ? { y: birth.y, m: birth.m, d: birth.d } : null, system, figur };
  return {
    weg: schoolLabel(sp.wegLabelKey(sp.figurWeg(system, figur)), lang),
    // Ein Weg-Key, den das System nicht (mehr) kennt, rechnet mit dem Standardweg —
    // dann heisst die Quelle auch so, statt den Autor zu behaupten.
    weg_quelle: figur?.weg && sp.wegGueltig(system, figur) ? (path.source || 'autor') : 'standard',
    zumJahr(jahr) {
      const r = sp.schoolStagesForYear({ ...args, jahr });
      return r ? { herbst: fmt(r.herbst), ...(r.fruehjahr ? { fruehjahr: fmt(r.fruehjahr) } : {}) } : null;
    },
    // Schulzeit als Zeiträume je Stufe — «wann ging X in die Primarschule».
    zeiten() {
      const z = sp.schulZeiten(args);
      if (!z) return null;
      return {
        stufen: z.stufen.map(st => ({ stufe: schoolLabel(sp.stufeLabelKey(st.stufe), lang), von: st.von, bis: st.bis })),
        einschulung: z.einschulung, abschluss: z.abschluss,
        ...(z.unsicher ? { unsicher: true, einschulung_alternative: z.einschulung_alternative, hinweis: 'Geburtstag relativ zum Einschulungs-Stichtag unbekannt: alle Grenzen ggf. ein Jahr verschoben.' } : {}),
      };
    },
    zuDatum(jahr, monat) {
      if (!monat) return this.zumJahr(jahr);
      return fmt(sp.schoolStageAt({ ...args, jahr, monat }));
    },
  };
}

// Ohne Figur, mit `jahr`: alle Figuren zum Stichtag in EINEM Aufruf. Die Frage
// «wer ist im Juni 2001 wie alt» kostete sonst einen Aufruf je Figur.
async function _ageTableAt(input, ctx) {
  const userEmail = ctx.userEmail || '';
  const { ageAt } = await ageAtModule();
  const monat = _monat(input.monat);
  const lang = getBookSettings(ctx.bookId, userEmail)?.language || 'de';
  const figs = listFiguresForSchoolPath(ctx.bookId, userEmail);
  const births = resolveBirthsForFigures(ctx.bookId, userEmail, figs);
  const figuren = [], ohne = [];
  for (const f of figs) {
    const birth = births.get(f.id);
    if (!birth) { ohne.push(f.name); continue; }
    const row = {
      fig_id: f.fig_id, name: f.name,
      geburt: { jahr: birth.y, ...(birth.m ? { monat: birth.m } : {}), quelle: birth.quelle },
      ...ageAt(birth, { y: input.jahr, m: monat }),
    };
    if (birth.widerspruch) row.geburtsjahr_widerspruch = birth.widerspruch;
    const schule = await _schoolStager(ctx, f, birth, lang);
    const stufe = schule?.zuDatum(input.jahr, monat);
    if (stufe) row.schulstufe = stufe;
    const zeiten = schule?.zeiten();
    if (zeiten) row.schulzeit = zeiten;
    const taetig = await _stationenAm(await _stationenFor(f.id), input.jahr, monat);
    if (taetig) row.taetigkeiten = taetig;
    figuren.push(row);
  }
  return _truncateResult({
    stichtag: { jahr: input.jahr, ...(monat ? { monat } : {}) },
    total_mit_geburt: figuren.length,
    total_ohne_geburt: ohne.length,
    ...(monat ? {} : { rechnung: 'Ohne Monat: Alter als Spanne, wo der Geburtstag im Jahr offen ist.' }),
    figuren,
    ohne_geburtsjahr: ohne,
  });
}

async function tool_get_figure_age(input, ctx) {
  const userEmail = ctx.userEmail || '';
  if (!input?.figur_id && !input?.figur_name) {
    if (Number.isInteger(input?.jahr)) return _ageTableAt(input, ctx);
    return { error: 'figur_id, figur_name oder jahr erforderlich.', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'figur_id/figur_name/jahr' } };
  }
  const { ageAt } = await ageAtModule();
  const fig = _findFigure(input, ctx);
  if (!fig) return { error: 'Figur nicht gefunden', errorKey: 'chat.toolError.figureNotFound', hint: 'Prüfe die Figurenliste im System-Prompt.' };

  const ageRow = listFigureAges(ctx.bookId, userEmail).find(a => a.fig_id === fig.fig_id) || null;
  const row = getFigureRow(fig.id);
  const { birth, widerspruch } = resolveBirth(
    birthCandidates(ctx.bookId, userEmail, { id: fig.id, geburtstag: row?.geburtstag }, ageRow?.geburtsjahr ?? null));

  const out = {
    figur: { fig_id: fig.fig_id, name: fig.name },
    geburt: birth ? { jahr: birth.y, ...(birth.m ? { monat: birth.m } : {}), ...(birth.d ? { tag: birth.d } : {}), quelle: birth.quelle } : null,
    ...(widerspruch ? { geburtsjahr_widerspruch: widerspruch } : {}),
    zeitlinie_real: !!getBookSettings(ctx.bookId, userEmail)?.zeitlinie_real,
  };
  const schule = await _schoolStager(ctx, fig, birth, getBookSettings(ctx.bookId, userEmail)?.language || 'de');
  if (schule) {
    out.schulweg = { weg: schule.weg, quelle: schule.weg_quelle };
    const zeiten = schule.zeiten();
    if (zeiten) out.schulweg.schulzeit = zeiten;
  }

  const stationen = await _stationenFor(fig.id);
  for (const [kind, list] of Object.entries(stationen)) out[kind] = list.slice(0, STATIONEN_LIMIT).map(st => _stationKurz(kind, st));

  if (ageRow) {
    out.alters_index = {
      alter_von: ageRow.alter_von, alter_bis: ageRow.alter_bis,
      bezugsjahr_von: ageRow.bezugsjahr_von, bezugsjahr_bis: ageRow.bezugsjahr_bis,
      gerechnet: ageRow.gerechnet, konfidenz: ageRow.konfidenz,
      belege: (ageRow.belege || []).slice(0, AGE_BELEGE_LIMIT).map(b => ({
        art: b.art, wert: b.wert, bezugsjahr: b.bezugsjahr, zitat: b.zitat, page_id: b.page_id, page_name: b.page_name,
      })),
    };
  }

  if (Number.isInteger(input?.jahr)) {
    const monat = _monat(input.monat);
    out.zum_jahr = { jahr: input.jahr, ...(monat ? { monat } : {}), ...(birth ? ageAt(birth, { y: input.jahr, m: monat }) : { hinweis: 'Kein Geburtsjahr bekannt — Alter nicht berechenbar.' }) };
    const stufe = monat ? schule?.zuDatum(input.jahr, monat) : schule?.zumJahr(input.jahr);
    if (stufe) out.zum_jahr.schulstufe = stufe;
    const taetig = await _stationenAm(stationen, input.jahr, monat);
    if (taetig) out.zum_jahr.taetigkeiten = taetig;
  }

  const needle = typeof input?.ereignis === 'string' ? input.ereignis.trim() : '';
  if (needle) {
    const events = findDatedEvents(ctx.bookId, userEmail, needle, AGE_EVENT_LIMIT);
    out.zu_ereignissen = events.map(e => {
      const at = { y: e.y, m: e.m, d: e.d };
      const age = birth ? ageAt(birth, at) : null;
      const stufe = schule && e.y != null ? schule.zuDatum(e.y, e.m) : null;
      return {
        ereignis: e.ereignis, datum: e.datum, jahr: e.y,
        ...(e.ye != null && e.ye !== e.y ? { jahr_ende: e.ye } : {}),
        ...(e.unsicher ? { datum_unsicher: true } : {}),
        ...(age || {}),
        ...(stufe ? { schulstufe: stufe } : {}),
      };
    });
    if (!events.length) {
      const ways = offeredList(ctx, ['get_timeline', 'search_passages'], '/');
      out.ereignis_hinweis = `Kein datiertes Ereignis mit «${needle}» im Zeitstrahl. ${ways ? `Mit ${ways} das Datum suchen` : 'Das Datum im Text suchen'} und dann mit jahr= erneut fragen.`;
    }
  }

  if (!birth) {
    out.hinweis = `Kein Geburtsjahr bekannt (weder Steckbrief noch Geburts-Ereignis noch Alters-Index). Wörtliche Altersangaben stehen ggf. unter alters_index${toolHint(ctx, 'search_passages', '; sonst search_passages')}.`
      + (getFigureAgeScan(ctx.bookId, userEmail)
        ? ' Die Alters-Analyse (Figuren-Karte, Reiter «Alter») fand für diese Figur kein Geburtsjahr; nach Textänderungen kann der Autor sie dort neu starten.'
        : ' Die Alters-Analyse lief für dieses Buch noch nie: der Autor kann sie in der Figuren-Karte, Reiter «Alter», mit «Alter analysieren» starten — sie liest Geburtsjahre und Altersangaben aus dem Text.');
  }
  else if (!birth.m) out.rechnung = 'Nur das Geburtsjahr ist bekannt: Alter als Spanne (vor/nach dem Geburtstag).';
  return _truncateResult(out);
}

module.exports = {
  tool_list_continuity_issues,
  tool_get_timeline,
  tool_get_figure_age,
};
