'use strict';
// Werkzeug-Executor des Plot-Chats. Zwei Arten:
//   - Lese-Werkzeuge: die Handler des gemeinsamen Katalogs (chat-tools) —
//     eine Quelle, kein zweiter Board-/Figuren-/Text-Leser.
//   - Vorschlags-Werkzeuge (propose_*): validieren gegen den Board-Stand und
//     sammeln EINEN normalisierten Vorschlag in ctx.proposals. Sie schreiben
//     NICHTS — der User übernimmt jeden Vorschlag einzeln im Frontend, über
//     dieselben /plot-Routen wie jede Board-Bearbeitung (inkl. Undo).
//
// Ein ungültiger Vorschlag (fremde id, Akt passt nicht zum Strang, unbekannte
// Figur) kommt als { error } ans Modell zurück, damit es den Aufruf korrigiert —
// das Frontend sieht nur Vorschläge, die beim Erzeugen gültig waren.
//
// Gespeichertes Format (context_info.proposals[i]), Felder je `type`:
//   beat_create   { act_id|act_ref, thread_id|thread_ref|null, after_beat_id?, at_start?, fields }
//   beat_update   { beat_id, fields, before }                 — nur geänderte Felder
//   beat_move     { beat_id, act_id|act_ref, thread_id|thread_ref|null, after_beat_id?, at_start?, before }
//   act_create    { name, thread_id|null, after_act_id?, at_start? }
//   act_update    { act_id, name, before }
//   thread_create { name, figure_id?|draft_figure_id? }
//   thread_update { thread_id, fields, before }
// Gemeinsam: { type, ref, begruendung, labels }. `ref` ist 1-basiert über alle
// Vorschläge DIESER Antwort (= Index + 1); act_ref/thread_ref zeigen darauf.
// Persistierter Status (vom User gesetzt, PATCH /plot/chat-proposal):
// applied_at + applied_id bzw. status='discarded'.

const { executeTool: executeCatalogTool } = require('./chat-tools');
const { loadBoardState } = require('./plot-chat-context');

const MAX_PROPOSALS = 30;
const MAX_TITEL = 200;
const MAX_BESCHREIBUNG = 4000;
const MAX_ZEIT = 120;
const MAX_NAME = 120;
const MAX_BEGRUENDUNG = 600;

const PROPOSE_TOOLS = new Set(['propose_beat', 'propose_beat_move', 'propose_act', 'propose_thread']);

function _str(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').trim().slice(0, max);
}
function _int(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return Number.isInteger(n) && n > 0 ? n : null;
}
function _err(msg) { return { error: msg }; }

// Board-Stand pro Antwort einmal laden; Vorschläge ändern ihn nicht.
function _state(ctx) {
  if (!ctx._board) ctx._board = loadBoardState(ctx.bookId, ctx.userEmail, ctx.chapterNames || new Map());
  return ctx._board;
}

// Akt aus act_id oder act_ref (Vorschlag dieser Antwort) auflösen.
// → { act_id, act } | { act_ref, refThread } | { error }
function _resolveAct(input, ctx, state) {
  const ref = _int(input.act_ref);
  if (ref) {
    const p = ctx.proposals[ref - 1];
    if (!p || p.type !== 'act_create') return _err(`act_ref ${ref} ist kein in dieser Antwort vorgeschlagener neuer Akt.`);
    return { act_ref: ref, refThread: p.thread_id ?? null, label: p.name };
  }
  const id = _int(input.act_id);
  if (!id) return null;
  const act = state.actById.get(id);
  if (!act) return _err(`Akt #${id} gibt es nicht. Nutze eine Akt-id aus dem Board.`);
  return { act_id: id, act, label: act.name };
}

// Strang aus thread_id oder thread_ref auflösen. undefined = nicht angegeben.
function _resolveThread(input, ctx, state) {
  const ref = _int(input.thread_ref);
  if (ref) {
    const p = ctx.proposals[ref - 1];
    if (!p || p.type !== 'thread_create') return _err(`thread_ref ${ref} ist kein in dieser Antwort vorgeschlagener neuer Strang.`);
    return { thread_ref: ref, label: p.name };
  }
  const id = _int(input.thread_id);
  if (!id) return undefined;
  const t = state.threadById.get(id);
  if (!t) return _err(`Strang #${id} gibt es nicht. Nutze eine Strang-id aus dem Board.`);
  return { thread_id: id, label: t.name };
}

// Hybrid-Akt-Regel (routes/plot.js#_actFitsThread): ein Beat sitzt auf einem
// GETEILTEN Akt oder einem Akt SEINES Strangs. Für Referenzen auf neue Akte gilt
// dasselbe gegen deren vorgeschlagenen thread_id.
function _actFits(actRes, threadRes) {
  const actThread = actRes.act ? (actRes.act.thread_id ?? null) : (actRes.refThread ?? null);
  if (actThread == null) return true;
  return !!threadRes && threadRes.thread_id === actThread;
}

// Figuren: fig_id, Name oder Kurzname (Katalog) bzw. Name (Werkstatt).
function _resolveFiguren(list, state) {
  const figure_ids = [];
  const draft_figure_ids = [];
  const names = [];
  const unknown = [];
  const norm = (s) => String(s || '').trim().toLowerCase();
  for (const raw of list) {
    const q = String(raw ?? '').trim();
    if (!q) continue;
    const key = norm(q);
    const cat = state.figures.find(f => f.fig_id === q)
      || state.figures.find(f => norm(f.name) === key || norm(f.kurzname) === key);
    if (cat) {
      if (!figure_ids.includes(cat.fig_id)) { figure_ids.push(cat.fig_id); names.push(cat.name || cat.kurzname || cat.fig_id); }
      continue;
    }
    const draft = state.drafts.find(d => norm(d.name) === key);
    if (draft) {
      if (!draft_figure_ids.includes(draft.id)) { draft_figure_ids.push(draft.id); names.push(draft.name); }
      continue;
    }
    unknown.push(q);
  }
  return { figure_ids, draft_figure_ids, names, unknown };
}

function _validChapter(raw, state) {
  const id = _int(raw);
  if (!id) return { id: null };
  if (!state.chapterNames.has(id)) return _err(`Kapitel #${id} gehört nicht zu diesem Buch. Nutze eine chapter_id aus Board oder Gliederung.`);
  return { id, label: state.chapterNames.get(id) };
}

// after_beat_id muss in der Zielzelle liegen (bei neuen Akten/Strängen gibt es
// dort noch keine Beats → nur „ans Ende"/„an den Anfang").
function _validAfter(input, cell, state, movingId = null) {
  const after = _int(input.after_beat_id);
  if (!after) return { after_beat_id: null, at_start: input.at_start === true };
  if (after === movingId) return _err('after_beat_id darf nicht der verschobene Beat selbst sein.');
  const b = state.beatById.get(after);
  if (!b) return _err(`Beat #${after} gibt es nicht.`);
  if (cell.act_id == null || b.act_id !== cell.act_id || (b.thread_id ?? null) !== (cell.thread_id ?? null)) {
    return _err(`Beat #${after} liegt nicht in der Zielzelle (Akt/Strang) — wähle einen Beat derselben Zelle oder lass after_beat_id weg.`);
  }
  return { after_beat_id: after, at_start: false, label: b.titel };
}

function _beatFieldsFromInput(input, state, { isUpdate }) {
  const fields = {};
  const labels = {};
  if (typeof input.titel === 'string') {
    const t = _str(input.titel, MAX_TITEL);
    if (!t) return _err('titel darf nicht leer sein.');
    fields.titel = t;
  }
  if (typeof input.beschreibung === 'string') fields.beschreibung = _str(input.beschreibung, MAX_BESCHREIBUNG);
  if (input.intensitaet != null) {
    const n = Number(input.intensitaet);
    if (!Number.isInteger(n) || n < 1 || n > 5) return _err('intensitaet muss 1–5 sein.');
    fields.intensitaet = n;
  }
  if (typeof input.zeit === 'string') fields.zeit = _str(input.zeit, MAX_ZEIT) || null;
  if (input.chapter_id != null) {
    const ch = _validChapter(input.chapter_id, state);
    if (ch.error) return ch;
    fields.chapter_id = ch.id;
    if (ch.label) labels.chapter = ch.label;
  }
  if (Array.isArray(input.figuren)) {
    const r = _resolveFiguren(input.figuren, state);
    if (r.unknown.length) {
      return _err(`Unbekannte Figur(en): ${r.unknown.join(', ')}. Nutze Namen oder fig_id aus der Figurenliste.`);
    }
    fields.figure_ids = r.figure_ids;
    fields.draft_figure_ids = r.draft_figure_ids;
    labels.figuren = r.names;
  }
  if (isUpdate && typeof input.verworfen === 'boolean') fields.verworfen = input.verworfen ? 1 : 0;
  return { fields, labels };
}

// Vorher-Werte der geänderten Felder (Diff-Anzeige + Stale-Erkennung im Frontend).
function _beatBefore(beat, fields, state) {
  const before = {};
  const labels = {};
  for (const k of Object.keys(fields)) {
    if (k === 'figure_ids') before.figure_ids = [...(beat.fig_ids || [])];
    else if (k === 'draft_figure_ids') before.draft_figure_ids = [...(beat.draft_fig_ids || [])];
    else if (k === 'verworfen') before.verworfen = beat.verworfen ? 1 : 0;
    else before[k] = beat[k] ?? null;
  }
  if ('figure_ids' in fields || 'draft_figure_ids' in fields) {
    labels.figuren_before = [
      ...(beat.fig_ids || []).map(id => state.figNameById.get(id) || id),
      ...(beat.draft_fig_ids || []).map(id => state.draftNameById.get(id)).filter(Boolean),
    ];
  }
  if ('chapter_id' in fields && beat.chapter_id) labels.chapter_before = state.chapterNames.get(beat.chapter_id) || beat.chapter_name || null;
  return { before, labels };
}

function _push(ctx, proposal, input) {
  const begruendung = _str(input.begruendung, MAX_BEGRUENDUNG);
  const p = { ...proposal, ref: ctx.proposals.length + 1, ...(begruendung ? { begruendung } : {}) };
  ctx.proposals.push(p);
  return { ok: true, ref: p.ref, hinweis: 'Vorschlag gesammelt — der User übernimmt ihn selbst. Nicht wiederholen.' };
}

function _proposeBeat(input, ctx) {
  const state = _state(ctx);
  const beatId = _int(input.beat_id);
  if (beatId) {
    const beat = state.beatById.get(beatId);
    if (!beat) return _err(`Beat #${beatId} gibt es nicht. Nutze eine Beat-id aus dem Board.`);
    if (input.act_id != null || input.act_ref != null || input.thread_id != null || input.thread_ref != null) {
      return _err('Zum Verschieben eines bestehenden Beats propose_beat_move verwenden; propose_beat ändert nur Inhalt/Felder.');
    }
    const r = _beatFieldsFromInput(input, state, { isUpdate: true });
    if (r.error) return r;
    // No-Op-Felder fallen weg — ein Vorschlag, der nichts ändert, ist keiner.
    const { before, labels: beforeLabels } = _beatBefore(beat, r.fields, state);
    for (const k of Object.keys(r.fields)) {
      if (JSON.stringify(r.fields[k] ?? null) === JSON.stringify(before[k] ?? null)) {
        delete r.fields[k]; delete before[k];
      }
    }
    if (!Object.keys(r.fields).length) return _err(`Der Vorschlag ändert an Beat #${beatId} nichts.`);
    return _push(ctx, {
      type: 'beat_update', beat_id: beatId, fields: r.fields, before,
      labels: { beat: beat.titel, ...r.labels, ...beforeLabels },
    }, input);
  }

  const actRes = _resolveAct(input, ctx, state);
  if (!actRes) return _err('Neuer Beat braucht act_id (oder act_ref auf einen neuen Akt dieser Antwort).');
  if (actRes.error) return actRes;
  const threadRes = _resolveThread(input, ctx, state);
  if (threadRes?.error) return threadRes;
  if (!_actFits(actRes, threadRes)) {
    return _err('Der Akt gehört einem Strang; ein Beat darin muss in genau diesem Strang liegen (thread_id angeben) oder in einen geteilten Akt.');
  }
  if (typeof input.verworfen === 'boolean') return _err('verworfen gibt es nur bei Änderungen bestehender Beats.');
  const r = _beatFieldsFromInput(input, state, { isUpdate: false });
  if (r.error) return r;
  if (!r.fields.titel) return _err('Neuer Beat braucht einen titel.');
  const cell = { act_id: actRes.act_id ?? null, thread_id: threadRes?.thread_id ?? null };
  const pos = (actRes.act_ref || threadRes?.thread_ref)
    ? { after_beat_id: null, at_start: input.at_start === true }
    : _validAfter(input, cell, state);
  if (pos.error) return pos;
  return _push(ctx, {
    type: 'beat_create',
    ...(actRes.act_ref ? { act_ref: actRes.act_ref } : { act_id: actRes.act_id }),
    ...(threadRes?.thread_ref ? { thread_ref: threadRes.thread_ref } : { thread_id: threadRes?.thread_id ?? null }),
    ...(pos.after_beat_id ? { after_beat_id: pos.after_beat_id } : {}),
    ...(pos.at_start ? { at_start: true } : {}),
    fields: r.fields,
    labels: { act: actRes.label, ...(threadRes ? { thread: threadRes.label } : {}), ...(pos.label ? { after: pos.label } : {}), ...r.labels },
  }, input);
}

function _proposeBeatMove(input, ctx) {
  const state = _state(ctx);
  const beatId = _int(input.beat_id);
  const beat = beatId ? state.beatById.get(beatId) : null;
  if (!beat) return _err(`Beat #${input.beat_id} gibt es nicht. Nutze eine Beat-id aus dem Board.`);
  const curAct = state.actById.get(beat.act_id);
  const actRes = _resolveAct(input, ctx, state) || { act_id: beat.act_id, act: curAct, label: curAct?.name };
  if (actRes.error) return actRes;
  let threadRes;
  if (input.ohne_strang === true) threadRes = null;
  else {
    threadRes = _resolveThread(input, ctx, state);
    if (threadRes?.error) return threadRes;
    if (threadRes === undefined) {
      threadRes = beat.thread_id != null
        ? { thread_id: beat.thread_id, label: state.threadById.get(beat.thread_id)?.name }
        : null;
    }
  }
  if (!_actFits(actRes, threadRes)) {
    return _err('Der Ziel-Akt gehört einem anderen Strang; wähle einen geteilten Akt oder den Akt des Ziel-Strangs.');
  }
  const cell = { act_id: actRes.act_id ?? null, thread_id: threadRes?.thread_id ?? null };
  const pos = (actRes.act_ref || threadRes?.thread_ref)
    ? { after_beat_id: null, at_start: input.at_start === true }
    : _validAfter(input, cell, state, beatId);
  if (pos.error) return pos;
  const sameCell = !actRes.act_ref && !threadRes?.thread_ref
    && cell.act_id === beat.act_id && cell.thread_id === (beat.thread_id ?? null);
  if (sameCell && !pos.after_beat_id && !pos.at_start) return _err(`Der Vorschlag verschiebt Beat #${beatId} nicht.`);
  return _push(ctx, {
    type: 'beat_move', beat_id: beatId,
    ...(actRes.act_ref ? { act_ref: actRes.act_ref } : { act_id: actRes.act_id }),
    ...(threadRes?.thread_ref ? { thread_ref: threadRes.thread_ref } : { thread_id: threadRes?.thread_id ?? null }),
    ...(pos.after_beat_id ? { after_beat_id: pos.after_beat_id } : {}),
    ...(pos.at_start ? { at_start: true } : {}),
    before: { act_id: beat.act_id, thread_id: beat.thread_id ?? null },
    labels: {
      beat: beat.titel,
      act: actRes.label,
      ...(threadRes ? { thread: threadRes.label } : {}),
      from_act: curAct?.name || null,
      ...(beat.thread_id != null ? { from_thread: state.threadById.get(beat.thread_id)?.name || null } : {}),
      ...(pos.label ? { after: pos.label } : {}),
    },
  }, input);
}

function _proposeAct(input, ctx) {
  const state = _state(ctx);
  const name = _str(input.name, MAX_NAME);
  if (!name) return _err('name ist Pflicht.');
  const actId = _int(input.act_id);
  if (actId) {
    const act = state.actById.get(actId);
    if (!act) return _err(`Akt #${actId} gibt es nicht.`);
    if (act.name === name) return _err(`Akt #${actId} heisst schon so.`);
    return _push(ctx, { type: 'act_update', act_id: actId, name, before: { name: act.name }, labels: { act: act.name } }, input);
  }
  let threadId = null;
  let threadLabel = null;
  if (input.thread_id != null) {
    const t = _resolveThread({ thread_id: input.thread_id }, ctx, state);
    if (t?.error) return t;
    threadId = t?.thread_id ?? null;
    threadLabel = t?.label ?? null;
  }
  const after = _int(input.after_act_id);
  let afterLabel = null;
  if (after) {
    const a = state.actById.get(after);
    if (!a) return _err(`Akt #${after} gibt es nicht.`);
    if ((a.thread_id ?? null) !== threadId) return _err('after_act_id muss im selben Bereich liegen (geteilte Akte bzw. Akte desselben Strangs).');
    afterLabel = a.name;
  }
  return _push(ctx, {
    type: 'act_create', name, thread_id: threadId,
    ...(after ? { after_act_id: after } : {}),
    ...(!after && input.at_start === true ? { at_start: true } : {}),
    labels: { ...(threadLabel ? { thread: threadLabel } : {}), ...(afterLabel ? { after: afterLabel } : {}) },
  }, input);
}

function _proposeThread(input, ctx) {
  const state = _state(ctx);
  const name = _str(input.name, MAX_NAME);
  if (!name) return _err('name ist Pflicht.');
  let fig = null;
  if (typeof input.figur === 'string' && input.figur.trim()) {
    const r = _resolveFiguren([input.figur], state);
    if (r.unknown.length) return _err(`Unbekannte Figur: ${input.figur}. Nutze Namen oder fig_id aus der Figurenliste.`);
    fig = r.figure_ids.length
      ? { figure_id: r.figure_ids[0], draft_figure_id: null, label: r.names[0] }
      : { figure_id: null, draft_figure_id: r.draft_figure_ids[0], label: r.names[0] };
  }
  const threadId = _int(input.thread_id);
  if (threadId) {
    const t = state.threadById.get(threadId);
    if (!t) return _err(`Strang #${threadId} gibt es nicht.`);
    const fields = {};
    const before = {};
    if (name !== t.name) { fields.name = name; before.name = t.name; }
    if (fig && (fig.figure_id !== (t.fig_id || null) || fig.draft_figure_id !== (t.draft_figure_id || null))) {
      fields.figure_id = fig.figure_id;
      fields.draft_figure_id = fig.draft_figure_id;
      before.figure_id = t.fig_id || null;
      before.draft_figure_id = t.draft_figure_id || null;
    }
    if (!Object.keys(fields).length) return _err(`Der Vorschlag ändert an Strang #${threadId} nichts.`);
    const figBefore = t.fig_id ? state.figNameById.get(t.fig_id) : (t.draft_figure_id ? state.draftNameById.get(t.draft_figure_id) : null);
    return _push(ctx, {
      type: 'thread_update', thread_id: threadId, fields, before,
      labels: { thread: t.name, ...(fig ? { figur: fig.label } : {}), ...(figBefore ? { figur_before: figBefore } : {}) },
    }, input);
  }
  return _push(ctx, {
    type: 'thread_create', name,
    ...(fig?.figure_id ? { figure_id: fig.figure_id } : {}),
    ...(fig?.draft_figure_id ? { draft_figure_id: fig.draft_figure_id } : {}),
    labels: fig ? { figur: fig.label } : {},
  }, input);
}

const PROPOSE_HANDLERS = {
  propose_beat: _proposeBeat,
  propose_beat_move: _proposeBeatMove,
  propose_act: _proposeAct,
  propose_thread: _proposeThread,
};

async function executePlotChatTool(name, input, ctx) {
  if (PROPOSE_TOOLS.has(name)) {
    if (ctx.proposals.length >= MAX_PROPOSALS) {
      return _err(`Höchstens ${MAX_PROPOSALS} Vorschläge pro Antwort. Beende die Antwort mit final_answer.`);
    }
    return PROPOSE_HANDLERS[name](input || {}, ctx);
  }
  if (!ctx.offeredTools?.has(name)) throw new Error(`Unbekanntes Werkzeug: ${name}`);
  return executeCatalogTool(name, input, ctx);
}

module.exports = { executePlotChatTool, MAX_PROPOSALS, PROPOSE_TOOLS };
