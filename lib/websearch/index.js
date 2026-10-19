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

/**
 * @param {string|null} userEmail
 * @returns {{ provider: string, mode: 'anthropic'|'searxng'|null,
 *             reason: null|'no_tools'|'off' }}
 */
function webSearchStatus(userEmail) {
  const provider = resolveProvider({ userEmail });
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

module.exports = { webSearchStatus, webSearchMode, searxng };
