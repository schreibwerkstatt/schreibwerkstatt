// Fine-Tuning-Export: Methods werden in Alpine.data('finetuneExportCard')
// gespreadet. Root-Zugriffe via window.__app.

import { fetchJson, downloadHref, downloadBlob } from '../utils.js';
import { FINETUNE_PROFILES, finetuneProfileById, buildStudioYaml, studioSteps } from './finetune-profiles.js';
import { buildModelfile } from './finetune-modelfile.js';

export const finetuneExportMethods = {
  // Gespeicherte Sets des Buchs, neuestes zuerst (überleben Neustarts, liegen
  // in der DB, die letzten fünf bleiben). `stale` = Buch
  // seither geändert → Warnung, kein Auto-Rerun.
  async finetuneLoadExports() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      const { exports } = await fetchJson(`/jobs/finetune-export/list?book_id=${encodeURIComponent(bookId)}`);
      if (Alpine.store('nav').selectedBookId !== bookId || this.finetuneLoading) return;
      this.finetuneExports = exports || [];
      if (!this.finetuneExports.some(ex => ex.id === this.finetuneOpenId)) this.finetuneOpenId = null;
    } catch (e) {
      console.error('[finetune] gespeicherte Exporte:', e);
    }
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

  finetuneDownloadStats(id) {
    if (!Alpine.store('nav').selectedBookId || !id) return;
    downloadHref(this._finetuneUrl('stats.json', id));
  },

  // Alle Dateien des Sets als ZIP (jede JSONL mit Inhalt + stats.json).
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

  // max_seq_length folgt dem Export-Feld, nicht dem Profil: Training und
  // Export-Filter müssen dasselbe Budget sehen, auch wenn der User es
  // nach der Profilwahl von Hand ändert.
  // Mit gespeichertem Export kennt die YAML die Train-Grösse: Gesamtschritte
  // als Kommentar, save_steps ≈ 10 % davon (finetune-profiles.js#studioSteps).
  finetuneDownloadStudioConfig() {
    const t = window.__app.t.bind(window.__app);
    const p = finetuneProfileById(this.finetuneProfileId);
    const trainCount = Number(this.finetuneLatestStats()?.train) || 0;
    const steps = studioSteps(p, trainCount);
    const yaml = buildStudioYaml(p, {
      maxSeqTokens: Number(this.finetuneMaxSeqTokens) || 0,
      trainCount,
      header: [
        t('finetune.profile.yaml.title', { profile: t('finetune.profile.option', { model: p.name, vram: p.vramGb }) }),
        t('finetune.profile.yaml.model', { model: p.model }),
        t('finetune.profile.yaml.order'),
        t('finetune.profile.yaml.eval'),
        steps
          ? t('finetune.profile.yaml.steps', { train: trainCount, batch: p.batch, accum: p.accum, epochs: steps.epochs, total: steps.total, save: steps.save })
          : t('finetune.profile.yaml.noExport'),
      ],
    });
    downloadBlob(new Blob([yaml], { type: 'application/yaml;charset=utf-8' }), this._finetuneFileName('studio-config', 'yaml'));
  },

  // System-Prompt aus dem gespeicherten Export (wörtlich wie im Training).
  // Sets von vor dieser Funktion tragen ihn nicht → Knopf ausgeblendet.
  finetuneDownloadModelfile(st) {
    if (!st?.systemPrompt) return;
    const t = window.__app.t.bind(window.__app);
    const p = finetuneProfileById(st.profileId || this.finetuneProfileId);
    const text = buildModelfile({
      systemPrompt: st.systemPrompt,
      header: [
        t('finetune.modelfile.title', { book: window.__app.selectedBookName || '', model: p.name }),
        t('finetune.modelfile.from'),
        t('finetune.modelfile.system'),
        t('finetune.modelfile.build'),
      ],
    });
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
