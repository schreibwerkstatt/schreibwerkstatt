'use strict';
// Einzelnes Nachprüfen von Kontinuitäts-Befunden (Knopf «Nachprüfen» in der
// Kontinuitäts-Karte, docs/komplett.md → «Befund nachprüfen»).
//
// Ein Call je Befund auf dem AKTUELLEN Text: Stelle A, Stelle B und die Abschnitte,
// die seit dem Prüflauf gespeichert wurden (die Korrektur steht oft an dritter
// Stelle). Kein ganzer Prüflauf, kein Katalog — darum Cent- statt Dollarbeträge.
//
// «behoben» erledigt den Befund nur mit einem Beleg, der im mitgegebenen Text
// wörtlich steht (lib/quote-verify.js). Ohne auffindbaren Beleg wird daraus
// «unbelegt» und der Befund bleibt offen — ein Modell, das «passt jetzt» sagt,
// ohne die Stelle zeigen zu können, entscheidet nichts.

const contentStore = require('../../../lib/content-store');
const { getContinuityIssueForRecheck, saveContinuityIssueRecheck } = require('../../../db/continuity');
const { normalizeForQuoteMatch, quoteFoundIn } = require('../../../lib/quote-verify');
const { birthCandidates, resolveBirth } = require('../../../lib/figure-birth');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts, tps, htmlToTextForPrompt,
} = require('../shared');

// Deckel des mitgegebenen Texts. A und B kommen immer mit (je bis PAGE_CAP), dann
// die zuletzt geänderten Abschnitte, solange das Gesamtbudget reicht.
const PAGE_CAP = 60000;
const TOTAL_CAP = 160000;
const MAX_CHANGED_PAGES = 4;

async function _pageText(pageId) {
  const pd = await contentStore.loadPage(pageId).catch(() => null);
  if (!pd) return null;
  return { id: pd.id, titel: pd.name || '', text: htmlToTextForPrompt(pd.html || '').slice(0, PAGE_CAP) };
}

/** Abschnitte für einen Befund: A, B, dann seit `since` geänderte (neueste zuerst). */
async function _collectSections(issue, pageMetas) {
  const out = [];
  let used = 0;
  const add = (p, rolle) => {
    if (!p || !p.text || out.some(o => o.id === p.id)) return;
    if (used + p.text.length > TOTAL_CAP && out.length) return;
    out.push({ ...p, rolle });
    used += p.text.length;
  };
  if (issue.page_a_id) add(await _pageText(issue.page_a_id), 'a');
  if (issue.page_b_id) add(await _pageText(issue.page_b_id), 'b');
  const changed = pageMetas
    .filter(m => m.updated_at && m.updated_at > issue.checked_at && m.id !== issue.page_a_id && m.id !== issue.page_b_id)
    .sort((x, y) => (y.updated_at > x.updated_at ? 1 : -1))
    .slice(0, MAX_CHANGED_PAGES);
  for (const m of changed) add(await _pageText(m.id), 'geaendert');
  return out;
}

function _figurenInfo(bookId, userEmail, figuren) {
  return figuren.map(f => {
    const { birth } = resolveBirth(birthCandidates(bookId, userEmail, f));
    if (!birth) return `${f.name}: Geburtsdatum unbekannt`;
    const datum = [birth.d, birth.m, birth.y].filter(x => x != null).join('.');
    return `${f.name}: geboren ${datum}`;
  });
}

/** Urteil des Modells → gespeichertes Urteil. Pure, damit testbar. */
function judgeRecheck(raw, haystackNorm) {
  const urteil = raw?.urteil;
  if (!['behoben', 'teilweise', 'weiterhin'].includes(urteil)) return null;
  const beleg = String(raw.beleg || '').trim();
  const found = !!beleg && quoteFoundIn(beleg, haystackNorm);
  if (urteil === 'behoben' && !found) {
    return { verdict: 'unbelegt', reason: String(raw.begruendung || ''), beleg, resolve: false };
  }
  return { verdict: urteil, reason: String(raw.begruendung || ''), beleg: found ? beleg : '', resolve: urteil === 'behoben' };
}

async function runKontinuitaetRecheckJob(jobId, bookId, bookName, userEmail, issueIds) {
  const log = makeJobLogger(jobId);
  const prompts = await getPrompts(userEmail);
  const { SYSTEM_KONTINUITAET } = await getBookPrompts(bookId, userEmail);
  const tok = { in: 0, out: 0, ms: 0 };
  const results = [];
  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 2 });
    const pageMetas = await contentStore.listPages(bookId);
    for (let i = 0; i < issueIds.length; i++) {
      const issue = getContinuityIssueForRecheck(issueIds[i]);
      if (!issue) continue;
      const from = 5 + Math.round((i / issueIds.length) * 90);
      const to = 5 + Math.round(((i + 1) / issueIds.length) * 90);
      updateJob(jobId, {
        statusText: 'job.phase.kontinuitaetRecheck',
        statusParams: { n: i + 1, total: issueIds.length },
        progress: from,
      });
      const sections = await _collectSections(issue, pageMetas);
      const raw = await aiCall(jobId, tok,
        prompts.buildKontinuitaetRecheckPrompt(bookName, issue, sections,
          _figurenInfo(issue.book_id, userEmail, issue.figuren)),
        SYSTEM_KONTINUITAET,
        from, to, 1500, 0.2, 2000, undefined, prompts.buildKontinuitaetRecheckSchema(),
      );
      if (!raw || typeof raw.urteil !== 'string') throw i18nError('job.error.recheckVerdictMissing');
      const hay = normalizeForQuoteMatch(sections.map(s => s.text).join('\n'));
      const v = judgeRecheck(raw, hay);
      if (!v) throw i18nError('job.error.recheckVerdictMissing');
      saveContinuityIssueRecheck(issue.id, v);
      results.push({ id: issue.id, verdict: v.verdict, resolved: v.resolve });
    }
    const behoben = results.filter(r => r.resolved).length;
    log.info(`Kontinuität nachgeprüft: ${results.length} Befunde, ${behoben} behoben.`);
    completeJob(jobId, { results, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `Kontinuität nachgeprüft: ${behoben}/${results.length} behoben`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Fehler Kontinuität nachprüfen: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

module.exports = { runKontinuitaetRecheckJob, judgeRecheck };
