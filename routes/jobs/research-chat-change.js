'use strict';
// `propose_research_item` MIT `item_id`: Änderung an einem BESTEHENDEN
// Fundstück vorschlagen (Recherche-Chat). Persistiert NICHTS — sammelt in
// ctx.changeProposals; der User übernimmt jeden Vorschlag einzeln
// (POST /research/chat-proposal/apply, routes/research-chat-changes.js).
//
// Drei Arten, gespeichert als `type`:
//   research_update  — title/body/source ersetzen, `append` anhängen, URLs und
//                      Tags ergänzen, `status` setzen («eingearbeitet» nur mit
//                      geprüftem `beleg` aus dem Manuskript)
//   research_archive — `archive: true`, allein
//   research_merge   — `merge_item_id` geht in `item_id` auf und wird gelöscht;
//                      optional title/body als zusammengeführter Text
// Fehler gehen als Text ans Modell zurück, damit es korrigiert.
// Deep-Doc: docs/recherche-chat.md („Änderungen an bestehenden Einträgen").

const contentStore = require('../../lib/content-store');
const { htmlToPlainText } = require('../../lib/html-text');
const { normalizeForQuoteMatch, quoteFoundIn } = require('../../lib/quote-verify');
const { str: _str, posInt: _int } = require('../../lib/proposal-input');
const {
  TITLE_MAX, BODY_MAX, SOURCE_MAX, RESEARCH_STATUS_SET, cleanStr, normalizeUrls,
} = require('../../lib/research-validate');
const { changeTarget, newUrls, newTags, appendedBody, mergeBlocker } = require('../../db/research-changes');
const { pageQuoteHaystack } = require('./ideen-chat-tools');

const MAX_BELEG = 500;

const _err = (error) => ({ ok: false, error, errorKey: 'chat.toolError.proposalRejected' });
const _label = (it) => it.title || it.urls?.[0]?.url || `#${it.id}`;

/**
 * Steht `beleg` im Text des Abschnitts? Geprüft gegen beide Textformen, in
 * denen das Modell Abschnitte zu sehen bekommt (Wortlaut-Suche: htmlToPlainText;
 * Lese-Werkzeuge: htmlToText) — ein wörtlich übernommener Treffer soll nicht an
 * einem Leerzeichen hinter einem Inline-Tag scheitern. false auch, wenn der
 * Abschnitt fehlt oder zu einem anderen Buch gehört.
 */
async function belegFoundInPage(pageId, beleg, bookId) {
  let page = null;
  try { page = await contentStore.loadPage(pageId); } catch (e) {
    if (e.code === 'NOT_FOUND' || e.status === 404) return false;
    throw e;
  }
  if (!page || page.book_id !== bookId) return false;
  return quoteFoundIn(beleg, pageQuoteHaystack(page.html))
    || quoteFoundIn(beleg, normalizeForQuoteMatch(htmlToPlainText(page.html || '')));
}

/** Kein zweiter Vorschlag zu einem Eintrag, den diese Antwort schon anfasst. */
function _touched(ctx, id) {
  return (ctx.changeProposals || []).some(p => p.item_id === id || p.merge_item_id === id);
}

async function _proposeUpdate(input, ctx, item) {
  const fields = {};
  const title = cleanStr(input.title, TITLE_MAX);
  if (title && title !== (item.title || '')) fields.title = title;
  const body = cleanStr(input.body, BODY_MAX);
  const append = _str(input.append, BODY_MAX);
  if (body && append) return _err('body ersetzt den Inhalt, append hängt an — nicht beides in einem Vorschlag.');
  if (body && body !== (item.body || '')) fields.body = body;
  if (append) {
    if (String(item.body || '').includes(append)) return _err('Dieser Text steht schon im Eintrag.');
    if (appendedBody(item.body, append) === null) return _err(`Mit dem angehängten Text würde der Inhalt länger als ${BODY_MAX} Zeichen — kürze ihn.`);
    fields.append = append;
  }
  const source = cleanStr(input.source, SOURCE_MAX);
  if (source && source !== (item.source || '')) fields.source = source;
  const tags = newTags(item.tags, input.tags);
  if (tags.length) fields.tags = tags;
  const { hadBadUrl } = normalizeUrls(input.urls);
  const urls = newUrls(item.urls, input.urls);
  if (hadBadUrl && !urls.length) return _err('URLs müssen mit http:// oder https:// beginnen.');

  let beleg = null;
  let belegPageName = null;
  if (input.status != null) {
    if (!RESEARCH_STATUS_SET.has(input.status)) return _err('status: offen, in_arbeit, eingearbeitet oder verworfen.');
    if (input.status !== item.status) fields.status = input.status;
  }
  const belegText = _str(input.beleg?.text, MAX_BELEG);
  const belegPage = _int(input.beleg?.page_id);
  if (fields.status === 'eingearbeitet' && (!belegText || !belegPage)) {
    return _err('«eingearbeitet» braucht einen beleg: die Textstelle im Manuskript (wörtlich, kurz), in der der Fund steckt, und die page_id ihres Abschnitts. Ohne gefundene Stelle schlage keinen Status vor.');
  }
  if (belegText || belegPage) {
    if (!fields.status) return _err('beleg gehört zu einer Status-Änderung.');
    if (!belegText || !belegPage) return _err('beleg braucht text und page_id.');
    if (!(await belegFoundInPage(belegPage, belegText, ctx.bookId))) {
      return _err(`Das Zitat steht nicht wörtlich in Abschnitt #${belegPage}. Übernimm die Stelle genau so, wie sie im Treffer steht.`);
    }
    beleg = { text: belegText, page_id: belegPage };
    belegPageName = (await contentStore.loadPage(belegPage).catch(() => null))?.name || null;
  }

  if (!Object.keys(fields).length && !urls.length) {
    return _err('Der Vorschlag ändert nichts am Eintrag — alle Angaben stehen schon so da.');
  }
  return {
    type: 'research_update',
    item_id: item.id,
    fields,
    ...(urls.length ? { urls } : {}),
    before: { title: item.title || '', body: item.body || '', source: item.source || '', status: item.status },
    ...(beleg ? { beleg } : {}),
    labels: { item: _label(item), kind: item.kind, ...(belegPageName ? { beleg_page: belegPageName } : {}) },
  };
}

function _proposeMerge(input, ctx, item, mergeId) {
  if (_touched(ctx, mergeId)) return _err(`Eintrag #${mergeId} ändert schon ein anderer Vorschlag dieser Antwort.`);
  const other = changeTarget(ctx.bookId, mergeId);
  if (!other) return _err(`Eintrag #${mergeId} gibt es in diesem Buch nicht.`);
  if (other.archived) return _err(`Eintrag #${mergeId} liegt im Archiv — zusammengeführt wird nur, was im Board steht.`);
  const blocker = mergeBlocker(item, other);
  if (blocker === 'MERGE_SELF') return _err('item_id und merge_item_id sind derselbe Eintrag.');
  if (blocker === 'MERGE_MEDIA') return _err(`Eintrag #${mergeId} ist ein Bild, Dokument oder Transkript — er kann nicht in einem anderen aufgehen. Führe umgekehrt zusammen oder lass beide stehen.`);
  if (input.append || input.status != null || input.archive === true || input.beleg || input.urls?.length || input.tags?.length || input.source) {
    return _err('Beim Zusammenführen nur title und body (der zusammengeführte Text) — URLs, Tags und Verknüpfungen ziehen von selbst um.');
  }
  const fields = {};
  const title = cleanStr(input.title, TITLE_MAX);
  const body = cleanStr(input.body, BODY_MAX);
  if (title) fields.title = title;
  if (body) fields.body = body;
  return {
    type: 'research_merge',
    item_id: item.id,
    merge_item_id: other.id,
    fields,
    before: { title: item.title || '', body: item.body || '' },
    labels: { item: _label(item), kind: item.kind, merge_item: _label(other), merge_kind: other.kind },
    merge_preview: { body: (other.body || '').slice(0, 600), urls: other.urls.length, tags: other.tags },
  };
}

/** Handler für `propose_research_item` mit `item_id`. */
async function proposeResearchChange(input, ctx, { maxProposals }) {
  const itemId = _int(input.item_id);
  if (!itemId) return _err('item_id muss die id eines Eintrags sein.');
  if ((ctx.proposals?.length || 0) + (ctx.changeProposals?.length || 0) >= maxProposals) {
    return { ok: false, error: `Maximal ${maxProposals} Vorschläge pro Antwort.`, errorKey: 'chat.toolError.proposalCap', errorParams: { max: maxProposals } };
  }
  const item = changeTarget(ctx.bookId, itemId);
  if (!item) return _err(`Eintrag #${itemId} gibt es in diesem Buch nicht.`);
  if (_touched(ctx, itemId)) return _err(`Zu Eintrag #${itemId} steht in dieser Antwort schon ein Vorschlag — fasse alle Änderungen an einem Eintrag in EINEM Aufruf zusammen.`);

  let proposal;
  const mergeId = _int(input.merge_item_id);
  if (input.archive === true) {
    if (item.archived) return _err(`Eintrag #${itemId} liegt schon im Archiv.`);
    if (mergeId || input.title || input.body || input.append || input.status != null || input.urls?.length || input.tags?.length || input.source) {
      return _err('archive steht allein — keine weiteren Änderungen im selben Vorschlag.');
    }
    proposal = { type: 'research_archive', item_id: item.id, labels: { item: _label(item), kind: item.kind } };
  } else if (item.archived) {
    return _err(`Eintrag #${itemId} liegt im Archiv — ändern lässt sich nur, was im Board steht.`);
  } else if (mergeId) {
    proposal = _proposeMerge(input, ctx, item, mergeId);
  } else {
    proposal = await _proposeUpdate(input, ctx, item);
  }
  if (proposal.ok === false) return proposal;
  const begruendung = _str(input.begruendung, 400);
  if (begruendung) proposal.begruendung = begruendung;
  ctx.changeProposals.push(proposal);
  return {
    ok: true, accepted_as_proposal: true, type: proposal.type, item_id: item.id,
    hinweis: 'Vorschlag gesammelt — der User übernimmt ihn selbst. Erwähne ihn kurz in der Antwort, nicht wiederholen.',
  };
}

module.exports = { proposeResearchChange, belegFoundInPage };
