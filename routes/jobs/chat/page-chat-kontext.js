'use strict';
// Weiterer Buch-Kontext des Abschnitts-Chats (docs/chats.md#abschnitts-chat):
//   - Zeitstrahl des Buchs (Block 1): Daten und Abfolge aus der Komplettanalyse —
//     ohne sie setzt das Modell Daten selbst fest.
//   - Offene Kontinuitäts-Befunde dieses Kapitels (Block 1).
//   - Offene Ideen im übrigen Buch (Block 2): der Plan des Autors für frühere und
//     spätere Teile, nach Lage zum aktuellen Abschnitt gruppiert.
//   - Frühere Szenen mit Figuren, die der Abschnitt nennt (Block 2).
// Hier wird nur geladen und eingeordnet; Form und Zeichendeckel macht
// public/js/prompts/page-chat-kontext.js. Kapitel-/Abschnittsnamen und die
// Lesereihenfolge kommen aus der Gliederung (content-store), nicht aus SQL-JOINs.

const {
  getLatestContinuityCheck, listContinuityIssuesForCheck, listContinuityIssueChapters,
  listTimelineEvents, listTimelineEventChapters, listTimelineEventFigures,
} = require('../../../db/book-chat/timeline');
const { getDescendantChapterIds } = require('../../../db/book-order');
const { formatChapterPath } = require('../../../lib/content-store');
const { getOpenBookIdeen, getSzenenMitFiguren } = require('../shared/queries');
const { mentionedFigureIds } = require('./page-chat-figuren');

function _groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/** Kapitel des Abschnitts samt Vorfahren (Pfad) und Unterkapiteln. */
function chapterScope(pageNode, chapterId) {
  const ids = new Set(pageNode?.chapter_ids || []);
  if (chapterId != null) {
    for (const id of getDescendantChapterIds(chapterId, { includeSelf: true })) ids.add(id);
  }
  return ids;
}

/**
 * Zeitstrahl des Buchs in Analyse-Reihenfolge. `imKapitel` markiert Ereignisse
 * dieses Kapitels (Vorrang beim Kappen).
 * @returns {Array<{ datum, ereignis, bedeutung, kapitel: string[], figuren: string[], imKapitel: boolean }>}
 */
function loadZeitstrahl(bookId, userEmail, scope) {
  const events = listTimelineEvents(bookId, userEmail || '');
  if (!events.length) return [];
  const ids = events.map(e => e.id);
  const chBy = _groupBy(listTimelineEventChapters(ids), 'event_id');
  const fgBy = _groupBy(listTimelineEventFigures(ids).filter(r => r.name), 'event_id');
  return events.map(e => {
    const ch = chBy.get(e.id) || [];
    return {
      datum: e.datum,
      ereignis: e.ereignis,
      bedeutung: e.bedeutung || null,
      kapitel: ch.map(c => c.chapter_name).filter(Boolean),
      figuren: (fgBy.get(e.id) || []).map(f => f.name),
      imKapitel: ch.some(c => scope.has(c.chapter_id)),
    };
  });
}

/** Offene (weder behobene noch verworfene) Befunde des jüngsten Checks, die dieses Kapitel betreffen. */
function loadKontinuitaet(bookId, userEmail, scope) {
  if (!scope.size) return [];
  const check = getLatestContinuityCheck(bookId, userEmail || null);
  if (!check) return [];
  const issues = listContinuityIssuesForCheck(check.id).filter(i => !i.resolved);
  if (!issues.length) return [];
  const chBy = _groupBy(listContinuityIssueChapters(issues.map(i => i.id)), 'issue_id');
  return issues
    .filter(i => (chBy.get(i.id) || []).some(c => scope.has(c.chapter_id)))
    .map(i => ({
      schwere: i.schwere || null,
      beschreibung: i.beschreibung || '',
      stelle_a: i.stelle_a || null,
      stelle_b: i.stelle_b || null,
      empfehlung: i.empfehlung || null,
      kapitel: (chBy.get(i.id) || []).map(c => c.chapter_name).filter(Boolean),
    }));
}

/**
 * Offene Ideen des Buchs ausser denen, die schon im Ideen-Block dieses Abschnitts
 * stehen, mit Ort und Lage zum aktuellen Abschnitt:
 *   'frueher' / 'spaeter' — Abschnitt oder Kapitel vor bzw. nach dem aktuellen
 *   'umgebend'           — ein übergeordnetes Kapitel des Abschnitts
 *   'buch'               — Idee ohne Ort
 * `abstand` = Abstand in Gliederungsknoten (Vorrang beim Kappen: nahe zuerst).
 */
function loadBuchIdeen(bookId, userEmail, { outline, pageId, excludeIds }) {
  const rows = getOpenBookIdeen(bookId, userEmail).filter(r => !excludeIds.has(r.id));
  if (!rows.length) return [];
  const pos = new Map();
  (outline || []).forEach((n, i) => pos.set(`${n.type}:${n.id}`, { i, n }));
  const cur = pos.get(`page:${pageId}`);
  const curChapters = new Set(cur?.n.chapter_ids || []);
  return rows.map(r => {
    const key = r.page_id != null ? `page:${r.page_id}` : r.chapter_id != null ? `chapter:${r.chapter_id}` : null;
    const hit = key ? pos.get(key) : null;
    if (!hit) {
      return { content: r.content, status: r.status, ort: null, lage: 'buch', abstand: Infinity, index: Infinity };
    }
    const { i, n } = hit;
    const ort = n.type === 'page'
      ? [formatChapterPath(n.path), n.name].filter(Boolean).join(' › ')
      : formatChapterPath(n.path);
    let lage;
    if (n.type === 'chapter' && curChapters.has(n.id)) lage = 'umgebend';
    else if (!cur) lage = 'buch';
    else lage = i < cur.i ? 'frueher' : 'spaeter';
    return { content: r.content, status: r.status, ort, lage, abstand: cur ? Math.abs(i - cur.i) : Infinity, index: i };
  });
}

/**
 * Szenen VOR dem aktuellen Abschnitt (Lesereihenfolge), in denen mindestens eine
 * Figur vorkommt, die der Abschnitt beim Namen nennt. Der Szenentitel ist eine
 * Ein-Satz-Inhaltsangabe — genau der Rückbezug, den der Chat sonst nicht hat (die
 * Figurendossiers tragen Szenen nur fürs eigene Kapitel, im Modus `ohne_listen` gar
 * nicht). Wertung/Kommentar bleiben weg: sie sind Kritik, kein Inhalt.
 * `abstand` = Abstand in Gliederungsknoten (Vorrang beim Kappen: nahe zuerst).
 */
function loadFruehereSzenen(bookId, userEmail, { outline, pageId, pageText, namen }) {
  if (!pageText || !namen?.length) return [];
  const mentioned = mentionedFigureIds(pageText, namen);
  if (!mentioned.size) return [];
  const nameById = new Map(namen.map(f => [f.id, f.kurzname || f.name]));
  const pos = new Map();
  (outline || []).forEach((n, i) => pos.set(`${n.type}:${n.id}`, { i, n }));
  const cur = pos.get(`page:${pageId}`);
  if (!cur) return [];
  const out = [];
  for (const s of getSzenenMitFiguren(bookId, userEmail)) {
    if (s.page_id === pageId) continue;
    const hit = s.page_id != null ? pos.get(`page:${s.page_id}`) : s.chapter_id != null ? pos.get(`chapter:${s.chapter_id}`) : null;
    if (!hit || hit.i >= cur.i) continue;
    // Szene am Kapitel des aktuellen Abschnitts ohne eigenen Abschnitt: Lage unklar → weglassen.
    if (hit.n.type === 'chapter' && (cur.n.chapter_ids || []).includes(hit.n.id)) continue;
    const gemeinsam = s.figure_ids.filter(id => mentioned.has(id));
    if (!gemeinsam.length) continue;
    out.push({
      titel: s.titel,
      ort: hit.n.type === 'page'
        ? [formatChapterPath(hit.n.path), hit.n.name].filter(Boolean).join(' › ')
        : formatChapterPath(hit.n.path),
      figuren: s.figure_ids.map(id => nameById.get(id)).filter(Boolean),
      abstand: cur.i - hit.i,
      index: hit.i,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Alles zusammen. `ideen` = die Ideen, die der Abschnitts-Chat schon mit [#id]
 * zeigt (getOpenIdeen) — sie kommen im Buch-Block nicht ein zweites Mal.
 */
function loadPageChatKontext({ bookId, userEmail, outline, pageId, chapterId, ideen, pageText, namen }) {
  const pageNode = (outline || []).find(n => n.type === 'page' && n.id === pageId) || null;
  const scope = chapterScope(pageNode, chapterId);
  return {
    zeitstrahl: loadZeitstrahl(bookId, userEmail, scope),
    kontinuitaet: loadKontinuitaet(bookId, userEmail, scope),
    buchIdeen: loadBuchIdeen(bookId, userEmail, {
      outline, pageId, excludeIds: new Set((ideen || []).map(i => i.id)),
    }),
    szenen: loadFruehereSzenen(bookId, userEmail, { outline, pageId, pageText, namen }),
  };
}

module.exports = { loadPageChatKontext, loadBuchIdeen, loadFruehereSzenen, chapterScope };
