// Alpine.data('finetuneExportCard') — Sub-Komponente der Finetune-Export-Karte.
//
// Trainiert immer das Leser-Modell (docs/finetuning.md#leser-modell).
//
// State: Trainingsprofil, Typ-Toggles, Längenfenster, Val-Split, Loading/Progress/Status,
// Verlauf der gespeicherten Sets (je Stats, Zeitpunkt, Veraltet-Flag) + aufgeklapptes Set.
// `showFinetuneExportCard` bleibt im Root (Hash-Router + Exklusivität).
//
// Export-Vorgaben kommen aus dem gewählten Trainingsprofil
// (book/finetune-profiles.js: Basismodell × GPU-Speicher, Default
// Ministral-3-8B auf 16 GB):
//   maxChars, maxSeqTokens → Sequenz-Budget des Profils
//   exportOptions    → Kernwissen, Mischung nach Tokens, Längen, Absatz-Budget,
//                      Ablehnen (geht als `export` an den Server)
//   emitText=false   → Studio rendert das Chat-Template selbst auf Basis des
//                      gewählten Basemodells; ein vorgerenderter text-Feld-
//                      String würde kollidieren. Nur einschalten, wenn du
//                      mit einem CLI-Trainer arbeitest, der `dataset_text_field`
//                      erwartet.

import { finetuneExportMethods } from '../book/finetune-export.js';
import { DEFAULT_FINETUNE_PROFILE_ID, finetuneProfileById, exportOptions } from '../book/finetune-profiles.js';
import { createCardJobFeature } from './job-feature-card.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { runningJobStatus } from './job-helpers.js';
import { EVT } from '../events.js';

export function registerFinetuneExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  const defaultProfile = finetuneProfileById(DEFAULT_FINETUNE_PROFILE_ID);
  const defaultExport = exportOptions(defaultProfile);
  window.Alpine.data('finetuneExportCard', () => ({
    finetuneProfileId:      DEFAULT_FINETUNE_PROFILE_ID,
    finetuneTypeStyle:      true,
    finetuneTypeScene:      true,
    finetuneTypeVerbatim:   defaultExport.types.verbatim !== false,
    finetuneTypeDialog:     true,
    finetuneTypeAuthorChat: true,
    finetuneMinChars:     200,
    finetuneMaxChars:     defaultProfile.maxChars,
    finetuneBiasBoost:    1,
    finetuneMaxTypeShare: 0,   // 0 = kein Typ-Cap; sonst Anteil 0.1–0.95 pro Typ
    finetuneMaxPerAnswer: 2,   // jede Antwort höchstens so oft (0 = aus)
    finetuneEditorFeedback: !!defaultExport.editorFeedback,
    finetuneValSplit:     0.1,
    finetuneValSeed:      0,
    finetuneMaxSeqTokens: defaultProfile.seq,
    finetuneEmitText:     false,
    finetuneTruncateLong: true,   // Lange Samples kappen statt droppen

    finetuneAiReversePrompts:        false,
    finetuneAiFactQA:                false,
    finetuneAiVoiceRewrite:          true,
    finetuneAiReversePromptsPerPage: 4,
    finetuneAiFactQAPerEntity:       4,
    finetuneAiParaphrase:            !!defaultExport.aiParaphrase,
    finetuneAiWhyQuestions:          !!defaultExport.aiWhyQuestions,
    finetuneAiPersona:               true,
    finetuneAiDeutung:               true,
    finetuneAiPersonaPerFigure:      8,
    finetuneAiDeutungPerScene:       2,

    finetuneLoading:  false,
    finetuneProgress: 0,
    finetuneStatus:   '',
    finetuneExports:  [],
    finetuneOpenId:   null,
    // Beziehungsprüfung (GET /jobs/finetune-export/relation-check): Konflikte
    // vor dem Export; bei Hauptfiguren startet der Export nur nach Bestätigung.
    finetuneRelCheck: { conflicts: [], mainCount: 0 },
    _finetuneAllowConflicts: false,

    _finetunePollTimer: null,
    _lifecycle: null,

    init() {
      const onJobReconnect = (e) => {
        const d = e.detail;
        if (d?.type !== 'finetune-export') return;
        const job = d.job;
        this.finetuneLoading = true;
        this.finetuneProgress = job.progress || 0;
        this.finetuneStatus = runningJobStatus(
          (k, p) => window.__app.t(k, p),
          job.statusText || 'common.analysisRunning', job.tokensIn, job.tokensOut, job.maxTokensOut,
          job.progress, job.tokensPerSec, job.statusParams,
        );
        this.startFinetuneExportPoll(d.jobId);
      };

      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showFinetuneExportCard',
        timerKeys: ['_finetunePollTimer'],
        onShow: () => this._onVisibleFinetuneExport(),
        resetState: {
          finetuneLoading: false,
          finetuneProgress: 0,
          finetuneStatus: '',
          finetuneExports: [],
          finetuneOpenId: null,
          finetuneRelCheck: { conflicts: [], mainCount: 0 },
          _finetuneAllowConflicts: false,
        },
        extraListeners: [{ type: EVT.JOB_RECONNECT, handler: onJobReconnect }],
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...finetuneExportMethods,

    ...createCardJobFeature({
      name: 'finetune-export',
      endpoint: '/jobs/finetune-export',
      timerProp: '_finetunePollTimer',
      methodNames: {
        start:     'startFinetuneExportPoll',
        run:       'runFinetuneExport',
        onVisible: '_onVisibleFinetuneExport',
      },
      fields: {
        show:     'showFinetuneExportCard',
        loading:  'finetuneLoading',
        progress: 'finetuneProgress',
        status:   'finetuneStatus',
      },
      i18n: {
        starting:       'finetune.starting',
        interrupted:    'job.interrupted',
        alreadyRunning: 'common.analysisAlreadyRunning',
      },
      progressResetDelay: 400,
      onOpen() { return Promise.all([this.finetuneLoadExports(), this.finetuneLoadRelCheck()]); },
      buildPayload() {
        return {
          book_id: parseInt(Alpine.store('nav').selectedBookId),
          book_name: window.__app.selectedBookName,
          profile: this.finetuneProfileId,
          allow_relation_conflicts: !!this._finetuneAllowConflicts,
          export: {
            ...exportOptions(finetuneProfileById(this.finetuneProfileId)),
            editorFeedback: !!this.finetuneEditorFeedback,
            aiParaphrase: !!this.finetuneAiParaphrase,
            aiWhyQuestions: !!this.finetuneAiWhyQuestions,
          },
          types: {
            style:      !!this.finetuneTypeStyle,
            scene:      !!this.finetuneTypeScene,
            verbatim:   !!this.finetuneTypeVerbatim,
            dialog:     !!this.finetuneTypeDialog,
            authorChat: !!this.finetuneTypeAuthorChat,
          },
          min_chars:      Number(this.finetuneMinChars) || 200,
          max_chars:      Number(this.finetuneMaxChars) || 4000,
          bias_boost:     Number(this.finetuneBiasBoost) || 1,
          max_type_share: Number(this.finetuneMaxTypeShare) || 0,
          max_per_answer: Number(this.finetuneMaxPerAnswer) || 0,
          val_split:      Number(this.finetuneValSplit) || 0,
          val_seed:       Number(this.finetuneValSeed)  || 0,
          max_seq_tokens: Number(this.finetuneMaxSeqTokens) || 0,
          emit_text:      !!this.finetuneEmitText,
          truncate_long:  !!this.finetuneTruncateLong,
          ai: {
            reverse_prompts:          !!this.finetuneAiReversePrompts,
            fact_qa:                  !!this.finetuneAiFactQA,
            voice_rewrite:            !!this.finetuneAiVoiceRewrite,
            reverse_prompts_per_page: Number(this.finetuneAiReversePromptsPerPage) || 4,
            fact_qa_per_entity:       Number(this.finetuneAiFactQAPerEntity)       || 4,
            persona:                  !!this.finetuneAiPersona,
            deutung:                  !!this.finetuneAiDeutung,
            persona_per_figure:       Number(this.finetuneAiPersonaPerFigure)      || 8,
            deutung_per_scene:        Number(this.finetuneAiDeutungPerScene)       || 2,
          },
        };
      },
      async onDone(job) {
        if (job.result?.empty) {
          this.finetuneStatus = window.__app.t('finetune.empty');
          return;
        }
        if (job.result?.blocked === 'relationConflicts') {
          const conflicts = job.result.relationConflicts || [];
          this.finetuneRelCheck = { conflicts, mainCount: conflicts.filter(c => c.main).length };
          this.finetuneStatus = window.__app.t('finetune.relcheck.stopped');
          return;
        }
        const st = job.result?.stats;
        this.finetuneStatus = window.__app.t('finetune.done', {
          n: st?.total ?? 0,
          train: st?.train ?? 0,
          val: st?.val ?? 0,
        });
        await this.finetuneLoadExports();
        this.finetuneOpenId = this.finetuneExports[0]?.id ?? null;
      },
    }),
  }));
}
