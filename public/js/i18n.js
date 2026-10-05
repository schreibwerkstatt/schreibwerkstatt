// Leichtgewichtiges i18n ohne Dependencies.
//
// Ablauf:
//   1. configureI18n(locale) lädt de.json als Fallback + die Ziel-Locale.
//   2. Alpine-Methoden (i18nMethods) liefern `t()` reaktiv über `this.$store.shell.uiLocale`.
//   3. changeLocale(loc) lädt neu + persistiert via PATCH /me/settings.
//
// Key-Konvention: 'bereich.feld' (z.B. 'header.logout', 'profile.title').
// Platzhalter: {name} → Parameter-Map: t('foo', { name: 'Anna' }).

import { formatLastRun as _formatLastRunImpl, localeTag } from './utils.js';
import { applyUnitTerm, UNIT_SECTION } from './i18n-unit-term.js';

const FALLBACK_LOCALE = 'de';
const SUPPORTED_LOCALES = ['de', 'en'];

let _messages = {};
let _fallback = null;
let _locale = FALLBACK_LOCALE;
// Gliederungseinheit des offenen Buchs (Abschnitt/Beitrag/Eintrag), gesetzt
// über setUnitTerm aus dem Root-Effekt (app-init.js). Siehe i18n-unit-term.js.
let _unit = UNIT_SECTION;

/** Gliederungseinheit für alle folgenden Übersetzungen setzen ('section'|'post'|'entry'). */
export function setUnitTerm(unit) { _unit = unit || UNIT_SECTION; }

// Ein Reload bricht einen laufenden Locale-Fetch der alten Seite ab. Das ist kein
// Fehler, sondern das Ende dieser Seite — die neue lädt die Locale selbst.
let _unloading = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { _unloading = true; });
  // Firefox bricht den Fetch schon beim Navigationsstart ab, vor `pagehide`.
  // Wird die Navigation abgebrochen (Dirty-Guard), gibt der Timer das Log frei.
  window.addEventListener('beforeunload', () => {
    _unloading = true;
    setTimeout(() => { _unloading = false; }, 2000);
  });
  window.addEventListener('pageshow', () => { _unloading = false; });
}

async function _load(locale) {
  const r = await fetch(`/js/i18n/${locale}.json`);
  if (!r.ok) throw new Error(`Locale ${locale} nicht verfügbar (${r.status}).`);
  return r.json();
}

/** Lädt Fallback (de) + Ziel-Locale. Idempotent – kann mehrfach aufgerufen werden. */
export async function configureI18n(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) locale = FALLBACK_LOCALE;
  if (!_fallback) _fallback = await _load(FALLBACK_LOCALE);
  if (locale === FALLBACK_LOCALE) {
    _messages = _fallback;
    _locale = FALLBACK_LOCALE;
  } else {
    try { _messages = await _load(locale); _locale = locale; }
    catch (e) {
      if (!_unloading) console.error('[i18n]', e.message, '– Fallback auf de.');
      _messages = _fallback;
      _locale = FALLBACK_LOCALE;
    }
  }
}

/** Liste der unterstützten Locales. */
export function getSupportedLocales() { return SUPPORTED_LOCALES.slice(); }

/** Übersetzt einen Key. Fallback: de-Wert; letzter Fallback: der Key selbst (sichtbares Debug-Signal). */
export function tRaw(key, params) {
  let msg = _messages[key];
  let locale = _locale;
  if (msg === undefined) { msg = _fallback?.[key]; locale = FALLBACK_LOCALE; }
  if (msg === undefined) msg = key;
  // Vor den Platzhaltern: ein Abschnittstitel im Parameter bleibt, wie er heisst.
  else msg = applyUnitTerm(msg, { key, locale, unit: _unit });
  if (params) {
    msg = msg.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? params[k] : `{${k}}`));
  }
  return msg;
}

/** Übersetzt eine Backend-Fehlerantwort. Akzeptiert:
 *  - { error_code: 'CODE', params: {...} } → t('error.CODE', params)
 *  - { error: 'freier Text' }              → Text direkt (Legacy-Fallback)
 *  - null / undefined / {}                  → common.unknownError
 */
export function tErrorRaw(response) {
  if (!response) return tRaw('common.unknownError');
  if (response.error_code) return tRaw('error.' + response.error_code, response.params || {});
  if (response.error)      return response.error;
  return tRaw('common.unknownError');
}

/** Fehlertext für einen `fetchJson`-Fehler (utils/net.js): Backend-Body über
 *  tErrorRaw, reiner Netzwerkausfall (status 0) als eigener Hinweis. Nie die
 *  rohe `HTTP 4xx`-Message — die ist für den User kein Satz. */
export function tFetchError(err) {
  if (err?.body) return tErrorRaw(err.body);
  if (err?.status === 0) return tRaw('common.networkError');
  return tRaw('common.unknownError');
}

/** Fehlertext für einen geworfenen `fetchJson`/`sendJson`-Fehler (utils/net.js):
 *  übersetzter `error_code` (`error.CODE` samt `params`), ohne Übersetzung der
 *  rohe Code, ohne Code die Error-Message. */
export function tFetchErrorRaw(err) {
  const code = err?.code;
  if (code) {
    const key = 'error.' + code;
    const msg = tRaw(key, err.body?.params || {});
    return msg === key ? code : msg;
  }
  return err?.message || tRaw('common.unknownError');
}

// Alpine-Methoden: `t` referenziert `this.$store.shell.uiLocale`, damit Alpine bei Sprachwechsel re-evaluiert.
// `this?.` ist Pflicht: Wird die Methode aus einem Scope aufgerufen, in dem Alpine
// den Receiver verliert (z. B. via `window.__app.t()` aus einer x-effect-Expression
// einer spät hydratisierten Combobox), wäre `this` undefined und der reine
// Reaktivitäts-Touch würde die ganze Alpine-Effect-Kette crashen. Übersetzung
// fällt dann auf die geladenen Modul-Messages zurück (tRaw), statt die Karte zu killen.
export const i18nMethods = {
  t(key, params) {
    void this?.$store?.shell?.uiLocale;
    void this?.$store?.shell?.unitTerm;
    return tRaw(key, params);
  },

  /** Backend-Fehler übersetzen. Siehe tErrorRaw für Schema. */
  tError(response) {
    void this?.$store?.shell?.uiLocale;
    void this?.$store?.shell?.unitTerm;
    return tErrorRaw(response);
  },

  /** ISO-Timestamp → relativer Lokalisiertext. Lazy-Import um Zykel zu vermeiden. */
  formatLastRun(isoStr) {
    if (!isoStr) return '';
    return _formatLastRunImpl(isoStr, (k, p) => tRaw(k, p), this?.$store?.shell?.uiLocale);
  },

  /** Sprache wechseln, neue Messages laden und auf Server persistieren. */
  async changeLocale(locale) {
    if (!SUPPORTED_LOCALES.includes(locale)) return;
    if (locale === this.$store.shell.uiLocale) return;
    await configureI18n(locale);
    this.$store.shell.uiLocale = locale;
    document.documentElement.setAttribute('lang', localeTag(locale));
    fetch('/me/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale }),
    }).catch(e => console.error('[i18n] Persist fehlgeschlagen:', e));
  },
};
