// Alpine.data('shareLinksCard') — Sub-Komponente "Geteilte Links".
// Listet alle Share-Links des Users zum aktuellen Buch (Create/Revoke/Patch) +
// Unread-Badge via owner_last_seen_at. Der Buch-Owner sieht zusätzlich die Links
// anderer Mitarbeiter (`mine: false`, mit Ersteller) und kann sie widerrufen;
// Bearbeiten, Kommentare und Statistik bleiben beim Ersteller. Kommentare werden NICHT mehr in der Karte
// angezeigt: „Kommentare anzeigen" wechselt in die passende Editor-Ansicht
// (Seiten-Share → Notebook-Leseansicht, Buch-/Kapitel-Share → Bucheditor), wo die
// Kommentar-Leiste verankerte UND allgemeine Threads zeigt und voll bedienbar ist.

import { setupCardLifecycle } from './card-lifecycle.js';
import { fetchJson, localeTag, tzOpts } from '../utils.js';
import { copyText } from '../copy-button.js';
import { EVT } from '../events.js';
import { isSelectedBook } from './book-guard.js';

export function registerShareLinksCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('shareLinksCard', () => ({
    links: [],
    loadingLinks: false,
    loadError: '',
    // Create-Form-State
    createKind: 'page', // 'page' | 'chapter' | 'book'
    createPageId: '',
    createChapterId: '',
    createIntro: '',
    createExpiresAt: '',
    createShowToc: false,
    creating: false,
    createError: '',
    // Edit-State
    editingToken: null,
    editIntro: '',
    editExpiresAt: '',
    editShowToc: false,
    savingEdit: false,
    // Copy-Feedback
    copiedToken: null,
    _copiedTimer: null,
    _lifecycle: null,
    // Live-Poll: aktualisiert Counts/Unread der Links, während die Karte sichtbar ist
    _pollTimer: null,
    // Aufgeklappte Statistik (Kapitel-Drop-off + Fazits) pro Link (Token oder null)
    expandedStatsToken: null,
    statsLoading: false,
    statsReadDepth: [],   // [{ chapter_id, chapter_name, avg_depth_pct, reached_views }]
    statsFeedback: [],    // [{ id, reader_name, rating, body, created_at, updated_at }]

    shareKindOptions() {
      const app = window.__app;
      return [
        { value: 'page',    label: app.t('share.create.page') },
        { value: 'chapter', label: app.t('share.create.chapter') },
        { value: 'book',    label: app.t('share.create.book') },
      ];
    },

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'shareLinks',
        showFlag: 'showShareLinksCard',
        load: () => this._loadAndPoll(),
        onShow: () => {
          this._applyPrefill();
          return this._loadAndPoll();
        },
        resetState: {
          links: [],
          loadError: '',
          createError: '',
          createPageId: '',
          createChapterId: '',
        },
        timerKeys: ['_pollTimer'],
        extraListeners: [
          { type: 'share:prefill', handler: (e) => {
              const d = e?.detail || {};
              if (d.kind === 'page') {
                this.createKind = 'page';
                this.createPageId = String(d.id || '');
              } else if (d.kind === 'chapter') {
                this.createKind = 'chapter';
                this.createChapterId = String(d.id || '');
              } else if (d.kind === 'book') {
                this.createKind = 'book';
              }
          } },
        ],
      });
      // Poll stoppen, sobald die Karte ausgeblendet wird (Lifecycle-Watch deckt
      // nur die steigende Flanke ab).
      this.$watch(() => window.__app.showShareLinksCard, (visible) => {
        if (!visible) this._stopPolling();
      });
    },

    _applyPrefill() {
      const pf = window.__app?._shareLinksPrefill;
      if (!pf) return;
      if (pf.kind === 'page') {
        this.createKind = 'page';
        this.createPageId = String(pf.id || '');
      } else if (pf.kind === 'chapter') {
        this.createKind = 'chapter';
        this.createChapterId = String(pf.id || '');
      } else if (pf.kind === 'book') {
        this.createKind = 'book';
      }
      window.__app._shareLinksPrefill = null;
    },

    destroy() {
      if (this._copiedTimer) { clearTimeout(this._copiedTimer); this._copiedTimer = null; }
      this._lifecycle?.destroy();
    },

    async loadLinks() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      this.loadingLinks = true;
      this.loadError = '';
      try {
        const rows = await fetchJson(`/share/api/links?book_id=${encodeURIComponent(bookId)}`);
        this.links = Array.isArray(rows) ? rows : [];
        // Falls aktuelles Page-Target preselected werden soll
        if (!this.createPageId && window.__app?.currentPage?.id) {
          this.createPageId = String(window.__app.currentPage.id);
        }
      } catch (e) {
        this.loadError = e.message || 'load failed';
      } finally {
        this.loadingLinks = false;
      }
    },

    // ── Live-Poll ─────────────────────────────────────────────────────────────
    // Erst-Load (mit Loading-State) plus Start des stillen Polls. Wird sowohl
    // beim Öffnen der Karte als auch nach Buchwechsel (Lifecycle cfg.load)
    // aufgerufen — `_startPolling` ist idempotent.
    async _loadAndPoll() {
      this._startPolling();
      return this.loadLinks();
    },

    _startPolling() {
      this._stopPolling();
      this._pollTimer = setInterval(() => this._quietRefresh(), 5000);
    },

    _stopPolling() {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    },

    // Stiller Refresh ohne Loading-Flicker: aktualisiert View-/Comment-/Unread-
    // Counts der Links in-place. Reviewer-Kommentare (Buch/Kapitel/Seite) tauchen
    // so binnen ~5 s als Unread-Badge beim Owner auf.
    async _quietRefresh() {
      if (typeof document !== 'undefined' && document.hidden) return;
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      let rows;
      try {
        rows = await fetchJson(`/share/api/links?book_id=${encodeURIComponent(bookId)}`);
      } catch { return; }
      if (!isSelectedBook(bookId)) return;
      if (!Array.isArray(rows)) return;
      const byToken = new Map(this.links.map(l => [l.token, l]));
      const sameSet = rows.length === this.links.length && rows.every(r => byToken.has(r.token));
      if (sameSet) {
        // In-place Merge → keine vollständige x-for-Neuzeichnung
        for (const r of rows) {
          const cur = byToken.get(r.token);
          if (!cur) continue;
          cur.view_count = r.view_count;
          cur.unique_views = r.unique_views;
          cur.avg_duration_ms = r.avg_duration_ms;
          cur.avg_max_scroll_pct = r.avg_max_scroll_pct;
          cur.avg_rating = r.avg_rating;
          cur.feedback_count = r.feedback_count;
          cur.comment_count = r.comment_count;
          cur.unread_count = r.unread_count;
          cur.creator_access = r.creator_access;
          cur.revoked_at = r.revoked_at;
        }
      } else {
        this.links = rows;
      }
    },

    linkUrl(token) {
      return `${location.origin}/share/${token}`;
    },

    linkStatus(link) {
      if (link.revoked_at) return 'revoked';
      // Ersteller hat die nötige Buchrolle verloren → für Leser bereits tot.
      if (link.creator_access === false) return 'revoked';
      if (link.expires_at && new Date(link.expires_at) < new Date()) return 'expired';
      return 'active';
    },

    // „Angelegt von …" nur an fremden Links (Buch-Owner-Sicht).
    creatorLabel(link) {
      if (link.mine !== false) return '';
      return window.__app.t('share.list.createdBy', { name: link.owner_display_name || link.owner_email || '' });
    },

    targetLabel(link) {
      const app = window.__app;
      if (link.kind === 'page') return link.page_name || app.t('share.target.pageFallback', { id: link.page_id });
      if (link.kind === 'book') return link.book_name || app.selectedBookName || app.t('share.target.book');
      return link.chapter_name || app.t('share.target.chapterFallback', { id: link.chapter_id });
    },

    pageOptions() {
      const tree = Alpine.store('nav').tree || [];
      const out = [];
      const walk = (items, prefix) => {
        for (const it of items) {
          if (it.type !== 'chapter') continue;
          const label = prefix ? `${prefix} › ${it.name}` : it.name;
          for (const p of (it.pages || [])) {
            out.push({ value: String(p.id), label: `${label} / ${p.name}` });
          }
          if (it.subchapters?.length) walk(it.subchapters, label);
        }
      };
      walk(tree, '');
      return out;
    },

    chapterOptions() {
      const tree = Alpine.store('nav').tree || [];
      const out = [];
      const walk = (items, depth) => {
        for (const it of items) {
          if (it.type !== 'chapter' || it.solo) continue;
          out.push({ value: String(it.id), label: '— '.repeat(depth) + it.name });
          if (it.subchapters?.length) walk(it.subchapters, depth + 1);
        }
      };
      walk(tree, 0);
      return out;
    },

    async createLink() {
      this.createError = '';
      const body = {
        kind: this.createKind,
        intro: this.createIntro || null,
        expires_at: this.createExpiresAt || null,
        show_toc: this.createKind !== 'page' && this.createShowToc,
      };
      if (this.createKind === 'page') {
        body.page_id = parseInt(this.createPageId, 10);
        if (!body.page_id) { this.createError = window.__app.t('share.error.pageRequired'); return; }
      } else if (this.createKind === 'chapter') {
        body.chapter_id = parseInt(this.createChapterId, 10);
        if (!body.chapter_id) { this.createError = window.__app.t('share.error.chapterRequired'); return; }
      } else {
        body.book_id = parseInt(Alpine.store('nav').selectedBookId, 10);
        if (!body.book_id) { this.createError = window.__app.t('share.error.bookRequired'); return; }
      }
      this.creating = true;
      try {
        const res = await fetch('/share/api/links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await res.json();
        if (!res.ok) {
          this.createError = window.__app.t('share.error.' + (j.error_code || 'generic'));
          return;
        }
        this.links = [j, ...this.links];
        this.createIntro = '';
        this.createExpiresAt = '';
        this.createShowToc = false;
        window.__app.refreshShareLinkCounts();
        copyText(this.linkUrl(j.token));
        this.copiedToken = j.token;
        if (this._copiedTimer) clearTimeout(this._copiedTimer);
        this._copiedTimer = setTimeout(() => { this.copiedToken = null; }, 2500);
      } catch (e) {
        this.createError = e.message || 'create failed';
      } finally {
        this.creating = false;
      }
    },

    async revokeLink(token) {
      const ok = await window.__app.appConfirm({
        message: window.__app.t('share.revoke.confirm'),
        confirmLabel: window.__app.t('share.revoke'),
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await fetch(`/share/api/links/${encodeURIComponent(token)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('revoke failed');
        await this.loadLinks();
        window.__app.refreshShareLinkCounts();
      } catch (e) {
        this.loadError = e.message;
      }
    },

    startEdit(link) {
      this.editingToken = link.token;
      this.editIntro = link.intro || '';
      this.editExpiresAt = link.expires_at ? link.expires_at.slice(0, 16) : '';
      this.editShowToc = !!link.show_toc;
    },

    cancelEdit() {
      this.editingToken = null;
      this.editIntro = '';
      this.editExpiresAt = '';
      this.editShowToc = false;
    },

    async saveEdit(token) {
      this.savingEdit = true;
      try {
        const res = await fetch(`/share/api/links/${encodeURIComponent(token)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            intro: this.editIntro || null,
            expires_at: this.editExpiresAt || null,
            show_toc: this.editShowToc,
          }),
        });
        if (!res.ok) throw new Error('patch failed');
        await this.loadLinks();
        this.cancelEdit();
      } catch (e) {
        this.loadError = e.message;
      } finally {
        this.savingEdit = false;
      }
    },

    // „Kommentare anzeigen": in die passende Editor-Ansicht wechseln, wo die
    // Kommentar-Leiste verankerte UND allgemeine Threads zeigt + bedienbar macht.
    // Seiten-Share → Notebook-Leseansicht der Seite; Buch-/Kapitel-Share →
    // Bucheditor (ganzer Manuskript-Stream). Markiert den Link zugleich als gesehen.
    async showCommentsForLink(link) {
      const app = window.__app;
      if (!app) return;
      // Unread für diesen Link serverseitig als gesehen markieren (fire-and-forget)
      // + lokal nullen, damit das Badge sofort verschwindet.
      fetch(`/share/api/links/${encodeURIComponent(link.token)}/comments?mark_seen=1`).catch(() => {});
      link.unread_count = 0;
      app.refreshShareCommentCounts?.();
      if (link.kind === 'chapter' || link.kind === 'book') {
        if (!app.showBookEditorCard) await app.toggleBookEditorCard?.();
        // Ohne bid: Leiste nur öffnen (kein Sprung zu einer bestimmten Stelle).
        window.dispatchEvent(new CustomEvent(EVT.BOOK_EDITOR_GOTO_COMMENT));
        return;
      }
      // Seiten-Share: zur Seite navigieren, dann die Notebook-Leiste öffnen.
      const pageId = link.page_id;
      if (!pageId) { this.loadError = app.t('share.comments.pageGone'); return; }
      app.gotoPageById(pageId);
      // Verzögert, damit der Seitenwechsel-Reset der Leiste (commentRailVisible=false
      // im currentPage-Watcher) zuerst läuft und das Öffnen gewinnt.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent(EVT.COMMENTS_RAIL_GOTO));
      }, 0);
    },

    async copyLink(token) {
      await copyText(this.linkUrl(token));
      this.copiedToken = token;
      if (this._copiedTimer) clearTimeout(this._copiedTimer);
      this._copiedTimer = setTimeout(() => { this.copiedToken = null; }, 2500);
    },

    formatExpires(iso) {
      if (!iso) return '';
      try {
        const d = new Date(iso);
        return d.toLocaleString(localeTag(Alpine.store('shell').uiLocale), tzOpts({
          dateStyle: 'medium',
          timeStyle: 'short',
        }));
      } catch { return iso; }
    },

    // Erstellungs-Datum (gleiches Format wie formatExpires).
    formatCreated(iso) {
      return this.formatExpires(iso);
    },

    // Durchschnittliche Lesedauer als kompakter Text: „2m 18s" / „45s" / „1h 3m".
    // Leerer String, wenn (noch) keine Dauer erfasst wurde (z. B. nur Bot-Aufrufe
    // ohne JS) — die Zeile wird dann ausgeblendet.
    formatDwell(ms) {
      if (!ms || ms <= 0) return '';
      const totalSec = Math.round(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    },

    // Gesamt-Lesetiefe als „Ø 62 % gelesen" (leer wenn nichts erfasst).
    formatScroll(pct) {
      if (pct == null || pct < 0) return '';
      return window.__app.t('share.readdepth.avg', { pct: Math.round(pct) });
    },

    // Durchschnitts-Sterne als voll/leer-Reihe (Anzeige) — z. B. für avg_rating 3.6
    // → 4 volle (gerundet) für die kompakte Zeile; die genaue Zahl steht daneben.
    ratingStars(avg) {
      const n = Math.round(avg || 0);
      return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
    },

    // Statistik-Panel eines Links auf-/zuklappen. Beim Öffnen Kapitel-Drop-off +
    // Fazits nachladen (on-demand, nicht im Poll — teurer JOIN/Scan).
    async toggleStats(link) {
      if (this.expandedStatsToken === link.token) { this.expandedStatsToken = null; return; }
      this.expandedStatsToken = link.token;
      this.statsReadDepth = [];
      this.statsFeedback = [];
      this.statsLoading = true;
      try {
        const [depth, fb] = await Promise.all([
          fetchJson(`/share/api/links/${encodeURIComponent(link.token)}/read-depth`).catch(() => ({ chapters: [] })),
          fetchJson(`/share/api/links/${encodeURIComponent(link.token)}/feedback`).catch(() => ({ feedback: [] })),
        ]);
        this.statsReadDepth = Array.isArray(depth?.chapters) ? depth.chapters : [];
        this.statsFeedback = Array.isArray(fb?.feedback) ? fb.feedback : [];
      } finally {
        this.statsLoading = false;
      }
    },

    // Ein-Fazit-Sterne (voll/leer) für die Detail-Liste.
    feedbackStars(rating) {
      const n = Math.max(0, Math.min(5, rating || 0));
      return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
    },

    // Restgültigkeit als ein lesbarer Satz pro Link-Zustand:
    //  - widerrufen → '' (Status-Badge zeigt es bereits)
    //  - kein Ablauf → „Unbegrenzt gültig"
    //  - abgelaufen → „Abgelaufen am {date}"
    //  - aktiv mit Ablauf → „Läuft {rel} ab ({date})", rel = lokalisierte Restzeit
    validityLabel(link) {
      const app = window.__app;
      if (!app) return '';
      if (link.revoked_at) return '';
      if (!link.expires_at) return app.t('share.expires.unlimited');
      const exp = new Date(link.expires_at);
      const date = this.formatExpires(link.expires_at);
      if (isNaN(exp.getTime())) return '';
      if (exp <= new Date()) return app.t('share.expires.expiredAt', { date });
      return app.t('share.expires.remaining', { rel: this._relFuture(exp), date });
    },

    // Lokalisierte Restzeit in die Zukunft („in 3 Tagen"/„in 5 Stunden") via
    // Intl.RelativeTimeFormat. Unter 1 Minute auf 1 geklemmt, damit nie
    // „in 0 Minuten" erscheint.
    _relFuture(d) {
      const tag = localeTag(Alpine.store('shell').uiLocale);
      const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
      const diffMin = Math.round((d.getTime() - Date.now()) / 60000);
      if (diffMin < 60) return rtf.format(Math.max(diffMin, 1), 'minute');
      const diffH = Math.round(diffMin / 60);
      if (diffH < 24) return rtf.format(diffH, 'hour');
      return rtf.format(Math.round(diffH / 24), 'day');
    },
  }));
}
