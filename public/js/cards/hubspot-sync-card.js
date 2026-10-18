// Alpine.data('hubspotSyncCard') — HubSpot-Sync-Provider. Thin Wrapper über
// `createSyncCard` (sync/sync-core.js): Status-Modell, Push und Konflikt-Diff
// liegen dort und gelten für alle Provider.
//
// Re-Push aktualisiert den HubSpot-Draft-Buffer; die Live-Version drüben bleibt
// unverändert, bis der User den Buffer in HubSpot publiziert. Ein importierter
// Post kann HubSpot-Module, CTAs oder Formulare tragen, die der Import nicht
// übernommen hat — im Buffer ersetzt der App-Body sie. Darum vor dem Re-Push
// ein Dialog. (Ein Edit am Draft in HubSpot fällt dagegen in der Vorab-Prüfung
// des Servers als Konflikt auf und wird nie still überschrieben.)
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
  // PUBLISHED: absolute Live-Post-URL. DRAFT: Editor-URL — ohne Login waere
  // der Draft drueben sonst nicht aufrufbar. `portalId` liefert
  // `/hubspot/:bookId/links` mit.
  viewUrl(page, providerMeta, link) {
    if (!link) return '';
    if (link.hubspot_state === 'DRAFT' && providerMeta?.portalId && link.hubspot_post_id) {
      return `https://app.hubspot.com/blog/${providerMeta.portalId}/editor/${link.hubspot_post_id}/content`;
    }
    return link.hubspot_url || '';
  },
  async confirmPush(pageId) {
    const root = window.__app;
    if (!root) return true;
    const page = (Alpine.store('nav').pages || []).find(p => p.id === pageId);
    if (!page || this.statusFor(page) !== 'push-needed') return true;
    return !!(await root.appConfirm({
      message: root.t('hubspot.repush.warning', { pageName: page.name || '' }),
      confirmLabel: root.t('hubspot.repush.confirm'),
      cancelLabel: root.t('common.cancel'),
    }));
  },
};

export function registerHubspotSyncCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('hubspotSyncCard', createSyncCard(hubspotSpec));
}
