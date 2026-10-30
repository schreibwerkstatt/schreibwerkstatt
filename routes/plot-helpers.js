'use strict';
// Gemeinsame Handler-Bausteine der Plot-Routen (routes/plot.js): Besitz-/ACL-
// Vorspann, Eingabe-Parser und die Anker-Anreicherung der Beat-Antworten. Kein
// Router — reine Funktionen, die die Fehler-Response bei Bedarf selbst senden.

const plotDb = require('../db/plot');
const { toIntId } = require('../lib/validate');
const { resolveChapterBookId } = require('../lib/content-ownership');
const { guardBook, sessionEmail } = require('../lib/acl');
const appSettings = require('../lib/app-settings');
const { timeKeyOf } = require('../lib/time-key');
const { parseDatum } = require('../lib/datum-parse');
const { parseActAgeRange } = require('../lib/plot-act-age');
const { computeFigureYears } = require('../lib/figure-years');
const { listAnalysedBirthYears } = require('../db/figure-ages');

// Entity per :id laden + Owner (user_email) + Buch-ACL prüfen. Gibt die Entity
// zurück oder null (die passende Fehler-Response wurde dann bereits gesendet).
// SSoT für die sonst in jedem :id-Handler (Akt/Beat/Thread/Run) wiederholte
// Login-/ID-/Owner-/Guard-Kette.
// Der Login-Check steht VOR dem Guard, weil der Besitz über die E-Mail geprüft
// wird — ohne ihn erschiene „nicht angemeldet" als 404. Gleicher Code wie der Guard.
function _loadOwned(req, res, getFn, notFoundCode) {
  const userEmail = sessionEmail(req);
  if (!userEmail) { res.status(401).json({ error_code: 'NOT_LOGGED_IN' }); return null; }
  const id = toIntId(req.params.id);
  if (!id) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  const row = getFn(id);
  if (!row || row.user_email !== userEmail) { res.status(404).json({ error_code: notFoundCode }); return null; }
  if (!guardBook(req, res, row.book_id, 'editor')) return null;
  return row;
}

// Book-skopierte Collection-Handler (kein :id): Login + book_id + ACL-Guard in
// einem Schritt. Gibt { userEmail, bookId } zurück oder null (die passende
// Fehler-Response wurde dann bereits gesendet). Pendant zu _loadOwned für die
// :id-Handler — SSoT für die sonst in jedem GET-Collection-Handler wiederholte
// book_id-/Guard-Kette (den Login prüft der Guard). Der Guard läuft VOR handler-spezifischen
// Zusatz-Validierungen (z.B. draft_id) — kein Leak an nicht-autorisierte Aufrufer.
function _requireBook(req, res) {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  if (!guardBook(req, res, bookId, 'editor')) return null;
  return { userEmail: sessionEmail(req), bookId };
}

// chapter_id muss zum Buch gehören, sonst NULL (kein Fremd-Verweis).
function _validChapterId(bookId, chapterId) {
  if (!chapterId) return null;
  return resolveChapterBookId(chapterId) === bookId ? parseInt(chapterId, 10) : null;
}

// Spannungswert (1–5) für den Spannungsbogen. undefined = ungültig (→ 400
// INVALID_INTENSITAET), null = leeren. Ganzzahl oder Ziffern-String, sonst nichts.
function _parseIntensitaet(raw) {
  if (raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw
    : (typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? parseInt(raw, 10) : NaN);
  return (Number.isInteger(n) && n >= 1 && n <= 5) ? n : undefined;
}

// 0/1-Flag (verworfen, archiviert): nur true/false/0/1 — alles andere ist ein
// Client-Fehler (→ 400 INVALID_FLAG), kein stilles truthy-Casting ("false" → 1).
function _parseFlag(raw) {
  if (raw === true || raw === 1) return 1;
  if (raw === false || raw === 0) return 0;
  return undefined;
}

// Anker-Felder (occ_count, occ_top) wie im Board-Payload — derselbe Lese-Filter
// (Score-Floor + nur anspringbare Fundstellen), damit das Drift-Badge nach
// POST/PATCH dieselbe Zahl zeigt wie nach dem nächsten GET /plot. Dazu das
// abgeleitete Zeitfenster `zeit_key` (lib/time-key.js) — zur Lesezeit aus dem
// Freitext gerechnet, nie gespeichert, damit es nicht neben `zeit` driftet.
function _anchorOpts() {
  return { minScore: Number(appSettings.get('plot.anchor.min_score')) || 0, navigableOnly: true };
}
function _withAnchor(beat, occ) {
  if (!beat) return beat;
  const e = occ || plotDb.beatOccurrenceEntry(beat.id, _anchorOpts());
  return { ...beat, occ_count: e ? e.count : 0, occ_top: e ? e.top : [], zeit_key: timeKeyOf(beat.zeit) };
}

// Zeitdaten der Katalog-Figuren für die Plot-Zeit (Zeit-Messung, Zeitvorschlag,
// Alters-Chip): fig_id → { name, geburtsjahr, geburtsjahr_quelle, stand }.
//   geburtsjahr — Steckbrief (figures.geburtstag), sonst das Geburtsjahr der
//     Alters-Analyse (db/figure-ages.js#listAnalysedBirthYears: aus dem Text
//     sicher belegt, ohne zweites Geburtsjahr im Text). `geburtsjahr_quelle` sagt welches
//     ('steckbrief' | 'text'). Ein nur aus Zeitstrahl-Ereignissen abgeleitetes
//     Jahr zählt nicht — „Geburt von X" hängt oft an der falschen Figur.
//   stand — wo der Text bei der Figur steht: ihr spätestes eigenes, sicher
//     datiertes Ereignis (lib/figure-years.js, nur bei echter Zeitlinie). Ohne
//     eigenes Ereignis null, nicht der Buch-Fallback.
// `stand: false` spart die Zeitlinien-Rechnung, wo nur Name + Geburtsjahr
// gebraucht werden (Board-Load: Alters-Chip und Akt-Fenster).
function _figureTimeMap(bookId, userEmail, { stand = true } = {}) {
  const years = stand ? computeFigureYears(bookId, userEmail) : null;
  const analysed = listAnalysedBirthYears(bookId, userEmail);
  const out = new Map();
  for (const f of plotDb.listFigureIdentities(bookId, userEmail)) {
    const p = f.geburtstag ? parseDatum(f.geburtstag) : null;
    const steckbrief = p && Number.isInteger(p.year) ? p.year : null;
    const text = analysed.has(f.id) ? analysed.get(f.id) : null;
    const fy = years && years.get(f.id);
    out.set(f.fig_id, {
      name: f.kurzname || f.name,
      geburtsjahr: steckbrief ?? text,
      geburtsjahr_quelle: steckbrief != null ? 'steckbrief' : (text != null ? 'text' : null),
      stand: fy && fy.anchor_ereignis != null && fy.jahr_im_roman != null
        ? { jahr: fy.jahr_im_roman, ereignis: fy.anchor_ereignis } : null,
    });
  }
  return out;
}

// act_id → { name, von, bis } für Akte, deren Name eine Altersspanne trägt.
function _actAgeMap(acts) {
  const out = new Map();
  for (const a of acts || []) {
    const r = parseActAgeRange(a.name);
    if (r) out.set(a.id, { name: a.name, ...r });
  }
  return out;
}

// thread_id → fig_id der Katalog-Hauptfigur (Werkstatt-Figuren haben kein Geburtsjahr).
function _threadFigMap(threads) {
  return new Map((threads || []).filter(t => t.fig_id).map(t => [t.id, t.fig_id]));
}

// Figuren-Bindung eines Strangs auflösen + aufs (Buch, User)-Subset validieren.
// figure_id kommt als TEXT-fig_id (Frontend-Identität) → INTEGER figures.id;
// draft_figure_id ist bereits INTEGER draft_figures.id. Fremd/leer → null.
function _resolveThreadFigure(bookId, userEmail, rawFigId) {
  return rawFigId ? (plotDb.resolveFigureIds(bookId, userEmail, [rawFigId])[0] || null) : null;
}
function _resolveThreadDraftFigure(bookId, userEmail, rawDraftId) {
  return rawDraftId ? (plotDb.resolveDraftFigureIds(bookId, userEmail, [rawDraftId])[0] || null) : null;
}

module.exports = {
  _loadOwned, _requireBook, _validChapterId, _parseIntensitaet, _parseFlag,
  _anchorOpts, _withAnchor, _resolveThreadFigure, _resolveThreadDraftFigure,
  _figureTimeMap, _actAgeMap, _threadFigMap,
};
