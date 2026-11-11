// Push-Dialog der Blog-Syncs (WordPress, HubSpot): jeder Push laeuft ueber ihn.
// Zeigt, was sich drueben aendert (Wort-Diff Blogstand → App-Stand, nur bei
// verknuepften Beitraegen), den Remote-Status und die drei Wege:
//   'draft'    — nur pushen (Create = Entwurf, Update = Inhalt ersetzen)
//   'now'      — pushen und veroeffentlichen
//   'schedule' — pushen und auf `scheduleAt` (Wanduhr der App-Zeitzone) planen
// Markup: partials/sync-dialogs.html (immer im Root, nicht in einer Karte —
// der Dialog geht aus Buchorganizer UND Notebook-Editor auf).
//
// Gespreadet in sync-core.js#createSyncCard; `spec` liefert
// `remoteState(link)` → 'draft' | 'published' | 'scheduled' | 'private' |
// 'pending' | null und optional `liveUpdate` (true: ein Update an einem
// veroeffentlichten Beitrag ist sofort live — WordPress; HubSpot schreibt in
// den Draft-Puffer).

import { loadDiff } from '../../lazy-libs.js';
import { renderInline } from '../../page-revision-diff.js';
import { zonedWallToIso } from '../../utils/date.js';
import { isSelectedBook } from '../book-guard.js';

export const REMOTE_STATE_LABELS = {
  draft: 'sync.remote.draft',
  published: 'sync.remote.published',
  scheduled: 'sync.remote.scheduled',
  private: 'sync.remote.private',
  pending: 'sync.remote.pending',
};

/** Ein Entwurf oder geplanter Beitrag ist auch ohne lokale Aenderung „pushbar":
 *  der Dialog veroeffentlicht bzw. plant ihn um. */
export const PUBLISHABLE_STATES = ['draft', 'scheduled', 'pending'];

export function pushDialogMethods(spec) {
  return {
    pushDialog: null,
    // Getter/Setter `pushDialogVisible` (x-model des <dialog>) steht direkt im
    // Objekt-Literal von sync-core.js: ein Spread kopierte den Getter als Wert.

    remoteState(page) {
      if (!this.connected || !page || typeof spec.remoteState !== 'function') return null;
      const link = this.linksMap[page.id];
      return link ? spec.remoteState(link) : null;
    },

    remoteStateLabel(page) {
      const key = REMOTE_STATE_LABELS[this.remoteState(page)];
      return key ? (window.__app?.t(key) || '') : '';
    },

    async openPushDialog(pageId) {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId || this.pushBusy[pageId]) return;
      await window.__app?._ensurePartial?.('sync-dialogs');
      const page = (Alpine.store('nav').pages || []).find(p => p.id === pageId) || { id: pageId };
      const link = this.linksMap[pageId] || null;
      const state = link && typeof spec.remoteState === 'function' ? spec.remoteState(link) : null;
      this.pushDialog = {
        pageId,
        name: page.name || '',
        linked: !!link,
        remoteState: state,
        hasLocalChange: this.statusFor(page) === 'push-needed' || !link,
        loading: !!link,
        error: '',
        diffHtml: '',
        unchanged: false,
        remoteTitle: '',
        scheduleAt: '',
      };
      if (link) await this._loadPushPreview(bookId, pageId);
    },

    async _loadPushPreview(bookId, pageId) {
      const app = window.__app;
      try {
        const { contentRepo } = await import('../../repo/content.js');
        const [remoteRes, localPage, diffLib] = await Promise.all([
          fetch(`${spec.endpointBase}/${bookId}/pages/${pageId}/remote`).then(r => r.ok ? r.json() : Promise.reject(r)),
          // fresh: der Diff ist die Entscheidungsgrundlage — aus dem SWR-Cache
          // sähe der lokale Stand womöglich älter aus, als er ist.
          contentRepo.loadPage(pageId, { fresh: true }),
          loadDiff(),
        ]);
        if (!isSelectedBook(bookId) || this.pushDialog?.pageId !== pageId) return;
        const localHtml = localPage.html || localPage.body_html || '';
        const out = renderInline(remoteRes.html || '', localHtml, diffLib);
        this.pushDialog = {
          ...this.pushDialog,
          loading: false,
          diffHtml: out.html,
          unchanged: out.unchanged,
          remoteTitle: remoteRes.title || '',
        };
      } catch (e) {
        console.error(`[sync:${spec.key}] Push-Vorschau laden fehlgeschlagen:`, e);
        if (this.pushDialog?.pageId !== pageId) return;
        const code = await this._errorCodeOf(e);
        const k = code ? `${spec.key}.error.${code}` : '';
        const txt = k ? app?.t(k) : '';
        this.pushDialog = {
          ...this.pushDialog,
          loading: false,
          error: txt && txt !== k ? txt : (app?.t('sync.push.previewFailed') || ''),
        };
      }
    },

    closePushDialog() { this.pushDialog = null; },

    /** Darf der Dialog veroeffentlichen bzw. planen? Ein schon live stehender
     *  Beitrag nicht — dort heisst „pushen" bereits aktualisieren. */
    pushDialogCanPublish() {
      const d = this.pushDialog;
      return !!d && d.remoteState !== 'published' && d.remoteState !== 'private';
    },

    /** Hinweiszeile unter dem Diff (i18n-Key oder ''). */
    pushDialogNote() {
      const d = this.pushDialog;
      if (!d) return '';
      if (d.remoteState === 'published') return spec.liveUpdate ? 'sync.push.noteLive' : 'sync.push.noteBuffer';
      if (!d.linked) return 'sync.push.noteNew';
      return '';
    },

    /** Anbieter-Hinweis bei verknüpften Beiträgen (`spec.pushNote`, i18n-Text
     *  mit `{pageName}`) bzw. Voraussetzung fürs Veröffentlichen. */
    pushDialogProviderNote() {
      const d = this.pushDialog;
      if (!d?.linked || !spec.pushNote) return '';
      return window.__app?.t(spec.pushNote, { pageName: d.name }) || '';
    },
    pushDialogPublishNote() {
      return spec.publishNote ? (window.__app?.t(spec.publishNote) || '') : '';
    },

    async confirmPushDialog(mode) {
      const d = this.pushDialog;
      if (!d) return;
      const opts = {};
      if (mode === 'now') opts.publish = 'now';
      if (mode === 'schedule') {
        const at = zonedWallToIso(d.scheduleAt);
        if (!at || Date.parse(at) <= Date.now() + 60_000) {
          this.pushDialog = { ...d, error: window.__app?.t('sync.push.scheduleInvalid') || '' };
          return;
        }
        opts.publish_at = at;
      }
      this.pushDialog = null;
      await this._startPush(d.pageId, opts);
    },
  };
}
