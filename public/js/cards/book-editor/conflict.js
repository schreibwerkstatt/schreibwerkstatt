// Teil von bookEditorCard (Facade cards/book-editor-card.js): Block-Level-Merge
// bei Stale-Write und das Auflösungs-Modal des Bucheditors. Methoden in den
// Card-Scope gespreadet (gemeinsames `this`).
//
// Gleiche Regel wie im Notebook-Editor (docs/notebook-editor.md → «Block-Level-
// Merge bei Stale-Write»), eigene Glue: `base = originalHtml` des Blocks,
// `local = block.html` (Live-Stand nach den Reads), `remote` = frischer Server-
// Stand. Kollisionsfrei → still gemergt und gegen den Server-Stempel
// gespeichert; echte Block-Kollision → Modal (partials/book-editor-conflict.html)
// mit Meine/Andere/Beide je Stelle. Ohne Block-IDs in der Basis (Seite seit
// Einführung nie gespeichert) gibt es nichts zu mergen — dann bleibt das
// Banner mit «Meine Version übernehmen» / «Server-Version übernehmen».
//
// Erwartet aus der Card: `activePageId`, `conflictResolution`, `_blockById`,
// `_blockEl`, `_autosave`, `_enqueueSave`, `_historyDrop`/`_historyFor`.

import { FEATURE_BLOCK_MERGE } from '../../app/app-state.js';
import { contentRepo } from '../../repo/content.js';
import { tErrorRaw } from '../../i18n.js';
import { buildResolvedHtml, mergeBlocks, mergedToHtml } from '../../editor/shared/block-merge.js';
import { syncLiveBlockIds } from '../../editor/shared/block-ids.js';
import { captureBlockCaret, restoreBlockCaret } from '../../editor/shared/block-caret.js';
import { conflictDiffView } from '../../editor/shared/conflict-diff.js';
import { conflictText } from '../../editor/shared/conflict-text.js';
import { remoteAuthorFrom } from '../../editor/shared/page-conflict.js';

// Merge-Plan aus drei Fassungen. Pure und darum unit-testbar.
//  - `{ kind: 'fallback' }`: kein Merge möglich (Flag aus, Basis ohne IDs).
//  - `{ kind: 'clean', html }`: kollisionsfrei, `html` ist der gemergte Stand.
//  - `{ kind: 'collision', merged, conflicts }`: mindestens eine Stelle haben
//    beide Seiten verschieden geändert.
export function planBlockMerge(baseHtml, localHtml, remoteHtml, { enabled = FEATURE_BLOCK_MERGE } = {}) {
  if (!enabled || !/\sdata-bid=/.test(baseHtml || '')) return { kind: 'fallback' };
  const m = mergeBlocks(baseHtml, localHtml, remoteHtml || '');
  if (!m.conflicts.length) return { kind: 'clean', html: mergedToHtml(m.merged) };
  return { kind: 'collision', merged: m.merged, conflicts: m.conflicts };
}

export const bookEditorConflictMethods = {
  // Block-IDs des Blocks eindeutig und vollständig halten (Chromium klont sie
  // beim Enter, neue Absätze haben keine) — vor jedem Save und Merge, sonst
  // verlöre der Merge einen der beiden Absätze mit derselben ID still. Aktiver
  // Block: im Live-DOM (reine Attribute, kein Caret-/Undo-Schritt), danach
  // `block.html` nachziehen. Inaktiver Block: über einen losgelösten Container
  // aus `block.html` — sein DOM trägt Anzeige-Artefakte (Diagramm-SVG, Badges).
  _syncBlockIds(block) {
    const active = this.activePageId === block.pageId ? this._blockEl(block.pageId) : null;
    const el = active || document.createElement('div');
    if (!active) el.innerHTML = block.html;
    if (syncLiveBlockIds(el, block.originalHtml)) block.html = el.innerHTML;
  },

  // Gemergten/aufgelösten Stand in den Block schreiben. Aktiver Block: DOM
  // direkt, Caret bleibt in seinem Block (shared/block-caret.js), neue Undo-
  // Baseline — ein Undo dahinter nähme die Remote-Blöcke wieder heraus, und der
  // nächste Save liefe gegen den neuen Stempel ohne 409 durch. Inaktiver Block:
  // `_rev++` → `_maybeRehydrate` schreibt ihn neu.
  _applyBlockHtml(block, html) {
    block.html = html;
    this._historyDrop?.(block.pageId);
    const el = this.activePageId === block.pageId ? this._blockEl(block.pageId) : null;
    if (el) {
      if (el.innerHTML !== html) {
        const caret = captureBlockCaret(el);
        el.innerHTML = html;
        restoreBlockCaret(el, caret);
      }
      this._historyFor?.(block.pageId, { create: true })?.reset(el.innerHTML);
    } else {
      block._rev++;
    }
  },

  // Veralteter Stand eines Blocks gegen den Server-Stand. Liefert:
  //  - 'merged': kollisionsfrei gemergt, Basis = Server-Stand, Block dirty —
  //    der Aufrufer speichert gegen `block.originalUpdatedAt`.
  //  - 'conflict': Modal offen (bzw. Banner, wenn schon ein anderes offen ist).
  //  - 'fallback': kein Merge möglich, Banner mit Überschreiben/Übernehmen.
  // `remote`: { remoteHtml, remoteUpdatedAt, ...Autor-Feldsatz }.
  _mergeStaleBlock(block, remote) {
    this._syncBlockIds(block);
    const plan = planBlockMerge(block.originalHtml, block.html, remote.remoteHtml);
    const banner = {
      remoteUserName: remote.remoteUserName,
      remoteUpdatedAt: remote.remoteUpdatedAt,
      remoteIsSelf: remote.remoteIsSelf,
      remoteDevice: remote.remoteDevice,
      remoteHtml: remote.remoteHtml,
    };
    if (plan.kind === 'clean') {
      this._applyBlockHtml(block, plan.html);
      block.originalHtml = remote.remoteHtml;
      block.originalUpdatedAt = remote.remoteUpdatedAt;
      block.dirty = true;
      const app = window.__app;
      app?.setStatus?.(app.t('edit.conflict.merged.silent'), false, 4000);
      return 'merged';
    }
    this._autosave.clear(block.pageId);
    block.conflict = { ...banner, mergeable: plan.kind === 'collision' };
    block.saveError = this._conflictText(block.conflict, 'hint');
    if (plan.kind === 'collision') this._openBookConflict(block, plan, remote);
    return plan.kind === 'collision' ? 'conflict' : 'fallback';
  },

  // Modal öffnen. Ist schon eines offen (Save-All über mehrere Abschnitte),
  // bleibt es beim Banner — dessen «Konflikt lösen …» rechnet später frisch.
  // Ersetzt ein Folge-Konflikt derselben Seite das Modal, bleiben die
  // Entscheidungen stehen.
  _openBookConflict(block, plan, remote) {
    const prev = this.conflictResolution;
    if (prev && prev.pageId !== block.pageId) return;
    const decisions = prev?.pageId === block.pageId ? { ...prev.decisions } : {};
    this.conflictResolution = {
      pageId: block.pageId,
      merged: plan.merged,
      conflicts: plan.conflicts.map((c) => ({ ...c, view: conflictDiffView(c) })),
      decisions,
      remoteHtml: remote.remoteHtml,
      remoteUpdatedAt: remote.remoteUpdatedAt,
      author: {
        remoteUserName: remote.remoteUserName,
        remoteIsSelf: remote.remoteIsSelf,
        remoteDevice: remote.remoteDevice,
      },
    };
  },

  bookConflictText(variant) {
    const app = window.__app;
    const cr = this.conflictResolution;
    if (!app || !cr) return '';
    const time = cr.remoteUpdatedAt ? app.formatDate(cr.remoteUpdatedAt) : '';
    return conflictText(app.t.bind(app), cr.author, variant, { time });
  },

  bookConflictChoice(bid) {
    return this.conflictResolution?.decisions[bid] || 'local';
  },

  resolveBookConflictBlock(bid, side) {
    if (this.conflictResolution) this.conflictResolution.decisions[bid] = side;
  },

  resolveAllBookConflicts(side) {
    const cr = this.conflictResolution;
    if (!cr) return;
    for (const c of cr.conflicts) cr.decisions[c.bid] = side;
  },

  // Auflösung übernehmen: aufgelöster Stand wird der Block-Inhalt, Basis der
  // Server-Stand, dann regulär speichern. Kommt dazwischen ein weiterer
  // Remote-Save, läuft der Save erneut in den Merge.
  submitBookConflict() {
    const cr = this.conflictResolution;
    if (!cr) return;
    const block = this._blockById(cr.pageId);
    this.conflictResolution = null;
    if (!block) return;
    this._applyBlockHtml(block, buildResolvedHtml(cr.merged, cr.decisions));
    block.originalHtml = cr.remoteHtml;
    block.originalUpdatedAt = cr.remoteUpdatedAt;
    block.conflict = null;
    block.saveError = '';
    block.dirty = true;
    this._enqueueSave(block.pageId);
  },

  // Schliessen ohne Entscheidung: nichts wird verworfen, der Block behält
  // seine Fassung und das Banner, gespeichert wird erst nach einer Auflösung.
  cancelBookConflict() {
    this.conflictResolution = null;
  },

  // «Konflikt lösen …» am Banner: frischen Server-Stand holen und neu mergen
  // (inzwischen kann ein weiterer Save dazugekommen sein, oder die Kollision
  // hat sich erledigt).
  async reopenBookConflict(block) {
    if (!block.conflict) return;
    let page;
    try {
      page = await contentRepo.loadPage(block.pageId, { fresh: true });
    } catch (e) {
      const app = window.__app;
      block.saveError = e?.body ? tErrorRaw(e.body) : (app?.t('bookEditor.saveFailed') || '');
      return;
    }
    this.conflictResolution = null;
    const r = this._mergeStaleBlock(block, {
      remoteHtml: page?.html || '',
      remoteUpdatedAt: page?.updated_at || null,
      ...remoteAuthorFrom(page),
    });
    if (r === 'merged') {
      block.conflict = null;
      block.saveError = '';
      this._enqueueSave(block.pageId);
    }
  },
};
