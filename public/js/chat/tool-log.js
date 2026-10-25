// Werkzeug-Verlauf der agentischen Chats (Buch-, Recherche-, Plot-, Ideen-Chat):
// aus context_info.tool_calls (+ tool_rounds, pre_context) bzw. dem Live-Stand
// des laufenden Jobs eine Liste von Einträgen fürs Partial chat-tool-log.html —
// rein per x-text bzw. x-entity-ref gerendert (kein x-html).
//
// Einträge (`kind`):
//   pre    — vorab geladener Kontext (Erst-Kontext), steht vor Runde 1
//   round  — Rundenkopf: Nummer, Notiz des Modells (was es vorhatte), Tokens
//   row    — ein Aufruf: Tätigkeit, Gegenstand (`view.subject`, serverseitig mit
//            Namen aufgelöst, routes/jobs/agentic-chat/tool-view.js), Ergebnis
//   group  — ab GROUP_MIN gleichen Aufrufen einer Runde gebündelt; die Einzelzeilen
//            klappen darunter auf
//   final  — Abschluss: Antwort mit geprüften Zitaten
//
// Ältere Antworten ohne `view` bekommen eine Sicht aus den Argumenten: Suchbegriffe
// als Zitat, IDs als Verweis ohne Namen.

// Arten der Server-Sicht, die `x-entity-ref` kennt (englische Kinds über KIND_ALIASES).
const ENTITY_KINDS = new Set(['page', 'chapter', 'figure', 'location', 'beat', 'thread', 'motif', 'research', 'draft', 'idee']);
// Ohne Sprungziel aus dem Chat heraus: Idee braucht ihren Ort, der hier fehlt.
const STATIC_KINDS = new Set(['idee']);
// Typen mit Frontend-Katalog: der Katalog liefert das Label, sonst der Server-Name.
const CATALOG_KINDS = new Set(['page', 'chapter', 'figure', 'location']);

const LEGACY_QUOTE_KEYS = ['pattern', 'query', 'q', 'suche', 'titel', 'title', 'prompt'];
const LEGACY_ID_KEYS = { page_id: 'page', chapter_id: 'chapter', figur_id: 'figure', loc_id: 'location' };
// Vom Loop nicht ausgeführt (Deckel, kaputte Argumente) — für Antworten vor dem
// `skipped`-Flag am Fehler-Key erkannt. Kein Fehler des Werkzeugs.
const SKIP_ERROR_KEYS = new Set([
  'chat.toolError.invalidArgs', 'chat.toolError.roundLimit', 'chat.toolError.roundBudget',
  'chat.toolError.synthesisOnly', 'chat.toolError.webSearchCap', 'chat.toolError.pageReadCap',
]);

// Dauer erst ab einer Sekunde: darunter ist sie Rauschen (Datenbank-Lookups).
const SHOW_DURATION_MS = 1000;
// Ab so vielen gleichen Aufrufen in einer Runde: eine Sammelzeile.
const GROUP_MIN = 3;
// Zusammenfassung oben erst bei langen Verläufen.
const SUMMARY_MIN_ROWS = 6;
const SUMMARY_TOP = 3;
const GROUP_PREVIEW = 3;

function _legacySubject(input) {
  const items = [];
  if (!input || typeof input !== 'object') return items;
  for (const k of LEGACY_QUOTE_KEYS) {
    if (typeof input[k] === 'string' && input[k].trim()) items.push({ t: 'q', v: input[k].trim().slice(0, 90) });
  }
  for (const [k, kind] of Object.entries(LEGACY_ID_KEYS)) {
    if (input[k] != null && input[k] !== '') items.push({ t: 'ref', k: kind, id: String(input[k]) });
  }
  if (typeof input.url === 'string') items.push({ t: 'url', v: input.url });
  return items;
}

// Ein Sicht-Element → Darstellungs-Teil: `entity` (Spec für x-entity-ref) oder `text`.
function _part(item, t) {
  if (!item || typeof item !== 'object') return null;
  if (item.t === 'q') return { kind: 'quote', text: t('chat.toolQuote', { v: item.v }) };
  if (item.t === 'url') {
    const ok = /^https?:\/\//i.test(item.v || '');
    return { kind: 'url', text: String(item.v || '').replace(/^https?:\/\/(www\.)?/i, ''), href: ok ? item.v : null };
  }
  if (item.t === 'more') return { kind: 'muted', text: t('chat.toolMore', { n: item.v }) };
  if (item.t === 'f') {
    const key = `chat.toolFilter.${item.k}`;
    const label = t(key, { v: item.v });
    return { kind: 'muted', text: label && label !== key ? label : `${item.k}: ${item.v}` };
  }
  if (item.t === 'ref') {
    if (ENTITY_KINDS.has(item.k)) {
      const entity = { type: item.k, ...(item.id != null ? { id: item.id } : {}), ...(item.v ? { name: item.v } : {}) };
      // Typen ohne Frontend-Katalog: Name als Label, sonst stünde dort «#34».
      if (item.v && !CATALOG_KINDS.has(item.k)) entity.label = item.v;
      if (STATIC_KINDS.has(item.k)) entity.static = true;
      return { kind: 'entity', entity };
    }
    // Akt (kein Verweistyp): Art + Name als Text.
    const key = `chat.toolRef.${item.k}`;
    const kindLabel = t(key);
    return { kind: 'muted', text: `${kindLabel && kindLabel !== key ? kindLabel + ' ' : ''}${item.v || '#' + item.id}` };
  }
  return null;
}

function _label(name, t) {
  const key = `chat.tool.${name}`;
  const label = t(key);
  return label && label !== key ? label : name;
}

function _durationLabel(ms, t) {
  if (!(ms >= SHOW_DURATION_MS)) return '';
  return t('chat.toolSeconds', { s: (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) });
}

function _rawInput(input) {
  try {
    const raw = input && Object.keys(input).length ? JSON.stringify(input) : '';
    return raw.length > 400 ? raw.slice(0, 400) + '…' : raw;
  } catch { return ''; }
}

function _row(tc, t, seen) {
  const subject = Array.isArray(tc.view?.subject) ? tc.view.subject : _legacySubject(tc.input);
  const skipped = tc.skipped === true || (tc.ok === false && SKIP_ERROR_KEYS.has(tc.errorKey));
  const failed = tc.ok === false && !skipped;
  const resultKey = tc.ok !== false ? tc.view?.result?.key : null;
  const trunc = tc.view?.trunc;
  // Gleicher Aufruf (Werkzeug + Argumente bzw. Sicht) wie schon einmal in dieser Antwort.
  const sig = `${tc.name}|${JSON.stringify(tc.input ?? tc.view?.subject ?? null)}`;
  const repeat = seen.has(sig);
  seen.add(sig);
  return {
    kind: 'row',
    name: String(tc.name),
    label: _label(tc.name, t),
    parts: subject.map(it => _part(it, t)).filter(Boolean),
    result: resultKey ? t(resultKey, tc.view.result.params || {}) : '',
    hit: !!resultKey && /^chat\.toolResult\.hits/.test(resultKey) && !/None$/.test(resultKey),
    empty: !!resultKey && /None$/.test(resultKey),
    duration: _durationLabel(tc.durationMs, t),
    truncated: tc.truncated
      ? (trunc ? t('chat.toolTruncatedOf', { shown: trunc.shown, total: trunc.total }) : t('chat.toolTruncated'))
      : '',
    repeat,
    skipped,
    failed,
    error: tc.ok === false
      ? ((tc.errorKey && t(tc.errorKey, tc.errorParams || {})) || (tc.error ? String(tc.error).slice(0, 200) : ''))
      : '',
    iter: tc.iter ?? null,
    raw: _rawInput(tc.input),
  };
}

// Gleiche Werkzeuge einer Runde ab GROUP_MIN zu einer Sammelzeile; Reihenfolge der
// Runde bleibt (die Gruppe steht dort, wo ihr erster Aufruf stand).
function _groupRound(rows, t) {
  const byName = new Map();
  for (const r of rows) byName.set(r.name, (byName.get(r.name) || 0) + 1);
  const out = [];
  const placed = new Set();
  for (const r of rows) {
    if (byName.get(r.name) < GROUP_MIN) { out.push(r); continue; }
    if (placed.has(r.name)) continue;
    placed.add(r.name);
    const children = rows.filter(x => x.name === r.name);
    const quotes = children.flatMap(c => c.parts.filter(p => p.kind === 'quote').slice(0, 1));
    const hits = children.filter(c => c.hit).length;
    const empty = children.filter(c => c.empty).length;
    const failed = children.filter(c => c.failed).length;
    const skipped = children.filter(c => c.skipped).length;
    const summary = [];
    if (hits || empty) summary.push(t('chat.toolGroupHits', { hit: hits, none: empty }));
    if (failed) summary.push(t('chat.toolGroupFailed', { n: failed }));
    if (skipped) summary.push(t('chat.toolGroupSkipped', { n: skipped }));
    out.push({
      kind: 'group',
      name: r.name,
      label: t('chat.toolGroupLabel', { label: r.label, n: children.length }),
      preview: quotes.slice(0, GROUP_PREVIEW).map(q => q.text).join(', ')
        + (quotes.length > GROUP_PREVIEW ? ' ' + t('chat.toolMore', { n: quotes.length - GROUP_PREVIEW }) : ''),
      result: summary.join(' · '),
      failed: failed > 0,
      children,
    });
  }
  return out;
}

function _finalEntry(tc, t) {
  const n = Number(tc?.input?.zitate_count) || 0;
  if (!n) return null;
  const bad = Number(tc.citations_invalid) || 0;
  return {
    kind: 'final',
    text: bad
      ? t('chat.toolFinalCitationsBad', { n, bad })
      : t(n === 1 ? 'chat.toolFinalCitationsOkOne' : 'chat.toolFinalCitationsOk', { n }),
    bad: bad > 0,
  };
}

/**
 * Einträge des Werkzeug-Verlaufs.
 * @param {{ tool_calls?: Array, tool_rounds?: Array, pre_context?: { count: number } }} ci  context_info bzw. Live-Stand
 * @param {(key: string, params?: object) => string} t
 * @param {{ fmtTok?: (n: number) => string }} [opts]
 * @returns {{ items: Array, rows: Array, summary: string }}
 */
export function toolLogEntries(ci, t, opts = {}) {
  const calls = Array.isArray(ci?.tool_calls) ? ci.tool_calls.filter(tc => tc && tc.name) : [];
  const finalCall = calls.find(tc => tc.name === 'final_answer');
  const seen = new Set();
  const rows = calls.filter(tc => tc.name !== 'final_answer').map(tc => _row(tc, t, seen));
  const roundInfo = new Map((Array.isArray(ci?.tool_rounds) ? ci.tool_rounds : []).map(r => [r.iter, r]));
  const iters = [...new Set(rows.map(r => r.iter))];
  const showRounds = iters.length > 1 || [...roundInfo.values()].some(r => r.note);
  const fmtTok = opts.fmtTok || (n => String(n));

  const items = [];
  const pre = Number(ci?.pre_context?.count) || 0;
  if (pre) items.push({ kind: 'pre', text: t(pre === 1 ? 'chat.toolPreContextOne' : 'chat.toolPreContext', { n: pre }) });
  for (const iter of iters) {
    const roundRows = rows.filter(r => r.iter === iter);
    if (showRounds && iter != null) {
      const info = roundInfo.get(iter);
      const tok = info ? (info.tokIn || 0) + (info.tokOut || 0) : 0;
      items.push({
        kind: 'round',
        text: t('chat.toolIter', { n: iter }),
        note: info?.note || '',
        tokens: tok ? t('chat.toolRoundTokens', { n: fmtTok(tok) }) : '',
      });
    }
    items.push(..._groupRound(roundRows, t));
  }
  const fin = _finalEntry(finalCall, t);
  if (fin) items.push(fin);
  return { items, rows, summary: rows.length >= SUMMARY_MIN_ROWS ? _summary(rows, iters, t) : '' };
}

// «10 Runden · Wortlaut im Buch gesucht ×34 · Abschnitte gelesen ×3 · +2 weitere»
function _summary(rows, iters, t) {
  const counts = new Map();
  for (const r of rows) counts.set(r.label, (counts.get(r.label) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const parts = [];
  const nRounds = iters.filter(i => i != null).length;
  if (nRounds > 1) parts.push(t('chat.toolSummaryRounds', { n: nRounds }));
  for (const [label, n] of ranked.slice(0, SUMMARY_TOP)) parts.push(n > 1 ? `${label} ×${n}` : label);
  if (ranked.length > SUMMARY_TOP) parts.push(t('chat.toolMore', { n: ranked.length - SUMMARY_TOP }));
  return parts.join(' · ');
}

/** Kopfzeile des klappbaren Verlaufs: Zahl der Aufrufe, echte Fehler extra (Übersprungenes nicht). */
export function toolLogHeading(rows, t) {
  const failed = rows.filter(r => r.failed).length;
  return failed
    ? t('chat.toolsToggleFailed', { n: rows.length, failed })
    : t('chat.toolsToggleN', { n: rows.length });
}
