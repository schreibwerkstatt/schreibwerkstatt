// Alpine.data('hubspotSyncCard') — HubSpot-Sync-Provider. Thin Wrapper über
// `createSyncCard` (sync/sync-core.js): Status-Modell, Push und Konflikt-Diff
// liegen dort und gelten für alle Provider.
//
// Re-Push aktualisiert den HubSpot-Draft-Buffer; die Live-Version drüben bleibt
// unverändert, bis der Buffer veröffentlicht wird (Push-Dialog «Pushen und
// veröffentlichen» oder in HubSpot). Ein importierter Post kann HubSpot-Module,
// CTAs oder Formulare tragen, die der Import nicht übernommen hat — im Buffer
// ersetzt der App-Body sie; darauf weist der Push-Dialog hin (`pushNote`). Ein
// Edit am Draft in HubSpot fällt in der Vorab-Prüfung des Servers als Konflikt
// auf und wird nie still überschrieben.
//
// Headless display-contents-Anker, via `$hubspot`-Magic global erreichbar.

import { createSyncCard } from './sync/sync-core.js';

const hubspotSpec = {
  key: 'hubspot',
  endpointBase: '/hubspot',
  jobTypes: {
    push: 'hubspot-push',
    refresh: ['hubspot-import'],
    reconcile: 'hubspot-reconcile',
  },
  pushErrorCode: 'HUBSPOT_PUSH_FAILED',
  liveUpdate: false,
  pushNote: 'hubspot.repush.warning',
  publishNote: 'hubspot.publish.needsTeaser',
  remoteState(link) {
    return {
      DRAFT: 'draft', PUBLISHED: 'published', SCHEDULED: 'scheduled',
      PUBLISHED_OR_SCHEDULED: 'scheduled',
    }[String(link?.hubspot_state || '').toUpperCase()] || null;
  },
  // PUBLISHED: absolute Live-Post-URL. DRAFT/SCHEDULED: Editor-URL — ohne
  // Login waere der Draft drueben sonst nicht aufrufbar. `portalId` liefert
  // `/hubspot/:bookId/links` mit.
  viewUrl(page, providerMeta, link) {
    if (!link) return '';
    const state = String(link.hubspot_state || '').toUpperCase();
    if (state !== 'PUBLISHED' && providerMeta?.portalId && link.hubspot_post_id) {
      return `https://app.hubspot.com/blog/${providerMeta.portalId}/editor/${link.hubspot_post_id}/content`;
    }
    return link.hubspot_url || '';
  },
};

export function registerHubspotSyncCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('hubspotSyncCard', createSyncCard(hubspotSpec));
}
