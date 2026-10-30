// Alpine.store('hints') — einmalige Feature-Tipps (`.feature-tip`, DESIGN.md
// „Feature-Tipp"): Ideen-Board → Ideen-Chat, Buchorganizer → Buch-Chat,
// Übersicht → «Nächste Schritte». Weggeklickt wird serverseitig pro User
// (app_users.onboarding_state.hints über PATCH /me/onboarding { dismissHint }),
// damit ein Tipp auf jedem Gerät weg bleibt.
//
// Geladen zusammen mit dem Welcome-Banner (app-onboarding.js#_loadOnboardingWelcome,
// eine Anfrage). Bis dahin ist kein Tipp offen — sonst blitzte ein schon
// weggeklickter Tipp beim Start kurz auf.

export function registerHintsStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('hints', {
    loaded: false,
    dismissed: {},

    setDismissed(keys) {
      const next = {};
      for (const k of Array.isArray(keys) ? keys : []) next[k] = true;
      this.dismissed = next;
      this.loaded = true;
    },

    isOpen(key) {
      return this.loaded && !this.dismissed[key];
    },

    async dismiss(key) {
      this.dismissed = { ...this.dismissed, [key]: true };
      try {
        await fetch('/me/onboarding', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dismissHint: key }),
        });
      } catch { /* non-fatal — lokal bleibt der Tipp weg */ }
    },
  });
}
