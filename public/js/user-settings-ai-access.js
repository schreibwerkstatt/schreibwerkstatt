// Eigener KI-Zugang im Profil (Claude oder OpenAI-kompatibel). Methoden werden in
// Alpine.data('userSettingsCard') gespreadet. Server: routes/me-ai-access.js —
// der API-Key kommt nie zurueck, nur `has_api_key`.

import { fetchJson, sendJson } from './utils.js';
import { tFetchErrorRaw } from './i18n.js';

// Protokollwert: „gespeicherten Key behalten" (wie bei den Admin-KI-Profilen).
const KEY_UNCHANGED = '__unchanged__';

function _emptyForm() {
  return {
    provider: 'claude', host: '', model: '', api_key: '',
    cloud: true, context_window: null, max_tokens_out: null,
  };
}

function _formFrom(access) {
  if (!access) return _emptyForm();
  return {
    provider: access.provider,
    host: access.host || '',
    model: access.model || '',
    api_key: '',
    cloud: access.cloud !== false,
    context_window: access.context_window || null,
    max_tokens_out: access.max_tokens_out || null,
  };
}

export const aiAccessState = () => ({
  aiAccessEnabled: false,
  aiAccessStored: false,
  aiAccess: null,
  aiAccessForm: _emptyForm(),
  aiAccessBusy: false,
  aiAccessError: '',
  aiAccessSaved: false,
});

export const aiAccessMethods = {
  _aiAccessApply(j) {
    this.aiAccessEnabled = !!j?.enabled;
    this.aiAccess = j?.access || null;
    this.aiAccessStored = !!(j?.access || j?.stored);
    this.aiAccessForm = _formFrom(this.aiAccess);
  },

  async loadAiAccess() {
    this.aiAccessError = '';
    this.aiAccessSaved = false;
    try {
      this._aiAccessApply(await fetchJson('/me/ai-access'));
    } catch {
      this.aiAccessEnabled = false;
      this.aiAccessStored = false;
      this.aiAccess = null;
    }
  },

  // Liegt fuer DIESEN Provider ein Key? Ein Provider-Wechsel verlangt einen neuen.
  aiAccessKeyStored() {
    return !!(this.aiAccess?.has_api_key && this.aiAccess.provider === this.aiAccessForm.provider);
  },

  async aiAccessSave() {
    this.aiAccessBusy = true;
    this.aiAccessError = '';
    this.aiAccessSaved = false;
    const f = this.aiAccessForm;
    const key = String(f.api_key || '').trim();
    try {
      const j = await sendJson('/me/ai-access', 'PUT', {
        provider: f.provider,
        host: f.provider === 'openai-compat' ? String(f.host || '').trim() : null,
        model: String(f.model || '').trim(),
        api_key: key || (this.aiAccessKeyStored() ? KEY_UNCHANGED : ''),
        cloud: f.provider === 'openai-compat' ? !!f.cloud : null,
        context_window: f.context_window || null,
        max_tokens_out: f.max_tokens_out || null,
      });
      this._aiAccessApply(j);
      this.aiAccessSaved = true;
      // Provider/Modell aendern Feature-Gates (/config: effektiver Provider + Klasse).
      await this._aiAccessRefreshConfig();
    } catch (e) {
      this.aiAccessError = tFetchErrorRaw(e);
    } finally {
      this.aiAccessBusy = false;
    }
  },

  // Provider/Modell bestimmen Feature-Gates aus /config (effektiver Provider +
  // Klasse, Recherche-Chat). Die direkt sichtbaren Felder sofort nachziehen; alle
  // uebrigen Gates greifen nach dem naechsten Neuladen (sagt der Speicher-Hinweis).
  async _aiAccessRefreshConfig() {
    try {
      const cfg = await fetchJson('/config?__fresh=1');
      const c = this.$store.config;
      if (cfg.effectiveProvider) c.effectiveProvider = cfg.effectiveProvider;
      if (cfg.effectiveProviderClass) c.effectiveProviderClass = cfg.effectiveProviderClass;
      if (cfg.claudeModel) c.claudeModel = cfg.claudeModel;
      if (cfg.openaiCompatModel) c.openaiCompatModel = cfg.openaiCompatModel;
      c.researchChatEnabled = !!cfg.researchChat?.enabled;
    } catch { /* Anzeige bleibt bis zum Neuladen beim alten Stand */ }
  },

  async aiAccessRemove() {
    if (!await window.__app.appConfirm({ message: window.__app.t('profile.aiAccess.confirmRemove'), danger: true })) return;
    this.aiAccessBusy = true;
    this.aiAccessError = '';
    this.aiAccessSaved = false;
    try {
      this._aiAccessApply(await sendJson('/me/ai-access', 'DELETE'));
      await this._aiAccessRefreshConfig();
    } catch (e) {
      this.aiAccessError = tFetchErrorRaw(e);
    } finally {
      this.aiAccessBusy = false;
    }
  },
};
