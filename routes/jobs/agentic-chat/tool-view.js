'use strict';
// Lesbare Sicht eines Werkzeug-Aufrufs für den Werkzeug-Verlauf der agentischen
// Chats (Buch-, Recherche-, Plot-, Ideen-Chat). Der Loop (./loop.js) hängt sie als
// `view` an jeden Eintrag von context_info.tool_calls:
//
//   view = {
//     subject: [                       // worum es ging, in Argument-Reihenfolge
//       { t: 'q',   v },               // Suchbegriff / Zitat / Titel → «v»
//       { t: 'ref', k, v, id },        // Objekt per ID; v = Anzeigename (fehlt, wenn nicht auflösbar)
//       { t: 'url', v },
//       { t: 'f',   k, v },            // Filter (status, typ, …) → chat.toolFilter.<k>
//       { t: 'more', v },              // weitere IDs derselben Liste
//     ],
//     result: { key, params? } | null, // i18n-Key: was herauskam (Treffer, Abschnitte, …)
//     trunc?: { shown, total },        // Liste gekürzt: so viele sah das Modell von wie vielen
//   }
//
// Dazu das Lauf-Protokoll für loop.js (unten): Rundennotizen, Live-Kopie des Logs
// für GET /jobs/:id, Zeilen der serverseitigen Anthropic-Websuche.
//
// Namen werden beim Speichern aufgelöst, nicht beim Anzeigen: so bleibt der Verlauf
// lesbar, auch wenn das Objekt später umbenannt oder gelöscht wird, und das UI muss
// nichts nachladen. Aufgelöst wird nur bei erfolgreichem Aufruf — der Handler hat
// dann Zugriff und Buch geprüft; eine fremde ID bleibt eine nackte ID.
// Technische Argumente (limit, offset, Zeichen-Deckel …) gehören nicht in die Sicht.

const { pageTitle, listChaptersForBook } = require('../../../db/content-names');
const { toolRefNames } = require('../../../db/chat-tool-refs');

const QUOTE_MAX = 90;
const MAX_LIST_REFS = 3;

// Argument → Objekt-Art (ID-Felder). `ids` zählt nur bei get_pages als Abschnitte.
const ID_KEYS = {
  page_id: 'page', beleg_page_id: 'page', chapter_id: 'chapter', chapter_ids: 'chapter',
  figur_id: 'figure', loc_id: 'location', act_id: 'act', beat_id: 'beat', thread_id: 'thread',
  idee_id: 'idee', motif_id: 'motif', draft_id: 'draft', item_id: 'research',
};
// Argument → Objekt-Art (schon ein Name, nichts aufzulösen).
const NAME_KEYS = {
  figur_name: 'figure', figur: 'figure', motif_name: 'motif', act_ref: 'act', thread_ref: 'thread',
};
// Freitext-Argumente, die als Zitat erscheinen.
const QUOTE_KEYS = new Set(['pattern', 'query', 'q', 'suche', 'titel', 'title', 'name', 'content', 'prompt', 'beleg', 'ereignis']);
// Filter, die die Auswahl sichtbar ändern (Rest: technische Deckel).
const FILTER_KEYS = new Set([
  'status', 'typ', 'kind', 'art', 'scope', 'schwere', 'kategorie', 'subjekt', 'metric',
  'jahr', 'register', 'doi', 'isbn', 'seite', 'offen_only', 'not_done', 'stale_only', 'at_start', 'ohne_strang',
  'view', 'diff',
]);

// Werkzeuge, deren Ergebnis eine Trefferliste ist.
const SEARCH_TOOLS = new Set([
  'search_passages', 'search_similar', 'search_chat_history', 'search_research_passages',
  'web_search', 'lookup_literature', 'find_repetitions', 'get_dialogue', 'get_figure_mentions',
  'get_motif_occurrences',   // abgelöst (get_motifs mit motif_id/motif_name), bleibt für alte Antworten
]);
const SECTION_TOOLS = new Set(['get_pages', 'get_chapter_text']);
const PROPOSE_TOOLS = new Set([
  'propose_beat', 'propose_beat_move', 'propose_act', 'propose_thread',
  'propose_idee', 'propose_idee_link', 'propose_research_item',
]);

function _clip(s, max = QUOTE_MAX) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function _scalar(v) {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

// Erste plausible Mengenangabe eines Ergebnisses: ausgewiesene Gesamtzahl vor der
// Länge der (evtl. gekürzten) Liste.
function _count(out) {
  if (Array.isArray(out)) return out.length;
  if (!out || typeof out !== 'object') return null;
  for (const k of ['total_results', 'gesamt', 'total', 'count']) {
    if (Number.isFinite(out[k])) return out[k];
  }
  for (const v of Object.values(out)) if (Array.isArray(v)) return v.length;
  return null;
}

function _countKey(base, n) {
  if (n == null) return null;
  if (n === 0) return { key: `chat.toolResult.${base}None` };
  if (n === 1) return { key: `chat.toolResult.${base}One` };
  return { key: `chat.toolResult.${base}`, params: { n } };
}

// Gekürzte Liste: wie viel das Modell sah gegen die ausgewiesene Gesamtzahl.
function _trunc(out) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
  const list = Object.values(out).find(Array.isArray);
  if (!list) return null;
  const total = ['total_results', 'gesamt', 'total', 'total_pages', 'total_chapters'].map(k => out[k]).find(Number.isFinite);
  return Number.isFinite(total) && total > list.length ? { shown: list.length, total } : null;
}

function _result(name, input, out) {
  if (SEARCH_TOOLS.has(name)) return _countKey('hits', _count(out));
  if (name === 'read_web_page') return input?.suche ? _countKey('hits', _count(out)) : null;
  if (SECTION_TOOLS.has(name)) return _countKey('sections', Array.isArray(out?.pages) ? out.pages.length : null);
  // get_motifs mit Motiv = Fundstellen-Liste, ohne = Übersicht.
  if (name === 'get_motifs' && (input?.motif_id || input?.motif_name)) {
    return _countKey('hits', Number.isFinite(out?.ist_count) ? out.ist_count : _count(out?.occurrences));
  }
  // Kennzahlen, keine Liste; Revisionsvergleich ist ein Diff, keine Menge.
  if (name === 'get_stil_metrics' || (name === 'list_revisions' && input?.diff)) return null;
  // quote_passage mit pattern ersetzt quote_match (Zitat prüfen); mit offset zitiert es.
  if (name === 'quote_match' || (name === 'quote_passage' && input?.pattern)) {
    return out?.total_matches > 1
      ? { key: 'chat.toolResult.quoteFoundOf', params: { n: out.total_matches } }
      : { key: 'chat.toolResult.quoteFound' };
  }
  if (name === 'quote_passage') return { key: 'chat.toolResult.quoted', params: { n: String(out?.quote || '').length } };
  if (PROPOSE_TOOLS.has(name)) {
    return out?.already_in_archive ? { key: 'chat.toolResult.proposedExists' } : { key: 'chat.toolResult.proposed' };
  }
  if (name === 'generate_image') return { key: 'chat.toolResult.image' };
  return _countKey('entries', _count(out));
}

/**
 * Sicht-Bauer pro Job: Namenslookups (Kapitel einmal pro Buch) werden gecacht.
 * @param {{ bookId: number, userEmail?: string }} ctx
 */
function makeToolViewer(ctx) {
  const bookId = ctx?.bookId;
  const userEmail = ctx?.userEmail || null;
  let chapters = null;

  function _pageName(id) {
    const r = pageTitle(id);
    return r && r.book_id === bookId ? r.title : null;
  }
  function _chapterName(id) {
    if (!chapters) chapters = new Map(listChaptersForBook(bookId).map(c => [String(c.chapter_id), c.chapter_name]));
    return chapters.get(String(id)) || null;
  }
  function _resolve(kind, id) {
    if (!bookId) return null;
    if (kind === 'page') return _pageName(id);
    if (kind === 'chapter') return _chapterName(id);
    return toolRefNames(bookId, userEmail, { [kind]: [id] })[kind]?.get(String(id)) || null;
  }

  function _ref(kind, id, resolve) {
    const name = resolve ? _resolve(kind, id) : null;
    return { t: 'ref', k: kind, id: _clip(id, 40), ...(name ? { v: _clip(name, 60) } : {}) };
  }

  function _subject(name, input, ok) {
    const items = [];
    const resolve = ok && !!bookId;
    for (const [k, v] of Object.entries(input || {})) {
      if (v == null || v === '' || v === false) continue;
      // read_research_item: `id` ist ein Recherche-Eintrag; get_pages: `ids` sind Abschnitte.
      const idKind = ID_KEYS[k]
        || (k === 'id' && name === 'read_research_item' ? 'research' : null)
        || (k === 'ids' && name === 'get_pages' ? 'page' : null)
        || (k === 'target_id' && ['research', 'beat', 'thread', 'motif', 'draft'].includes(input.target_kind) ? input.target_kind : null);
      if (idKind) {
        const list = Array.isArray(v) ? v : [v];
        for (const id of list.slice(0, MAX_LIST_REFS)) if (_scalar(id)) items.push(_ref(idKind, id, resolve));
        if (list.length > MAX_LIST_REFS) items.push({ t: 'more', v: list.length - MAX_LIST_REFS });
        continue;
      }
      // get_location_profile: `name` ist der Ort, kein Zitat.
      const nameKind = NAME_KEYS[k] || (k === 'name' && name === 'get_location_profile' ? 'location' : null);
      if (nameKind && typeof v === 'string') { items.push({ t: 'ref', k: nameKind, v: _clip(v, 60) }); continue; }
      if (k === 'url' && typeof v === 'string') { items.push({ t: 'url', v: _clip(v, 120) }); continue; }
      if (QUOTE_KEYS.has(k) && typeof v === 'string') { items.push({ t: 'q', v: _clip(v) }); continue; }
      if (FILTER_KEYS.has(k) && _scalar(v)) items.push({ t: 'f', k, v: typeof v === 'boolean' ? true : _clip(v, 40) });
    }
    return items;
  }

  /**
   * @param {string} name   Werkzeug
   * @param {object} input  Argumente des Modells
   * @param {*} out         Ergebnis des Handlers (vor dem Kürzen)
   * @param {boolean} ok
   */
  return function describe(name, input, out, ok) {
    const trunc = ok ? _trunc(out) : null;
    return {
      subject: _subject(name, input, ok),
      result: ok ? _result(name, input, out) : null,
      ...(trunc ? { trunc } : {}),
    };
  };
}

// ── Lauf-Protokoll (loop.js) ────────────────────────────────────────────────

const ROUND_NOTE_MAX = 280;
const LIVE_MAX_TOOLS = 80;
const LIVE_MAX_ROUNDS = 20;

/** Notiz einer Runde (Text neben den Werkzeug-Aufrufen bzw. Thinking-Zwischenstand), gekürzt; JSON ist keine Notiz. */
function roundNote(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.startsWith('{')) return null;
  return t.length > ROUND_NOTE_MAX ? t.slice(0, ROUND_NOTE_MAX - 1) + '…' : t;
}

/**
 * Schlanke Kopie des Werkzeug-Logs für den Live-Verlauf: nur, was die Zeile braucht
 * (Sicht statt Rohargumente), gedeckelt — der Job-Record geht bei jedem Poll übers Netz.
 */
function liveTools(toolLog) {
  return toolLog.slice(-LIVE_MAX_TOOLS).map(e => ({
    name: e.name, ok: e.ok, iter: e.iter, durationMs: e.durationMs, truncated: e.truncated,
    ...(e.view ? { view: e.view } : {}),
    ...(e.skipped ? { skipped: true } : {}),
    ...(e.server ? { server: true } : {}),
    ...(e.errorKey ? { errorKey: e.errorKey, errorParams: e.errorParams || null } : {}),
  }));
}

/** Verlaufszeile einer serverseitigen Anthropic-Websuche (server_tool_use). */
function serverSearchEntry(query, iter) {
  return {
    name: 'web_search', input: { query }, ok: true, durationMs: 0, resultBytes: 0, truncated: false,
    iter, server: true, view: { subject: query ? [{ t: 'q', v: _clip(query) }] : [], result: null },
  };
}

/** Trefferzahl bzw. Fehler aus dem web_search_tool_result-Block nachtragen. */
function applyServerSearchResult(entry, block) {
  if (!entry) return;
  if (Array.isArray(block.content)) {
    entry.view.result = _countKey('hits', block.content.filter(r => r?.type === 'web_search_result').length);
    return;
  }
  const code = String(block.content?.error_code || 'unknown');
  Object.assign(entry, { ok: false, error: code, errorKey: 'chat.toolError.webSearchFailed', errorParams: { code } });
}

module.exports = {
  makeToolViewer, roundNote, liveTools, serverSearchEntry, applyServerSearchResult, LIVE_MAX_ROUNDS,
};
