'use strict';
// KI-Profil-Overlay: loest `ai.<provider>.<key>` pro User auf.
//
// Ein Profil (`ai_profiles`, zugewiesen via app_users.ai_profile_id) traegt einen
// Provider und beliebig viele Parameter-Ueberschreibungen. NULL in einer Spalte
// heisst „globaler Wert" — deshalb ist das hier ein Overlay und kein Ersatz:
//
//   aiSetting('openai-compat', 'model')   → Profil-Modell, sonst ai.openai-compat.model
//
// Das Overlay greift NUR, wenn der Provider des Profils dem angefragten Provider
// entspricht. Sonst bekaeme ein Call, der (aus welchem Grund auch immer) explizit
// gegen einen anderen Provider geht, die Parameter eines fremden Modells — etwa
// den Claude-Modellnamen als `model` an einen llama.cpp-Server.
//
// Der User kommt wie bei resolveProvider aus dem ALS-Context (der Job-Worker setzt
// ihn in routes/jobs/shared/queue.js#drainQueue), sofern der Aufrufer ihn nicht
// mitgibt. Ohne Kontext bleibt es beim globalen Wert.
//
// Lazy require auf die db-Module: lib/ai wird auch in Pfaden geladen, in denen die
// Tabellen noch nicht existieren (frische DB vor der Migration, Unit-Tests, die nur
// die Budget-Rechnung anfassen). Ein fehlendes Profil ist dort kein Fehler, sondern
// schlicht „kein Overlay".

const appSettings = require('../app-settings');
const { getContext } = require('../log-context');

function _emailFrom(opts) {
  if (opts && opts.userEmail) return opts.userEmail;
  if (opts && opts.userEmail === null) return null;
  return getContext().user || null;
}

/**
 * Wirksames Profil dieses Users (oder null). Reihenfolge:
 *   1. eigener Zugang des Kontos (`owner_email`) — nur solange der Admin das
 *      Feature offen hat (`ai.user_api.enabled`). Zugedreht faellt das Konto
 *      sofort auf seine Zuweisung zurueck; der gespeicherte Zugang bleibt liegen.
 *   2. vom Admin zugewiesenes Profil (app_users.ai_profile_id)
 */
function activeProfile(opts) {
  const email = _emailFrom(opts);
  if (!email) return null;
  try {
    const aiProfiles = require('../../db/ai-profiles');
    if (appSettings.get('ai.user_api.enabled') === true) {
      const own = aiProfiles.getOwnProfile(email);
      if (own) return own;
    }
    const appUsers = require('../../db/app-users');
    const u = appUsers.getUser(email);
    if (!u || !u.ai_profile_id) return null;
    const prof = aiProfiles.getProfile(u.ai_profile_id);
    return prof && !prof.owner_email ? prof : null;
  } catch { return null; }
}

/** Faehrt dieser User gerade seinen EIGENEN Zugang (eigener Key, er zahlt)? */
function usesOwnAccess(opts) {
  return !!activeProfile(opts)?.owner_email;
}

/** Eigener Zugang auf einen EIGENEN Endpunkt (OpenAI-kompatibel)? Dann gelten die
 *  Instanz-Overrides des Admins (Job-Modelle, Fenster, Effort) nicht — sie
 *  beschreiben die Modelle der Instanz und waeren dort fremde Modellnamen.
 *  Ein eigener Claude-Zugang tauscht nur den Key: Modell, Tiers, Fenster und
 *  Effort kommen wie ohne eigenen Zugang aus den Instanz-Einstellungen. */
function usesOwnEndpoint(opts) {
  const prof = activeProfile(opts);
  return !!prof?.owner_email && prof.provider !== 'claude';
}

/** Provider des zugewiesenen Profils (oder null = User folgt dem globalen ai.provider). */
function profileProvider(opts) {
  return activeProfile(opts)?.provider || null;
}

/**
 * Effektiver Wert von `ai.<provider>.<key>`: Profil-Spalte, sonst App-Setting.
 * `key` ist zugleich der Spaltenname im Profil (SSoT der Liste:
 * db/ai-profiles.js#PROFILE_FIELDS).
 */
function aiSetting(provider, key, opts) {
  const global = appSettings.get(`ai.${provider}.${key}`);
  const prof = activeProfile(opts);
  if (!prof || prof.provider !== provider) return global;
  // Eigener Claude-Zugang traegt nur den Key; alle Parameter von der Instanz.
  if (prof.owner_email && provider === 'claude') return global;
  const v = prof[key];
  // Eigener Zugang erbt den Host nie: der Instanz-Host ist das interne Netz des
  // Betreibers, und an ihn ginge dann der Key des Users.
  if (key === 'host' && prof.owner_email) return v ?? null;
  return (v === null || v === undefined) ? global : v;
}

/**
 * Klartext-API-Key fuer diesen Provider. Getrennt von aiSetting, weil der Key im
 * Profil verschluesselt liegt und db/ai-profiles ihn bewusst nicht mit ausliefert.
 */
function aiApiKey(provider, opts) {
  const prof = activeProfile(opts);
  if (prof && prof.provider === provider) {
    let key = null;
    try { key = require('../../db/ai-profiles').apiKeyOf(prof.id); }
    catch { /* faellt auf den globalen Key zurueck */ }
    if (key) return key;
    // Eigener Zugang: NIE auf den Instanz-Key zurueckfallen. Der Host kommt dort
    // vom User — ein Fallback schickte den Key des Betreibers an dessen Server.
    if (prof.owner_email) return '';
  }
  return String(appSettings.get(`ai.${provider}.api_key`) || '');
}

/**
 * Identitaet der aktiven Konfiguration fuer Cache-Schluessel und Semaphore-Buckets.
 * Zwei Profile auf DEMSELBEN Provider mit verschiedenen Modellen duerfen sich weder
 * Cache-Zeilen (der `provider`-Anteil im PK unterscheidet sie nicht) noch einen
 * Parallelitaets-Zaehler teilen (verschiedene Hosts vertragen verschiedene Lasten).
 */
function profileKey(provider, opts) {
  const prof = activeProfile(opts);
  if (!prof || prof.provider !== provider) return null;
  return `p${prof.id}`;
}

/**
 * Wie aiSetting, aber gegen einen MITGEGEBENEN profileKey statt gegen den
 * ALS-Context. Noetig fuer alles, was ausserhalb des aufrufenden Kontexts laeuft:
 * der Semaphore-Zaehler in ./shared wird beim Freiwerden eines Slots neu
 * ausgewertet — und das passiert im Kontext eines FREMDEN Calls. Ueber den
 * ALS-Context gelesen bekaeme der Bucket dort die Obergrenze eines anderen Profils.
 */
function aiSettingByProfileKey(provider, key, pkey) {
  const global = appSettings.get(`ai.${provider}.${key}`);
  const m = /^p(\d+)$/.exec(String(pkey || ''));
  if (!m) return global;
  try {
    const prof = require('../../db/ai-profiles').getProfile(parseInt(m[1], 10));
    if (!prof || prof.provider !== provider) return global;
    const v = prof[key];
    return (v === null || v === undefined) ? global : v;
  } catch { return global; }
}

module.exports = {
  activeProfile, usesOwnAccess, usesOwnEndpoint, profileProvider, aiSetting, aiApiKey, profileKey, aiSettingByProfileKey,
};
