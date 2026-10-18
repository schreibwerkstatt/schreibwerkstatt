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
    refresh: ['blog-import', 'blog-pull'],
    reconcile: 'blog-reconcile',
  },
  pushErrorCode: 'BLOG_PUSH_FAILED',
  // WordPress-Frontend-URL fuer eine verlinkte Page (`?p=ID` funktioniert
  // unabhaengig vom Permalink-Setup; bei Drafts liefert WP eine Preview-/
  // Login-Seite, je nach Session des Browsers).
  viewUrl(page, providerMeta, link) {
    if (!link || !link.wp_post_id || !providerMeta?.baseUrl) return '';
    const base = providerMeta.baseUrl.replace(/\/$/, '');
    return `${base}/?p=${link.wp_post_id}`;
  },
};

export function registerBlogSyncCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('blogSyncCard', createSyncCard(blogSpec));
}
