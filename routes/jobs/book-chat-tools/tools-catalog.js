'use strict';
// Listing-/Lookup-Tools: Buch-Inventar (Kapitel, Figuren, Orte, Szenen,
// Ideen, Buch-Settings, Revisionen). Reines DB-Aggregat, kein
// Volltext-Laden. Temporal-Tools (Kontinuitaet/Zeitstrahl) liegen in tools-timeline.js.

const { getBookSettings, getBookName, worldFactsScanState } = require('../../../db/schema');
const { narrativeLabels } = require('../narrative-labels');
const pageRevisions = require('../../../db/page-revisions');
const { _truncateResult, _findFigure, resultCapFor } = require('./shared');
const { isIdeeStatus, isOpenIdeeStatus, normalizeIdeeStatus } = require('../../../lib/ideen-status');
const { listLocationChaptersWithNames } = require('../../../db/book-chat/text');
const { attachLinks: attachIdeaLinks } = require('../../../db/ideen');
const {
  listChaptersWithStats, listPagesWithStats, getPageHeader, listIdeenWithPlaces,
  listLocationsWithFirstPage, listLocationChaptersForLocations,
  listLocationFiguresForLocations, listLocationFigures, getLocationIdByLocId,
  getLocationByLocId, findLocationByName, listLocationScenesWithPlaces,
  listSongsWithFirstPage, listSongChaptersForSongs, listSongFiguresForSongs,
  listScenesWithPlaces, listSceneFiguresForScenes,
  listSceneLocationsForScenes, listFiguresWithMentions, listWorldFacts,
  listWorldFactChapterNames,
} = require('../../../db/book-chat/catalog');

// ── list_chapters ────────────────────────────────────────────────────────────
// Kompakt + paginiert: die Zusammenfassung (Summen, hint, Seitenformat) steht VOR
// der Kapitelliste — wird gekürzt, verliert das Modell die hintersten Kapitel, nie
// die Summen. Seiten als Tupel `[page_id, page_name, words]` statt Objekten (spart
// die Schlüssel pro Seite, bei Büchern mit hunderten Seiten der Hauptteil). Passt
// die Liste nicht in den Ergebnis-Deckel, wird sie kapitelweise abgeschnitten und
// `next_offset` genannt — kein String-Schnitt mitten in einer Seite.

const LIST_CHAPTERS_PAGE_FORMAT = '[page_id, page_name, words]';

function tool_list_chapters(input, ctx) {
  const chapterRows = listChaptersWithStats(ctx.bookId);

  // Seiten mit ihren Kapitelzuordnungen laden – inkl. Seiten ohne Kapitel (chapter_id IS NULL)
  const pageRows = listPagesWithStats(ctx.bookId);

  const pagesByChapter = new Map();
  const orphanPages = [];
  let totalWords = 0, totalPages = 0, totalChars = 0;
  for (const p of pageRows) {
    totalPages++;
    totalWords += p.words;
    totalChars += p.chars;
    const entry = [p.page_id, p.page_name, p.words];
    if (p.chapter_id == null) orphanPages.push(entry);
    else {
      if (!pagesByChapter.has(p.chapter_id)) pagesByChapter.set(p.chapter_id, []);
      pagesByChapter.get(p.chapter_id).push(entry);
    }
  }

  const allChapters = chapterRows.map(r => ({
    chapter_id:   r.chapter_id,
    chapter_name: r.chapter_name,
    words:        r.words,
    pages:        pagesByChapter.get(r.chapter_id) || [],
  }));

  const offset = Math.max(0, Number.isInteger(input?.offset) ? input.offset : 0);
  const limit  = Number.isInteger(input?.limit) && input.limit > 0 ? input.limit : allChapters.length;
  const head = {
    total_chapters: allChapters.length,
    total_pages:    totalPages,
    total_words:    totalWords,
    hint:           _listChaptersHint(totalChars, ctx.inputBudgetChars),
    page_format:    LIST_CHAPTERS_PAGE_FORMAT,
  };
  if (!head.hint) delete head.hint;

  const cap = resultCapFor(ctx);
  let shown = allChapters.slice(offset, offset + limit);
  const build = (list) => ({
    ...head,
    offset,
    chapters: list,
    ...(offset === 0 && orphanPages.length ? { pages_without_chapter: orphanPages } : {}),
    ...(offset + list.length < allChapters.length ? { next_offset: offset + list.length } : {}),
  });
  let out = build(shown);
  // Kapitelweise kürzen, bis es passt (mindestens ein Kapitel bleibt).
  while (shown.length > 1 && JSON.stringify(out).length > cap) {
    shown = shown.slice(0, Math.max(1, Math.floor(shown.length * 0.75)));
    out = build(shown);
  }
  if (out.next_offset != null) {
    out.paging_hint = `Weitere Kapitel: list_chapters mit offset=${out.next_offset} aufrufen.`;
  }
  return _truncateResult(out, cap);
}

// Lade-Hinweis abhängig davon, ob das ganze Buch in das Input-Budget passt.
// Schwelle 50 % des Budgets: lässt Platz für System-Prompt, Tool-Schemas und
// Chat-Historie. Ziel: bei semantischen Selektions-Aufgaben (lustigste/schönste
// Stellen, Ton, Stimmung) den Agenten zur Voll-Lektüre lenken statt zum seriellen
// search_passages-Stichwort-Raten. budget unbekannt → konservativer Wort-Fallback.
// Der Hinweis nennt die BEDINGUNG zuerst und die Erlaubnis danach: «passt in den Kontext»
// ist eine Aussage über Kapazität, kein Auftrag. Sonst liest der Agent Voll-Lektüre als
// Standardweg und lädt auch für eine einzelne Faktenfrage ganze Kapitel.
function _listChaptersHint(totalChars, inputBudgetChars) {
  const budget = Number(inputBudgetChars) || 0;
  const cheapFirst = 'Für eine einzelne Faktenfrage (Alter, Datum, Beruf, Ort, Beziehung) bleibst du '
    + 'beim Erst-Kontext bzw. search_similar/search_passages/get_figure_profile — Volltext nicht nötig.';
  if (budget > 0 && totalChars > 0 && totalChars < budget * 0.5) {
    return 'NUR falls die Frage den ganzen Text sichten muss (inhaltliche/semantische Selektion über '
      + 'das Buch — lustigste/schönste/spannendste Stellen, Ton, Stimmung): das ganze Buch passt in den '
      + 'Kontext, lade dann ganze Kapitel via get_chapter_text (mehrere gebündelt in EINER Runde) und '
      + `wähle aus eigener Lektüre aus, statt mit search_passages nach Stichwörtern zu raten. ${cheapFirst}`;
  }
  if (totalChars > 0 && totalChars < 60000) {
    return 'Eher kleines Buch – du kannst ganze Kapitel via get_chapter_text (gebündelt) oder '
      + `Abschnitte via get_pages laden, WENN die Frage Lektüre statt Stichwort-Suche verlangt. ${cheapFirst}`;
  }
  return undefined;
}

// ── list_ideen ────────────────────────────────────────────────────────────────

const IDEEN_DEFAULT_LIMIT = 50;
const IDEEN_CONTENT_CHARS = 400;

function tool_list_ideen(input, ctx) {
  const userEmail = ctx.userEmail || '';
  // `status` ist die Achse (offen → in_arbeit → erledigt, daneben verworfen);
  // `offen_only` ist die Abkuerzung fuer die haeufigste Frage („was ist hier
  // noch offen?") und meint offen UND in_arbeit.
  const statusFilter = isIdeeStatus(input?.status) ? input.status : null;
  const offenOnly = input?.offen_only === true;
  const pageFilter    = Number.isInteger(input?.page_id)    ? input.page_id    : null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const limit = Math.min(200, Math.max(1, Number.isInteger(input?.limit) ? input.limit : IDEEN_DEFAULT_LIMIT));

  const rows = listIdeenWithPlaces(ctx.bookId, userEmail, {
    status: statusFilter, offenOnly, pageId: pageFilter, chapterId: chapterFilter,
  });
  if (!rows.length) return { ideen: [], total: 0 };

  const total = rows.length;
  // Verknuepfungen (Beat / Motiv / Recherche-Fundstueck …) nur fuer die gezeigten
  // Zeilen nachladen — Label per JOIN zur Lesezeit (db/ideen.js#attachLinks).
  const shown = attachIdeaLinks(rows.slice(0, limit));
  const limited = shown.map(r => ({
    id: r.id,
    scope: r.scope,
    content: r.content && r.content.length > IDEEN_CONTENT_CHARS
      ? r.content.slice(0, IDEEN_CONTENT_CHARS) + '…'
      : (r.content || ''),
    status: normalizeIdeeStatus(r.status),
    status_at: r.status_at || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    page_id: r.page_id,
    page_name: r.page_name || null,
    chapter_id: r.effective_chapter_id ?? null,
    chapter_name: r.chapter_name || null,
    ...(r.links?.length
      ? { verknuepft: r.links.map(l => ({ art: l.target_kind, id: l.target_id, label: l.label })) }
      : {}),
  }));

  const offen = rows.filter(r => isOpenIdeeStatus(r.status)).length;
  return _truncateResult({
    ideen: limited,
    total,
    offen,
    abgeschlossen: total - offen,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
  });
}

// ── list_locations ────────────────────────────────────────────────────────────

function tool_list_locations(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;

  const rows = listLocationsWithFirstPage(ctx.bookId, userEmail, chapterFilter);
  if (!rows.length) {
    return { locations: [], hint: 'Keine Orte vorhanden. Komplettanalyse ausführen.' };
  }

  const locIds = rows.map(r => r.id);

  const chRows = listLocationChaptersForLocations(locIds);
  const fgRows = listLocationFiguresForLocations(ctx.bookId, userEmail, locIds);

  const chByLoc = new Map();
  for (const r of chRows) {
    if (!chByLoc.has(r.location_id)) chByLoc.set(r.location_id, []);
    chByLoc.get(r.location_id).push({ chapter_id: r.chapter_id, chapter_name: r.chapter_name || null, haeufigkeit: r.haeufigkeit });
  }
  const fgByLoc = new Map();
  for (const r of fgRows) {
    if (!fgByLoc.has(r.location_id)) fgByLoc.set(r.location_id, []);
    fgByLoc.get(r.location_id).push({ fig_id: r.fig_id, name: r.name || null });
  }

  return _truncateResult({
    locations: rows.map(r => {
      const kap = chByLoc.get(r.id) || [];
      return {
        loc_id: r.loc_id,
        name: r.name,
        typ: r.typ || null,
        beschreibung: r.beschreibung || null,
        stimmung: r.stimmung || null,
        erste_erwaehnung: r.erste_erwaehnung || null,
        erste_erwaehnung_page_id: r.erste_erwaehnung_page_id || null,
        erste_erwaehnung_page_name: r.erste_erwaehnung_page_name || null,
        kapitel: kap,
        last_chapter: kap.length ? kap[kap.length - 1] : null,
        figuren: fgByLoc.get(r.id) || [],
      };
    }),
    total: rows.length,
  });
}

// ── list_songs ──────────────────────────────────────────────────────────────

const SONGS_DEFAULT_LIMIT = 50;
const SONGS_MAX_LIMIT     = 200;

function tool_list_songs(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const limit = Math.min(SONGS_MAX_LIMIT, Math.max(1, Number.isInteger(input?.limit) ? input.limit : SONGS_DEFAULT_LIMIT));

  let figFilterId = null;
  if (input?.figur_id || input?.figur_name) {
    const figRow = _findFigure(input, ctx);
    if (!figRow) return { error: 'Figur nicht gefunden' };
    figFilterId = figRow.id;
  }

  const rows = listSongsWithFirstPage(ctx.bookId, userEmail, {
    chapterId: chapterFilter, figureId: figFilterId,
  });
  if (!rows.length) {
    return { songs: [], total: 0, hint: 'Keine Songs für diesen Filter. Songs werden in der Musikbibliothek bzw. via Komplettanalyse erfasst.' };
  }

  const songIds = rows.map(r => r.id);

  const chRows = listSongChaptersForSongs(songIds);
  const fgRows = listSongFiguresForSongs(songIds);

  const chBy = new Map();
  for (const r of chRows) {
    if (!chBy.has(r.song_id)) chBy.set(r.song_id, []);
    chBy.get(r.song_id).push({ chapter_id: r.chapter_id, chapter_name: r.chapter_name || null, haeufigkeit: r.haeufigkeit });
  }
  const fgBy = new Map();
  for (const r of fgRows) {
    if (!fgBy.has(r.song_id)) fgBy.set(r.song_id, []);
    fgBy.get(r.song_id).push({ fig_id: r.fig_id, name: r.name || null, kontext_typ: r.kontext_typ || null });
  }

  const total = rows.length;
  const limited = rows.slice(0, limit).map(r => ({
    song_id:                    r.song_uid,
    titel:                      r.titel,
    interpret:                  r.interpret || null,
    genre:                      r.genre || null,
    kontext_typ:                r.kontext_typ || null,
    beschreibung:               r.beschreibung || null,
    stimmung:                   r.stimmung || null,
    erste_erwaehnung:           r.erste_erwaehnung || null,
    erste_erwaehnung_page_id:   r.erste_erwaehnung_page_id || null,
    erste_erwaehnung_page_name: r.erste_erwaehnung_page_name || null,
    kapitel:                    chBy.get(r.id) || [],
    figuren:                    fgBy.get(r.id) || [],
  }));

  return _truncateResult({
    songs: limited,
    total,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
  });
}

// ── get_location_profile ──────────────────────────────────────────────────────

function tool_get_location_profile(input, ctx) {
  const userEmail = ctx.userEmail || null;
  let locRow = null;
  if (input?.loc_id) {
    locRow = getLocationByLocId(ctx.bookId, input.loc_id, userEmail);
  }
  if (!locRow && input?.name) {
    locRow = findLocationByName(ctx.bookId, userEmail, input.name);
  }
  if (!locRow) return { error: 'Ort nicht gefunden. Erst list_locations rufen, um loc_id/Name zu ermitteln.' };

  const kapitel = listLocationChaptersWithNames(locRow.id).map(r => ({ chapter_id: r.chapter_id, chapter_name: r.chapter_name || null, haeufigkeit: r.haeufigkeit }));

  const figuren = listLocationFigures(ctx.bookId, userEmail, locRow.id).map(r => ({ fig_id: r.fig_id, name: r.name || null }));

  const szenen = listLocationScenesWithPlaces(locRow.id, ctx.bookId, userEmail).map(r => ({
    scene_id: r.scene_id, titel: r.titel, wertung: r.wertung || null,
    chapter_id: r.chapter_id, chapter_name: r.chapter_name || null,
    page_id: r.page_id, page_name: r.page_name || null,
  }));

  return _truncateResult({
    loc_id:                     locRow.loc_id,
    name:                       locRow.name,
    typ:                        locRow.typ || null,
    beschreibung:               locRow.beschreibung || null,
    stimmung:                   locRow.stimmung || null,
    erste_erwaehnung:           locRow.erste_erwaehnung || null,
    erste_erwaehnung_page_id:   locRow.erste_erwaehnung_page_id || null,
    erste_erwaehnung_page_name: locRow.erste_erwaehnung_page_name || null,
    kapitel,
    last_chapter: kapitel.length ? kapitel[kapitel.length - 1] : null,
    figuren,
    szenen,
    total_kapitel: kapitel.length,
    total_figuren: figuren.length,
    total_szenen: szenen.length,
  });
}

// ── list_scenes ───────────────────────────────────────────────────────────────

const SCENES_DEFAULT_LIMIT = 50;

function tool_list_scenes(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const pageFilter    = Number.isInteger(input?.page_id)    ? input.page_id    : null;
  const limit = Math.min(200, Math.max(1, Number.isInteger(input?.limit) ? input.limit : SCENES_DEFAULT_LIMIT));

  let figFilterId = null;
  if (input?.figur_id || input?.figur_name) {
    const figRow = _findFigure(input, ctx);
    if (!figRow) return { error: 'Figur nicht gefunden' };
    figFilterId = figRow.id;
  }
  let locFilterId = null;
  if (input?.loc_id) {
    const locRow = getLocationIdByLocId(ctx.bookId, input.loc_id, userEmail);
    if (!locRow) return { error: 'Ort nicht gefunden' };
    locFilterId = locRow.id;
  }

  const rows = listScenesWithPlaces(ctx.bookId, userEmail, {
    chapterId: chapterFilter, pageId: pageFilter, figureId: figFilterId, locationId: locFilterId,
  });
  if (!rows.length) return { scenes: [], total: 0, hint: 'Keine Szenen für diesen Filter.' };

  const sceneIds = rows.map(r => r.id);

  const sfRows = listSceneFiguresForScenes(sceneIds);
  const slRows = listSceneLocationsForScenes(sceneIds);

  const sfBy = new Map();
  for (const r of sfRows) {
    if (!sfBy.has(r.scene_id)) sfBy.set(r.scene_id, []);
    sfBy.get(r.scene_id).push({ fig_id: r.fig_id, name: r.name });
  }
  const slBy = new Map();
  for (const r of slRows) {
    if (!slBy.has(r.scene_id)) slBy.set(r.scene_id, []);
    slBy.get(r.scene_id).push({ loc_id: r.loc_id, name: r.name });
  }

  const total = rows.length;
  const limited = rows.slice(0, limit).map(r => ({
    scene_id: r.id,
    titel: r.titel,
    wertung: r.wertung || null,
    kommentar: r.kommentar || null,
    chapter_id: r.chapter_id, chapter_name: r.chapter_name || null,
    page_id: r.page_id, page_name: r.page_name || null,
    figuren: sfBy.get(r.id) || [],
    orte:    slBy.get(r.id) || [],
  }));

  return _truncateResult({
    scenes: limited,
    total,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
  });
}

// ── get_book_settings ─────────────────────────────────────────────────────────

const BUCHTYP_LABELS_DE = {
  roman: 'Roman',
  kurzgeschichten: 'Kurzgeschichten',
  gesellschaft: 'Gesellschaftsroman',
  krimi: 'Krimi / Thriller',
  historisch: 'Historischer Roman',
  fantasy_scifi: 'Fantasy / Science-Fiction',
  erotik: 'Erotik',
  jugend: 'Jugendbuch / Kinderbuch',
  autobiografie: 'Autobiografie / Memoir',
  tagebuch: 'Tagebuch',
  sachbuch: 'Sachbuch',
  lyrik: 'Lyrik',
  essay: 'Essay',
  blog: 'Blog',
  satire: 'Satire',
  andere: 'Andere',
};

function tool_get_book_settings(_input, ctx) {
  const userEmail = ctx.userEmail || null;
  const settings = getBookSettings(ctx.bookId, userEmail);
  const labels = narrativeLabels(settings);
  return {
    book_id:                  ctx.bookId,
    book_name:                getBookName(ctx.bookId) || null,
    language:                 settings.language,
    region:                   settings.region,
    locale:                   `${settings.language}-${settings.region}`,
    buchtyp:                  settings.buchtyp || null,
    buchtyp_label:            settings.buchtyp ? (BUCHTYP_LABELS_DE[settings.buchtyp] || settings.buchtyp) : null,
    erzaehlperspektive:       settings.erzaehlperspektive || null,
    erzaehlperspektive_label: labels.erzaehlperspektive,
    erzaehlzeit:              settings.erzaehlzeit || null,
    erzaehlzeit_label:        labels.erzaehlzeit,
    buch_kontext:             settings.buch_kontext || null,
    is_finished:              settings.is_finished ? 1 : 0,
    daily_goal_chars:         settings.daily_goal_chars || null,
  };
}

// ── list_figures ──────────────────────────────────────────────────────────────

const LIST_FIGURES_DEFAULT_LIMIT = 50;
const LIST_FIGURES_MAX_LIMIT     = 200;

function tool_list_figures(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const limit = Math.min(Math.max(1, input?.limit || LIST_FIGURES_DEFAULT_LIMIT), LIST_FIGURES_MAX_LIMIT);
  const sort = ['mentions_desc', 'name', 'presence_desc'].includes(input?.sort) ? input.sort : 'mentions_desc';

  const rows = listFiguresWithMentions(ctx.bookId, userEmail);

  const PRES_ORDER = { 'haupt': 0, 'protagonist': 0, 'haupt-': 0, 'wichtig': 1, 'neben': 2, 'rand': 3, 'statist': 4 };
  const presKey = (p) => {
    if (!p) return 99;
    const k = String(p).toLowerCase();
    for (const key of Object.keys(PRES_ORDER)) if (k.includes(key)) return PRES_ORDER[key];
    return 50;
  };

  const sorted = [...rows];
  if (sort === 'mentions_desc') sorted.sort((a, b) => b.mentions - a.mentions || a.id - b.id);
  else if (sort === 'name')      sorted.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'presence_desc') sorted.sort((a, b) => presKey(a.praesenz) - presKey(b.praesenz) || b.mentions - a.mentions);

  const sliced = sorted.slice(0, limit);
  return _truncateResult({
    total: rows.length,
    results: sliced.map(r => ({
      fig_id:   r.fig_id,
      name:     r.name,
      kurzname: r.kurzname || null,
      typ:      r.typ || null,
      rolle:    r.rolle || null,
      praesenz: r.praesenz || null,
      mentions: r.mentions,
    })),
    ...(sliced.length < rows.length ? { truncated: true, total_results: rows.length } : {}),
  });
}

// ── list_revisions ────────────────────────────────────────────────────────────

const LIST_REVISIONS_DEFAULT_LIMIT = 20;
const LIST_REVISIONS_MAX_LIMIT     = 100;

function tool_list_revisions(input, ctx) {
  const pageId = input?.page_id;
  if (!Number.isInteger(pageId)) return { error: 'page_id fehlt' };

  const pageRow = getPageHeader(pageId);
  if (!pageRow || pageRow.book_id !== ctx.bookId) {
    return { error: 'Abschnitt nicht im aktuellen Buch.' };
  }

  const limit = Math.min(Math.max(1, input?.limit || LIST_REVISIONS_DEFAULT_LIMIT), LIST_REVISIONS_MAX_LIMIT);
  const total = pageRevisions.countForPage(pageId);
  const revs  = pageRevisions.listForPage(pageId, limit);

  return _truncateResult({
    page_id:      pageId,
    page_name:    pageRow.page_name,
    chapter_id:   pageRow.chapter_id || null,
    chapter_name: pageRow.chapter_name || null,
    total_revisions: total,
    results: revs.map(r => ({
      rev_id:     r.id,
      created_at: r.created_at,
      source:     r.source,
      user_email: r.user_email || null,
      chars:      r.chars,
      words:      r.words,
      summary:    r.summary || null,
    })),
    ...(revs.length < total ? { truncated: true, total_results: total } : {}),
  });
}

// ── list_world_facts ────────────────────────────────────────────────────────
// Deklaratives Buch-Wissen (Weltregeln/Fakten) aus der Komplettanalyse.
// Optionale Filter: kategorie (exakt), subjekt (Teilstring). Kapitelname per JOIN
// zur Lesezeit (kein Snapshot).
//
// Leerer Index heisst „nie analysiert", nicht „das Buch hat keine Weltregeln":
// `scanned` trennt beides, damit der Agent aus einer leeren Antwort nicht
// schliesst, es gebe nichts, und die Aussage als Fakt weitergibt.
function tool_list_world_facts(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const kategorie = typeof input?.kategorie === 'string' && input.kategorie.trim() ? input.kategorie.trim().toLowerCase() : null;
  const subjekt   = typeof input?.subjekt === 'string' && input.subjekt.trim() ? input.subjekt.trim() : null;

  const rows = listWorldFacts(ctx.bookId, userEmail, { kategorie, subjekt });
  if (!rows.length) {
    const { scanned } = worldFactsScanState(ctx.bookId, userEmail);
    const hint = !scanned
      ? 'Der Welt-Fakten-Index ist NICHT erhoben (Komplettanalyse nie gelaufen). Das ist keine Aussage über das Buch — sage nicht, es gebe keine Weltregeln, sondern nutze andere Werkzeuge oder benenne die Lücke.'
      : (kategorie !== null || subjekt !== null)
        ? 'Index erhoben, aber zu diesem Filter kein Fakt. Ohne kategorie/subjekt erneut fragen, bevor du „nicht etabliert" schliesst.'
        : 'Index erhoben, enthält aber keinen einzigen Welt-Fakt.';
    return { fakten: [], scanned, hint };
  }

  const factIds = rows.map(r => r.id);
  const chRows = listWorldFactChapterNames(factIds);
  const chByFact = new Map();
  for (const r of chRows) {
    if (!chByFact.has(r.fact_id)) chByFact.set(r.fact_id, []);
    if (r.chapter_name) chByFact.get(r.fact_id).push(r.chapter_name);
  }

  return _truncateResult({
    fakten: rows.map(r => ({
      kategorie:    r.kategorie || null,
      subjekt:      r.subjekt || null,
      fakt:         r.fakt,
      seite:        r.seite_label || null,
      kapitel:      chByFact.get(r.id) || [],
    })),
    total: rows.length,
    scanned: true,
  });
}

module.exports = {
  tool_list_chapters,
  tool_list_ideen,
  tool_list_locations,
  tool_get_location_profile,
  tool_list_scenes,
  tool_list_songs,
  tool_get_book_settings,
  tool_list_figures,
  tool_list_revisions,
  tool_list_world_facts,
};
