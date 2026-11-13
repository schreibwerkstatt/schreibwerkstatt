// Fine-Tuning-Export: Methods werden in Alpine.data('finetuneExportCard')
// gespreadet. Root-Zugriffe via window.__app.

import { fetchJson, downloadHref, downloadBlob } from '../utils.js';
import { FINETUNE_PROFILES, finetuneProfileById } from './finetune-profiles.js';
import { studioYamlFor, modelfileFor } from './finetune-studio-files.js';
import { isSelectedBook } from '../cards/book-guard.js';

export const finetuneExportMethods = {
  // Gespeicherte Sets des Buchs, neuestes zuerst (überleben Neustarts, liegen
  // in der DB, die letzten fünf bleiben). `stale` = Buch
  // seither geändert → Warnung, kein Auto-Rerun.
  async finetuneLoadExports() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      const { exports } = await fetchJson(`/jobs/finetune-export/list?book_id=${encodeURIComponent(bookId)}`);
      if (!isSelectedBook(bookId) || this.finetuneLoading) return;
      this.finetuneExports = exports || [];
      if (!this.finetuneExports.some(ex => ex.id === this.finetuneOpenId)) this.finetuneOpenId = null;
    } catch (e) {
      console.error('[finetune] gespeicherte Exporte:', e);
    }
  },

  // Beziehungsprüfung ohne Export (routes/jobs/finetune-export/lib/relation-check.js).
  async finetuneLoadRelCheck() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      const r = await fetchJson(`/jobs/finetune-export/relation-check?book_id=${encodeURIComponent(bookId)}`);
      if (!isSelectedBook(bookId)) return;
      this.finetuneRelCheck = { conflicts: r.conflicts || [], mainCount: r.mainCount || 0 };
    } catch (e) {
      console.error('[finetune] Beziehungsprüfung:', e);
    }
  },

  // Start des Exports: Konflikte bei Hauptfiguren halten ihn an — der Autor
  // bestätigt ausdrücklich, dass die betroffenen Beziehungen bis zur Klärung
  // wegfallen (`allow_relation_conflicts`).
  async finetuneStart() {
    const app = window.__app;
    this._finetuneAllowConflicts = false;
    if (this.finetuneRelCheck.mainCount > 0) {
      const ok = await app.appConfirm({
        message: app.tn('finetune.relcheck.confirm', this.finetuneRelCheck.mainCount),
        confirmLabel: app.t('finetune.relcheck.confirmLabel'),
      });
      if (!ok) return;
      this._finetuneAllowConflicts = true;
    }
    return this.runFinetuneExport();
  },

  // Neuestes Set: liefert der Studio-Config die Train-Grösse.
  finetuneLatestStats() {
    return this.finetuneExports[0]?.stats || null;
  },

  finetuneToggleExport(id) {
    this.finetuneOpenId = this.finetuneOpenId === id ? null : id;
  },

  finetuneProfileLabel(st) {
    const p = st?.profileId && FINETUNE_PROFILES.find(x => x.id === st.profileId);
    return p ? window.__app.t('finetune.profile.option', { model: p.name, vram: p.vramGb }) : '';
  },

  async finetuneDeleteExport(id) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !await app.appConfirm({
      message: app.t('finetune.history.confirmDelete'),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    try {
      await fetchJson(`/jobs/finetune-export/${encodeURIComponent(id)}?book_id=${encodeURIComponent(bookId)}`, { method: 'DELETE' });
      this.finetuneExports = this.finetuneExports.filter(ex => ex.id !== id);
      if (this.finetuneOpenId === id) this.finetuneOpenId = null;
    } catch (e) {
      console.error('[finetune] Export löschen:', e);
      app.setStatus(app.t('common.deleteFailed'), false, 5000);
    }
  },

  _finetuneUrl(file, id) {
    const bookId = Alpine.store('nav').selectedBookId;
    return `/jobs/finetune-export/${file}?book_id=${encodeURIComponent(bookId)}&id=${encodeURIComponent(id)}`;
  },

  finetuneDownload(kind, id) {
    if (!Alpine.store('nav').selectedBookId || !id) return;
    if (!['train', 'val', 'all', 'eval', 'val-facts', 'val-writing', 'val-persona', 'val-refusal', 'val-editor'].includes(kind)) return;
    downloadHref(this._finetuneUrl(`${kind}.jsonl`, id));
  },

  finetuneDownloadJudge(id) {
    if (!Alpine.store('nav').selectedBookId || !id) return;
    downloadHref(this._finetuneUrl('eval-judge.md', id));
  },

  // Konfliktliste: neue Sets tragen die Liste, ältere nur die Zahl.
  finetuneConflictCount(st) {
    const c = st?.relationConflicts;
    return Array.isArray(c) ? c.length : Number(c) || 0;
  },

  finetuneDownloadStats(id) {
    if (!Alpine.store('nav').selectedBookId || !id) return;
    downloadHref(this._finetuneUrl('stats.json', id));
  },

  // Alle Dateien des Sets als ZIP: jede JSONL mit Inhalt, stats.json,
  // Studio-Config, Modelfile und Bewertungsanleitung (sofern vorhanden).
  finetuneDownloadZip(id) {
    if (!Alpine.store('nav').selectedBookId || !id) return;
    downloadHref(this._finetuneUrl('export.zip', id));
  },

  // Dateiname wie die Server-Downloads: finetune-<art>-<Buch>-<Profil>-<Zeit>
  // (stats.fileStem). Ohne Export: <art>.<ext>.
  _finetuneFileName(kind, ext) {
    const stem = this.finetuneLatestStats()?.fileStem;
    return stem ? `finetune-${kind}-${stem}.${ext}` : `${kind}.${ext}`;
  },

  finetuneProfileOptions() {
    const t = window.__app.t.bind(window.__app);
    return FINETUNE_PROFILES.map(p => ({
      value: p.id,
      label: t('finetune.profile.option', { model: p.name, vram: p.vramGb }),
    }));
  },

  // Profilwechsel setzt die Export-Vorgaben, die zum Sequenz-Budget des
  // Profils passen. Studio rendert das Template selbst → kein text-Feld.
  // `id` aus dem Event: x-model zieht erst nach `combobox-change` nach.
  finetuneApplyProfile(id) {
    this.finetuneProfileId = id;
    const p = finetuneProfileById(id);
    this.finetuneMaxSeqTokens = p.seq;
    this.finetuneMaxChars = p.maxChars;
    this.finetuneEmitText = false;
  },

  // Ohne Export folgt max_seq_length dem Export-Feld; mit Export der
  // empfohlenen Länge des neuesten Sets (P95 + Puffer), Train-Grösse für
  // save_steps — dieselben Dateien wie im ZIP (finetune-studio-files.js).
  finetuneDownloadStudioConfig() {
    const t = window.__app.t.bind(window.__app);
    const st = this.finetuneLatestStats();
    const sameProfile = st && (st.profileId || this.finetuneProfileId) === this.finetuneProfileId;
    const yaml = studioYamlFor({
      profileId: this.finetuneProfileId,
      stats: sameProfile ? st : null,
      maxSeqTokens: Number(this.finetuneMaxSeqTokens) || 0,
      t,
    });
    downloadBlob(new Blob([yaml], { type: 'application/yaml;charset=utf-8' }), this._finetuneFileName('studio-config', 'yaml'));
  },

  // System-Prompt aus dem gespeicherten Export (wörtlich wie im Training).
  // Sets von vor dieser Funktion tragen ihn nicht → Knopf ausgeblendet.
  finetuneDownloadModelfile(st) {
    const text = modelfileFor({ stats: st, bookName: window.__app.selectedBookName || '', t: window.__app.t.bind(window.__app) });
    if (!text) return;
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'Modelfile');
  },

  finetuneFormatBytes(n) {
    if (n == null) return '';
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  },

  // Qualitäts-Statistik des Sets (stats.quality, routes/jobs/finetune-export/lib/export-stats.js).
  finetunePct(x) {
    return (Number(x || 0) * 100).toFixed(1) + ' %';
  },

  finetuneOverlapTotal(st) {
    const o = st?.quality?.overlap || {};
    return (o.prompt || 0) + (o.answer || 0) + (o.shingle || 0);
  },

  finetuneTokenShares(st) {
    const q = st?.quality || {};
    return {
      writing: this.finetunePct(q.writingTokenShare), facts: this.finetunePct(q.factTokenShare),
      persona: this.finetunePct(q.personaTokenShare), refusal: this.finetunePct(q.refusalTokenShare),
    };
  },

  finetuneQualityRows(st) {
    const t = window.__app.t.bind(window.__app);
    return (st?.quality?.tasks || []).map(r => ({
      ...r,
      label: t('finetune.task.' + r.task),
      familyLabel: t('finetune.family.' + r.family),
    }));
  },
};
