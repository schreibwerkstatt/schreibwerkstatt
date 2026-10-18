// „Erste Schritte" — Onboarding-Fortschritts-Checkliste. Buch-unabhaengige Karte
// (wie help), fuer jeden Auth-User sichtbar. Zeigt echten Fortschritt entlang des
// Kern-Pfads (Buch → Text → KI-Analyse → Teilen), abgeleitet serverseitig aus dem
// tatsaechlichen State (GET /me/onboarding) — kein Klick-Zaehler. Bietet zusaetzlich
// den One-Click-Import eines gemeinfreien Beispielbuchs.
import { setupCardLifecycle } from './card-lifecycle.js';

// Reihenfolge = Anzeige-Reihenfolge. `action` steuert die CTA des offenen Schritts.
const STEP_KEYS = ['book', 'page', 'analysis', 'share'];

export function registerOnboardingCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('onboardingCard', () => ({
    stepKeys: STEP_KEYS,
    steps: { book: false, page: false, analysis: false, share: false },
    loading: false,
    demoBusy: false,
    error: '',
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'onboarding',
        showFlag: 'showOnboardingCard',
        showNeedsBookId: false,
        onShow: () => this.loadOnboarding(),
        extraListeners: [
          { type: 'card:refresh', handler: (e) => { if (e?.detail?.name === 'onboarding') this.loadOnboarding(); } },
        ],
      });
    },

    destroy() {
      this._lifecycle?.destroy();
      this._abortCtrl?.abort();
    },

    async loadOnboarding() {
      this.loading = true;
      this.error = '';
      try {
        const res = await fetch('/me/onboarding', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('load failed');
        const data = await res.json();
        if (data?.steps) this.steps = data.steps;
      } catch {
        this.error = window.__app?.t?.('onboarding.loadError') || '';
      } finally {
        this.loading = false;
      }
    },

    doneCount() {
      return STEP_KEYS.reduce((n, k) => n + (this.steps[k] ? 1 : 0), 0);
    },
    totalCount() {
      return STEP_KEYS.length;
    },
    allDone() {
      return this.doneCount() === STEP_KEYS.length;
    },
    progressPct() {
      return Math.round((this.doneCount() / STEP_KEYS.length) * 100);
    },

    // Titel/Beschreibung/CTA-Label eines Schritts (i18n).
    stepTitle(key) { return window.__app?.t?.(`onboarding.step.${key}.title`) || key; },
    stepDesc(key) { return window.__app?.t?.(`onboarding.step.${key}.desc`) || ''; },
    // Ohne gewähltes Buch führt jeder CTA zu «Buch anlegen» (doStep) — dann
    // trägt er auch dessen Beschriftung statt «Analyse starten» o. ä.
    stepCta(key) {
      const app = window.__app;
      const target = (key !== 'book' && !window.Alpine?.store('nav')?.selectedBookId) ? 'book' : key;
      return app?.t?.(`onboarding.step.${target}.cta`) || '';
    },

    // CTA eines offenen Schritts: navigiert in die passende Funktion. Schritte
    // 2–4 brauchen ein gewaehltes Buch; ohne Buch faellt alles auf „Buch anlegen".
    doStep(key) {
      const app = window.__app;
      if (!app) return;
      const hasBook = !!app.$store?.nav?.selectedBookId;
      if (key === 'book' || !hasBook) { app.openCreateBook?.(); return; }
      if (key === 'page') { app.toggleBookOverviewCard?.(); return; }
      if (key === 'analysis') { app.alleAktualisieren?.(); return; }
      if (key === 'share') { app.toggleShareLinksCard?.(); return; }
    },

    // Beispielbuch anlegen + hineinnavigieren (Root-Pfad, geteilt mit der
    // Welcome-Karte). Die Buch-Übersicht schliesst diese Karte via Exklusivität.
    async importDemo() {
      if (this.demoBusy) return;
      this.demoBusy = true;
      this.error = '';
      const app = window.__app;
      const ok = await app?.importDemoBook?.();
      if (!ok) this.error = app?.t?.('onboarding.demoError') || '';
      this.demoBusy = false;
    },

    // „Ausblenden": Onboarding als erledigt markieren + Karte schliessen.
    async dismiss() {
      const app = window.__app;
      try {
        await fetch('/me/onboarding', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ completed: true, welcomeDismissed: true }),
        });
      } catch { /* non-fatal — Karte trotzdem schliessen */ }
      if (app) {
        app.onboardingWelcome = false;
        if (app.showOnboardingCard) app.toggleOnboardingCard?.();
      }
    },
  }));
}
