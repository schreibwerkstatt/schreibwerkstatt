// Root-Methoden fuer das Onboarding: First-Login-Willkommens-Banner, Beispielbuch-
// Import, Manuskript-Import und Hilfe-Einstieg (von der Welcome-Karte genutzt)
// sowie der Sprung ins erste Lektorat (Etappe «lektorat» der Checkliste). Die
// eigentliche „Erste Schritte"-Karte lebt in cards/onboarding-card.js; hier nur
// der buch-unabhaengige Banner-State am Root (onboardingWelcome) + sein Loader
// und die zwei Banner-Aktionen. Persistiert wird das Wegklicken serverseitig
// (app_users.onboarding_state.welcomeDismissed) via PATCH /me/onboarding.
import { sendJson } from '../utils.js';
import { openCardWith, CARD_REQUEST } from '../cards/card-request.js';

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
      await sendJson('/me/onboarding', 'PATCH', { welcomeDismissed: true });
    } catch (e) {
      // non-fatal — Banner bleibt lokal ausgeblendet, kommt nach Reload wieder.
      console.warn('[onboarding] dismiss', e);
    }
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

  // Hilfe auf einem bestimmten Reiter öffnen ('features' | 'changelog'),
  // unabhängig vom Ungelesen-Stand der Neuigkeiten: Welcome-Link «Wie
  // funktioniert …», Versionszeile im Avatar-Menü, Palette.
  openHelpTab(tab) {
    return openCardWith(CARD_REQUEST.HELP_TAB, tab, () => (this.showHelpCard ? null : this.toggleHelpCard()));
  },

  // Welcome-Karte: Import-Karte auf «Manuskript» öffnen. Ohne Buch steht sie
  // im Modus «neues Buch» (folder-import-card.js#onShow); der Job navigiert
  // nach dem Import selbst ins angelegte Buch.
  openManuscriptImport() {
    return openCardWith(CARD_REQUEST.IMPORT_KIND_TAB, 'manuscript',
      () => (this.showFolderImportCard ? null : this.toggleFolderImportCard()));
  },

  // «Erste Schritte», Etappe «Ersten Abschnitt lektorieren»: einen Abschnitt
  // mit Text öffnen (den offenen, sonst den ersten mit Text in Buch-Reihenfolge)
  // und dort das Lektorat starten. Startet nur, wenn der Abschnitt wirklich
  // geladen, nicht leer und das Lektorat erlaubt ist; sonst bleibt der
  // Abschnitt offen und der User sieht den Lektorat-Knopf selbst. Ohne
  // Abschnitte geht es in die Buch-Übersicht (dort entsteht der erste).
  async startFirstLektorat() {
    const pages = this.$store.nav.pages || [];
    const hasText = (p) => (this.tokEsts?.[p.id]?.chars || 0) > 0;
    const cur = this.currentPage && pages.find(p => p.id === this.currentPage.id);
    const target = (cur && hasText(cur) ? cur : null) || pages.find(hasText) || cur || pages[0];
    if (!target) { this.toggleBookOverviewCard?.(); return; }
    await this.selectPage(target);
    if (this.currentPage?.id !== target.id || this.currentPageEmpty) return;
    if (this.editMode || this.focusActive || this.checkLoading) return;
    if (this.canReview?.() === false) return;
    await this.runCheck?.();
  },

  // Welcome-Karte: Beispielbuch anlegen; Fehler als Status-Toast (die Karte
  // «Erste Schritte» zeigt ihn stattdessen inline, siehe onboarding-card.js).
  async importDemoBookFromWelcome() {
    if (!await this.importDemoBook()) this.setStatus(this.t('onboarding.demoError'), false, 6000);
  },
};
