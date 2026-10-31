'use strict';

// Figuren-Material des Leser-Modells: Werkstatt-Figuren (Mindmap-Notizen + Kern-
// Fundstellen) zusammengeführt mit dem Katalog (`figRows`) und den Dialogzeilen.
// Gelesen wird über die DB-Module der Werkstatt, nicht per eigenem SQL.

const { listDraftFigures } = require('../../../../../db/draft-figures');
const { listDraftOccurrences } = require('../../../../../db/draft-figure-occurrences');
const { PSYCHE_KERNE } = require('../../../../../lib/draft-mindmap-extract');
const appSettings = require('../../../../../lib/app-settings');
const { figureDepth } = require('../author-chat/depth');

// Notiz-Container der Default-Mindmap (lib/draft-mindmap-default.js), in
// Lesereihenfolge. Ein Container ist ein Knoten mit fester ID; was der Autor
// darunter hängt, sind die Notizen. Eigene Äste (`custom`) zählen mit.
const NOTE_NODES = [
  'aussehen', 'persoenlichkeit', 'hintergrund', 'beziehungen', 'konflikt', 'bogen',
  'musikgeschmack', 'sprechweise', 'phrasen', 'verben', 'want', 'need', 'wound', 'lie', 'custom',
];

// Beschriftung im Material der KI-Prompts. Trainingstext, kein UI-String.
const NOTE_LABELS = {
  aussehen:        { de: 'Aussehen', en: 'Appearance' },
  persoenlichkeit: { de: 'Persönlichkeit', en: 'Personality' },
  hintergrund:     { de: 'Hintergrund', en: 'Background' },
  beziehungen:     { de: 'Beziehungen', en: 'Relationships' },
  konflikt:        { de: 'Innerer Konflikt', en: 'Inner conflict' },
  bogen:           { de: 'Entwicklung', en: 'Arc' },
  musikgeschmack:  { de: 'Musikgeschmack', en: 'Taste in music' },
  sprechweise:     { de: 'Sprechweise', en: 'Way of speaking' },
  phrasen:         { de: 'Typische Wendungen', en: 'Typical phrases' },
  verben:          { de: 'Typische Verben', en: 'Typical verbs' },
  want:            { de: 'Was die Figur will', en: 'What the character wants' },
  need:            { de: 'Was die Figur braucht', en: 'What the character needs' },
  wound:           { de: 'Alte Wunde', en: 'Old wound' },
  lie:             { de: 'Lüge, die sie sich erzählt', en: 'The lie they tell themselves' },
  custom:          { de: 'Weitere Notizen', en: 'Further notes' },
};

const isMarker = (t) => /^__i18n:.+__$/.test(t);

function _find(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children || []) {
    const f = _find(c, id);
    if (f) return f;
  }
  return null;
}

// Notizen unter einem Container, Unterknoten flach als «Eltern: Kind» angehängt.
function _notesUnder(node) {
  const out = [];
  const walk = (n, prefix) => {
    for (const c of n.children || []) {
      const t = typeof c?.topic === 'string' ? c.topic.trim() : '';
      if (!t || isMarker(t)) { walk(c, prefix); continue; }
      out.push(prefix ? `${prefix}: ${t}` : t);
      walk(c, t);
    }
  };
  if (node) walk(node, '');
  return out;
}

function collectNotes(mindmap) {
  const data = mindmap?.data;
  const out = {};
  if (!data) return out;
  for (const id of NOTE_NODES) {
    const notes = _notesUnder(_find(data, id));
    if (notes.length) out[id] = notes;
  }
  return out;
}

function figureKey(fig, draft) {
  return fig ? 'fig:' + fig.fig_id : 'draft:' + draft.id;
}

// Tragend laut Analyse: Typ Hauptfigur/Antagonist (Freitext älterer Läufe,
// darum per Teilwort) oder Präsenz `zentral`.
const isCentral = (f) => /haupt|protagon|antagon|main|lead/i.test(String(f.typ || '')) || f.praesenz === 'zentral';

function dialogsFor(ctx, fig, name) {
  const keys = new Set([String(name || '').toLowerCase()]);
  if (fig?.name) keys.add(fig.name.toLowerCase());
  if (fig?.kurzname) keys.add(fig.kurzname.toLowerCase());
  const out = [];
  for (const k of keys) out.push(...(ctx.dialogsByFigure.get(k) || []));
  return out;
}

// → [{ key, name, fig, draft, notes, occByKern, dialogs }] — die tragenden Figuren:
// jede Werkstatt-Figur (wer eine Figur dort ausarbeitet, führt sie als tragend)
// plus die tragenden Katalog-Figuren ohne Werkstatt-Figur (Notizen leer). Eine
// Werkstatt-Figur hängt am Katalog über `source_fig_id`, sonst per Name.
function loadReaderFigures(ctx) {
  const { bookIdInt, userEmail, figRows, figById } = ctx;
  const byName = new Map();
  for (const f of figRows) {
    for (const n of [f.name, f.kurzname]) if (n) byName.set(n.trim().toLowerCase(), f);
  }
  const minScore = Number(appSettings.get('werkstatt.anchor.min_score')) || 0;
  const out = [];
  const seenFig = new Set();
  for (const d of listDraftFigures(bookIdInt, userEmail)) {
    const fig = (d.source_fig_id && figById.get(d.source_fig_id)) || byName.get(String(d.name || '').trim().toLowerCase()) || null;
    if (fig && seenFig.has(fig.fig_id)) continue;
    if (fig) seenFig.add(fig.fig_id);
    const occByKern = {};
    for (const o of listDraftOccurrences(d.id, { minScore })) {
      if (!PSYCHE_KERNE.includes(o.kern) || !o.snippet) continue;
      (occByKern[o.kern] ||= []).push(o);
    }
    const name = fig?.name || d.name;
    out.push({
      key: figureKey(fig, d), name, fig, draft: d,
      notes: collectNotes(d.mindmap), occByKern,
      dialogs: dialogsFor(ctx, fig, name),
    });
  }
  for (const f of figRows) {
    if (seenFig.has(f.fig_id) || !isCentral(f)) continue;
    out.push({
      key: figureKey(f, null), name: f.name, fig: f, draft: null,
      notes: {}, occByKern: {}, dialogs: dialogsFor(ctx, f, f.name),
    });
  }
  return out;
}

// Analyse-Felder im Material, Beschriftung je Sprache. Trainingstext, kein UI-String.
const DEPTH_LABELS = {
  rolle:       { de: 'Rolle', en: 'Role' },
  motivation:  { de: 'Motivation', en: 'Motivation' },
  konflikt:    { de: 'Konflikt', en: 'Conflict' },
  arc:         { de: 'Entwicklung', en: 'Arc' },
  hintergrund: { de: 'Hintergrund', en: 'Background' },
  aeusseres:   { de: 'Äusseres', en: 'Appearance' },
  stimme:      { de: 'Sprechweise', en: 'Way of speaking' },
};

// Material für die Ich-Form: Analyse (Beschreibung, Tiefe-Felder, Schlüssel-
// zitate), Werkstatt-Notizen, echte Dialogzeilen.
function personaMaterial(rf, langIsEn) {
  const lang = langIsEn ? 'en' : 'de';
  const lines = [];
  const f = rf.fig;
  if (f?.beschreibung) lines.push((langIsEn ? 'Description: ' : 'Beschreibung: ') + f.beschreibung);
  if (f?.beruf) lines.push((langIsEn ? 'Occupation: ' : 'Beruf: ') + f.beruf);
  if (f?.tags_csv) lines.push((langIsEn ? 'Traits: ' : 'Eigenschaften: ') + f.tags_csv.split(',').map(t => t.trim()).filter(Boolean).join(', '));
  const depth = f ? figureDepth(f) : null;
  if (depth) {
    for (const [k, label] of Object.entries(DEPTH_LABELS)) if (depth[k]) lines.push(`${label[lang]}: ${depth[k]}`);
  }
  for (const id of NOTE_NODES) {
    const notes = rf.notes[id];
    if (notes?.length) lines.push(`${NOTE_LABELS[id][lang]}: ${notes.join('; ')}`);
  }
  if (depth?.zitate.length) {
    lines.push('', langIsEn ? 'Key quotes:' : 'Schlüsselzitate:');
    for (const z of depth.zitate) lines.push('- ' + z);
  }
  if (rf.dialogs.length) {
    lines.push('', langIsEn ? 'Dialogue lines of the character:' : 'Dialogzeilen der Figur:');
    for (const d of rf.dialogs) lines.push('- ' + d.quote);
  }
  return lines.join('\n');
}

// Persona braucht Stoff: Innenleben (Werkstatt-Notizen oder Motivation/Konflikt
// der Analyse) oder genug eigene Dialogzeilen.
const PERSONA_MIN_DIALOGS = 3;
function hasPersonaMaterial(rf) {
  return Object.keys(rf.notes).length > 0 || !!(rf.fig?.motivation || rf.fig?.konflikt)
    || rf.dialogs.length >= PERSONA_MIN_DIALOGS;
}

module.exports = {
  loadReaderFigures, personaMaterial, hasPersonaMaterial, collectNotes,
  NOTE_LABELS, PERSONA_MIN_DIALOGS,
};
