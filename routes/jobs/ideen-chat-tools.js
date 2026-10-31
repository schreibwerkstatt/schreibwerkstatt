'use strict';
// Werkzeug-Executor des Ideen-Chats. Zwei Arten:
//   - Lese-Werkzeuge: die Handler des gemeinsamen Katalogs (chat-tools) —
//     eine Quelle, kein zweiter Text-/Plot-/Figuren-Leser.
//   - Vorschlags-Werkzeuge (propose_*): validieren gegen den Ideen-Stand und
//     sammeln EINEN normalisierten Vorschlag in ctx.proposals. Sie schreiben
//     NICHTS — der User übernimmt jeden Vorschlag einzeln im Frontend, über
//     dieselben /ideen-Routen wie jede Board-Bearbeitung.
//
// Ein ungültiger Vorschlag (fremde id, abgeschaltete Stufe, Anker im falschen
// Buch) kommt als { error } ans Modell zurück, damit es den Aufruf korrigiert.
// Die Regeln spiegeln routes/ideen.js — die Route prüft beim Übernehmen erneut,
// der Vorschlag ist kein Schreibrecht.
//
// Gespeichertes Format (context_info.proposals[i]), Felder je `type`:
//   idee_create { fields: { content, page_id?|chapter_id? } }
//   idee_update { idee_id, fields: { content?, status?, page_id?|chapter_id? }, before, beleg? }
//               — `anker_loesen` setzt page_id UND chapter_id auf null (zurück ans Buch)
//   link_create { idee_id|idee_ref, target_kind, target_id }
// Gemeinsam: { type, ref, begruendung, labels }. `ref` ist 1-basiert über alle
// Vorschläge DIESER Antwort; `idee_ref` zeigt auf ein idee_create derselben Antwort.
// `beleg` = { text, page_id } — Textstelle, die eine Stufen-Änderung trägt
// (Erledigt-Check). Sie wird beim Vorschlagen gegen den Abschnittstext geprüft
// (lib/quote-verify.js, Heuhaufen = pageQuoteHaystack, derselbe Text, den das
// Modell liest): ein «erledigt» mit einem Zitat, das im Text nicht steht, kommt
// als Fehler ans Modell zurück, nie beim User an. Beim Übernehmen wird es gegen
// den dann aktuellen Text erneut geprüft (routes/ideen-chat-proposals.js). Persistierter Status (PATCH /ideen/chat-proposal):
// applied_at + applied_id bzw. status='discarded'.

const { executeTool: executeCatalogTool } = require('./chat-tools');
const { loadIdeenState } = require('./ideen-chat-context');
const { isIdeeStatus, isOpenIdeeStatus, isIdeaLinkKind } = require('../../lib/ideen-status');
const contentStore = require('../../lib/content-store');
const { htmlToText } = require('./shared');
const { normalizeForQuoteMatch, quoteFoundIn } = require('../../lib/quote-verify');
const { str: _str, posInt: _int } = require('../../lib/proposal-input');
const { ideeProposalKey } = require('../../lib/chat-idee-proposals');
const { canonicalIdeeAnchor } = require('../../lib/idee-anchor');
const { err: _err, pushProposal: _push, oneLine } = require('./proposal-chat-shared');

const MAX_PROPOSALS = 40;
const MAX_CONTENT = 4000; // = routes/ideen.js MAX_LEN
const MAX_BELEG = 500;

const PROPOSE_TOOLS = new Set(['propose_idee', 'propose_idee_link']);

// Ideen-Stand pro Antwort einmal laden; Vorschläge ändern ihn nicht.
function _state(ctx) {
  if (!ctx._ideen) ctx._ideen = loadIdeenState(ctx.bookId, ctx.userEmail, ctx.tree || {});
  return ctx._ideen;
}

function _preview(s, n = 120) { return oneLine(s, n); }

// Anzeige-Name eines Ankers (Abschnitt bzw. Kapitel) oder null = Buch.
function _anchorLabel(state, { page_id, chapter_id }) {
  if (page_id) return state.pageById.get(page_id)?.name || `#${page_id}`;
  if (chapter_id) return state.chapterNames.get(chapter_id) || `#${chapter_id}`;
  return null;
}

// Anker aus page_id/chapter_id. → { page_id?, chapter_id? } | {} (keiner) | { error }
function _resolveAnchor(input, state) {
  const pageId = _int(input.page_id);
  const chapterId = _int(input.chapter_id);
  if (pageId && chapterId) return _err('Entweder page_id ODER chapter_id — eine Idee hängt an höchstens einem Anker.');
  if (pageId) {
    if (!state.pageById.has(pageId)) return _err(`Abschnitt #${pageId} gehört nicht zu diesem Buch. Nutze eine page#-id aus der Gliederung.`);
    return { page_id: pageId };
  }
  if (chapterId) {
    if (!state.chapterNames.has(chapterId)) return _err(`Kapitel #${chapterId} gehört nicht zu diesem Buch. Nutze eine chapter#-id aus der Gliederung.`);
    // Einabschnitts-Kapitel: derselbe Ort wie sein Abschnitt, die Idee hängt am Abschnitt.
    const c = canonicalIdeeAnchor({ kind: 'chapter', id: chapterId });
    if (c.kind === 'page' && state.pageById.has(c.id)) return { page_id: c.id };
    return { chapter_id: chapterId };
  }
  return {};
}

/**
 * Vergleichsform eines Abschnittstexts für die Beleg-Prüfung — derselbe
 * HTML→Text-Weg, über den das Modell Abschnitte liest (htmlToText: Satzzeichen
 * an Inline-Tags, Tabellen-Zusammenfassung, Nachrichtenverläufe), damit ein
 * wörtlich übernommenes Zitat auch gefunden wird. Geteilt mit der Prüfung beim
 * Übernehmen (routes/ideen-chat-proposals.js).
 */
function pageQuoteHaystack(html) {
  return normalizeForQuoteMatch(htmlToText(html || ''));
}

/** Steht `beleg` (Zitat) im aktuellen Text von `pageId`? Lädt frisch über die Facade. */
async function belegInPage(pageId, beleg, bookId = null) {
  let page = null;
  try { page = await contentStore.loadPage(pageId); } catch (e) {
    if (e.code === 'NOT_FOUND' || e.status === 404) return false;
    throw e;
  }
  if (!page || (bookId != null && page.book_id != null && page.book_id !== bookId)) return false;
  return quoteFoundIn(beleg, pageQuoteHaystack(page.html));
}

function _proposeCreate(input, ctx, state) {
  if (input.status != null) return _err('Eine neue Idee beginnt immer als «offen» — status nur bei Änderungen (mit idee_id).');
  const content = _str(input.content, MAX_CONTENT);
  if (!content) return _err('Neue Idee braucht content (Stichpunkt, keine Prosa).');
  if (input.anker_loesen === true) return _err('anker_loesen nur bei Änderungen (mit idee_id) — eine neue Idee ohne Ort ist schon eine Buch-Idee.');
  const anchor = _resolveAnchor(input, state);
  if (anchor.error) return anchor;
  // Dieselbe neue Idee zweimal in einer Antwort: nicht doppelt sammeln.
  const key = ideeProposalKey({ content, ...anchor });
  const dup = ctx.proposals.find(p => p.type === 'idee_create' && ideeProposalKey(p.fields) === key);
  if (dup) return { ok: true, ref: dup.ref, hinweis: `Dieselbe Idee ist schon als Vorschlag ref ${dup.ref} gesammelt — nicht doppelt.` };
  const label = _anchorLabel(state, anchor);
  return _push(ctx, {
    type: 'idee_create',
    fields: { content, ...anchor },
    labels: label ? { anchor: label, anchor_kind: anchor.page_id ? 'page' : 'chapter' } : {},
  }, input);
}

// Normalisierter Klartext eines Abschnitts, pro Antwort einmal geladen.
async function _pageHaystack(ctx, pageId) {
  if (!ctx._pageText) ctx._pageText = new Map();
  if (!ctx._pageText.has(pageId)) {
    const page = await contentStore.loadPage(pageId);
    ctx._pageText.set(pageId, pageQuoteHaystack(page?.html));
  }
  return ctx._pageText.get(pageId);
}

async function _proposeUpdate(input, ctx, state, ideeId) {
  const idee = state.ideeById.get(ideeId);
  if (!idee) return _err(`Idee #${ideeId} gibt es nicht. Nutze eine [#id] aus der Ideenliste.`);
  const fields = {};
  const before = {};
  const labels = { idee: _preview(idee.content) };

  // Leerer Text heisst «nicht angegeben» (beide Pfade, proposal-chat-shared.js).
  const c = _str(input.content, MAX_CONTENT);
  if (c && c !== idee.content) { fields.content = c; before.content = idee.content; }
  if (input.status != null) {
    if (!isIdeeStatus(input.status)) return _err(`Unbekannte Stufe «${input.status}». Erlaubt: ${state.stages.join(', ')}.`);
    if (input.status !== idee.status) {
      // = routes/ideen.js: in eine abgeschaltete Stufe wird nicht gewechselt.
      if (!state.stages.includes(input.status)) {
        return _err(`Die Stufe «${input.status}» ist in diesem Buch abgeschaltet. Erlaubt: ${state.stages.join(', ')}.`);
      }
      fields.status = input.status;
      before.status = idee.status;
    }
  }
  const anchor = _resolveAnchor(input, state);
  if (anchor.error) return anchor;
  if (input.anker_loesen === true) {
    // Zurück ans Buch: PATCH /ideen/:id mit page_id = chapter_id = null.
    if (anchor.page_id || anchor.chapter_id) return _err('anker_loesen und ein neuer Ort schliessen sich aus.');
    if (idee.page_id == null && idee.chapter_id == null) return _err(`Idee #${ideeId} hängt schon an keinem Ort.`);
    if (!isOpenIdeeStatus(idee.status)) return _err(`Idee #${ideeId} ist ${idee.status} — eine abgeschlossene Idee wandert nicht mehr.`);
    fields.page_id = null;
    fields.chapter_id = null;
    before.page_id = idee.page_id ?? null;
    before.chapter_id = idee.chapter_id ?? null;
    labels.anchor = null;
    labels.anchor_kind = 'book';
    labels.anchor_before = _anchorLabel(state, idee) || null;
  } else if (anchor.page_id || anchor.chapter_id) {
    // = routes/ideen.js: eine abgeschlossene Idee wandert nicht mehr.
    if (!isOpenIdeeStatus(idee.status)) return _err(`Idee #${ideeId} ist ${idee.status} — eine abgeschlossene Idee bekommt keinen neuen Ort.`);
    const same = anchor.page_id ? anchor.page_id === idee.page_id : anchor.chapter_id === idee.chapter_id;
    if (!same) {
      // Der neue Anker leert den alten — auch beim Wechsel Kapitel ↔ Abschnitt.
      Object.assign(fields, anchor);
      before.page_id = idee.page_id ?? null;
      before.chapter_id = idee.chapter_id ?? null;
      labels.anchor = _anchorLabel(state, anchor);
      labels.anchor_kind = anchor.page_id ? 'page' : 'chapter';
      labels.anchor_before = _anchorLabel(state, idee) || null;
    }
  }
  if (!Object.keys(fields).length) return _err(`Der Vorschlag ändert an Idee #${ideeId} nichts.`);

  let beleg = null;
  const belegText = _str(input.beleg, MAX_BELEG);
  const bp = _int(input.beleg_page_id);
  if (fields.status && ('page_id' in fields || 'chapter_id' in fields) && !isOpenIdeeStatus(fields.status)) {
    return _err('Ort ändern und zugleich abschliessen geht nicht — eine Idee wandert nur, solange sie offen ist.');
  }
  if (fields.status === 'erledigt' && (!belegText || !bp)) {
    return _err('Wer «erledigt» vorschlägt, belegt es: gib in `beleg` die Textstelle (wörtlich, kurz) an, die die Pendenz einlöst, und in beleg_page_id ihren Abschnitt.');
  }
  if (belegText) {
    if (!bp) return _err('Zum beleg gehört beleg_page_id — der Abschnitt, in dem das Zitat steht.');
    if (!state.pageById.has(bp)) return _err(`beleg_page_id #${bp} gehört nicht zu diesem Buch.`);
    if (!quoteFoundIn(belegText, await _pageHaystack(ctx, bp))) {
      return _err(`Das Zitat steht so nicht in Abschnitt #${bp}. Lies den Abschnitt und zitiere wörtlich — oder lass den Vorschlag weg.`);
    }
    beleg = { text: belegText, page_id: bp };
    labels.beleg_page = state.pageById.get(bp)?.name || null;
  }
  return _push(ctx, {
    type: 'idee_update', idee_id: ideeId, fields, before,
    ...(beleg ? { beleg } : {}),
    labels,
  }, input);
}

async function _proposeIdee(input, ctx) {
  const state = _state(ctx);
  const ideeId = _int(input.idee_id);
  return ideeId ? _proposeUpdate(input, ctx, state, ideeId) : _proposeCreate(input, ctx, state);
}

function _proposeLink(input, ctx) {
  const state = _state(ctx);
  const kind = input.target_kind;
  if (!isIdeaLinkKind(kind)) return _err(`target_kind muss einer von research, beat, thread, motif, draft sein.`);
  const targetId = _int(input.target_id);
  const target = targetId ? (state.targets?.[kind] || []).find(t => t.id === targetId) : null;
  if (!target) return _err(`${kind}#${input.target_id} ist kein verknüpfbares Ziel in diesem Buch. Nutze eine id aus der Zielliste.`);

  const ref = _int(input.idee_ref);
  if (ref) {
    const p = ctx.proposals[ref - 1];
    if (!p || p.type !== 'idee_create') return _err(`idee_ref ${ref} ist keine in dieser Antwort vorgeschlagene neue Idee.`);
    return _push(ctx, {
      type: 'link_create', idee_ref: ref, target_kind: kind, target_id: targetId,
      labels: { idee: _preview(p.fields.content), target: target.label },
    }, input);
  }
  const ideeId = _int(input.idee_id);
  const idee = ideeId ? state.ideeById.get(ideeId) : null;
  if (!idee) return _err(`Idee #${input.idee_id} gibt es nicht. Nutze eine [#id] aus der Ideenliste oder idee_ref.`);
  if ((idee.links || []).some(l => l.target_kind === kind && l.target_id === targetId)) {
    return _err(`Idee #${ideeId} ist mit ${kind}#${targetId} schon verknüpft.`);
  }
  return _push(ctx, {
    type: 'link_create', idee_id: ideeId, target_kind: kind, target_id: targetId,
    labels: { idee: _preview(idee.content), target: target.label },
  }, input);
}

const PROPOSE_HANDLERS = {
  propose_idee: _proposeIdee,
  propose_idee_link: _proposeLink,
};

async function executeIdeenChatTool(name, input, ctx) {
  if (PROPOSE_TOOLS.has(name)) {
    if (ctx.proposals.length >= MAX_PROPOSALS) {
      return _err(`Höchstens ${MAX_PROPOSALS} Vorschläge pro Antwort. Beende die Antwort mit final_answer.`);
    }
    return PROPOSE_HANDLERS[name](input || {}, ctx);
  }
  if (!ctx.offeredTools?.has(name)) throw new Error(`Unbekanntes Werkzeug: ${name}`);
  return executeCatalogTool(name, input, ctx);
}

module.exports = { executeIdeenChatTool, MAX_PROPOSALS, PROPOSE_TOOLS, pageQuoteHaystack, belegInPage };
