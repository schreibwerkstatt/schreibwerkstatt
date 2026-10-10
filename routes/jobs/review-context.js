'use strict';
// Lädt strukturierte Komplettanalyse-Daten + Lektorats-Findings für ein Buch
// und verdichtet sie zu einem Kontext-Objekt, das `buildBookReviewSinglePassPrompt`
// / `buildBookReviewMultiPassPrompt` einkippt.
//
// Alle Quellen sind optional: fehlt eine Komplettanalyse, bleibt das Feld leer
// und der Prompt-Block für diese Quelle wird vom Builder weggelassen.

const { db, getChapterFigures, getChapterFigureRelations, getLatestContinuityCheck,
  listWorldFacts, worldFactsScanState } = require('../../db/schema');
const { getGraph: getMotifGraph } = require('../../db/motifs');
const { listStructureChecks } = require('../../db/textsorte');
const { summarizeStrukturChecks } = require('../../lib/struktur-summary');
const { summarizeWorldFacts } = require('../../lib/welt-summary');
const plotDb = require('../../db/plot');
const { listFigureNamesForUser } = require('../../db/book-chat/figures');
const { listDraftFigures } = require('../../db/draft-figures');
const { beatsInReadingOrder } = require('../../lib/plot-reading-order');
const { listIdeenWithPlaces } = require('../../db/book-chat/catalog');

// Schutz vor Prompt-Bloat. Werte konservativ – die Buchreview liefert ohnehin
// den Volltext (Single-Pass) bzw. die Kapitelanalysen (Multi-Pass) als Hauptinput.
const MAX_FIGUREN          = 30;
const MAX_BEZIEHUNGEN      = 60;
const MAX_CONTINUITY       = 25;
const MAX_ZEITSTRAHL       = 40;
const MAX_MOTIVE           = 40;
const MAX_PLAN_BEATS       = 30;
const MAX_KAPITEL_IDEEN    = 20;
const MAX_OFFENE_BEATS     = 25;
const MAX_UNGESCHRIEBEN    = 10;

function _truncString(s, n) {
  if (!s) return '';
  const t = String(s).trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/** Lädt Zeitstrahl-Events aus zeitstrahl_events. Kapitel-Namen kommen via
 *  Junction-Tabelle zeitstrahl_event_chapters → chapters (Migration 74).
 *  Pro Event: kommagetrennte Kapitelnamen in Sort-Order.
 */
function _loadZeitstrahl(bookId, userEmail) {
  return db.prepare(`
    SELECT ze.datum, ze.ereignis, ze.typ, ze.bedeutung,
           (
             SELECT GROUP_CONCAT(c.chapter_name, ', ')
               FROM zeitstrahl_event_chapters zec
               LEFT JOIN chapters c ON c.chapter_id = zec.chapter_id
              WHERE zec.event_id = ze.id
           ) AS kapitel
      FROM zeitstrahl_events ze
     WHERE ze.book_id = ? AND ze.user_email = ?
     ORDER BY ze.sort_order, ze.id
  `).all(bookId, userEmail || '');
}

/** Sammelt alle für die Buchreview-Augmentation relevanten Strukturdaten.
 *  Liefert ein flaches Objekt mit den Buckets; leere Buckets bleiben als
 *  leere Arrays / null – der Prompt-Builder entscheidet, was er injiziert.
 */
function loadReviewKomplettContext(bookId, userEmail) {
  const figuren     = (getChapterFigures(bookId, null, userEmail) || []).slice(0, MAX_FIGUREN).map(f => ({
    name: f.name,
    kurzname: f.kurzname || null,
    typ: f.typ || null,
    geschlecht: f.geschlecht || null,
    beruf: f.beruf || null,
    beschreibung: _truncString(f.beschreibung, 240),
  }));
  const beziehungen = (getChapterFigureRelations(bookId, null, userEmail) || []).slice(0, MAX_BEZIEHUNGEN).map(b => ({
    von: b.von,
    zu: b.zu,
    typ: b.typ,
    beschreibung: _truncString(b.beschreibung, 160),
  }));
  const continuity  = getLatestContinuityCheck(bookId, userEmail);
  const continuityIssues = continuity?.issues
    ? continuity.issues.slice(0, MAX_CONTINUITY).map(i => ({
        schwere: i.schwere,
        typ: i.typ,
        beschreibung: _truncString(i.beschreibung, 240),
        kapitel: (i.kapitel || []).slice(0, 3),
        figuren: (i.figuren || []).slice(0, 5),
      }))
    : [];
  const zeitstrahl = _loadZeitstrahl(bookId, userEmail).slice(0, MAX_ZEITSTRAHL).map(e => ({
    datum: e.datum,
    ereignis: _truncString(e.ereignis, 160),
    typ: e.typ || null,
    kapitel: e.kapitel || null,
  }));

  return { figuren, beziehungen, continuityIssues, zeitstrahl };
}

/** Wie loadReviewKomplettContext, aber auf ein Kapitel (bzw. eine Menge von
 *  Kapitel-IDs bei include_subchapters) gescopt. Figuren/Beziehungen kommen aus
 *  den Auftritten in genau diesen Kapiteln; Kontinuitäts-Befunde und Zeitstrahl-
 *  Events werden über die Kapitelnamen gefiltert. So sieht die Kapitelbewertung
 *  die Buchwahrheit, die für ihre Achsen `figuren` und `kohaerenz` zählt, statt
 *  das Kapitel isoliert zu beurteilen.
 *
 *  @param {number} bookId
 *  @param {string} userEmail
 *  @param {{chapterIds:Array<number|string>, chapterNames:string[]}} scope
 */
function loadChapterReviewKomplettContext(bookId, userEmail, { chapterIds = [], chapterNames = [] } = {}) {
  const ids = [...new Set(chapterIds.map(Number).filter(Boolean))];
  const empty = { figuren: [], beziehungen: [], continuityIssues: [], zeitstrahl: [] };
  if (!bookId || !ids.length) return empty;
  const nameSet = new Set(chapterNames.map(n => String(n || '').toLowerCase().trim()).filter(Boolean));
  const inScope = (kap) => !nameSet.size
    || (Array.isArray(kap) ? kap : String(kap || '').split(','))
        .some(k => nameSet.has(String(k).toLowerCase().trim()));

  const figMap = new Map();
  for (const cid of ids) {
    for (const f of getChapterFigures(bookId, cid, userEmail) || []) {
      if (!figMap.has(f.id)) figMap.set(f.id, f);
    }
  }
  const figuren = [...figMap.values()].slice(0, MAX_FIGUREN).map(f => ({
    name: f.name,
    kurzname: f.kurzname || null,
    typ: f.typ || null,
    geschlecht: f.geschlecht || null,
    beruf: f.beruf || null,
    beschreibung: _truncString(f.beschreibung, 240),
  }));

  const relMap = new Map();
  for (const cid of ids) {
    for (const b of getChapterFigureRelations(bookId, cid, userEmail) || []) {
      relMap.set(`${b.von}\u0000${b.zu}\u0000${b.typ}`, b);
    }
  }
  const beziehungen = [...relMap.values()].slice(0, MAX_BEZIEHUNGEN).map(b => ({
    von: b.von,
    zu: b.zu,
    typ: b.typ,
    beschreibung: _truncString(b.beschreibung, 160),
  }));

  const continuity = getLatestContinuityCheck(bookId, userEmail);
  const continuityIssues = (continuity?.issues || [])
    .filter(i => inScope(i.kapitel))
    .slice(0, MAX_CONTINUITY).map(i => ({
      schwere: i.schwere,
      typ: i.typ,
      beschreibung: _truncString(i.beschreibung, 240),
      kapitel: (i.kapitel || []).slice(0, 3),
      figuren: (i.figuren || []).slice(0, 5),
    }));

  const zeitstrahl = _loadZeitstrahl(bookId, userEmail)
    .filter(e => e.kapitel && inScope(e.kapitel))
    .slice(0, MAX_ZEITSTRAHL).map(e => ({
      datum: e.datum,
      ereignis: _truncString(e.ereignis, 160),
      typ: e.typ || null,
      kapitel: e.kapitel || null,
    }));

  return { figuren, beziehungen, continuityIssues, zeitstrahl };
}

/** Lädt die Motiv-Werkstatt-Daten (Themen & Motive) für die Buchbewertung.
 *  Anders als die Komplettanalyse-Daten sind Motive teils AUTOR-ABSICHT (Soll):
 *  der Prompt-Block markiert sie deshalb explizit als geplant, nicht als
 *  Buchwahrheit. Pro Motiv wird das Soll (verankerte Figuren/Kapitel/Beats/Seiten)
 *  gegen das Ist (Fundstellen aus der Motiverkennung, `motif_occurrences`)
 *  gestellt, damit die Bewertung die Umsetzung/Kohärenz beurteilen kann, ohne
 *  eine Plan-Abweichung blind abzustrafen.
 *
 *  Buchweit (kein Kapitel-Scope) — nur für die Buchbewertung gedacht. Fehlt eine
 *  Motiv-Werkstatt, bleibt `motive` leer und der Prompt-Block entfällt.
 */
function loadReviewMotivContext(bookId, userEmail) {
  let graph;
  try {
    graph = getMotifGraph(bookId, userEmail);
  } catch {
    return { themen: [], motive: [] };
  }
  const themeById = new Map((graph?.themes || []).map(t => [t.id, t.name]));
  const themen = (graph?.themes || []).map(t => ({
    name: t.name,
    beschreibung: _truncString(t.beschreibung, 200),
  }));
  const motive = (graph?.motifs || []).slice(0, MAX_MOTIVE).map(m => ({
    name: m.name,
    thema: m.theme_id != null ? (themeById.get(m.theme_id) || null) : null,
    beschreibung: _truncString(m.beschreibung, 200),
    sollFiguren: (m.figures || []).map(f => f.name).filter(Boolean).slice(0, 8),
    sollKapitel: (m.chapters || []).map(c => c.name).filter(Boolean).slice(0, 8),
    sollBeats: (m.beats || []).length,
    sollSeiten: (m.pages || []).length,
    istFunde: m.occurrenceCount || 0,
  }));
  return { themen, motive };
}

/** Lädt die Ist-Befunde des Struktur-Checks und verdichtet sie für die Bewertung.
 *
 *  Anders als alle anderen Kontext-Quellen hier ist das eine MESSUNG, kein
 *  Modell-Urteil: der Struktur-Check prüft jeden Beitrag regelbasiert gegen den
 *  Soll-Katalog seiner Textsorte (SSoT public/js/prompts/textsorten.js). Ohne
 *  diesen Block schätzt die Bewertung die Formtreue der Sammlung, obwohl sie
 *  vorliegt.
 *
 *  Der Scope kommt über `pages` — die Job-Pfade haben ihre Seitenliste ohnehin
 *  geladen, und so bleibt hier jeder direkte Zugriff auf `pages` aus (Content-
 *  Store-Facade-Regel). Buchbewertung reicht alle Seiten herein, Kapitelbewertung
 *  nur die des Kapitels.
 *
 *  @param {number} bookId
 *  @param {Array<{id:number,title?:string,name?:string}>} pages Seiten im Scope
 *  @param {{scope?: 'book'|'chapter'}} opts
 *  @returns {object|null} null, wenn im Scope kein Befund vorliegt
 */
function loadStrukturContext(bookId, pages, { scope = 'book' } = {}) {
  if (!bookId || !pages?.length) return null;
  let checks;
  try {
    checks = listStructureChecks(bookId);
  } catch {
    return null;   // Struktur-Check ist optional (nur journalistische Bücher)
  }
  if (!checks?.length) return null;
  return summarizeStrukturChecks(checks, pages, { scope });
}

/** Verdichtet den Welt-Fakten-Index zur Weltaufbau-MESSUNG fuer die Buchbewertung.
 *
 *  Zweite Quelle neben dem Struktur-Check, die messt statt urteilt: `world_facts`
 *  sagt, welche Kategorien die Welt tragen, welche Subjekte ihre Naben sind und
 *  welche Kapitel gar nichts etablieren. Die Bewertung konnte das bisher nur aus
 *  dem Volltext schaetzen — im Multi-Pass sah sie nicht einmal den.
 *
 *  Buchweit (kein Kapitel-Scope): die Aussage ist die Verteilung ueber den Buchbogen,
 *  und die ist auf Kapitelebene keine. Die Kapitelbewertung bleibt darum unberuehrt.
 *
 *  `kapitelNamen` kommt vom Aufrufer (Lesereihenfolge aus der ohnehin geladenen
 *  Seitengruppierung) — so bleibt hier jeder Zugriff auf `chapters`/`pages` aus.
 *
 *  @param {number} bookId
 *  @param {string} userEmail
 *  @param {string[]} kapitelNamen  Kapitel in Lesereihenfolge
 *  @returns {object|null} null, wenn der Index nicht erhoben ist oder leer bleibt
 */
function loadWeltContext(bookId, userEmail, kapitelNamen = []) {
  if (!bookId) return null;
  try {
    const { scanned } = worldFactsScanState(bookId, userEmail);
    if (!scanned) return null;
    return summarizeWorldFacts({ scanned, fakten: listWorldFacts(bookId, userEmail) }, kapitelNamen);
  } catch {
    return null;   // Welt-Fakten sind optional (keine Komplettanalyse gelaufen)
  }
}

/** Lädt die GEPLANTEN Beats der Plot-Werkstatt, die auf die bewerteten Kapitel
 *  zielen — Autor-Absicht (Soll), keine Buchwahrheit. Ein Beat zielt aufs Kapitel
 *  über sein eigenes `chapter_id`, sonst über das seines Strangs (Live-Vererbung,
 *  docs/plot.md). Verworfene Beats fallen raus. Pro Beat zusätzlich der Ist-Befund
 *  der Beat-Verankerung (`im_text`: Anzahl Fundstellen; null = nie verankert),
 *  damit die Bewertung „als eingearbeitet markiert, aber nicht auffindbar" sieht,
 *  statt es zu raten.
 *
 *  Pro (Buch, User) skopiert wie das Board. Fehlt eine Plot-Planung oder zielt
 *  kein Beat auf diese Kapitel → null, der Prompt-Block entfällt.
 *
 *  @param {number} bookId
 *  @param {string} userEmail
 *  @param {Array<number|string>} chapterIds  bewertete Kapitel (inkl. Sub-Kapitel)
 *  @returns {{ beats: object[], gesamt: number, verankert: boolean }|null}
 */
function loadChapterPlanContext(bookId, userEmail, chapterIds = []) {
  const ids = new Set(chapterIds.map(Number).filter(Boolean));
  if (!bookId || !ids.size) return null;
  try {
    const threads = plotDb.listThreads(bookId, userEmail);
    const threadById = new Map(threads.map(t => [t.id, t]));
    const effChapter = (b) => b.chapter_id
      || (b.thread_id != null ? threadById.get(b.thread_id)?.chapter_id : null) || null;
    const all = plotDb.listBeats(bookId, userEmail);
    const inScope = all.filter(b => !b.verworfen && ids.has(Number(effChapter(b))));
    if (!inScope.length) return null;

    const actById = new Map(plotDb.listActs(bookId, userEmail).map(a => [a.id, a]));
    const ordered = beatsInReadingOrder({ acts: [...actById.values()], threads, beats: inScope });
    const figNames = new Map(listFigureNamesForUser(bookId, userEmail).map(r => [r.fig_id, r.name || r.kurzname || r.fig_id]));
    const draftNames = new Map(listDraftFigures(bookId, userEmail).map(d => [d.id, d.name]));
    const occ = plotDb.beatOccurrenceMap(bookId, userEmail, {});
    const verankert = plotDb.beatAnchorLastRun(bookId, userEmail) != null;

    const beats = ordered.slice(0, MAX_PLAN_BEATS).map(b => {
      const t = b.thread_id != null ? threadById.get(b.thread_id) : null;
      const figuren = [
        ...(b.fig_ids || []).map(f => figNames.get(f)),
        ...(b.draft_fig_ids || []).map(d => draftNames.get(d)),
        t?.fig_id ? figNames.get(t.fig_id) : (t?.draft_figure_id ? draftNames.get(t.draft_figure_id) : null),
      ].filter(Boolean);
      return {
        titel: b.titel,
        beschreibung: _truncString(b.beschreibung, 300),
        status: b.status,
        akt: actById.get(b.act_id)?.name || null,
        strang: t?.name || null,
        figuren: [...new Set(figuren)].slice(0, 6),
        orte: (b.locations || []).map(l => l.name).filter(Boolean).slice(0, 4),
        intensitaet: b.intensitaet || null,
        im_text: verankert ? (occ.get(b.id)?.count || 0) : null,
      };
    });
    return { beats, gesamt: inScope.length, verankert };
  } catch {
    return null;   // Plot-Werkstatt ist optional
  }
}

/** Lädt die OFFENEN Ideen/Pendenzen des Autors an den bewerteten Kapiteln — am
 *  Kapitel selbst oder an einer seiner Seiten (Stufe offen oder in Arbeit).
 *  Zweck: die Bewertung soll nicht als Empfehlung wiederholen, was der Autor dort
 *  schon notiert hat, sondern es höchstens bestätigen oder schärfen. Erledigte und
 *  verworfene fallen raus; Buch-Ideen ohne Ort gehören keinem Kapitel.
 *
 *  User-privat wie jede Ideen-Lesung. null ohne offene Idee (Block entfällt).
 *
 *  @returns {{ ideen: Array<{content:string, ort:string}>, gesamt: number }|null}
 */
function loadChapterIdeenContext(bookId, userEmail, chapterIds = []) {
  const ids = [...new Set(chapterIds.map(Number).filter(Boolean))];
  if (!bookId || !ids.length || !userEmail) return null;
  try {
    const rows = ids.flatMap(cid => listIdeenWithPlaces(bookId, userEmail, { offenOnly: true, chapterId: cid }));
    if (!rows.length) return null;
    const ideen = rows.slice(0, MAX_KAPITEL_IDEEN).map(r => ({
      content: _truncString(r.content, 240),
      ort: r.scope === 'page' && r.page_name ? `Seite «${r.page_name}»` : 'Kapitel',
    }));
    return { ideen, gesamt: rows.length };
  } catch {
    return null;   // Ideen sind optional
  }
}

/** Kapitel, die HINTER dem letzten Kapitel mit Text angelegt, aber noch leer
 *  sind — die Hüllen, die eine Autorin für Späteres anlegt. Pure.
 *
 *  Why: «Kapitel 3 von 12» las sich wie ein Buch mit neun geschriebenen
 *  Folgekapiteln. Leere Kapitel VOR dem letzten geschriebenen zählen nicht: das
 *  sind Lücken im Text, keine ausstehende Fortsetzung.
 *
 *  @param {Array<{id:number|string, name:string}>} chaptersFlat  Buchreihenfolge
 *  @param {Set<string>} writtenIds  Kapitel-IDs (String) mit Text
 *  @returns {{ namen: string[], gesamt: number }|null}
 */
function trailingUnwrittenChapters(chaptersFlat, writtenIds) {
  let last = -1;
  chaptersFlat.forEach((c, i) => { if (writtenIds.has(String(c.id))) last = i; });
  if (last === -1) return null;
  const rest = chaptersFlat.slice(last + 1).filter(c => !writtenIds.has(String(c.id)));
  if (!rest.length) return null;
  return { namen: rest.slice(0, MAX_UNGESCHRIEBEN).map(c => c.name), gesamt: rest.length };
}

/** Noch geplante Beats der Plot-Werkstatt (Status «geplant», nicht verworfen) in
 *  Lesereihenfolge — für die BUCHbewertung eines unfertigen Werks: wohin der
 *  bisher geschriebene Text laut Plan noch führen soll. Autor-Absicht, keine
 *  Textwahrheit. null ohne solche Beats (Block entfällt).
 *
 *  @param {Map<string,string>} chapterNameById  für die Zuordnung «Kapitel: …»
 *  @returns {{ beats: object[], gesamt: number, verankert: boolean }|null}
 */
function loadOpenPlanBeats(bookId, userEmail, chapterNameById = new Map()) {
  if (!bookId) return null;
  try {
    const threads = plotDb.listThreads(bookId, userEmail);
    const threadById = new Map(threads.map(t => [t.id, t]));
    const offen = plotDb.listBeats(bookId, userEmail).filter(b => !b.verworfen && b.status === 'geplant');
    if (!offen.length) return null;
    const acts = plotDb.listActs(bookId, userEmail);
    const actById = new Map(acts.map(a => [a.id, a]));
    const ordered = beatsInReadingOrder({ acts, threads, beats: offen });
    const verankert = plotDb.beatAnchorLastRun(bookId, userEmail) != null;
    const occ = verankert ? plotDb.beatOccurrenceMap(bookId, userEmail, {}) : null;
    const beats = ordered.slice(0, MAX_OFFENE_BEATS).map(b => {
      const t = b.thread_id != null ? threadById.get(b.thread_id) : null;
      const chId = b.chapter_id || t?.chapter_id || null;
      return {
        titel: b.titel,
        beschreibung: _truncString(b.beschreibung, 200),
        kapitel: chId ? (chapterNameById.get(String(chId)) || null) : null,
        akt: actById.get(b.act_id)?.name || null,
        strang: t?.name || null,
        intensitaet: b.intensitaet || null,
        im_text: verankert ? (occ.get(b.id)?.count || 0) : null,
      };
    });
    return { beats, gesamt: offen.length, verankert };
  } catch {
    return null;   // Plot-Werkstatt ist optional
  }
}

/** Werkstand für die Bewertungs-Prompts: null, wenn das Buch als abgeschlossen
 *  markiert ist (dann trägt der System-Prompt «Werk abgeschlossen»), sonst
 *  `{ inArbeit: true }`, mit `zielProzent`, wenn ein Zielumfang gesetzt ist und
 *  der Aufrufer die geschriebene Zeichenzahl kennt.
 *
 *  Die Kapitelbewertung übergibt bewusst KEINE Zeichenzahl: der Prozentwert
 *  hängt am ganzen Buch und invalidierte sonst den Kapitel-Cache bei jeder
 *  Änderung in einem anderen Kapitel.
 *
 *  @param {object|null} bookSettings  Ausgabe von getBookSettings
 *  @param {number|null} [writtenChars]
 *  `ungeschrieben`/`geplant` nur für die Buchbewertung (trailingUnwrittenChapters,
 *  loadOpenPlanBeats).
 *
 *  @returns {{ inArbeit: true, zielProzent: number|null, ungeschrieben?: object, geplant?: object }|null}
 */
function werkstandFor(bookSettings, writtenChars = null, { ungeschrieben = null, geplant = null } = {}) {
  if (bookSettings?.is_finished) return null;
  const goal = Number(bookSettings?.goal_target_chars) || 0;
  const zielProzent = goal > 0 && writtenChars != null
    ? Math.round((writtenChars / goal) * 100)
    : null;
  return {
    inArbeit: true, zielProzent,
    // Nur gesetzt, wenn vorhanden — die Signatur bleibt sonst wortgleich.
    ...(ungeschrieben ? { ungeschrieben } : {}),
    ...(geplant ? { geplant } : {}),
  };
}

module.exports = {
  werkstandFor,
  trailingUnwrittenChapters,
  loadOpenPlanBeats,
  loadChapterIdeenContext,
  loadChapterPlanContext,
  loadWeltContext,
  loadReviewKomplettContext,
  loadChapterReviewKomplettContext,
  loadReviewMotivContext,
  loadStrukturContext,
};
