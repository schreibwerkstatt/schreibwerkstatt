'use strict';
// CRUD für draft_figures (Figuren-Werkstatt). Owner-Check pro Operation.
// Default-Mindmap-Knoten als i18n-Marker persistiert; Frontend löst via t() auf,
// damit die Locale-Wahl des späteren Betrachters gilt (CLAUDE.md-Pattern).

const express = require('express');
const {
  listDraftFigures, getDraftFigureBySource,
  createDraftFigure, updateDraftFigure, deleteDraftFigure,
  listImportableFigures, listWerkstattRuns, deleteWerkstattRun,
  getFigureWithDetails, setDraftSourceFigure, listLinkCandidates,
} = require('../db/schema');
const { importedSourceNames } = require('../db/draft-figures');
const { scopedDraft, scopedRun } = require('./draft-figures-acl');
const occDb = require('../db/draft-figure-occurrences');
const retrieval = require('../lib/semantic-retrieval');
const contentStore = require('../lib/content-store');
const { extractPsychologie, PSYCHE_KERNE } = require('../lib/draft-mindmap-extract');
const { computeArcFindings } = require('../lib/figure-arc');
const appSettings = require('../lib/app-settings');
const { buildMindmapFromFigure, mapArchetype } = require('../lib/draft-mindmap-builder');
const { defaultMindmap } = require('../lib/draft-mindmap-default');
const { toIntId } = require('../lib/validate');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const { getUser } = require('../db/app-users');
const { tServerParams } = require('../lib/i18n-server');
const { localIsoDate } = require('../lib/local-date');
const logger = require('../logger');

const router = express.Router();
// ACL: jede :book_id-Route erfordert mind. viewer-Rolle (drafts user-scoped,
// aber Anlage auf fremden Büchern sonst möglich → IDOR). Setzt zugleich den
// ALS-Logging-Context (book) + req.bookId/req.bookRole.
//
// Weil der Guard hier haengt, sind Login UND Buch-Id in jedem :book_id-Handler
// bereits geprueft: dort steht deshalb KEIN zweites sessionEmail()+401 und kein
// eigenes toIntId(req.params.book_id) — das waere toter Code mit einem zweiten
// error_code fuer dieselbe Lage. Die Buch-Id kommt als `req.bookId`.
router.param('book_id', aclParamGuard('viewer'));
const jsonBody = express.json({ limit: '1mb' });

const MAX_NAME_LEN = 200;
const MAX_NOTES_LEN = 8000;
const MAX_MINDMAP_BYTES = 256 * 1024;

// Struktur-Grenzen des Baums. Jeder Lesepfad (Brainstorm-Pfadsuche, Bogen-
// Extraktion, i18n-Resolve, Buch-Chat-Tools) laeuft rekursiv ueber den Baum und
// erwartet String-Topics: ein Knoten mit Zahl-Topic oder ein tausendfach
// verschachtelter Ast liesse dort `trim()` bzw. den Stack werfen — und die
// Bogen-Ansicht antwortete dann fuer ALLE Figuren des Users mit 500.
const MAX_MINDMAP_DEPTH = 64;
const MAX_MINDMAP_NODES = 5000;
const MAX_NODE_ID_LEN = 200;
const MAX_TOPIC_LEN = 2000;

function _validateMindmap(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!obj.data || typeof obj.data !== 'object') return false;
  const json = JSON.stringify(obj);
  if (json.length > MAX_MINDMAP_BYTES) return false;
  // Iterativ statt rekursiv: die Pruefung selbst darf an der Tiefe nicht werfen.
  const seen = new Set();
  const stack = [{ node: obj.data, depth: 1 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    if (depth > MAX_MINDMAP_DEPTH) return false;
    if (typeof node.id !== 'string' || !node.id || node.id.length > MAX_NODE_ID_LEN) return false;
    if (typeof node.topic !== 'string' || node.topic.length > MAX_TOPIC_LEN) return false;
    if (seen.has(node.id)) return false;   // jsMind adressiert Knoten ueber die id
    seen.add(node.id);
    if (seen.size > MAX_MINDMAP_NODES) return false;
    if (node.children != null) {
      if (!Array.isArray(node.children)) return false;
      for (const c of node.children) stack.push({ node: c, depth: depth + 1 });
    }
  }
  return true;
}

// Die Wurzel der Mindmap IST die Figur: ihr Topic folgt dem Namen, nie umgekehrt
// als zweite Quelle. Ohne das zeigte die Mindmap nach einer Umbenennung im
// Formular den alten Namen, und die KI saehe ihn im Knotenpfad („Mara > Stimme").
// Das Frontend spiegelt eine Umbenennung der Wurzel ins Namensfeld; hier wird
// die Invariante fuer jeden Schreibweg gezogen, auch fuer fremde Clients.
function _withRootName(mindmap, name) {
  if (!mindmap?.data || mindmap.data.topic === name) return mindmap;
  return { ...mindmap, data: { ...mindmap.data, topic: name } };
}

// Werkstatt-Runs: KI-Lauf-Historie pro Draft (Brainstorm + Consistency).
// Routen müssen VOR /:book_id stehen, sonst frisst der numerische Param-Match
// das Wort "runs" und Express liefert 400 INVALID_ID.
// Liste ohne result_json (spart bei vielen Einträgen); Detail liefert vollen
// JSON. Owner-Check via user_email auf draft (List) bzw. run (Get/Delete).
router.get('/by-id/:id/runs', (req, res) => {
  const draft = scopedDraft(req, res, req.params.id);
  if (!draft) return;
  res.json(listWerkstattRuns(draft.id, draft.user_email));
});

// Fundstellen EINER Werkstatt-Figur (Ist-Index des Bogens). Optionaler
// `kern`-Filter fuer den Zell-Klick im Verlaufsband: die Zelle nennt eine Zahl,
// und ohne ihre Aufloesung bleibt sie eine Behauptung (gleiche Begruendung wie
// das Zell-Detail der Motiv-Werkstatt). Ohne Filter alle Kerne.
router.get('/by-id/:id/occurrences', (req, res) => {
  const draft = scopedDraft(req, res, req.params.id);
  if (!draft) return;
  const kern = PSYCHE_KERNE.includes(req.query.kern) ? req.query.kern : null;
  // Derselbe Floor wie in der Bogen-Ansicht — sonst loeste die Zelle mehr
  // Fundstellen auf, als sie zaehlt.
  const minScore = Number(appSettings.get('werkstatt.anchor.min_score')) || 0;
  res.json(occDb.listDraftOccurrences(draft.id, { kern, minScore }));
});

router.get('/runs/:run_id', (req, res) => {
  const run = scopedRun(req, res, req.params.run_id);
  if (!run) return;
  res.json(run);
});

router.delete('/runs/:run_id', (req, res) => {
  const run = scopedRun(req, res, req.params.run_id);
  if (!run) return;
  deleteWerkstattRun(run.id, run.user_email);
  res.json({ ok: true });
});

// Liste aller Werkstatt-Figuren eines Buchs (per User).
router.get('/:book_id', (req, res) => {
  res.json(listDraftFigures(req.bookId, sessionEmail(req)));
});

// Einzelne Werkstatt-Figur per id.
router.get('/by-id/:id', (req, res) => {
  const draft = scopedDraft(req, res, req.params.id);
  if (!draft) return;
  res.json(draft);
});

// Neue Werkstatt-Figur. Body: { name, archetype?, notes?, mindmap? }.
// Ohne mindmap → Default-Tree (Steckbrief + Stimme + Subtext + Eigene Aspekte).
router.post('/:book_id', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = req.bookId;

  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_NAME_LEN) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });

  const archetype = req.body?.archetype ? String(req.body.archetype).trim().slice(0, 50) : null;
  const notes = req.body?.notes ? String(req.body.notes).slice(0, MAX_NOTES_LEN) : null;
  const mindmap = _withRootName(req.body?.mindmap || defaultMindmap(name), name);
  if (!_validateMindmap(mindmap)) return res.status(400).json({ error_code: 'MINDMAP_INVALID' });

  const created = createDraftFigure(bookId, userEmail, { name, archetype, mindmap, notes });
  logger.info(`[werkstatt] create id=${created.id} book=${bookId} name="${name}"`);
  res.json(created);
});

// Update. Body: { name?, archetype?, mindmap?, notes?, expectedUpdatedAt? }.
//
// `expectedUpdatedAt` ist der Stand, auf dem der Client editiert hat. Weicht er
// vom Server-Stand ab (zweiter Tab, Zweitgeraet), antwortet die Route 409
// DRAFT_CONFLICT samt aktuellem Draft, statt den neueren Stand still zu
// ueberschreiben. Ohne das Feld (Fremd-Clients) bleibt es beim Last-Write-Wins.
router.put('/:id', jsonBody, (req, res) => {
  const draft = scopedDraft(req, res, req.params.id);
  if (!draft) return;

  const expected = req.body?.expectedUpdatedAt;
  if (expected != null && String(expected) !== String(draft.updated_at)) {
    return res.status(409).json({ error_code: 'DRAFT_CONFLICT', current: draft });
  }

  const name = req.body?.name != null
    ? String(req.body.name).trim()
    : draft.name;
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_NAME_LEN) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });

  const archetype = req.body?.archetype != null
    ? (req.body.archetype ? String(req.body.archetype).trim().slice(0, 50) : null)
    : draft.archetype;
  const notes = req.body?.notes != null
    ? (req.body.notes ? String(req.body.notes).slice(0, MAX_NOTES_LEN) : null)
    : draft.notes;
  const mindmap = _withRootName(req.body?.mindmap != null ? req.body.mindmap : draft.mindmap, name);
  if (!_validateMindmap(mindmap)) return res.status(400).json({ error_code: 'MINDMAP_INVALID' });

  const updated = updateDraftFigure(draft.id, { name, archetype, mindmap, notes });
  res.json(updated);
});

// Liste der figures eines Buchs, die noch nicht importiert wurden (per User,
// dedupliziert pro Name, mit Kontext-Zweitzeile). Abfrage samt Dedupe-Regel:
// db/draft-figures.js#listImportableFigures.
router.get('/:book_id/importable', (req, res) => {
  res.json(listImportableFigures(req.bookId, sessionEmail(req)));
});

// Bogen-Ansicht: Ist-Index + Messung fuer ALLE Werkstatt-Figuren eines Buchs.
// Speist das Kern-x-Kapitel-Verlaufsband der Karte UND die Befund-Sammelstelle;
// ein zweiter Lesepfad zeigte zwei verschiedene Bestaende (gleiche Regel wie die
// zwei Ansichten des Recherche-Boards).
//
// `scanned=false` heisst UNGEPRUEFT, nicht abwesend: ohne befuellten Ist-Index
// liefert die Messung keine Befunde, und das Frontend weist den Zustand aus —
// sonst meldete ein nie gelaufener Anchor jeden Kern als „steht nicht im Buch"
// (gleiches Muster wie `motif_occurrences` und `anchorMap === null` im Plot-Check).
//
// Kapitel-Reihenfolge ueber die Content-Store-Facade (kein Direkt-SQL auf
// chapters), wortgleich mit routes/motifs.js#_chapterOrder.
function _chapterOrder(tree) {
  const out = [];
  (function walk(chapters) {
    for (const c of chapters || []) {
      out.push(c.id);
      walk(c.subchapters);
    }
  })(tree?.chapters);
  return out;
}

// Befund-Codes, die eine NULL an Fundstellen behaupten (lib/figure-arc.js).
const ARC_ZERO_CODES = new Set(['kernOhneText', 'bogenOhneBeleg']);

router.get('/:book_id/arc', async (req, res) => {
  const bookId = req.bookId;
  const userEmail = sessionEmail(req);
  try {
    const drafts = listDraftFigures(bookId, userEmail);
    // Verankert ist das Buch, sobald es Fundstellen gibt ODER ein Anchor-Lauf
    // erfolgreich durchlief — sonst bliebe ein Lauf ohne jeden Treffer fuer
    // immer „noch nicht verankert". Ohne vollstaendigen Index unter dem aktiven
    // Modell sucht ein Lauf nichts (figur-anchor scheitert dann mit
    // anchorNoIndex); ein frueherer Treffer-loser Lauf zaehlt darum nur, solange
    // der Index steht — nach einem Modellwechsel ist seine Null ungeprueft.
    const anchor = occDb.figurAnchorState(bookId, userEmail);
    const scanned = anchor.hasOccurrences || (anchor.lastJobRunMs != null && retrieval.indexReady(bookId));
    const floor = Number(appSettings.get('werkstatt.anchor.min_score')) || 0;

    // Counts + Kapitel-Aufschluesselung einmal buchweit holen und auf die Drafts
    // verteilen — kein Query pro Figur.
    const counts = new Map();
    for (const r of occDb.occCounts(bookId, userEmail, floor)) {
      if (!counts.has(r.draft_id)) counts.set(r.draft_id, {});
      counts.get(r.draft_id)[r.kern] = r.n;
    }
    const chapters = new Map();
    for (const r of occDb.occChapters(bookId, userEmail, floor)) {
      if (r.chapter_id == null) continue;   // Fundstelle ohne aufloesbares Kapitel
      if (!chapters.has(r.draft_id)) chapters.set(r.draft_id, {});
      const perKern = chapters.get(r.draft_id);
      (perKern[r.kern] ||= []).push({ chapterId: r.chapter_id, n: r.n });
    }

    const payload = drafts.map(d => {
      const psy = extractPsychologie(d.mindmap);
      const geplant = {};
      for (const k of PSYCHE_KERNE) geplant[k] = !!(psy && psy[k] && psy[k].length);
      return {
        id: d.id, name: d.name, archetype: d.archetype,
        geplant,
        counts: counts.get(d.id) || {},
        occ: chapters.get(d.id) || {},
        // Mindmap seit der letzten Verankerung geaendert: ein dabei neu geplanter
        // Kern wurde nie gesucht. Seine Null ist UNGEPRUEFT, nicht abwesend.
        anchorStale: scanned && occDb.draftChangedSinceAnchor(d, anchor.lastRunMs),
      };
    });

    const chapterOrder = _chapterOrder(await contentStore.bookTree(bookId, req));
    const staleIds = new Set(payload.filter(d => d.anchorStale).map(d => d.id));
    // Die Messung kennt nur Zahlen; „Kern ohne Fundstelle" darf sie nur ueber
    // Kerne behaupten, die der letzte Lauf auch gesucht hat. Fuer geaenderte
    // Drafts fallen die beiden Null-Befunde darum weg, bis neu verankert ist.
    const befunde = computeArcFindings({ drafts: payload, chapterOrder, scanned })
      .filter(b => !(staleIds.has(b.draft_id) && ARC_ZERO_CODES.has(b.code)));
    res.json({
      drafts: payload, befunde, scanned,
      stale: occDb.draftAnchorStale(bookId, userEmail),
      kerne: PSYCHE_KERNE,
    });
  } catch (e) {
    logger.error(`[werkstatt] Bogen-Ansicht fehlgeschlagen book=${bookId}: ${e.message}`, { stack: e.stack });
    res.status(500).json({ error_code: 'FIGURE_ARC_FAILED' });
  }
});

// Werkstatt-Figur aus bestehender figures-Row importieren. Body: { figureId }.
// Idempotent gegenüber doppelten Klicks: bestehender Draft mit gleicher
// source_figure_id → 409 mit existingDraftId, damit das Frontend dorthin
// navigieren kann statt einen zweiten Draft anzulegen.
router.post('/:book_id/import', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = req.bookId;
  const figureId = toIntId(req.body?.figureId);
  if (!figureId) return res.status(400).json({ error_code: 'FIGURE_ID_REQ' });

  const fig = getFigureWithDetails(figureId);
  if (!fig) return res.status(404).json({ error_code: 'FIGURE_NOT_FOUND' });
  if (fig.book_id !== bookId) return res.status(400).json({ error_code: 'FIGURE_BOOK_MISMATCH' });
  // Owner-Check: figures sind per User skopiert (ON DELETE pro User getrennt
  // via saveFigurenToDb). Nur eigene Figuren importierbar; Komplettanalyse-
  // Figuren mit user_email=NULL (Pre-Migration-Daten) bleiben verboten, sonst
  // entstünden Drafts ohne reverse-Owner-Pfad bei späterer figure-Mutation.
  if (fig.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });

  const existing = getDraftFigureBySource(bookId, userEmail, figureId);
  if (existing) {
    return res.status(409).json({ error_code: 'ALREADY_IMPORTED', existingDraftId: existing.id });
  }
  // Gleichnamige Katalog-Zeile (Merge-Kollision `__2`) einer schon importierten
  // Figur: dieselbe Figur, kein zweiter Draft. Gleiche Regel wie der Picker
  // (db/draft-figures.js#listImportableFigures).
  const norm = (s) => String(s || '').trim().toLowerCase();
  if (importedSourceNames(bookId, userEmail).has(norm(fig.name))) {
    const twin = listDraftFigures(bookId, userEmail).find(d => d.source_figure_id && norm(d.source_figure_name) === norm(fig.name));
    return res.status(409).json({ error_code: 'ALREADY_IMPORTED', existingDraftId: twin?.id ?? null });
  }

  const mindmap = buildMindmapFromFigure(fig);
  if (!_validateMindmap(mindmap)) return res.status(500).json({ error_code: 'MINDMAP_INVALID' });
  const archetype = mapArchetype(fig.typ);
  // Notiz in der Sprache des Users zum Import-Zeitpunkt, KEIN __i18n:-Marker:
  // das Notizfeld ist Freitext, ein Marker stuende dort roh im Textarea.
  const locale = getUser(userEmail)?.language || 'de';
  const notes = tServerParams('werkstatt.importNote', { name: fig.name, date: localIsoDate() }, locale);

  const created = createDraftFigure(bookId, userEmail, {
    name: fig.name,
    archetype,
    mindmap,
    notes,
    sourceFigureId: figureId,
  });
  logger.info(`[werkstatt] import draft=${created.id} from figure=${figureId} ("${fig.name}")`);
  res.json(created);
});

// Nachtraegliche Verknuepfung mit einer Katalog-Figur (`source_figure_id`).
//
// Der Weg fuer alle, die erst geplant und dann geschrieben haben: die
// Komplettanalyse legt die Figur ein zweites Mal an, und ohne diesen Zeiger
// bleiben es zwei Figuren — mit zwei Bruecken-Spalten an jedem Beat und jedem
// Motiv. `figureId: null` loest die Verknuepfung wieder.
//
// Kein Promotion-Pfad: der Katalog bleibt der abgeleitete Index der
// Komplettanalyse, hier wird nur ein Zeiger gesetzt.
router.get('/:book_id/link-candidates', (req, res) => {
  const cands = listLinkCandidates(req.bookId, sessionEmail(req));
  res.json(cands);
});

router.post('/by-id/:id/link-figure', jsonBody, (req, res) => {
  const draft = scopedDraft(req, res, req.params.id);
  if (!draft) return;
  const raw = req.body?.figureId;
  if (raw == null) {
    logger.info(`[werkstatt] unlink draft=${draft.id} von figure=${draft.source_figure_id}`);
    return res.json(setDraftSourceFigure(draft.id, null));
  }
  const figureId = toIntId(raw);
  if (!figureId) return res.status(400).json({ error_code: 'FIGURE_ID_REQ' });

  const fig = getFigureWithDetails(figureId);
  if (!fig) return res.status(404).json({ error_code: 'FIGURE_NOT_FOUND' });
  if (fig.book_id !== draft.book_id) return res.status(400).json({ error_code: 'FIGURE_BOOK_MISMATCH' });
  // Owner-Check wie beim Import: Pre-Migration-Figuren mit user_email IS NULL
  // bleiben verboten, sonst entstuende ein Zeiger ohne reverse-Owner-Pfad.
  if (fig.user_email !== draft.user_email) return res.status(403).json({ error_code: 'FORBIDDEN' });

  // Eine Katalog-Figur haengt an hoechstens EINEM Draft — sonst zeigten zwei
  // Werkstatt-Figuren auf dieselbe Quelle und die Lesezeit-Aufloesung waere
  // mehrdeutig (dasselbe, was der Import mit 409 ALREADY_IMPORTED abfaengt).
  const existing = getDraftFigureBySource(draft.book_id, draft.user_email, figureId);
  if (existing && existing.id !== draft.id) {
    return res.status(409).json({ error_code: 'ALREADY_IMPORTED', existingDraftId: existing.id });
  }

  logger.info(`[werkstatt] link draft=${draft.id} → figure=${figureId} ("${fig.name}")`);
  res.json(setDraftSourceFigure(draft.id, figureId));
});

router.delete('/:id', (req, res) => {
  const draft = scopedDraft(req, res, req.params.id);
  if (!draft) return;
  deleteDraftFigure(draft.id);
  logger.info(`[werkstatt] delete id=${draft.id}`);
  res.json({ ok: true });
});

module.exports = { router, defaultMindmap, _withRootName };
