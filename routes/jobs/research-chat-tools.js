'use strict';
// Werkzeuge des agentischen Recherche-Chats (mit Web-Suche).
// Rückwärtsgewandt: liest vorhandenes Material + Buch-Entitäten und SAMMELT
// Vorschläge — schreibt NIE Buchtext und persistiert NICHTS automatisch.
//
// Die Lese-Werkzeuge (Archiv, Passagen-Suche, Literatur-Register, Welt-Übersicht)
// teilt er mit den anderen Chats (./chat-tools/, Spalte `research` in
// public/js/prompts/chat-tools/access.js). Hier nur, was es allein im
// Recherche-Chat gibt:
//   `web_search` — beim Suchweg 'anthropic' Anthropics serverseitiges Tool ohne
//     Handler (die API führt es selbst aus); beim Suchweg 'searxng' laufen
//     `web_search` und `read_web_page` als Function-Tools über ./research-web-tools.js.
//   `propose_research_item` — sammelt nur in ctx.proposals; der User bestätigt
//     jeden Vorschlag im Frontend (POST /research/chat-proposal). Ob die URLs in
//     diesem Lauf tatsächlich abgerufen wurden, markiert der Job danach
//     (research-chat-helpers.js#markProposalUrls).
//
// ctx = { bookId, userEmail, jobSignal, logger, offeredTools, proposals: [] }

const { _truncateResult, resultCapFor } = require('./chat-tools/shared');
const { executeTool: executeCatalogTool, TOOLS: CATALOG_TOOLS } = require('./chat-tools');
const {
  PROPOSAL_KINDS, TITLE_MAX, BODY_MAX, SOURCE_MAX,
  cleanStr, normalizeUrls, normalizeTags, normalizeTitleForMatch,
} = require('../../lib/research-validate');
const { findDuplicateItem } = require('../../db/research-items');
const { normalizeUrl } = require('../../lib/url-normalize');
const { WEB_TOOLS } = require('./research-web-tools');

const MAX_PROPOSALS = 12;

const _snip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// ── propose_research_item ────────────────────────────────────────────────────
// Persistiert NICHTS — sammelt nur in ctx.proposals; der User bestätigt im Frontend.
function tool_propose_research_item(input, ctx) {
  const kind = PROPOSAL_KINDS.has(input.kind) ? input.kind : 'note';
  const title = cleanStr(input.title, TITLE_MAX) || '';
  const body = cleanStr(input.body, BODY_MAX) || '';
  const source = cleanStr(input.source, SOURCE_MAX) || '';
  const tags = normalizeTags(input.tags);

  // Normalisierung (http(s)-only, Dedup, Cap, Label) geteilt mit POST /research
  // über lib/research-validate — so kann der Vorschlag nicht andere Regeln
  // akzeptieren als das Speichern später durchlässt.
  const { urls, hadBadUrl } = normalizeUrls(input.urls);

  if (!title && !body && !urls.length) {
    return { ok: false, error: 'Vorschlag braucht mindestens Titel, Inhalt oder eine URL.', errorKey: 'chat.toolError.proposalEmpty' };
  }
  if (hadBadUrl && !urls.length) {
    return { ok: false, error: 'URLs müssen mit http:// oder https:// beginnen.', errorKey: 'chat.toolError.invalidParam', errorParams: { param: 'urls' } };
  }

  if ((ctx.proposals?.length || 0) >= MAX_PROPOSALS) {
    return { ok: false, error: `Maximal ${MAX_PROPOSALS} Vorschläge pro Antwort.`, errorKey: 'chat.toolError.proposalCap', errorParams: { max: MAX_PROPOSALS } };
  }
  // Wortgleicher Titel oder dieselbe URL (normalisiert: Tracking-Parameter, www.,
  // http/https) schon in DIESER Antwort vorgeschlagen → kein zweiter Knopf.
  const tNorm = normalizeTitleForMatch(title);
  if (tNorm && ctx.proposals.some(p => normalizeTitleForMatch(p.title) === tNorm)) {
    return { ok: false, error: 'Ein Vorschlag mit diesem Titel steht in dieser Antwort schon.', errorKey: 'chat.toolError.proposalDuplicate' };
  }
  const urlNorms = new Set(urls.map(u => normalizeUrl(u.url)).filter(Boolean));
  if (urlNorms.size && ctx.proposals.some(p => (p.urls || []).some(u => urlNorms.has(normalizeUrl(u.url))))) {
    return { ok: false, error: 'Ein Vorschlag mit dieser URL steht in dieser Antwort schon — ergänze ihn nicht doppelt.', errorKey: 'chat.toolError.proposalDuplicate' };
  }

  const proposal = { kind, title, body, urls, source, tags };
  // Abgleich mit dem Archiv (gleiche URL oder wortgleicher Titel): der Vorschlag
  // bleibt stehen, trägt aber die Id des bestehenden Eintrags — das Frontend
  // zeigt „schon im Board" statt eines blinden Speichern-Knopfs.
  const dup = findDuplicateItem(ctx.bookId, { urls, title });
  if (dup) {
    proposal.exists_item_id = dup.id;
    proposal.exists_match = dup.match;
  }
  ctx.proposals.push(proposal);
  return {
    ok: true, accepted_as_proposal: true, kind, title: title || urls[0]?.url || _snip(body, 60),
    ...(dup ? {
      already_in_archive: { id: dup.id, title: dup.title || '', match: dup.match },
      hinweis: 'Ein Eintrag mit dieser URL bzw. diesem Titel liegt schon im Archiv. Der User sieht das am Vorschlag; erwähne es in der Antwort.',
    } : {}),
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────
const OWN_TOOLS = {
  propose_research_item: tool_propose_research_item,
  ...WEB_TOOLS,
};

async function executeResearchTool(name, input, ctx) {
  if (!OWN_TOOLS[name] && CATALOG_TOOLS[name]) return executeCatalogTool(name, input, ctx);
  const fn = OWN_TOOLS[name];
  // Nicht angebotene Werkzeuge weist schon der Loop ab (chat.toolError.notOffered);
  // das hier ist nur der Rückfall für einen Namen, den es gar nicht gibt.
  if (!fn) throw new Error(`Unbekanntes Werkzeug: ${name}`);
  const result = await fn(input || {}, ctx);
  // Derselbe Deckel, den der Loop pro Werkzeug anlegt — sonst kürzte diese Stufe
  // eine Seite, die der Job ausdrücklich grösser zulässt (pageResultCapChars).
  const pageCap = Number(ctx?.pageResultCapChars) || 0;
  return _truncateResult(result, name === 'read_web_page' && pageCap > 0 ? pageCap : resultCapFor(ctx));
}

module.exports = { executeResearchTool, OWN_TOOLS };
