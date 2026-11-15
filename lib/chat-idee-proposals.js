'use strict';
// Ideen-Vorschläge aus Abschnitts- und Buch-Chat: bemerkt das Modell beim
// Antworten einen Widerspruch, Fehler oder offenen Punkt, der sich nicht als
// Textersetzung lösen lässt, schlägt es vor, ihn als Idee (Pendenz) an einem
// Abschnitt oder Kapitel festzuhalten. Hier wird die Modellausgabe normalisiert und gegen
// das Buch geprüft — geschrieben wird NICHTS: der User erfasst jeden Vorschlag
// einzeln über POST /ideen (gleiche Validierung wie in der Ideen-Karte), der
// Status landet über PATCH /ideen/chat-proposal am Vorschlag.
//
// Gespeichertes Format (context_info.proposals[i]) — dieselbe Form wie das
// idee_create des Ideen-Chats (routes/jobs/ideen-chat-tools.js), damit der
// geteilte Status-Router (routes/chat-proposal-status.js) sie gleich behandelt:
//   { type: 'idee_create', fields: { content, page_id | chapter_id }, begruendung?,
//     labels: { anchor, anchor_kind: 'page'|'chapter' } }
//
// Anker ist ein Abschnitt ODER ein Kapitel des Session-Buchs (wie in der
// Ideen-Karte: höchstens einer). Auflösung:
//   - `ort: 'kapitel'` (Abschnitts-Chat): das genannte bzw. das Kapitel des
//     eigenen Abschnitts; hat der Abschnitt keins, der Abschnitt selbst.
//   - sonst `page_id` vor `chapter_id` (Buch-Chat; beide gesetzt → der Abschnitt
//     ist der genauere Ort), zuletzt der eigene Abschnitt (`defaultPageId`).
//   - ein Kapitel mit genau einem Abschnitt und ohne Unterkapitel ist derselbe
//     Ort wie dieser Abschnitt: der Vorschlag hängt dann am Abschnitt
//     (lib/idee-anchor.js, auch im Ideen-Chat) — sonst lägen die Ideen eines
//     solchen Buchs mal am Kapitel, mal am Abschnitt.
// Ein Vorschlag auf einen fremden oder unbekannten Ort fällt still heraus (kein
// Fehler für den User — die Antwort selbst bleibt gültig).
//
// Dazu (nur Abschnitts-Chat): Änderungen an den offenen Ideen, die der Chat im
// Prompt sieht — Text, Stufe, «erledigt» nur mit geprüftem Beleg aus dem
// Abschnitt (normalizeChatIdeeUpdates, Format = idee_update des Ideen-Chats).

const { getPageWithChapter, getChapterRow } = require('../db/book-chat/text');
const { canonicalIdeeAnchor } = require('./idee-anchor');
const { str: _str, posInt: _int } = require('./proposal-input');

const { isIdeeStatus } = require('./ideen-status');

const MAX_PROPOSALS = 5;
const MAX_CONTENT = 4000; // = routes/ideen.js MAX_LEN
const MAX_BEGRUENDUNG = 600;
const MAX_BELEG = 500;      // = routes/jobs/ideen-chat-tools.js MAX_BELEG
const MAX_UPDATES = 5;
const LABEL_CLIP = 120;

/**
 * Gleichheits-Schlüssel eines idee_create (Ort + Text ohne Gross/Klein) — eine
 * Antwort schlägt dieselbe Idee nicht zweimal vor. Geteilt mit dem Ideen-Chat
 * (routes/jobs/ideen-chat-tools.js). `fields` = { content, page_id?|chapter_id? }.
 */
function ideeProposalKey(fields) {
  const f = fields || {};
  const anchor = f.page_id ? `page:${f.page_id}` : f.chapter_id ? `chapter:${f.chapter_id}` : 'book';
  return `${anchor}\u0000${String(f.content || '').trim().toLowerCase()}`;
}

function _cached(cache, key, load) {
  if (!cache.has(key)) cache.set(key, load(key) || null);
  return cache.get(key);
}

/**
 * Anker eines Vorschlags → { kind: 'page'|'chapter', id, name } oder null.
 * Nur Orte im Buch `bookId`.
 */
function _resolveAnchor(item, { bookId, defaultPageId, pages, chapters }) {
  const page = (id) => {
    const r = id ? _cached(pages, id, getPageWithChapter) : null;
    return r && r.book_id === bookId ? r : null;
  };
  const chapter = (id) => {
    const r = id ? _cached(chapters, id, getChapterRow) : null;
    return r && r.book_id === bookId ? r : null;
  };
  const asPage = (r) => (r ? { kind: 'page', id: r.page_id, name: r.page_name } : null);
  const asChapter = (r) => (r ? { kind: 'chapter', id: r.chapter_id, name: r.chapter_name } : null);

  const pageId = _int(item.page_id);
  const chapterId = _int(item.chapter_id);
  if (item.ort === 'kapitel') {
    if (chapterId) return asChapter(chapter(chapterId));
    const own = page(pageId || defaultPageId);
    if (!own) return null;
    return asChapter(chapter(own.chapter_id)) || asPage(own);
  }
  if (pageId) return asPage(page(pageId));
  if (chapterId) return asChapter(chapter(chapterId));
  return asPage(page(defaultPageId));
}

/**
 * @param {unknown} raw  Modellfeld `ideen` (Array von { inhalt, begruendung?, page_id?, chapter_id?, ort? })
 * @param {{ bookId: number, defaultPageId?: number|null }} opts
 * @returns {Array<object>} normalisierte idee_create-Vorschläge (höchstens MAX_PROPOSALS)
 */
function normalizeChatIdeeProposals(raw, { bookId, defaultPageId = null } = {}) {
  if (!Array.isArray(raw) || !bookId) return [];
  const out = [];
  const seen = new Set();
  const ctx = { bookId, defaultPageId, pages: new Map(), chapters: new Map() };
  for (const item of raw) {
    if (out.length >= MAX_PROPOSALS) break;
    if (!item || typeof item !== 'object') continue;
    const content = _str(item.inhalt ?? item.content, MAX_CONTENT);
    if (!content) continue;
    const anchor = canonicalIdeeAnchor(_resolveAnchor(item, ctx));
    if (!anchor) continue;
    const key = ideeProposalKey({ content, [anchor.kind === 'page' ? 'page_id' : 'chapter_id']: anchor.id });
    if (seen.has(key)) continue;
    seen.add(key);
    const begruendung = _str(item.begruendung, MAX_BEGRUENDUNG);
    out.push({
      type: 'idee_create',
      fields: { content, [anchor.kind === 'page' ? 'page_id' : 'chapter_id']: anchor.id },
      ...(begruendung ? { begruendung } : {}),
      labels: { anchor: anchor.name || '', anchor_kind: anchor.kind },
    });
  }
  return out;
}

function _oneLine(s, n = LABEL_CLIP) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/**
 * Änderungs-Vorschläge des Abschnitts-Chats an den offenen Ideen, die er im
 * Prompt sieht (Abschnitt + umliegendes Kapitel). Gespeichertes Format = das
 * idee_update des Ideen-Chats (routes/jobs/ideen-chat-tools.js), damit Status-
 * Router und Beleg-Prüfung beim Übernehmen dieselben bleiben:
 *   { type: 'idee_update', idee_id, fields: { content?, status? }, before,
 *     beleg?: { text, page_id }, begruendung?, scope: { kind, id },
 *     labels: { idee, beleg_page? } }
 * `scope` = Anker der Idee — das Frontend liest darüber den aktuellen Stand nach.
 * Kein Ortswechsel, kein Zusammenführen: das bleibt dem Ideen-Chat.
 *
 * Regeln (Spiegel von routes/ideen.js + Ideen-Chat; die Route prüft beim
 * Übernehmen erneut):
 *   - nur Ideen aus `ideen` (dieselbe Liste wie im Prompt), je Idee ein Vorschlag;
 *   - Stufe nur, wenn bekannt, aktiv im Buch (`stages`) und anders als jetzt;
 *   - «erledigt» nur mit `beleg`, den `belegOk(text)` im Abschnitt findet
 *     (Heuhaufen = der Text, den das Modell las) — sonst fällt der Vorschlag weg;
 *     ein nicht gefundener Beleg an einer anderen Stufe fällt allein weg;
 *   - leerer Text = «nicht angegeben»; ein Vorschlag ohne Änderung fällt weg.
 * Was wegfällt, fällt still weg (die Antwort bleibt gültig) und wird gezählt.
 *
 * @param {unknown} raw  Modellfeld `ideen_aenderungen`
 *   (Array von { idee_id, inhalt?, status?, beleg?, begruendung? })
 * @param {{ ideen: Array<{id,content,status,scope}>, stages: string[], pageId: number,
 *   pageName?: string|null, chapterId?: number|null, belegOk: (text: string) => boolean }} opts
 * @returns {{ proposals: object[], dropped: number }}
 */
function normalizeChatIdeeUpdates(raw, { ideen, stages, pageId, pageName = null, chapterId = null, belegOk } = {}) {
  if (!Array.isArray(raw) || !raw.length) return { proposals: [], dropped: 0 };
  const byId = new Map((Array.isArray(ideen) ? ideen : []).map(i => [i.id, i]));
  const active = new Set(Array.isArray(stages) ? stages : []);
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    if (out.length >= MAX_UPDATES) { dropped++; continue; }
    const id = _int(item.idee_id);
    const idee = id ? byId.get(id) : null;
    if (!idee || seen.has(id)) { dropped++; continue; }
    const fields = {};
    const before = {};
    const content = _str(item.inhalt ?? item.content, MAX_CONTENT);
    if (content && content !== idee.content) { fields.content = content; before.content = idee.content; }
    const status = item.status;
    if (isIdeeStatus(status) && status !== idee.status && active.has(status)) {
      fields.status = status;
      before.status = idee.status;
    }
    const belegText = _str(item.beleg, MAX_BELEG);
    const belegFound = !!belegText && !!belegOk?.(belegText);
    if (fields.status === 'erledigt' && !belegFound) { dropped++; continue; }
    if (!Object.keys(fields).length) { dropped++; continue; }
    seen.add(id);
    const begruendung = _str(item.begruendung, MAX_BEGRUENDUNG);
    const scope = idee.scope === 'chapter' ? { kind: 'chapter', id: chapterId } : { kind: 'page', id: pageId };
    out.push({
      type: 'idee_update',
      idee_id: id,
      fields,
      before,
      ...(belegFound ? { beleg: { text: belegText, page_id: pageId } } : {}),
      ...(begruendung ? { begruendung } : {}),
      ...(scope.id ? { scope } : {}),
      labels: { idee: _oneLine(idee.content), ...(belegFound && pageName ? { beleg_page: pageName } : {}) },
    });
  }
  return { proposals: out, dropped };
}

module.exports = {
  normalizeChatIdeeProposals, normalizeChatIdeeUpdates, ideeProposalKey,
  MAX_CHAT_IDEE_PROPOSALS: MAX_PROPOSALS, MAX_CHAT_IDEE_UPDATES: MAX_UPDATES,
};
