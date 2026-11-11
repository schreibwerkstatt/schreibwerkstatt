// Alpine.data('blogSyncCard') — WordPress-Sync-Provider. Thin Wrapper über
// `createSyncCard` (sync/sync-core.js): Status-Modell, Push und Konflikt-Diff
// liegen dort und gelten für alle Provider. Lebt als headless
// display-contents-Anker in index.html, via `$blog`-Magic global erreichbar.

import { createSyncCard } from './sync/sync-core.js';

const blogSpec = {
  key: 'blog',
  endpointBase: '/blog',
  jobTypes: {
    push: 'blog-push',
    refresh: ['blog-import', 'blog-pull', 'blog-repull'],
    reconcile: 'blog-reconcile',
  },
  pushErrorCode: 'BLOG_PUSH_FAILED',
  // WordPress schreibt ein Update an einem veröffentlichten Beitrag direkt live.
  liveUpdate: true,
  // `wp_status` des Links (Pull, Push, Abgleich halten ihn aktuell).
  remoteState(link) {
    return {
      draft: 'draft', publish: 'published', future: 'scheduled', private: 'private', pending: 'pending',
    }[link?.wp_status] || null;
  },
  // WordPress-Frontend-URL fuer eine verlinkte Page (`?p=ID` funktioniert
  // unabhaengig vom Permalink-Setup). Nicht veroeffentlichte Beitraege mit
  // `preview=true` — sonst zeigt WordPress einem eingeloggten Browser je nach
  // Theme eine 404 statt der Vorschau.
  viewUrl(page, providerMeta, link) {
    if (!link || !link.wp_post_id || !providerMeta?.baseUrl) return '';
    const base = providerMeta.baseUrl.replace(/\/$/, '');
    const preview = link.wp_status && link.wp_status !== 'publish' ? '&preview=true' : '';
    return `${base}/?p=${link.wp_post_id}${preview}`;
  },
};

export function registerBlogSyncCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('blogSyncCard', createSyncCard(blogSpec));
}
