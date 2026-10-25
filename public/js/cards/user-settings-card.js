// Alpine.data('userSettingsCard') — Sub-Komponente der Benutzer-Einstellungen
// (Profil, Default-Präferenzen). Fachlicher State lebt hier,
// `showUserSettingsCard` + `toggleUserSettingsCard` im Root. Daten werden nur
// beim erstmaligen Öffnen nachgeladen (user-bound, nicht buch-bound) — kein
// book:changed-Hook nötig.

import { userSettingsMethods } from '../user-settings.js';
import { aiAccessState, aiAccessMethods } from '../user-settings-ai-access.js';
import { EVT } from '../events.js';
import { takeCardRequest, CARD_REQUEST } from './card-request.js';
import { scrollToWhenReady } from '../app/app-navigation.js';

export function registerUserSettingsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('userSettingsCard', () => ({
    userSettingsProfile: null,
    userSettingsDefaultLanguage: '',
    userSettingsDefaultRegion: '',
    userSettingsDefaultBuchtyp: '',
    userSettingsFocusGranularity: 'paragraph',
    userSettingsDailyGoal: 0,
    userSettingsLoading: false,
    userSettingsSaving: false,
    userSettingsSaved: false,
    userSettingsError: '',
    dictEntries: [],
    dictFilter: '',
    // Abgeschaltete LanguageTool-Regeln (routes/languagetool.js#/rules)
    ltRuleEntries: [],
    // Device-Tokens (native Clients, z.B. Mac-Focus-Writer)
    deviceTokensList: [],
    deviceTokensLoading: false,
    deviceTokensCreating: false,
    deviceTokensError: '',
    deviceTokensNewName: '',
    // 'device' = native Clients (volle Rechte), 'capture' = Browser-Erweiterung
    // (darf nur erfassen). Serverseitige Wahrheit: lib/device-scopes.js.
    deviceTokensNewKind: 'device',
    deviceTokensJustCreated: null,
    // Konto-Selbstloeschung (DELETE /me/account, Guideline 5.1.1(v))
    accountDeleting: false,
    accountDeleteError: '',
    // macOS-App (schreibwerkstatt-focuseditor): storeUrl = Mac App Store
    // (einziger Installationsweg), available/version = freigegebene Store-Version
    macRelease: { available: false, storeUrl: '' },
    // Android-App-Download (schreibwerkstatt-mobile)
    androidRelease: { available: false },
    // Chrome-Erweiterung (schreibwerkstatt-browser-extension): storeUrl = Chrome
    // Web Store (regulaerer Weg), available/zip = ZIP-Release als Zweitweg
    extensionRelease: { available: false, storeUrl: '' },
    // Eigener KI-Zugang (routes/me-ai-access.js)
    ...aiAccessState(),
    _savedAtTimer: null,

    get dictEntriesFiltered() {
      const q = (this.dictFilter || '').trim().toLowerCase();
      if (!q) return this.dictEntries;
      return this.dictEntries.filter(e => (e.word || '').toLowerCase().includes(q));
    },

    // Buchname zum Woerterbuch-/Regel-Eintrag mit Buch-Scope.
    ltScopeLabel(bookId) {
      if (!bookId) return this.$app.t('spellcheck.dict.scope_global');
      const b = (this.$store.nav.books || []).find(x => String(x.id) === String(bookId));
      return b ? b.name : this.$app.t('spellcheck.dict.scope_book');
    },

    _onViewReset: null,
    _onCardRequest: null,
    _loadingAll: false,

    init() {
      this.$watch(() => window.__app.showUserSettingsCard, async (visible) => {
        if (!visible) return;
        this._loadingAll = true;
        try {
          await this._loadAll();
        } finally {
          this._loadingAll = false;
        }
        this._applySectionRequest();
      });

      this._onViewReset = () => {
        this.userSettingsSaved = false;
        this.userSettingsError = '';
      };
      window.addEventListener(EVT.VIEW_RESET, this._onViewReset);

      // Sprung auf einen Abschnitt (Command-Palette). Öffnet der Sprung die
      // Karte erst, holt der Lade-Watcher oben den Wunsch nach dem Laden ab —
      // vorher steht das Formular hinter `userSettingsLoading` und ist unsichtbar.
      this._onCardRequest = async (e) => {
        if (e.detail?.key !== CARD_REQUEST.USER_SETTINGS_SECTION) return;
        await this.$nextTick();
        if (!this._loadingAll) this._applySectionRequest();
      };
      window.addEventListener(EVT.CARD_REQUEST, this._onCardRequest);
    },

    async _loadAll() {
      await this.loadUserSettings();
      await this.loadDictEntries();
      await this.loadLtRules();
      await this.loadAiAccess();
      await this.loadDeviceTokens();
      await this.loadMacRelease();
      await this.loadAndroidRelease();
      await this.loadExtensionRelease();
    },

    // Abschnitte tragen `data-settings-section`; bei mehreren Zeilen (Apps)
    // zählt die erste sichtbare. Der Abschnitt klappt auf, gescrollt wird auf
    // seine Kopfzeile — das Panel darunter kann höher als das Fenster sein.
    async _applySectionRequest() {
      const section = takeCardRequest(CARD_REQUEST.USER_SETTINGS_SECTION);
      if (!section) return;
      await this.$nextTick();
      const row = [...this.$el.querySelectorAll(`[data-settings-section="${section}"]`)]
        .find(el => el.offsetParent !== null);
      // Abschnitt gibt es hier nicht (z.B. KI-Zugang vom Admin zu): dann
      // wenigstens den Karten-Anfang zeigen, den der Toggle übersprungen hat.
      if (!row) { window.__app?._scrollToCardByKey?.('userSettings'); return; }
      const panel = window.Alpine.$data(row);
      if (panel && 'open' in panel) panel.open = true;
      scrollToWhenReady(() => row.querySelector('.collapsible-toggle') || row);
    },

    async loadDictEntries() {
      if (!this.$store.config.languagetoolEnabled) { this.dictEntries = []; return; }
      try {
        const r = await fetch('/dictionary', { credentials: 'same-origin' });
        if (!r.ok) { this.dictEntries = []; return; }
        const j = await r.json();
        this.dictEntries = Array.isArray(j.entries) ? j.entries : [];
      } catch { this.dictEntries = []; }
    },

    async removeDictEntry(entry) {
      if (!entry || !entry.word) return;
      try {
        await fetch('/dictionary', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ word: entry.word, bookId: entry.book_id, lang: entry.lang }),
        });
      } catch {}
      await this.loadDictEntries();
    },

    async loadLtRules() {
      if (!this.$store.config.languagetoolEnabled) { this.ltRuleEntries = []; return; }
      try {
        const r = await fetch('/languagetool/rules', { credentials: 'same-origin' });
        if (!r.ok) { this.ltRuleEntries = []; return; }
        const j = await r.json();
        this.ltRuleEntries = Array.isArray(j.entries) ? j.entries : [];
      } catch { this.ltRuleEntries = []; }
    },

    async removeLtRule(entry) {
      if (!entry || !entry.rule_id) return;
      try {
        await fetch('/languagetool/rules', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ ruleId: entry.rule_id, bookId: entry.book_id }),
        });
      } catch {}
      await this.loadLtRules();
    },

    destroy() {
      if (this._savedAtTimer) { clearTimeout(this._savedAtTimer); this._savedAtTimer = null; }
      if (this._onViewReset) window.removeEventListener(EVT.VIEW_RESET, this._onViewReset);
      if (this._onCardRequest) window.removeEventListener(EVT.CARD_REQUEST, this._onCardRequest);
    },

    ...userSettingsMethods,
    ...aiAccessMethods,
  }));
}
