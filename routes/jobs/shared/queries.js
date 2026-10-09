'use strict';
const { db } = require('../../../db/schema');
const { openStatusSql } = require('../../../lib/ideen-status');
const { listFigureAges } = require('../../../db/figure-ages');
const { birthCandidates, resolveBirth } = require('../../../lib/figure-birth');

/**
 * Offene Ideen einer Seite + des umliegenden Kapitels (user-spezifisch).
 * Werden im Seiten-Chat als Kontext eingespielt. Kapitel-Ideen sind oft
 * relevanter fuer Folgeseiten als rein seitenspezifische Notizen — daher
 * mit-eingespielt. `scope` ('page'|'chapter') unterscheidet im Prompt-Output.
 *
 * „Offen" heisst `offen` ODER `in_arbeit` (lib/ideen-status.js#openStatusSql) —
 * `erledigt` und `verworfen` fallen beide raus. Eine verworfene Idee als Absicht
 * des Autors vorzulegen waere die schlechtere Halluzinationsquelle von beiden:
 * das Modell schlaegt dann genau das vor, wogegen er sich entschieden hat.
 */
function getOpenIdeen(pageId, userEmail) {
  if (!pageId || !userEmail) return [];
  return db.prepare(`
    SELECT 'page' AS scope, i.content, i.created_at
    FROM ideen i
    WHERE i.page_id = ? AND i.user_email = ? AND ${openStatusSql('i')}
    UNION ALL
    SELECT 'chapter' AS scope, i.content, i.created_at
    FROM ideen i
    JOIN pages p ON p.chapter_id = i.chapter_id
    WHERE p.page_id = ? AND i.user_email = ? AND ${openStatusSql('i')}
    ORDER BY scope ASC, created_at ASC
  `).all(pageId, userEmail, pageId, userEmail);
}

/**
 * Letztes Lektorat einer Seite (user-spezifisch). Wird im Seiten-Chat als
 * Kontext eingespielt, damit die KI auf bereits gefundene Beanstandungen Bezug
 * nehmen kann ohne sie neu zu erfinden.
 */
function getLatestPageCheck(pageId, userEmail) {
  if (!pageId || !userEmail) return null;
  const row = db.prepare(`
    SELECT checked_at, error_count, errors_json, stilanalyse, fazit, model
    FROM page_checks
    WHERE page_id = ? AND user_email = ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(pageId, userEmail);
  if (!row) return null;
  let fehler = [];
  try { fehler = JSON.parse(row.errors_json || '[]'); } catch { fehler = []; }
  return {
    checked_at: row.checked_at,
    error_count: row.error_count,
    fehler,
    stilanalyse: row.stilanalyse || null,
    fazit: row.fazit || null,
    model: row.model || null,
  };
}

/** Letzte Buchbewertung für ein Buch (user-spezifisch) aus der DB. */
function getLatestReview(bookId, userEmail) {
  const row = db.prepare(`
    SELECT review_json FROM book_reviews
    WHERE book_id = ? AND user_email = ?
    ORDER BY reviewed_at DESC LIMIT 1
  `).get(bookId, userEmail);
  if (!row) return null;
  try { return JSON.parse(row.review_json); } catch { return null; }
}

/** Alle Figuren eines Buchs (user-spezifisch) als kompaktes Objekt-Array.
 *  chapterId (optional, Number): filtert auf Figuren/Orte/Szenen, die in
 *  diesem Kapitel auftreten. Übergabe per stabiler chapter_id (nicht Name) —
 *  Snapshot-Spalten existieren nicht mehr, alle Anzeige-Werte werden zur
 *  Lese-Zeit aus chapters JOIN'd. */
function getFiguren(bookId, userEmail, chapterId = null) {
  const figParams = chapterId != null ? [bookId, userEmail, chapterId] : [bookId, userEmail];
  const rows = db.prepare(`
    SELECT f.id AS db_id, f.fig_id, f.name, f.kurzname, f.typ, f.beschreibung, f.beruf, f.geschlecht, f.geburtstag,
           GROUP_CONCAT(DISTINCT ft.tag) AS tags,
           GROUP_CONCAT(DISTINCT c.chapter_name) AS kapitel
    FROM figures f
    LEFT JOIN figure_tags        ft ON ft.figure_id = f.id
    LEFT JOIN figure_appearances fa ON fa.figure_id = f.id
    LEFT JOIN chapters           c  ON c.chapter_id = fa.chapter_id
    WHERE f.book_id = ? AND f.user_email = ?
    ${chapterId != null ? 'AND EXISTS (SELECT 1 FROM figure_appearances fa2 WHERE fa2.figure_id = f.id AND fa2.chapter_id = ?)' : ''}
    GROUP BY f.id
    ORDER BY f.sort_order
  `).all(...figParams);

  const evtRows = db.prepare(`
    SELECT f.fig_id, fe.datum, fe.ereignis, fe.bedeutung, fe.typ,
           c.chapter_name AS kapitel
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    WHERE f.book_id = ? AND f.user_email = ?
    ORDER BY fe.sort_order
  `).all(bookId, userEmail);
  const eventsByFigId = {};
  for (const e of evtRows) {
    if (!eventsByFigId[e.fig_id]) eventsByFigId[e.fig_id] = [];
    eventsByFigId[e.fig_id].push({
      datum: e.datum, ereignis: e.ereignis,
      ...(e.bedeutung ? { bedeutung: e.bedeutung } : {}),
      typ: e.typ,
      ...(e.kapitel  ? { kapitel: e.kapitel }     : {}),
    });
  }

  const relRows = db.prepare(`
    SELECT ff.fig_id AS from_fig_id, ft.fig_id AS to_fig_id,
           r.typ, r.beschreibung, r.machtverhaltnis
    FROM figure_relations r
    JOIN figures ff ON ff.id = r.from_fig_id
    JOIN figures ft ON ft.id = r.to_fig_id
    WHERE r.book_id = ? AND r.user_email = ?
  `).all(bookId, userEmail);
  const relsByFigId = {};
  for (const r of relRows) {
    const entry = {
      typ: r.typ,
      ...(r.beschreibung    ? { beschreibung: r.beschreibung }       : {}),
      ...(r.machtverhaltnis != null ? { machtverhaltnis: r.machtverhaltnis } : {}),
    };
    if (!relsByFigId[r.from_fig_id]) relsByFigId[r.from_fig_id] = [];
    relsByFigId[r.from_fig_id].push({ mit: r.to_fig_id, ...entry });
    if (!relsByFigId[r.to_fig_id]) relsByFigId[r.to_fig_id] = [];
    relsByFigId[r.to_fig_id].push({ mit: r.from_fig_id, ...entry });
  }

  const locParams = chapterId != null ? [chapterId, bookId, userEmail] : [bookId, userEmail];
  const locRows = db.prepare(chapterId != null ? `
    SELECT f.fig_id, l.name, l.typ, l.beschreibung, l.stimmung
    FROM location_figures lf
    JOIN figures f ON f.id = lf.figure_id
    JOIN locations l ON l.id = lf.location_id
    JOIN location_chapters lc ON lc.location_id = l.id AND lc.chapter_id = ?
    WHERE l.book_id = ? AND l.user_email = ?
    ORDER BY l.sort_order
  ` : `
    SELECT f.fig_id, l.name, l.typ, l.beschreibung, l.stimmung
    FROM location_figures lf
    JOIN figures f ON f.id = lf.figure_id
    JOIN locations l ON l.id = lf.location_id
    WHERE l.book_id = ? AND l.user_email = ?
    ORDER BY l.sort_order
  `).all(...locParams);
  const locsByFigId = {};
  for (const l of locRows) {
    if (!locsByFigId[l.fig_id]) locsByFigId[l.fig_id] = [];
    locsByFigId[l.fig_id].push({
      name: l.name,
      ...(l.typ         ? { typ:         l.typ         } : {}),
      ...(l.beschreibung? { beschreibung: l.beschreibung} : {}),
      ...(l.stimmung    ? { stimmung:     l.stimmung    } : {}),
    });
  }

  const sceneParams = chapterId != null ? [bookId, userEmail, chapterId] : [bookId, userEmail];
  const sceneRows = db.prepare(chapterId != null ? `
    SELECT f.fig_id, fs.titel, c.chapter_name AS kapitel, fs.wertung, fs.kommentar
    FROM scene_figures sf
    JOIN figures f ON f.id = sf.figure_id
    JOIN figure_scenes fs ON fs.id = sf.scene_id
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    WHERE fs.book_id = ? AND fs.user_email = ? AND fs.chapter_id = ?
    ORDER BY fs.sort_order
  ` : `
    SELECT f.fig_id, fs.titel, c.chapter_name AS kapitel, fs.wertung, fs.kommentar
    FROM scene_figures sf
    JOIN figures f ON f.id = sf.figure_id
    JOIN figure_scenes fs ON fs.id = sf.scene_id
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    WHERE fs.book_id = ? AND fs.user_email = ?
    ORDER BY fs.sort_order
  `).all(...sceneParams);
  const scenesByFigId = {};
  for (const s of sceneRows) {
    if (!scenesByFigId[s.fig_id]) scenesByFigId[s.fig_id] = [];
    scenesByFigId[s.fig_id].push({
      titel: s.titel,
      ...(s.kapitel   ? { kapitel:   s.kapitel   } : {}),
      ...(s.wertung  != null ? { wertung:  s.wertung  } : {}),
      ...(s.kommentar ? { kommentar: s.kommentar } : {}),
    });
  }

  // Geburtsjahr nach derselben Vorrangregel wie `get_figure_age` (lib/figure-birth.js).
  // Ohne Jahrgang rechnet kein Chat ein Alter («wann wird X eingeschult?»), und ein
  // Widerspruch zwischen Steckbrief, Geburts-Ereignis und Alters-Index ist genau der
  // Befund, den eine solche Frage sucht.
  const indexYearById = new Map(listFigureAges(bookId, userEmail).map(a => [a.fig_id, a.geburtsjahr]));
  const birthById = new Map();
  for (const r of rows) {
    const { birth, widerspruch } = resolveBirth(birthCandidates(bookId, userEmail,
      { id: r.db_id, geburtstag: r.geburtstag }, indexYearById.get(r.fig_id) ?? null));
    if (!birth) continue;
    birthById.set(r.db_id, {
      geburtsjahr: birth.y, geburtsjahr_quelle: birth.quelle,
      ...(widerspruch ? { geburtsjahr_widerspruch: widerspruch } : {}),
    });
  }

  return rows.map(r => ({
    id: r.fig_id, name: r.name, kurzname: r.kurzname, typ: r.typ,
    beschreibung: r.beschreibung, beruf: r.beruf, geschlecht: r.geschlecht,
    ...(r.geburtstag ? { geburtstag: r.geburtstag } : {}),
    ...birthById.get(r.db_id),
    eigenschaften: r.tags ? r.tags.split(',') : [],
    kapitel: r.kapitel ? r.kapitel.split(',') : [],
    ...(eventsByFigId[r.fig_id]?.length  ? { lebensereignisse: eventsByFigId[r.fig_id]  } : {}),
    ...(relsByFigId[r.fig_id]?.length    ? { beziehungen:      relsByFigId[r.fig_id]    } : {}),
    ...(locsByFigId[r.fig_id]?.length    ? { schauplätze:      locsByFigId[r.fig_id]    } : {}),
    ...(scenesByFigId[r.fig_id]?.length  ? { szenen:           scenesByFigId[r.fig_id]  } : {}),
  }));
}

/**
 * Konversationshistorie einer Session als Messages-Array für die KI.
 * Fasst aufeinanderfolgende Messages derselben Rolle zusammen, damit die
 * user/assistant-Alternation strikt bleibt (LM-Studio-Chat-Templates werfen
 * sonst eine Jinja-Exception). Das passiert z.B. nach einem abgebrochenen
 * Job, der eine User-Message ohne Antwort in der DB hinterlassen hat.
 *
 * `annotate(row)` (optional) hängt an eine Nachricht einen Zusatz an — der
 * Seiten-Chat gibt so die früheren `vorschlaege` samt Status mit (die Zeile trägt
 * `role`, `content`, `vorschlaege` als JSON-String). Ohne `annotate` ist die
 * Historie reiner Gesprächstext (Buch-/Recherche-Chat).
 */
function buildChatMessageHistory(sessionId, { annotate = null } = {}) {
  const rows = db.prepare(`
    SELECT role, content, vorschlaege FROM chat_messages
    WHERE session_id = ? ORDER BY created_at ASC
  `).all(sessionId);
  const out = [];
  for (const r of rows) {
    const extra = annotate ? annotate(r) : '';
    const content = extra ? `${r.content}\n\n${extra}` : r.content;
    const last = out[out.length - 1];
    if (last && last.role === r.role) {
      last.content += '\n\n' + content;
    } else {
      out.push({ role: r.role, content });
    }
  }
  return out;
}

module.exports = { getOpenIdeen, getLatestReview, getLatestPageCheck, getFiguren, buildChatMessageHistory };
