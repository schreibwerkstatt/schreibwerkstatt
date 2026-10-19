'use strict';
// Websuche: welcher Suchweg gilt für diesen User? EINE Entscheidung für
// Recherche-Chat und Weltfakten-Faktencheck, für deren Gates, /config und die
// Jobs selbst.
//
//   'anthropic'  Claude mit Anthropics serverseitigem web_search
//   'searxng'    Function-Tool web_search über lib/websearch/searxng.js
//   null         keine Websuche → Feature für diesen User nicht verfügbar
//
// Settings: `websearch.claude` (Claude), `websearch.provider` (alle anderen).
// SearXNG ohne URL zählt als nicht verfügbar; Claude fällt dann auf Anthropic
// zurück. Provider ohne Tool-Calling (providerSupportsTools) haben keinen Weg.

const appSettings = require('../app-settings');
const { resolveProvider, providerSupportsTools } = require('../ai');
const searxng = require('./searxng');

// Freischaltung des SearXNG-Pfads. Aus, solange die Function-Tools im
// Recherche-Chat noch fehlen: dann sucht Claude immer über Anthropic, und
// andere Provider bekommen `claude_only` — exakt das Verhalten vor der
// Websuche-Umstellung (docs/feature-ideen.md, Umsetzungsplan Schritt 6).
let _searxngToolsReady = false;

/** Nur für Tests: Freischaltung umschalten. */
function _setSearxngToolsReady(v) { _searxngToolsReady = !!v; }

/**
 * @param {string|null} userEmail
 * @returns {{ provider: string, mode: 'anthropic'|'searxng'|null,
 *             reason: null|'no_tools'|'off'|'claude_only' }}
 */
function webSearchStatus(userEmail) {
  const provider = resolveProvider({ userEmail });
  if (!_searxngToolsReady) {
    return provider === 'claude'
      ? { provider, mode: 'anthropic', reason: null }
      : { provider, mode: null, reason: 'claude_only' };
  }
  const searxngReady = searxng.isConfigured();
  if (provider === 'claude') {
    const mode = appSettings.get('websearch.claude') === 'searxng' && searxngReady ? 'searxng' : 'anthropic';
    return { provider, mode, reason: null };
  }
  if (!providerSupportsTools(provider, { userEmail })) return { provider, mode: null, reason: 'no_tools' };
  if (appSettings.get('websearch.provider') === 'searxng' && searxngReady) {
    return { provider, mode: 'searxng', reason: null };
  }
  return { provider, mode: null, reason: 'off' };
}

function webSearchMode(userEmail) {
  return webSearchStatus(userEmail).mode;
}

module.exports = { webSearchStatus, webSearchMode, searxng, _setSearxngToolsReady };
