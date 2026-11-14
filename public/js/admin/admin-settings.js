// AdminSettingsCard-Methods.

import { formatNum } from '../num-input.js';
import { localeTag, fetchJson, sendJson } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { ADMIN_SETTINGS_TABS, ADMIN_SETTINGS_TEST_TAB } from './admin-settings-tabs.js';
import { adminFmtDateTime } from './admin-format.js';

// Formularwert eines Felds → gewünschte Aktion beim Speichern.
//   { op: 'none' }            nichts zu tun
//   { op: 'set', value }      Wert schreiben
//   { op: 'reset' }           auf Registry-Default zurück (DB-Zeile weg)
// Leeres Zahlenfeld heisst «Standard» (nicht 0); leeres Secret heisst
// «unverändert», ausser der Admin hat es ausdrücklich zum Löschen markiert.
function _isNumKey(s) {
  return typeof s.value === 'number' || typeof s.default === 'number';
}
function _same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export const adminSettingsMethods = {
  async adminSettingsLoad() {
    if (this.adminSettingsLoading) return;
    this.adminSettingsLoading = true;
    this.adminSettingsError = '';
    try {
      const data = await fetchJson('/admin/settings');
      const map = {};
      for (const s of data.settings) {
        map[s.key] = s;
      }
      this.adminSettingsMap = map;
      this.adminSettingsAuth = data.auth || { own_has_password: false, env_admin: false };
      // Form-State aus map kopieren — Form-Inputs schreiben in form, Save
      // diff't vs. map und sendet nur geaenderte Keys ans Backend.
      this.adminSettingsForm = this._adminSettingsBuildForm(map);
      this.adminSettingsPendingReset = {};
      // Provider-Unterreiter nur beim ersten Laden auf den aktiven Provider
      // stellen — ein Neu-Laden (auch nach dem Speichern) behält den Reiter.
      if (!this.adminSettingsLoadedOnce) {
        const cur = this.adminSettingsForm['ai.provider'];
        if (cur === 'claude' || cur === 'ollama' || cur === 'openai-compat') {
          this.adminSettingsProviderSubtab = cur;
        }
        this.adminSettingsLoadedOnce = true;
      }
    } catch (e) {
      this.adminSettingsError = tFetchError(e);
    } finally {
      this.adminSettingsLoading = false;
    }
  },

  _adminSettingsBuildForm(map) {
    const form = {};
    for (const key of Object.keys(map)) {
      const s = map[key];
      // Encrypted: leerer String; leer gespeichert heisst „unverändert".
      form[key] = s.encrypted ? '' : (s.value ?? '');
    }
    return form;
  },

  // Gewünschte Aktion je Key (siehe _isNumKey/_same oben).
  _adminSettingsIntent(key) {
    const s = this.adminSettingsMap[key];
    if (!s) return { op: 'none' };
    const raw = this.adminSettingsForm[key];
    const pending = !!this.adminSettingsPendingReset[key];
    if (s.encrypted) {
      if (raw !== '' && raw != null) return { op: 'set', value: raw };
      return pending && !s.isDefault ? { op: 'reset' } : { op: 'none' };
    }
    let value;
    if (_isNumKey(s)) {
      if (raw === null || raw === undefined || raw === '') {
        return s.isDefault ? { op: 'none' } : { op: 'reset' };
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) return { op: 'none' };
      value = n;
    } else if (typeof s.value === 'boolean' || typeof s.default === 'boolean') {
      value = raw === true || raw === 'true';
    } else {
      value = raw ?? '';
    }
    if (pending && _same(value, s.default ?? '')) return s.isDefault ? { op: 'none' } : { op: 'reset' };
    return _same(value, s.value ?? '') ? { op: 'none' } : { op: 'set', value };
  },

  adminSettingsIsDirty(key) {
    return this._adminSettingsIntent(key).op !== 'none';
  },

  adminSettingsHasChanges() {
    return Object.keys(this.adminSettingsMap || {}).some(k => this.adminSettingsIsDirty(k));
  },

  // true = weitermachen (nichts offen oder Verwerfen bestätigt).
  async adminSettingsConfirmDiscard() {
    if (!this.adminSettingsHasChanges()) return true;
    const app = window.__app;
    return !!(await app.appConfirm({
      message: app.t('admin.settings.discardConfirm'),
      confirmLabel: app.t('admin.settings.discard'),
      danger: true,
    }));
  },

  async adminSettingsReload() {
    if (!(await this.adminSettingsConfirmDiscard())) return;
    await this.adminSettingsLoad();
  },

  // Zustandszeile eines Felds (setting-field.js): 'reset' | 'unsaved' | 'changed' | ''.
  adminSettingsFieldState(key) {
    const s = this.adminSettingsMap?.[key];
    if (!s) return '';
    const op = this._adminSettingsIntent(key).op;
    if (op === 'reset') return 'reset';
    if (op === 'set') return 'unsaved';
    return s.isDefault ? '' : 'changed';
  },

  adminSettingsFieldTip(key) {
    const s = this.adminSettingsMap?.[key];
    if (!s || s.isDefault || !s.updated_at) return null;
    return window.__app.t('admin.settings.field.changedTip', {
      by: s.updated_by || '—',
      at: adminFmtDateTime(s.updated_at),
    });
  },

  // «Auf Standard zurücksetzen» anbieten: gespeicherter Wert weicht vom Standard
  // ab und ist noch nicht zum Zurücksetzen markiert — oder das Feld ist
  // ungespeichert verändert (dann setzt der Knopf auf den Standard zurück).
  adminSettingsCanReset(key) {
    const s = this.adminSettingsMap?.[key];
    if (!s) return false;
    const op = this._adminSettingsIntent(key).op;
    if (op === 'reset') return false;
    if (s.encrypted) return !s.isDefault;
    return !s.isDefault || op === 'set';
  },

  adminSettingsResetField(key) {
    const s = this.adminSettingsMap?.[key];
    if (!s) return;
    this.adminSettingsPendingReset = { ...this.adminSettingsPendingReset, [key]: true };
    this.adminSettingsForm[key] = s.encrypted ? '' : (s.default ?? '');
  },

  // Speichern = EIN Request (PUT /admin/settings): der Server prüft alle Werte,
  // bevor er einen schreibt; ein Fehler nennt den Key und lässt nichts halb
  // gespeichert zurück. Danach neu laden (Masken, Standard-Marker).
  async adminSettingsSave() {
    if (this.adminSettingsSaving) return;
    this.adminSettingsSaving = true;
    this.adminSettingsError = '';
    this.adminSettingsSaved = false;
    const values = {};
    const reset = [];
    for (const key of Object.keys(this.adminSettingsMap)) {
      const intent = this._adminSettingsIntent(key);
      if (intent.op === 'set') values[key] = intent.value;
      else if (intent.op === 'reset') reset.push(key);
    }
    const count = Object.keys(values).length + reset.length;
    try {
      if (count) await sendJson('/admin/settings', 'PUT', { values, reset });
      this.adminSettingsSavedCount = count;
      this.adminSettingsSaved = true;
      setTimeout(() => { this.adminSettingsSaved = false; }, 2500);
      await this.adminSettingsLoad();
    } catch (e) {
      this.adminSettingsError = tFetchError(e);
    } finally {
      this.adminSettingsSaving = false;
    }
  },

  // Wechsel auf lokale Anmeldung vorbereitet, eigenes Passwort fehlt, kein
  // ENV-Notfallzugang: der Server würde das Speichern ablehnen.
  adminSettingsNeedsOwnPassword() {
    return this.adminSettingsForm['auth.method'] === 'local'
      && this.adminSettingsMap['auth.method']?.value !== 'local'
      && !this.adminSettingsAuth?.own_has_password
      && !this.adminSettingsAuth?.env_admin;
  },

  async adminSettingsSetOwnPassword() {
    const me = Alpine.store('session').currentUser?.email;
    const password = this.adminSettingsOwnPassword;
    if (!me || !password || this.adminSettingsOwnPasswordBusy) return;
    this.adminSettingsOwnPasswordBusy = true;
    this.adminSettingsError = '';
    try {
      await sendJson(`/admin/users/${encodeURIComponent(me)}/password`, 'POST', { password });
      this.adminSettingsOwnPassword = '';
      this.adminSettingsAuth = { ...this.adminSettingsAuth, own_has_password: true };
    } catch (e) {
      this.adminSettingsError = tFetchError(e);
    } finally {
      this.adminSettingsOwnPasswordBusy = false;
    }
  },

  // Formularwerte des sichtbaren Provider-Unterreiters (auch ungespeichert)
  // für den Verbindungstest. Secrets nur, wenn neu eingetippt — sonst nimmt
  // der Server den gespeicherten Wert.
  _adminSettingsProviderValues(provider) {
    const out = {};
    const prefix = `ai.${provider}.`;
    for (const [key, raw] of Object.entries(this.adminSettingsForm)) {
      if (!key.startsWith(prefix)) continue;
      const s = this.adminSettingsMap[key];
      if (s?.encrypted) { if (raw) out[key] = raw; continue; }
      out[key] = raw;
    }
    return out;
  },

  async adminSettingsTest(kind) {
    const path = kind === 'provider'     ? '/admin/settings/test-provider'
               : kind === 'oauth'        ? '/admin/settings/test-oauth'
               : kind === 'smtp'         ? '/admin/settings/smtp/test-send'
               : kind === 'languagetool' ? '/admin/settings/test-languagetool'
               : kind === 'stt'          ? '/admin/settings/test-stt'
               : kind === 'tts'          ? '/admin/settings/test-tts'
               : kind === 'image'        ? '/admin/settings/test-image'
               : kind === 'embed'        ? '/admin/settings/test-embed'
               : kind === 'rerank'       ? '/admin/settings/test-rerank'
               : kind === 'geocode'      ? '/admin/settings/test-geocode'
               : kind === 'tiles'        ? '/admin/settings/test-tiles'
               : kind === 'websearch'    ? '/admin/settings/test-websearch'
               : null;
    if (!path) return;
    let body;
    if (kind === 'smtp') body = {};
    if (kind === 'provider') {
      const provider = this.adminSettingsProviderSubtab;
      body = { provider, values: this._adminSettingsProviderValues(provider) };
    }
    this.adminSettingsTestResult = { kind, running: true };
    try {
      // Bewusst roher fetch: die Test-Endpunkte liefern ihr Ergebnis
      // ({ ok, error, … }) auch mit Fehler-Status als Body — der wird angezeigt.
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json();
      this.adminSettingsTestResult = { kind, ...j, running: false };
    } catch (e) {
      this.adminSettingsTestResult = { kind, ok: false, error: 'NETWORK', running: false };
    }
  },

  adminSettingsTestVisible() {
    const r = this.adminSettingsTestResult;
    return !!r && ADMIN_SETTINGS_TEST_TAB[r.kind] === this.adminSettingsTab;
  },

  // Fehlercode einer Verbindungsprobe → Satz. Codes kommen aus den test-*-Routen
  // (UPPER_SNAKE), dem Mailer (kebab-case) oder als HTTP_<status>.
  adminSettingsTestErrorText(r) {
    const t = window.__app.t.bind(window.__app);
    const raw = String(r?.error || '');
    if (!raw) return '';
    const http = /^HTTP_(\d+)$/.exec(raw);
    if (http) return t('admin.settings.test.error.HTTP', { status: http[1] });
    const code = raw.toUpperCase().replace(/-/g, '_');
    const key = `admin.settings.test.error.${code}`;
    const msg = t(key, { missing: (r.missing || []).join(', ') });
    return msg === key ? t('admin.settings.test.error.OTHER', { code: raw }) : msg;
  },

  // Einziger Setter des Reiters: Tab-Leiste (x-model der tabs()-Instanz),
  // Permalink/Palette (tabRequest) und Tests gehen hierüber; der Nachlade-Effekt
  // hängt zusätzlich am $watch in der Karte, damit kein Weg ihn umgeht.
  adminSettingsSwitchTab(tab) {
    if (!ADMIN_SETTINGS_TABS.includes(tab)) return;
    this.adminSettingsTab = tab;
    this._adminSettingsOnTab(tab);
  },

  _adminSettingsOnTab(tab) {
    if (tab === 'api' && !this.adminApiTokensLoaded) {
      this.adminApiTokensLoad();
    }
  },

  // ── API-Tokens (Tab `api`) ──────────────────────────────────────────────
  // Plain-Token wird vom Server NUR einmal nach POST zurueckgegeben und im
  // Frontend in `adminApiTokensJustCreated` zwischengespeichert, bis der
  // User ihn ueber „Verbergen" wegklickt. DB speichert nur den SHA-256-Hash.

  async adminApiTokensLoad() {
    if (this.adminApiTokensLoading) return;
    this.adminApiTokensLoading = true;
    this.adminApiTokensError = '';
    try {
      const data = await fetchJson('/admin/api-tokens');
      this.adminApiTokensList = Array.isArray(data.tokens) ? data.tokens : [];
      this.adminApiTokensLoaded = true;
    } catch (e) {
      this.adminApiTokensError = tFetchError(e);
    } finally {
      this.adminApiTokensLoading = false;
    }
  },

  async adminApiTokensCreate() {
    const name = (this.adminApiTokensNewName || '').trim();
    if (!name) {
      this.adminApiTokensError = window.__app.t('admin.settings.api.errorNameRequired');
      return;
    }
    this.adminApiTokensCreating = true;
    this.adminApiTokensError = '';
    try {
      const body = { display_name: name };
      if (this.adminApiTokensNewExpiresAt) body.expires_at = this.adminApiTokensNewExpiresAt;
      if (this.adminApiTokensNewIncludeUsers) body.include_users = true;
      const j = await sendJson('/admin/api-tokens', 'POST', body);
      this.adminApiTokensJustCreated = j;
      this.adminApiTokensNewName = '';
      this.adminApiTokensNewExpiresAt = '';
      this.adminApiTokensNewIncludeUsers = false;
      await this.adminApiTokensLoad();
    } catch (e) {
      this.adminApiTokensError = tFetchError(e);
    } finally {
      this.adminApiTokensCreating = false;
    }
  },

  async adminApiTokensRevoke(id) {
    if (!await window.__app.appConfirm({ message: window.__app.t('admin.settings.api.confirmRevoke'), danger: true })) return;
    try {
      await sendJson(`/admin/api-tokens/${id}/revoke`, 'POST');
      await this.adminApiTokensLoad();
    } catch (e) {
      this.adminApiTokensError = tFetchError(e);
    }
  },

  async adminApiTokensDelete(id) {
    if (!await window.__app.appConfirm({ message: window.__app.t('admin.settings.api.confirmDelete'), danger: true })) return;
    try {
      await sendJson(`/admin/api-tokens/${id}`, 'DELETE');
      await this.adminApiTokensLoad();
    } catch (e) {
      this.adminApiTokensError = tFetchError(e);
    }
  },

  adminApiTokensDismissPlain() {
    this.adminApiTokensJustCreated = null;
  },

  // Wie viele Claude-Werte im eingeklappten „Erweitert"-Bereich weichen vom
  // Standard ab (Per-Job-Modell, explizites Limit/Timeout)? Der Zähler steht am
  // Toggle, damit eine aktive Abweichung nicht hinter dem Einklappen verschwindet.
  adminClaudeOverrideCount() {
    const keys = [
      'ai.claude.model.lektorat', 'ai.claude.model.komplett', 'ai.claude.model.komplett.extract',
      'ai.claude.model.bookchat', 'ai.claude.model.synonym', 'ai.claude.model.finetune', 'ai.claude.context_window', 'ai.claude.max_tokens_out',
      'ai.claude.context_window.komplett', 'ai.claude.max_tokens_out.komplett', 'ai.claude.timeout_ms.komplett',
      'ai.claude.context_window.bookchat', 'ai.claude.max_tokens_out.bookchat', 'ai.claude.timeout_ms.bookchat',
    ];
    // Ein mitgelieferter Default (z.B. Haiku für den Fine-Tuning-Export) ist
    // keine Abweichung des Admins — gezählt wird erst ein gesetzter Wert.
    return keys.filter(k => {
      const v = this.adminSettingsForm?.[k];
      if (this.adminSettingsMap?.[k]?.isDefault && !this.adminSettingsIsDirty(k)) return false;
      return typeof v === 'string' ? v.trim() !== '' : Number(v) > 0;
    }).length;
  },


  // Spiegelt die Budget-Ableitung aus lib/ai.js (getContextConfigFor) +
  // routes/jobs/shared/loader.js (chunkLimitsFor) im Frontend, damit der Admin
  // schon beim Tippen sieht, wie das Kontextfenster die Komplettanalyse-Pässe
  // skaliert. Reiner Schätzwert (charsPerToken provider-typisch) — die echte
  // Quelle bleibt der Server. Liefert null, wenn context_window noch ungültig.
  adminSettingsBudget(provider) {
    const p = (provider === 'claude' || provider === 'ollama' || provider === 'openai-compat') ? provider : 'claude';
    const ctx = Number(this.adminSettingsForm[`ai.${p}.context_window`]);
    if (!Number.isFinite(ctx) || ctx <= 0) return null;
    let out = Number(this.adminSettingsForm[`ai.${p}.max_tokens_out`]);
    if (!Number.isFinite(out) || out <= 0) out = p === 'claude' ? 64000 : 16000;
    // Die Komplettanalyse deckelt ihre Calls bei der Klasse 'local' auf
    // ai.komplett.extract_max_tokens; die Klasse 'cloud' behält das Provider-Ceiling
    // (spiegelt phases/tokens.js#komplettMaxTokens, Klassen-Entscheid analog
    // lib/ai/config.js#providerClass: openai-compat nur mit gesetztem `.cloud`).
    // Weil die Vorschau genau diese Pässe beschreibt, muss sie mit demselben Cap rechnen
    // wie chunkLimitsFor — sonst zeigt sie kleinere Chunks, als der Job tatsächlich bildet.
    const isCloudClass = p === 'claude'
      || (p === 'openai-compat' && this.adminSettingsForm['ai.openai-compat.cloud'] === true);
    const komplettOut = Number(this.adminSettingsForm['ai.komplett.extract_max_tokens']);
    if (!isCloudClass && Number.isFinite(komplettOut) && komplettOut > 0) out = Math.min(out, komplettOut);
    const cptRaw = Number(this.adminSettingsForm['ai.chars_per_token']);
    const charsPerToken = Number.isFinite(cptRaw) && cptRaw > 0 ? cptRaw : (p === 'claude' ? 3 : 4);
    // Sicherheitspuffer proportional — spiegelt contextSafetyMargin in lib/ai/config.js.
    const safetyMargin = Math.max(2000, Math.round(ctx * 0.03));
    const inputBudgetTokens = Math.max(2000, ctx - out - safetyMargin);
    const inputBudgetChars = inputBudgetTokens * charsPerToken;
    const singlePass = Math.max(20000, Math.min(2000000, Math.floor(inputBudgetChars * 0.70)));
    const perChunk = Math.max(10000, Math.min(200000, Math.floor(inputBudgetChars * 0.35)));
    const RECOMMENDED = 128000;
    const level = ctx >= RECOMMENDED ? 'ok' : (ctx >= 64000 ? 'warn' : 'bad');
    const tag = localeTag(Alpine.store('shell').uiLocale);
    const fmt = (n) => formatNum(n, { localeTag: tag, decimals: 0 });
    return {
      level,
      f: {
        ctx: fmt(ctx),
        recommended: fmt(RECOMMENDED),
        budget: fmt(inputBudgetChars),
        single: fmt(singlePass),
        chunk: fmt(perChunk),
      },
    };
  },
};
