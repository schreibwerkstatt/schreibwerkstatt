// Alpine.data('finetuneExportCard') — Sub-Komponente der Finetune-Export-Karte.
//
// Trainiert immer das Leser-Modell (docs/finetuning.md#leser-modell).
//
// State: Trainingsprofil, Typ-Toggles, Längenfenster, Val-Split, Loading/Progress/Status, Stats,
// Zeitpunkt + Veraltet-Flag des gespeicherten Sets.
// `showFinetuneExportCard` bleibt im Root (Hash-Router + Exklusivität).
//
// Export-Vorgaben kommen aus dem gewählten Trainingsprofil
// (book/finetune-profiles.js: Basismodell × GPU-Speicher, Default
// Ministral-3-8B auf 20 GB):
//   maxChars, maxSeqTokens → Sequenz-Budget des Profils
//   emitText=false   → Studio rendert das Chat-Template selbst auf Basis des
//                      gewählten Basemodells; ein vorgerenderter text-Feld-
//                      String würde kollidieren. Nur einschalten, wenn du
//                      mit einem CLI-Trainer arbeitest, der `dataset_text_field`
//                      erwartet.

import { finetuneExportMethods } from '../book/finetune-export.js';
import { DEFAULT_FINETUNE_PROFILE_ID, finetuneProfileById } from '../book/finetune-profiles.js';
import { createCardJobFeature } from './job-feature-card.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { runningJobStatus } from './job-helpers.js';

export function registerFinetuneExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  const defaultProfile = finetuneProfileById(DEFAULT_FINETUNE_PROFILE_ID);
  window.Alpine.data('finetuneExportCard', () => ({
    finetuneProfileId:      DEFAULT_FINETUNE_PROFILE_ID,
    finetuneTypeStyle:      true,
    finetuneTypeScene:      true,
    finetuneTypeVerbatim:   true,
    finetuneTypeDialog:     true,
    finetuneTypeAuthorChat: true,
    finetuneMinChars:     200,
    finetuneMaxChars:     defaultProfile.maxChars,
    finetuneBiasBoost:    1,
    finetuneMaxTypeShare: 0,   // 0 = kein Typ-Cap; sonst Anteil 0.1–0.95 pro Typ
    finetuneMaxPerAnswer: 2,   // jede Antwort höchstens so oft (0 = aus)
    finetuneMaxFactShare: 0.4, // Faktenfragen höchstens dieser Anteil (0 = aus)
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
    finetuneAiPersona:               true,
    finetuneAiDeutung:               true,
    finetuneAiPersonaPerFigure:      8,
    finetuneAiDeutungPerScene:       2,

    finetuneLoading:  false,
    finetuneProgress: 0,
    finetuneStatus:   '',
    finetuneStats:    null,
    finetuneSavedAt:  null,
    finetuneStale:    false,

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
          finetuneStats: null,
          finetuneSavedAt: null,
          finetuneStale: false,
        },
        extraListeners: [{ type: 'job:reconnect', handler: onJobReconnect }],
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
      onOpen() { return this.finetuneLoadSaved(); },
      buildPayload() {
        this.finetuneStats = null;
        this.finetuneSavedAt = null;
        this.finetuneStale = false;
        return {
          book_id: parseInt(Alpine.store('nav').selectedBookId),
          book_name: window.__app.selectedBookName,
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
          max_fact_share: Number(this.finetuneMaxFactShare) || 0,
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
          this.finetuneStats = null;
          return;
        }
        this.finetuneStats = job.result?.stats || null;
        this.finetuneSavedAt = new Date().toISOString();
        this.finetuneStale = false;
        this.finetuneStatus = window.__app.t('finetune.done', {
          n: this.finetuneStats?.total ?? 0,
          train: this.finetuneStats?.train ?? 0,
          val: this.finetuneStats?.val ?? 0,
        });
      },
    }),
  }));
}
