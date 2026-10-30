// Root-Methoden fuer das Onboarding: First-Login-Willkommens-Banner, Beispielbuch-
// Import und Hilfe-Einstieg (beide von der Welcome-Karte genutzt). Die
// eigentliche „Erste Schritte"-Karte lebt in cards/onboarding-card.js; hier nur
// der buch-unabhaengige Banner-State am Root (onboardingWelcome) + sein Loader
// und die zwei Banner-Aktionen. Persistiert wird das Wegklicken serverseitig
// (app_users.onboarding_state.welcomeDismissed) via PATCH /me/onboarding.
export const appOnboardingMethods = {
  // Beim Bootstrap aufgerufen (app-init): Banner nur zeigen, solange der User
  // ihn weder weggeklickt noch das Onboarding abgeschlossen hat. Non-blocking.
  async _loadOnboardingWelcome() {
    try {
      const res = await fetch('/me/onboarding', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      const st = data?.state || {};
      this.onboardingWelcome = !st.welcomeDismissed && !st.completed;
      // Weggeklickte Feature-Tipps (cards/hints-store.js) kommen mit derselben Antwort.
      this.$store.hints?.setDismissed(st.hints);
    } catch { /* non-fatal — kein Banner, kein Fehler */ }
  },

  // Banner-CTA: „Erste Schritte" oeffnen (schliesst Banner, offene Karte laedt
  // ihren Fortschritt selbst).
  async openOnboardingFromWelcome() {
    this.onboardingWelcome = false;
    if (!this.showOnboardingCard) await this.toggleOnboardingCard();
  },

  // Banner wegklicken: sofort ausblenden + serverseitig merken.
  async dismissOnboardingWelcome() {
    this.onboardingWelcome = false;
    try {
      await fetch('/me/onboarding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ welcomeDismissed: true }),
      });
    } catch { /* non-fatal — Banner bleibt lokal ausgeblendet */ }
  },

  // Beispielbuch (gemeinfreie Prosa, lib/demo-book.js) anlegen und hinein-
  // navigieren. Geteilt von Welcome-Karte und «Erste Schritte»; serverseitig
  // idempotent. Navigation über den Hash: `_applyHash` lädt Abschnitte und
  // öffnet die Buch-Übersicht. Liefert true bei Erfolg.
  async importDemoBook() {
    if (this.demoBookBusy) return false;
    this.demoBookBusy = true;
    try {
      const res = await fetch('/me/onboarding/demo-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('demo failed');
      const data = await res.json();
      if (!data?.bookId) throw new Error('demo failed');
      await this.loadBooks?.({ fresh: true });
      window.location.hash = '#book/' + data.bookId;
      return true;
    } catch {
      return false;
    } finally {
      this.demoBookBusy = false;
    }
  },

  // Welcome-Link «Wie funktioniert …» → Hilfe auf dem Funktionsüberblick,
  // unabhängig vom Ungelesen-Stand der Neuigkeiten.
  openHelpFeatures() {
    this.$store.shell.helpTabRequest = 'features';
    if (!this.showHelpCard) this.toggleHelpCard();
  },

  // Welcome-Karte: Beispielbuch anlegen; Fehler als Status-Toast (die Karte
  // «Erste Schritte» zeigt ihn stattdessen inline, siehe onboarding-card.js).
  async importDemoBookFromWelcome() {
    if (!await this.importDemoBook()) this.setStatus(this.t('onboarding.demoError'), false, 6000);
  },
};
