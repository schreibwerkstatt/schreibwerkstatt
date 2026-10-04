'use strict';
// Kontinuitaetspruefung + Faktencheck: eine Zeile pro Issue
// (`continuity_issues`) plus Bruecken-Tabellen fuer Figuren-/Kapitel-Referenzen.
// Vorbild: figure_scenes mit scene_figures/scene_locations.
//
// Triage-Status (`resolved` = behoben, `dismissed` = kein Fehler) lebt an der Issue-
// Zeile, jeder Lauf legt aber frische Zeilen an. Damit die Triage einen neuen Lauf
// (auch den Nacht-Cron) übersteht, übernimmt das Speichern den Status früherer,
// wiedererkannter Befunde (lib/continuity-carryover.js). Alte Checks bleiben dafür
// stehen; angezeigt wird nur der neueste.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { toRefString: _toRefString } = require('./write-helpers');
const { carryOverStatus } = require('../lib/continuity-carryover');

const _insContinuityCheck = db.prepare(
  `INSERT INTO continuity_checks (book_id, user_email, checked_at, summary, model)
   VALUES (?, ?, ${NOW_ISO_SQL}, ?, ?)`
);
const _insContinuityIssue = db.prepare(
  `INSERT INTO continuity_issues
   (check_id, book_id, user_email, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, quelle,
    page_a_id, page_b_id, resolved, resolved_at, dismissed, dismissed_at, sort_order, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`
);
const _insContinuityIssueFig = db.prepare(
  `INSERT INTO continuity_issue_figures (issue_id, figure_id, figur_name, sort_order) VALUES (?, ?, ?, ?)`
);
const _insContinuityIssueCh = db.prepare(
  `INSERT INTO continuity_issue_chapters (issue_id, chapter_id, sort_order) VALUES (?, ?, ?)`
);

// Figuren-/Kapitelnamen eines KI-Befunds auflösen (dedupliziert, Reihenfolge bleibt).
// figIdToRowId: TEXT-fig_id → INTEGER figures.id.
function _resolveRefs(it, figNameToId, figIdToRowId, chNameToId) {
  const figs = [];
  const seenFig = new Set();
  for (const name of (Array.isArray(it.figuren) ? it.figuren.map(_toRefString).filter(Boolean) : [])) {
    const fid = figNameToId?.[name] || null;
    const key = (fid || '') + '|' + name;
    if (seenFig.has(key)) continue;
    seenFig.add(key);
    figs.push({ name, fid, rowId: fid ? (figIdToRowId[fid] ?? null) : null });
  }
  const chs = [];
  const seenCh = new Set();
  for (const name of (Array.isArray(it.kapitel) ? it.kapitel.map(_toRefString).filter(Boolean) : [])) {
    const cid = chNameToId?.[name] ?? null;
    const key = (cid ?? '') + '|' + name;
    if (seenCh.has(key)) continue;
    seenCh.add(key);
    chs.push({ name, cid });
  }
  return {
    figs, chs,
    figuren: figs.map(f => f.name),
    fig_ids: figs.filter(f => f.fid).map(f => f.fid),
    kapitel: chs.map(c => c.name),
    chapter_ids: chs.filter(c => c.cid != null).map(c => c.cid),
  };
}

// Eine Issue-Zeile + Figuren-/Kapitel-Bridges anlegen und die Frontend-Normalform
// zurückgeben. Geteilt von saveContinuityCheck (Voll-Check) und saveFaktencheckIssues
// (Anhang an bestehenden Check). `status` = übernommener Triage-Status oder null.
function _persistOneContinuityIssue(cid, bookIdInt, email, it, refs, status, sortIndex) {
  const resolved = !!status?.resolved;
  const dismissed = !!status?.dismissed;
  const { lastInsertRowid: issueId } = _insContinuityIssue.run(
    cid, bookIdInt, email,
    it.schwere || null, it.typ || null, it.beschreibung || null,
    it.stelle_a || null, it.stelle_b || null, it.empfehlung || null,
    it.quelle || null,
    it.page_a_id ?? null, it.page_b_id ?? null,
    resolved ? 1 : 0, resolved ? (status.resolved_at || null) : null,
    dismissed ? 1 : 0, dismissed ? (status.dismissed_at || null) : null,
    sortIndex,
  );
  refs.figs.forEach((f, j) => _insContinuityIssueFig.run(issueId, f.rowId, f.name, j));
  refs.chs.forEach((c, j) => { if (c.cid != null) _insContinuityIssueCh.run(issueId, c.cid, j); });
  return {
    id: issueId,
    resolved, dismissed,
    schwere: it.schwere || null, typ: it.typ || null,
    beschreibung: it.beschreibung || null,
    stelle_a: it.stelle_a || null, stelle_b: it.stelle_b || null,
    empfehlung: it.empfehlung || null,
    quelle: it.quelle || null,
    page_a_id: it.page_a_id ?? null, page_b_id: it.page_b_id ?? null,
    figuren: refs.figuren, fig_ids: refs.fig_ids,
    kapitel: refs.kapitel, chapter_ids: refs.chapter_ids,
  };
}

function _figIdToRowIdMap(bookIdInt, email) {
  // continuity_issue_figures.figure_id ist INTEGER (figures.id) seit Mig 73 —
  // figNameToId liefert TEXT-fig_id, zusaetzlicher Lookup TEXT → INT.
  const figRows = db.prepare(
    'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookIdInt, email);
  return Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
}

/** Frühere Befunde mit Triage-Status (behoben oder kein Fehler) dieses Buchs, neueste
 *  zuerst — Kandidaten für carryOverStatus. Kapitel als IDs + Namen, Figuren als Namen. */
function _priorTriaged(bookIdInt, email) {
  const rows = db.prepare(`
    SELECT ci.id, ci.typ, ci.stelle_a, ci.stelle_b, ci.resolved, ci.resolved_at, ci.dismissed, ci.dismissed_at
      FROM continuity_issues ci JOIN continuity_checks cc ON cc.id = ci.check_id
     WHERE ci.book_id = ? AND ci.user_email IS ? AND (ci.resolved = 1 OR ci.dismissed = 1)
     ORDER BY cc.checked_at DESC, ci.id DESC
  `).all(bookIdInt, email);
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  const figs = db.prepare(`SELECT issue_id, figur_name FROM continuity_issue_figures WHERE issue_id IN (${ph})`).all(...ids);
  const chs = db.prepare(`
    SELECT cic.issue_id, cic.chapter_id, c.chapter_name
      FROM continuity_issue_chapters cic LEFT JOIN chapters c ON c.chapter_id = cic.chapter_id
     WHERE cic.issue_id IN (${ph})`).all(...ids);
  const byId = new Map(rows.map(r => [r.id, { ...r, figuren: [], kapitel: [], chapter_ids: [] }]));
  for (const f of figs) if (f.figur_name) byId.get(f.issue_id).figuren.push(f.figur_name);
  for (const c of chs) {
    const it = byId.get(c.issue_id);
    if (c.chapter_id != null) it.chapter_ids.push(c.chapter_id);
    if (c.chapter_name) it.kapitel.push(c.chapter_name);
  }
  return rows.map(r => byId.get(r.id));
}

// Issues auflösen, Triage übernehmen, speichern. Läuft innerhalb der Aufrufer-Transaktion.
function _persistIssues(cid, bookIdInt, email, issuesArr, sortStart, figNameToId, chNameToId) {
  const figIdToRowId = _figIdToRowIdMap(bookIdInt, email);
  const refsList = issuesArr.map(it => _resolveRefs(it || {}, figNameToId, figIdToRowId, chNameToId));
  const statuses = carryOverStatus(
    issuesArr.map((it, i) => ({ ...(it || {}), ...refsList[i] })),
    _priorTriaged(bookIdInt, email),
  );
  return issuesArr.map((it, i) =>
    _persistOneContinuityIssue(cid, bookIdInt, email, it || {}, refsList[i], statuses[i], sortStart + i));
}

/** Speichert einen Kontinuitäts-Check mit allen Issues als eigene Zeilen.
 *  issues: [{schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, quelle?,
 *            page_a_id?, page_b_id?, figuren:[Namen], kapitel:[Namen]}]
 *  figNameToId / chNameToId: Auflösungs-Maps (Name → fig_id / chapter_id).
 *  Gibt { checkId, normalizedIssues } zurück (Frontend-Form mit fig_ids/chapter_ids
 *  und übernommenem Triage-Status). */
function saveContinuityCheck(bookId, userEmail, summary, model, issues, figNameToId, chNameToId) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  let normalizedIssues = [];
  let checkId = null;
  db.transaction(() => {
    const { lastInsertRowid: cid } = _insContinuityCheck.run(
      bookIdInt, email, summary || '', model || null,
    );
    checkId = cid;
    const issuesArr = Array.isArray(issues) ? issues : [];
    normalizedIssues = _persistIssues(cid, bookIdInt, email, issuesArr, 0, figNameToId, chNameToId)
      .map(({ id, ...rest }) => rest);
  })();
  return { checkId, normalizedIssues };
}

// Faktencheck-Befunde (typ='faktenfehler') an den NEUESTEN Kontinuitäts-Check anhängen,
// statt einen konkurrierenden Check anzulegen (getLatestContinuityCheck zeigt nur den
// neuesten → ein eigener Check würde die Kontinuitäts-Befunde verdecken). Idempotent:
// vorhandene faktenfehler-Zeilen dieses Checks werden zuerst gelöscht (Bridges via CASCADE),
// dann die neuen eingefügt. Gibt es noch keinen Check (Faktencheck vor jeder Komplettanalyse),
// wird einer angelegt. summaryFallback nur für diesen Neuanlage-Fall. Die Kontinuitäts-Befunde
// (andere typ) des Checks bleiben unberührt. */
function saveFaktencheckIssues(bookId, userEmail, model, issues, figNameToId, chNameToId, summaryFallback = '') {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const issuesArr = Array.isArray(issues) ? issues : [];
  let normalizedIssues = [];
  db.transaction(() => {
    let row = db.prepare(
      'SELECT id FROM continuity_checks WHERE book_id = ? AND user_email IS ? ORDER BY checked_at DESC LIMIT 1'
    ).get(bookIdInt, email);
    let cid = row?.id;
    if (!cid) {
      ({ lastInsertRowid: cid } = _insContinuityCheck.run(bookIdInt, email, summaryFallback || '', model || null));
    }
    // Die zu ersetzenden faktenfehler-Zeilen bleiben bis nach der Triage-Übernahme
    // stehen (sie sind deren Quelle) und fallen erst danach.
    const stale = row?.id
      ? db.prepare("SELECT id FROM continuity_issues WHERE check_id = ? AND typ = 'faktenfehler'").all(cid).map(r => r.id)
      : [];
    // Neue faktenfehler ans Ende einsortieren (sort_order nach den bestehenden Issues).
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM continuity_issues WHERE check_id = ?').get(cid).m;
    normalizedIssues = _persistIssues(cid, bookIdInt, email, issuesArr, maxSort + 1, figNameToId, chNameToId)
      .map(({ id, ...rest }) => rest);
    if (stale.length) {
      db.prepare(`DELETE FROM continuity_issues WHERE id IN (${stale.map(() => '?').join(',')})`).run(...stale);
    }
  })();
  return { normalizedIssues };
}

/** Lädt den letzten Kontinuitäts-Check eines Buchs in Frontend-Form
 *  ({id, checked_at, issues:[{...}], summary, model}) oder null. */
function getLatestContinuityCheck(bookId, userEmail) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const row = db.prepare(`
    SELECT id, checked_at, summary, model
    FROM continuity_checks
    WHERE book_id = ? AND user_email IS ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(bookIdInt, email);
  if (!row) return null;
  const issueRows = db.prepare(`
    SELECT id, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, quelle,
           resolved, dismissed, page_a_id, page_b_id
    FROM continuity_issues
    WHERE check_id = ?
    ORDER BY sort_order, id
  `).all(row.id);
  const figRows = db.prepare(`
    SELECT cif.issue_id, f.fig_id, cif.figur_name
    FROM continuity_issue_figures cif
    LEFT JOIN figures f ON f.id = cif.figure_id
    WHERE cif.issue_id IN (SELECT id FROM continuity_issues WHERE check_id = ?)
    ORDER BY cif.issue_id, cif.sort_order
  `).all(row.id);
  const chRows = db.prepare(`
    SELECT cic.issue_id, cic.chapter_id, c.chapter_name
    FROM continuity_issue_chapters cic
    LEFT JOIN chapters c ON c.chapter_id = cic.chapter_id
    WHERE cic.issue_id IN (SELECT id FROM continuity_issues WHERE check_id = ?)
    ORDER BY cic.issue_id, cic.sort_order
  `).all(row.id);
  const figByIssue = new Map();
  for (const r of figRows) {
    if (!figByIssue.has(r.issue_id)) figByIssue.set(r.issue_id, { figuren: [], fig_ids: [] });
    const bucket = figByIssue.get(r.issue_id);
    if (r.figur_name) bucket.figuren.push(r.figur_name);
    if (r.fig_id) bucket.fig_ids.push(r.fig_id);
  }
  const chByIssue = new Map();
  for (const r of chRows) {
    if (!chByIssue.has(r.issue_id)) chByIssue.set(r.issue_id, { kapitel: [], chapter_ids: [] });
    const bucket = chByIssue.get(r.issue_id);
    if (r.chapter_name) bucket.kapitel.push(r.chapter_name);
    if (r.chapter_id != null) bucket.chapter_ids.push(r.chapter_id);
  }
  const issues = issueRows.map(r => ({
    id: r.id,
    resolved: !!r.resolved,
    dismissed: !!r.dismissed,
    schwere: r.schwere, typ: r.typ, beschreibung: r.beschreibung,
    stelle_a: r.stelle_a, stelle_b: r.stelle_b, empfehlung: r.empfehlung,
    quelle: r.quelle || null,
    page_a_id: r.page_a_id ?? null, page_b_id: r.page_b_id ?? null,
    figuren: figByIssue.get(r.id)?.figuren || [],
    fig_ids: figByIssue.get(r.id)?.fig_ids || [],
    kapitel: chByIssue.get(r.id)?.kapitel || [],
    chapter_ids: chByIssue.get(r.id)?.chapter_ids || [],
  }));
  return { id: row.id, checked_at: row.checked_at, issues, summary: row.summary, model: row.model };
}

/** book_id eines Issues (fuer ACL/Log-Context vor der Mutation). null wenn unbekannt. */
function getContinuityIssueBookId(issueId) {
  const id = parseInt(issueId);
  if (!id) return null;
  const row = db.prepare('SELECT book_id FROM continuity_issues WHERE id = ?').get(id);
  return row ? row.book_id : null;
}

/** Setzt das resolved-Flag eines Kontinuitaets-Issues. resolved_at = jetzt bzw.
 *  null beim Wiederoeffnen. Gibt true zurueck, wenn eine Zeile betroffen war. */
function setContinuityIssueResolved(issueId, resolved) {
  const id = parseInt(issueId);
  if (!id) return false;
  const now = resolved ? new Date().toISOString() : null;
  const info = db.prepare(
    'UPDATE continuity_issues SET resolved = ?, resolved_at = ? WHERE id = ?'
  ).run(resolved ? 1 : 0, now, id);
  return info.changes > 0;
}

/** Markiert ein Issue als „kein Fehler" (Fehlalarm) bzw. hebt das auf. Der Status wird
 *  von späteren Läufen übernommen (carryOverStatus). */
function setContinuityIssueDismissed(issueId, dismissed) {
  const id = parseInt(issueId);
  if (!id) return false;
  const now = dismissed ? new Date().toISOString() : null;
  const info = db.prepare(
    'UPDATE continuity_issues SET dismissed = ?, dismissed_at = ? WHERE id = ?'
  ).run(dismissed ? 1 : 0, now, id);
  return info.changes > 0;
}

module.exports = {
  saveContinuityCheck,
  saveFaktencheckIssues,
  getLatestContinuityCheck,
  getContinuityIssueBookId,
  setContinuityIssueResolved,
  setContinuityIssueDismissed,
};
