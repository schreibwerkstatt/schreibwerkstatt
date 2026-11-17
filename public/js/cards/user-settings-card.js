// Alpine.data('userSettingsCard') — Sub-Komponente von «Profil & Einstellungen».
// Reiter wie die Bucheinstellungen: Allgemein · Geräte · KI-Zugang · Wörterbuch
// · Gefahrenzone (Liste: URL_TABS.userSettings in card-request.js). Fachlicher
// State lebt hier, `showUserSettingsCard` + `toggleUserSettingsCard` im Root.
// Daten werden beim Öffnen geladen (user-bound, nicht buch-bound) — kein
// book:changed-Hook nötig.

import { userSettingsMethods } from '../user-settings.js';
import { aiAccessState, aiAccessMethods } from '../user-settings-ai-access.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { CARD_REQUEST } from './card-request.js';
import { registerBusySource } from '../app/boot/update-policy.js';
import { isSpellerRuleId } from './editor-spellcheck/categories.js';
import { fmtDateTime } from '../utils.js';

export function registerUserSettingsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('userSettingsCard', () => ({
    userSettingsTab: 'general',
    // Erst nach dem vollständigen Laden steht fest, welche Reiter es gibt
    // (KI-Zugang hängt an /me/ai-access) — vorher fiele ein Deep-Link auf
    // `#profil/ai` auf «Allgemein» zurück.
    _tabsReady: false,
    // Ungespeichertes in «Allgemein» (user-settings.js#userSettingsDirty).
    _generalBaseline: null,
    _settling: null,
    _unregisterBusy: null,
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

    // Zeitpunkt, an dem ein Wort ins Wörterbuch kam bzw. eine Regel aus ging.
    ltEntryDate(iso) {
      return fmtDateTime(iso, this.$store.shell.uiLocale);
    },

    ltIsSpellerRule(ruleId) { return isSpellerRuleId(ruleId); },

    // Was das Ausschalten bewirkt: bei der Rechtschreibregel die ganze
    // Rechtschreibprüfung, sonst nur die Befunde dieser einen Regel.
    ltRuleMeaning(e) {
      const where = e.book_id
        ? this.$app.t('spellcheck.rules.whereBook', { book: this.ltScopeLabel(e.book_id) })
        : this.$app.t('spellcheck.rules.whereAll');
      return isSpellerRuleId(e.rule_id)
        ? this.$app.t('spellcheck.rules.meaningSpeller', { where })
        : this.$app.t('spellcheck.rules.meaning', { where });
    },

    _onViewReset: null,
    _lifecycle: null,

    init() {
      this._onViewReset = () => {
        this.userSettingsSaved = false;
        this.userSettingsError = '';
      };
      // Benutzerbezogen, nicht buchbezogen: kein Reset/Reload beim Buchwechsel.
      // Reiter-Wunsch (Palette, Permalink `#profil/<reiter>`) holt der Lifecycle.
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showUserSettingsCard',
        showNeedsBookId: false,
        onShow: async () => {
          this._tabsReady = false;
          try { await this._loadAll(); } finally { this._tabsReady = true; }
          this._ensureTabAvailable();
        },
        onHide: () => this._settleUnsavedGeneral(),
        onViewReset: () => this._onViewReset(),
        tabRequest: { key: CARD_REQUEST.USER_SETTINGS_TAB, apply: (tab) => { this.userSettingsTab = tab; }, current: () => this.userSettingsTab },
        extraListeners: [{
          // Reload/Tab-Close mit Ungespeichertem: native Rückfrage
          // (appConfirm geht in beforeunload nicht — der Browser blockt Modals).
          type: 'beforeunload',
          handler: (e) => {
            if (!window.__app?.showUserSettingsCard || !this.userSettingsDirty()) return;
            e.preventDefault();
            e.returnValue = '';
          },
        }],
      });
      // Ungespeichertes zählt als ungespeicherte Arbeit: ein Pflicht-Update der
      // Shell lädt den Tab dann nicht neu.
      this._unregisterBusy = registerBusySource(() => this.userSettingsDirty() || this.userSettingsSaving);
      // Reiter, dessen Knopf mit der Admin-Freigabe verschwindet, darf nicht
      // aktiv bleiben — sonst stünde sein Panel ohne Reiter da.
      this.$watch(() => [this.userSettingsTab, this.aiAccessEnabled, this.aiAccessStored,
        this.$store.config.languagetoolEnabled], () => this._ensureTabAvailable());
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

    // KI-Zugang: offen, solange der Admin das Feature freigibt oder noch ein
    // Zugang liegt, den der User entfernen können soll. Wörterbuch: nur mit
    // LanguageTool.
    _tabAvailable(tab) {
      if (tab === 'ai') return !!(this.aiAccessEnabled || this.aiAccessStored);
      if (tab === 'dict') return !!this.$store.config.languagetoolEnabled;
      return true;
    },

    _ensureTabAvailable() {
      if (!this._tabsReady) return;
      if (!this._tabAvailable(this.userSettingsTab)) this.userSettingsTab = 'general';
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
      this._unregisterBusy?.();
      this._lifecycle?.destroy();
    },

    ...userSettingsMethods,
    ...aiAccessMethods,
  }));
}
