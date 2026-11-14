// Motiv-Werkstatt — Undo/Redo-Records. Stack, Deckel, Flight-Schutz, Epoche und
// Fehler-Requeue trägt der Kern [cards/board-history.js]; hier steht nur, wie ein
// Record aufgezeichnet und in beide Richtungen angewendet wird. Tastatur über
// `bindBoardHistoryKeys` (motiv-card.js), Knöpfe im Kartenkopf (motiv.html).
//
// Record-Typen (before UND after, derselbe Record bedient beide Richtungen):
//   { kind: 'create-motif' | 'create-theme' | 'create-relation', id }
//   { kind: 'motif-edit',   id, before: { core?, links? }, after: { core?, links? } }
//                            core = Name/Thema/Beschreibung/Trigger (PATCH),
//                            links = Soll-Verknüpfungen (PUT /:id/links)
//   { kind: 'theme-fields', id, before: {...}, after: {...} }  — Name/Beschreibung/Farbe
//   { kind: 'motif-move',   id, beforeTheme, afterTheme, beforeOrder, afterOrder } — Baum-Drag
//   { kind: 'theme-order',  before: [ids], after: [ids] }
//   { kind: 'relation-typ', id, before, after }
//   { kind: 'delete-relation' | 'delete-motif' | 'delete-theme', id, snapshot }
//
// Löschen ist rückgängig machbar: das Undo legt aus dem Snapshot neu an
// (Motiv: Felder, Thema, Verknüpfungen, Beziehungen, Position, Ideen-Links;
// Thema: Felder, Position, seine Motive) und schreibt die neue ID per
// `_remapHistory` in alle Records um; das Redo löscht wieder. Nicht erfasst:
// die Graph-Positionen (Layout) — sie sind Ansicht, kein Inhalt.
//
// Die Applier sprechen die Routen direkt an (nie die interaktiven Methoden,
// die selbst aufzeichnen) und laden danach das Board (die Werkstatt spiegelt
// nach jeder Mutation per loadBoard, siehe crud.js).

import { sendJson } from '../../utils.js';
import { boardHistoryMethods } from '../../cards/board-history.js';

const byPos = (a, b) => (a.position ?? 0) - (b.position ?? 0);

// Alte → neue ID eines Typs in einem Record umschreiben (Motiv-, Themen- und
// Beziehungs-IDs teilen sich den Zahlenraum, darum gezielt je Feld).
export function remapMotivRecord(rec, type, oldId, newId) {
  const m = (v) => (v === oldId ? newId : v);
  const arr = (a) => (Array.isArray(a) ? a.map(m) : a);
  const s = rec.snapshot;
  if (type === 'motif') {
    if (['create-motif', 'motif-edit', 'motif-move', 'delete-motif'].includes(rec.kind)) rec.id = m(rec.id);
    if (rec.kind === 'motif-move') { rec.beforeOrder = arr(rec.beforeOrder); rec.afterOrder = arr(rec.afterOrder); }
    if (rec.kind === 'delete-motif' && s) {
      s.order = arr(s.order);
      for (const r of s.relations || []) { r.from = m(r.from); r.to = m(r.to); }
    }
    if (rec.kind === 'delete-relation' && s) { s.from = m(s.from); s.to = m(s.to); }
    if (rec.kind === 'delete-theme' && s) s.motifIds = arr(s.motifIds);
  } else if (type === 'theme') {
    if (['create-theme', 'theme-fields', 'delete-theme'].includes(rec.kind)) rec.id = m(rec.id);
    if (rec.kind === 'theme-order') { rec.before = arr(rec.before); rec.after = arr(rec.after); }
    if (rec.kind === 'delete-theme' && s) s.order = arr(s.order);
    if (rec.kind === 'motif-edit') {
      for (const side of [rec.before, rec.after]) if (side?.core && 'theme_id' in side.core) side.core.theme_id = m(side.core.theme_id);
    }
    if (rec.kind === 'motif-move') { rec.beforeTheme = m(rec.beforeTheme); rec.afterTheme = m(rec.afterTheme); }
    if (rec.kind === 'delete-motif' && s?.core) s.core.theme_id = m(s.core.theme_id);
  } else if (type === 'relation') {
    if (['create-relation', 'relation-typ', 'delete-relation'].includes(rec.kind)) rec.id = m(rec.id);
    if (rec.kind === 'delete-motif' && s) for (const r of s.relations || []) r.id = m(r.id);
  }
}

export const motivHistoryMethods = {
  ...boardHistoryMethods,

  // ── Kern-Hooks ─────────────────────────────────────────────────────────────
  _historyBusy() { return !!this.busy || !!this._motifSaving; },
  _historySetBusy(flag) { this.busy = flag; },
  // Undo heisst zurückdrehen, nicht den Entwurf speichern: offene Puffer der
  // beiden Editoren verwerfen, bevor ein Record angewendet wird.
  _historyBeforeApply() {
    if (this.motifDirty?.()) this.cancelMotifEdit();
    if (this.themeDirty?.()) this.cancelThemeEdit();
  },

  _remapMotivIds(type, oldId, newId, ...extra) {
    if (oldId === newId) return;
    this._remapHistory((rec) => remapMotivRecord(rec, type, oldId, newId), ...extra);
  },

  // ── Snapshots ──────────────────────────────────────────────────────────────
  _motifCoreSnap(m) {
    return {
      name: m.name || '',
      theme_id: m.theme_id || null,
      beschreibung: m.beschreibung || '',
      trigger_terms: [...(m.trigger_terms || [])],
    };
  },
  _motifLinkSnap(m) {
    const ids = (arr, k = 'id') => (arr || []).map(x => x[k]);
    return {
      figures: ids(m.figures, 'figId'),
      draftFigures: ids(m.draftFigures),
      beats: ids(m.beats),
      chapters: ids(m.chapters),
      pages: ids(m.pages),
    };
  },
  _motifOrder() { return [...this.motifs].sort(byPos).map(m => m.id); },
  _themeOrder() { return [...this.themes].sort(byPos).map(t => t.id); },
  _motifDeleteSnap(m) {
    return {
      core: this._motifCoreSnap(m),
      farbe: m.farbe || null,
      links: this._motifLinkSnap(m),
      relations: (this.relations || [])
        .filter(r => r.from_motif_id === m.id || r.to_motif_id === m.id)
        .map(r => ({ id: r.id, from: r.from_motif_id, to: r.to_motif_id, typ: r.typ })),
      order: this._motifOrder(),
      ideaIds: (this.ideasFor?.(m.id) || []).map(i => i.idea_id).filter(Boolean),
    };
  },
  _themeDeleteSnap(t) {
    return {
      fields: { name: t.name || '', beschreibung: t.beschreibung || '', farbe: t.farbe || null },
      order: this._themeOrder(),
      motifIds: this.motifs.filter(m => m.theme_id === t.id).map(m => m.id),
    };
  },

  // ── Anwenden ───────────────────────────────────────────────────────────────
  async _applyInverse(rec) {
    switch (rec.kind) {
      case 'create-motif':    return this._mhRun(() => sendJson(`/motifs/${rec.id}`, 'DELETE'), { clearMotif: rec.id });
      case 'create-theme':    return this._mhRun(() => sendJson(`/motifs/themes/${rec.id}`, 'DELETE'), { clearTheme: rec.id });
      case 'create-relation': return this._mhRun(() => sendJson(`/motifs/relations/${rec.id}`, 'DELETE'));
      case 'motif-edit':      return this._mhRun(() => this._mhMotifEdit(rec.id, rec.before));
      case 'theme-fields':    return this._mhRun(() => sendJson(`/motifs/themes/${rec.id}`, 'PATCH', rec.before));
      case 'motif-move':      return this._mhRun(() => this._mhMotifMove(rec.id, rec.beforeTheme, rec.beforeOrder, rec.afterTheme));
      case 'theme-order':     return this._mhRun(() => this._mhPutOrder('/motifs/themes/order', rec.before));
      case 'relation-typ':    return this._mhRun(() => sendJson(`/motifs/relations/${rec.id}`, 'PATCH', { typ: rec.before }));
      case 'delete-relation': return this._mhRestoreRelation(rec);
      case 'delete-motif':    return this._mhRestoreMotif(rec);
      case 'delete-theme':    return this._mhRestoreTheme(rec);
      default: return false;
    }
  },

  // create-* fehlt: nach dem Undo eines Create verwirft der Kern den Redo-Stack.
  async _applyForward(rec) {
    switch (rec.kind) {
      case 'motif-edit':      return this._mhRun(() => this._mhMotifEdit(rec.id, rec.after));
      case 'theme-fields':    return this._mhRun(() => sendJson(`/motifs/themes/${rec.id}`, 'PATCH', rec.after));
      case 'motif-move':      return this._mhRun(() => this._mhMotifMove(rec.id, rec.afterTheme, rec.afterOrder, rec.beforeTheme));
      case 'theme-order':     return this._mhRun(() => this._mhPutOrder('/motifs/themes/order', rec.after));
      case 'relation-typ':    return this._mhRun(() => sendJson(`/motifs/relations/${rec.id}`, 'PATCH', { typ: rec.after }));
      case 'delete-relation': return this._mhRedelete(rec, 'relation');
      case 'delete-motif':    return this._mhRedelete(rec, 'motif');
      case 'delete-theme':    return this._mhRedelete(rec, 'theme');
      default: return false;
    }
  },

  // Request(s) ausführen, danach das Board frisch laden. Eine offene Auswahl auf
  // dem gerade entfernten Objekt wird aufgehoben.
  async _mhRun(fn, { clearMotif = null, clearTheme = null } = {}) {
    try {
      await fn();
    } catch (e) {
      this.errorMessage = window.__app.t('motiv.error.save');
      return false;
    }
    if (clearMotif != null && this.selectedMotifId === clearMotif) { this.selectedMotifId = null; this.occurrences = []; }
    if (clearTheme != null && this.selectedThemeId === clearTheme) { this.selectedThemeId = null; this._loadThemeBuffer(null); }
    await this.loadBoard();
    // Offener Editor auf dem zurückgedrehten Objekt: Puffer auf den neuen Stand.
    const m = this.selectedMotif?.();
    if (m) { this._loadMotifBuffer(m); this._loadLinkBuffer(m); }
    const t = this.selectedTheme?.();
    if (t) this._loadThemeBuffer(t);
    this.errorMessage = '';
    return true;
  },

  async _mhMotifEdit(id, side) {
    if (side?.core) await sendJson(`/motifs/${id}`, 'PATCH', side.core);
    if (side?.links) await sendJson(`/motifs/${id}/links`, 'PUT', side.links);
  },

  async _mhPutOrder(url, ids) {
    await sendJson(url, 'PUT', { book_id: this._bookId(), order: ids });
  },

  // Motiv in ein Thema + an eine Position zurück. Die Reihenfolge enthält nur
  // Motive, die es noch gibt; seither angelegte reihen sich hinten ein.
  async _mhMotifMove(id, themeId, order, otherTheme) {
    if ((themeId ?? null) !== (otherTheme ?? null)) await sendJson(`/motifs/${id}`, 'PATCH', { theme_id: themeId ?? null });
    await this._mhPutOrder('/motifs/order', this._liveOrder(order, this.motifs));
  },

  _liveOrder(order, list) {
    const alive = new Set(list.map(x => x.id));
    const kept = (order || []).filter(id => alive.has(id));
    for (const x of [...list].sort(byPos)) if (!kept.includes(x.id)) kept.push(x.id);
    return kept;
  },

  async _mhRestoreRelation(rec) {
    const s = rec.snapshot;
    let rel;
    try {
      rel = await sendJson('/motifs/relations', 'POST', { from_motif_id: s.from, to_motif_id: s.to, typ: s.typ });
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); return false; }
    this._remapMotivIds('relation', rec.id, rel.id, rec);
    await this.loadBoard();
    return true;
  },

  async _mhRestoreMotif(rec) {
    const s = rec.snapshot;
    let motif;
    try {
      motif = await sendJson('/motifs', 'POST', {
        book_id: this._bookId(), ...s.core, farbe: s.farbe || undefined,
      });
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); return false; }
    const oldId = rec.id;
    const nid = motif.id;
    // Folge-Schritte best-effort: ein Fehlschlag lässt das wiederhergestellte
    // Motiv stehen (der Snapshot-Rest ist dann verloren, nicht das Motiv).
    try { await sendJson(`/motifs/${nid}/links`, 'PUT', s.links); } catch (e) { /* Verknüpfungen bleiben leer */ }
    const alive = new Set(this.motifs.map(m => m.id));
    for (const r of s.relations || []) {
      const from = r.from === oldId ? nid : r.from;
      const to = r.to === oldId ? nid : r.to;
      if ((from !== nid && !alive.has(from)) || (to !== nid && !alive.has(to))) continue;
      try {
        const rel = await sendJson('/motifs/relations', 'POST', { from_motif_id: from, to_motif_id: to, typ: r.typ });
        if (rel?.id != null) this._remapMotivIds('relation', r.id, rel.id, rec);
      } catch (e) { /* Partner inzwischen weg */ }
    }
    let ideas = false;
    for (const ideaId of s.ideaIds || []) {
      try { await sendJson(`/ideen/${ideaId}/links`, 'POST', { target_kind: 'motif', target_id: nid }); ideas = true; } catch (e) { /* Idee weg */ }
    }
    this._remapMotivIds('motif', oldId, nid, rec);
    const order = (s.order || []).map(id => (id === oldId ? nid : id));
    try { await this._mhPutOrder('/motifs/order', this._liveOrder(order, [...this.motifs, { id: nid, position: Infinity }])); } catch (e) { /* Position bleibt hinten */ }
    await this.loadBoard();
    if (ideas) this.loadIdeaBacklinks?.('motif');
    return true;
  },

  async _mhRestoreTheme(rec) {
    const s = rec.snapshot;
    let theme;
    try {
      theme = await sendJson('/motifs/themes', 'POST', { book_id: this._bookId(), ...s.fields });
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); return false; }
    const oldId = rec.id;
    const nid = theme.id;
    const alive = new Set(this.motifs.map(m => m.id));
    for (const mid of s.motifIds || []) {
      if (!alive.has(mid)) continue;
      try { await sendJson(`/motifs/${mid}`, 'PATCH', { theme_id: nid }); } catch (e) { /* Motiv weg */ }
    }
    this._remapMotivIds('theme', oldId, nid, rec);
    const order = (s.order || []).map(id => (id === oldId ? nid : id));
    try { await this._mhPutOrder('/motifs/themes/order', this._liveOrder(order, [...this.themes, { id: nid, position: Infinity }])); } catch (e) { /* hinten */ }
    await this.loadBoard();
    return true;
  },

  // Redo eines Löschens: frisch fotografieren, dann wieder löschen.
  async _mhRedelete(rec, type) {
    if (type === 'relation') {
      const r = this.relations.find(x => x.id === rec.id);
      if (!r) return false;
      rec.snapshot = { from: r.from_motif_id, to: r.to_motif_id, typ: r.typ };
      return this._mhRun(() => sendJson(`/motifs/relations/${rec.id}`, 'DELETE'));
    }
    if (type === 'motif') {
      const m = this.motifById(rec.id);
      if (!m) return false;
      rec.snapshot = this._motifDeleteSnap(m);
      return this._mhRun(() => sendJson(`/motifs/${rec.id}`, 'DELETE'), { clearMotif: rec.id });
    }
    const t = this.themeById(rec.id);
    if (!t) return false;
    rec.snapshot = this._themeDeleteSnap(t);
    return this._mhRun(() => sendJson(`/motifs/themes/${rec.id}`, 'DELETE'), { clearTheme: rec.id });
  },
};
