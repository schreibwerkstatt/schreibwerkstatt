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
const { listFigureAges } = require('../../../db/figure-ages');
const { getBookSettings } = require('../../../db/book-settings');
const { birthCandidates, resolveBirth } = require('../../../lib/figure-birth');
const { _truncateResult, _findFigure } = require('./shared');

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
    enriched = enriched.filter(i => i.kapitel.some(c => c.chapter_id === chapterFilter));
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
    if (!focusFig) return { error: 'Figur nicht gefunden', hint: 'Prüfe die Figurenliste im System-Prompt.' };
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

const AGE_EVENT_LIMIT = 10;
const AGE_BELEGE_LIMIT = 5;

/** Alter zum Zeitpunkt `at` bei Geburt `birth` (je {y, m?, d?}). Mit Monat (+Tag) auf
 *  beiden Seiten exakt, sonst als Spanne [n−1, n] — ohne Geburtstag im Jahr ist nicht
 *  entscheidbar, ob er schon war. */
function ageAt(birth, at) {
  if (!Number.isInteger(birth?.y) || !Number.isInteger(at?.y)) return null;
  const n = at.y - birth.y;
  let von = n - 1, bis = n;
  if (birth.m && at.m) {
    if (at.m > birth.m) von = bis = n;
    else if (at.m < birth.m) von = bis = n - 1;
    else if (birth.d && at.d) von = bis = (at.d >= birth.d ? n : n - 1);
  }
  const out = von === bis ? { alter: bis, exakt: true } : { alter_von: von, alter_bis: bis, exakt: false };
  if (bis < 0) out.vor_geburt = true;
  return out;
}

function tool_get_figure_age(input, ctx) {
  const userEmail = ctx.userEmail || '';
  if (!input?.figur_id && !input?.figur_name) return { error: 'figur_id oder figur_name erforderlich.' };
  const fig = _findFigure(input, ctx);
  if (!fig) return { error: 'Figur nicht gefunden', hint: 'Prüfe die Figurenliste im System-Prompt.' };

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
    out.zum_jahr = { jahr: input.jahr, ...(birth ? ageAt(birth, { y: input.jahr }) : { hinweis: 'Kein Geburtsjahr bekannt — Alter nicht berechenbar.' }) };
  }

  const needle = typeof input?.ereignis === 'string' ? input.ereignis.trim() : '';
  if (needle) {
    const events = findDatedEvents(ctx.bookId, userEmail, needle, AGE_EVENT_LIMIT);
    out.zu_ereignissen = events.map(e => {
      const at = { y: e.y, m: e.m, d: e.d };
      const age = birth ? ageAt(birth, at) : null;
      return {
        ereignis: e.ereignis, datum: e.datum, jahr: e.y,
        ...(e.ye != null && e.ye !== e.y ? { jahr_ende: e.ye } : {}),
        ...(e.unsicher ? { datum_unsicher: true } : {}),
        ...(age || {}),
      };
    });
    if (!events.length) out.ereignis_hinweis = `Kein datiertes Ereignis mit «${needle}» im Zeitstrahl. Mit get_timeline/search_passages das Datum suchen und dann mit jahr= erneut fragen.`;
  }

  if (!birth) out.hinweis = 'Kein Geburtsjahr bekannt (weder Steckbrief noch Geburts-Ereignis noch Alters-Index). Wörtliche Altersangaben stehen ggf. unter alters_index; sonst search_passages.';
  else if (!birth.m) out.rechnung = 'Nur das Geburtsjahr ist bekannt: Alter als Spanne (vor/nach dem Geburtstag).';
  return _truncateResult(out);
}

module.exports = {
  tool_list_continuity_issues,
  tool_get_timeline,
  tool_get_figure_age,
  ageAt,
};
