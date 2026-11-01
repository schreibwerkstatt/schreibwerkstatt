// Fine-Tuning-Export: Methods werden in Alpine.data('finetuneExportCard')
// gespreadet. Root-Zugriffe via window.__app.

import { fetchJson, tzOpts, downloadHref, downloadBlob } from '../utils.js';
import { FINETUNE_PROFILES, finetuneProfileById, buildStudioYaml, studioSteps } from './finetune-profiles.js';
import { buildModelfile } from './finetune-modelfile.js';

export const finetuneExportMethods = {
  // Zuletzt gespeichertes Set des Buchs (überlebt Neustarts, liegt serverseitig
  // auf der Platte). `stale` = Buch seither geändert → Warnung, kein Auto-Rerun.
  async finetuneLoadSaved() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      const { export: saved } = await fetchJson(`/jobs/finetune-export/latest?book_id=${encodeURIComponent(bookId)}`);
      if (Alpine.store('nav').selectedBookId !== bookId || this.finetuneLoading) return;
      this.finetuneStats = saved?.stats || null;
      this.finetuneSavedAt = saved?.createdAt || null;
      this.finetuneStale = !!saved?.stale;
    } catch (e) {
      console.error('[finetune] gespeicherter Export:', e);
    }
  },

  finetuneSavedLabel() {
    if (!this.finetuneSavedAt) return '';
    const date = new Date(this.finetuneSavedAt).toLocaleString(undefined, tzOpts({ dateStyle: 'medium', timeStyle: 'short' }));
    return window.__app.t('finetune.hint.saved', { date });
  },

  finetuneDownload(kind) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.finetuneStats) return;
    if (!['train', 'val', 'all', 'eval', 'val-facts', 'val-writing', 'val-refusal'].includes(kind)) return;
    downloadHref(`/jobs/finetune-export/${kind}.jsonl?book_id=${encodeURIComponent(bookId)}`);
  },

  finetuneDownloadStats() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.finetuneStats) return;
    downloadHref(`/jobs/finetune-export/stats.json?book_id=${encodeURIComponent(bookId)}`);
  },

  // Dateiname wie die Server-Downloads: finetune-<art>-<Buch>-<Profil>-<Zeit>
  // (stats.fileStem). Ohne Export: <art>.<ext>.
  _finetuneFileName(kind, ext) {
    const stem = this.finetuneStats?.fileStem;
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
    const trainCount = Number(this.finetuneStats?.train) || 0;
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
  finetuneDownloadModelfile() {
    const st = this.finetuneStats;
    if (!st?.systemPrompt) return;
    const t = window.__app.t.bind(window.__app);
    const p = finetuneProfileById(this.finetuneProfileId);
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

  finetuneOverlapTotal() {
    const o = this.finetuneStats?.quality?.overlap || {};
    return (o.prompt || 0) + (o.answer || 0) + (o.shingle || 0);
  },

  finetuneTokenShares() {
    const q = this.finetuneStats?.quality || {};
    return {
      writing: this.finetunePct(q.writingTokenShare), facts: this.finetunePct(q.factTokenShare),
      persona: this.finetunePct(q.personaTokenShare), refusal: this.finetunePct(q.refusalTokenShare),
    };
  },

  finetuneQualityRows() {
    const t = window.__app.t.bind(window.__app);
    return (this.finetuneStats?.quality?.tasks || []).map(r => ({
      ...r,
      label: t('finetune.task.' + r.task),
      familyLabel: t('finetune.family.' + r.family),
    }));
  },
};
