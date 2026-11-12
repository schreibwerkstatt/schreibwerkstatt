// Alpine.data('erzaehlprofilCard') — Sub-Komponente der Erzählprofil-Karte.
// Zeigt das in der Komplettanalyse-Phase «Erzählprofil» erzeugte Kapitel-Profil
// (POV/Erzählzeit + Abweichung, Spannungskurve, Themen/Motive) und erlaubt es, nur
// diese Phase eigenständig neu zu berechnen (Job /jobs/erzaehlprofil). Rein lesend
// gegenüber dem Manuskript.

import { erzaehlprofilMethods } from '../book/erzaehlprofil.js';
import { createCardJobFeature } from './job-feature-card.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { runningJobStatus } from './job-helpers.js';
import { EVT } from '../events.js';

export function registerErzaehlprofilCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('erzaehlprofilCard', () => ({
    erzaehlprofilResult: null,
    erzaehlprofilLoading: false,
    erzaehlprofilProgress: 0,
    erzaehlprofilStatus: '',
    _erzaehlprofilPollTimer: null,
    _lifecycle: null,

    init() {
      // Reconnect nach Tab-Reopen/Reload während ein Erzählprofil-Job lief.
      const onJobReconnect = (e) => {
        const d = e.detail;
        if (d?.type !== 'erzaehlprofil') return;
        this.erzaehlprofilLoading = true;
        this.erzaehlprofilProgress = d.job.progress || 0;
        this.erzaehlprofilStatus = runningJobStatus(
          (k, p) => window.__app.t(k, p),
          d.job.statusText || 'common.analysisRunning', d.job.tokensIn, d.job.tokensOut, d.job.maxTokensOut,
          d.job.progress, d.job.tokensPerSec, d.job.statusParams,
        );
        this.startErzaehlprofilPoll(d.jobId);
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'erzaehlprofil',
        showFlag: 'showErzaehlprofilCard',
        timerKeys: ['_erzaehlprofilPollTimer'],
        onShow: () => this._onVisibleErzaehlprofil(),
        resetState: {
          erzaehlprofilResult: null,
          erzaehlprofilLoading: false,
          erzaehlprofilProgress: 0,
          erzaehlprofilStatus: '',
        },
        extraListeners: [{ type: EVT.JOB_RECONNECT, handler: onJobReconnect }],
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...erzaehlprofilMethods,

    ...createCardJobFeature({
      name: 'erzaehlprofil',
      endpoint: '/jobs/erzaehlprofil',
      timerProp: '_erzaehlprofilPollTimer',
      methodNames: {
        start:     'startErzaehlprofilPoll',
        run:       'runErzaehlprofil',
        onVisible: '_onVisibleErzaehlprofil',
      },
      fields: {
        show:     'showErzaehlprofilCard',
        loading:  'erzaehlprofilLoading',
        progress: 'erzaehlprofilProgress',
        status:   'erzaehlprofilStatus',
      },
      i18n: {
        starting:       'erzaehlprofil.starting',
        interrupted:    'job.interrupted',
        alreadyRunning: 'common.analysisAlreadyRunning',
      },
      progressResetDelay: 400,
      buildPayload() {
        return {
          book_id: parseInt(Alpine.store('nav').selectedBookId),
          book_name: window.__app.selectedBookName || '',
        };
      },
      async onDone() {
        this.erzaehlprofilStatus = '';
        await this._loadErzaehlprofil();
      },
      async onOpen() {
        await this._loadErzaehlprofil();
      },
    }),
  }));
}
