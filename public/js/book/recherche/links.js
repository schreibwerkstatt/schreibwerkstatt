// Verknuepfungs-Ebene der Recherche-Karte: Link-Picker, Sprung zum verknuepften
// Element, die KI-Verknuepfungsvorschlaege (Job /jobs/research-link) und die
// Erreichbarkeits-Pruefung der URLs (Job /jobs/research-link-check).

import { fetchJson } from '../../utils.js';
import { startPoll } from '../../cards/job-helpers.js';

export const rechercheLinkMethods = {
  // ── Verknüpfungen ──────────────────────────────────────────────────────────
  // Picker-Popover (DESIGN.md „Picker-Popover"), verankert an `anchor`
  // (Menue-Anker in Liste/Board-Karte, Verknuepfen-Knopf im Detail-Dialog).
  async openLinkPicker(item, anchor = null) {
    await this.ensureLinkTargets();
    this.linkPickerItemId = item.id;
    this.linkPickerKind = 'page';
    this.linkPickerTargetId = '';
    this.$nextTick(() => {
      if (this.linkPickerItemId !== item.id) return;
      this._openPickerPopover(anchor, 'rechercheLinkPopover', () => this.cancelLinkPicker());
    });
  },
  cancelLinkPicker() {
    this.linkPickerItemId = null;
    this.linkPickerTargetId = '';
    this._releasePickerPopover();
  },
  linkPickerItem() {
    if (this.linkPickerItemId == null) return null;
    return (this.items || []).find(i => i.id === this.linkPickerItemId) || null;
  },

  // Ziel-Optionen des Link-Pickers baut die generische entityPicker-Komponente
  // (entity 'target') aus `linkTargets[linkPickerKind]`.

  async addLink(itemId, targetKind, targetId) {
    const app = window.__app;
    if (!targetKind || !targetId) return;
    try {
      const row = await fetchJson(`/research/${itemId}/links`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_kind: targetKind, target_id: parseInt(targetId, 10) }),
      });
      this._replaceItem(row);
      this.cancelLinkPicker();
      if (targetKind === 'page') this._refreshRechercheCounts('page');
      if (targetKind === 'chapter') this._refreshRechercheCounts('chapter');
    } catch { this.errorMessage = app.t('recherche.error.link'); }
  },

  async confirmLinkPicker() {
    if (!this.linkPickerItemId || !this.linkPickerTargetId) return;
    return this.addLink(this.linkPickerItemId, this.linkPickerKind, this.linkPickerTargetId);
  },

  // Sprung zum verknüpften Element: baut den Deep-Link-Hash und überlässt die
  // eigentliche Navigation (Karte öffnen, Eintrag fokussieren, Exklusivität)
  // dem Hash-Router als SSoT. Kind → Router-View-Segment; thread hat keinen
  // Deep-Link-Arg (nur Board öffnen), alle anderen springen per target_id.
  gotoLink(link) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !link) return;
    const VIEW = {
      figure: 'figur', location: 'ort', scene: 'szene',
      beat: 'plot', thread: 'plot', chapter: 'kapitel', page: 'page',
    };
    const view = VIEW[link.target_kind];
    if (!view) return;
    const arg = (link.target_kind !== 'thread' && link.target_id != null)
      ? `/${link.target_id}` : '';
    location.hash = `#book/${bookId}/${view}${arg}`;
  },

  async removeLink(item, link) {
    try {
      const row = await fetchJson(`/research/${item.id}/links/${link.link_id}`, { method: 'DELETE' });
      this._replaceItem(row);
      if (link.target_kind === 'page') this._refreshRechercheCounts('page');
      if (link.target_kind === 'chapter') this._refreshRechercheCounts('chapter');
    } catch { this.errorMessage = window.__app.t('recherche.error.link'); }
  },

  // ── KI-Verknüpfungsvorschläge ──────────────────────────────────────────────
  async suggestLinks(item) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    this.suggestItemId = item.id;
    this.suggestStatus = app.t('recherche.suggest.running');
    this.suggestions = { ...this.suggestions, [item.id]: null };
    this.closeActionMenu();
    try {
      const { jobId } = await fetchJson('/jobs/research-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, item_id: item.id }),
      });
      startPoll(this, {
        timerProp: '_suggestTimer',
        jobId,
        onNotFound: () => { this.suggestItemId = null; this.suggestStatus = ''; },
        onError: () => {
          this.suggestItemId = null;
          this.suggestStatus = '';
          this.errorMessage = app.t('recherche.suggest.error');
        },
        onDone: (job) => {
          this.suggestItemId = null;
          this.suggestStatus = '';
          const list = job.result?.suggestions || [];
          this.suggestions = { ...this.suggestions, [item.id]: list };
          if (!list.length) this.suggestStatus = app.t('recherche.suggest.none');
        },
      });
    } catch (e) {
      this.suggestItemId = null;
      this.suggestStatus = '';
      this.errorMessage = app.t('recherche.suggest.error');
    }
  },

  async acceptSuggestion(item, sugg) {
    await this.addLink(item.id, sugg.target_kind, sugg.target_id);
    const list = (this.suggestions[item.id] || []).filter(
      s => !(s.target_kind === sugg.target_kind && s.target_id === sugg.target_id)
    );
    this.suggestions = { ...this.suggestions, [item.id]: list };
  },
  dismissSuggestions(item) {
    const next = { ...this.suggestions };
    delete next[item.id];
    this.suggestions = next;
  },
  itemSuggestions(item) { return this.suggestions[item.id] || null; },

  // ── Link-Pruefung ──────────────────────────────────────────────────────────
  // Prueft alle URLs der nicht archivierten Fundstuecke des Buchs (serverseitig
  // ueber safeFetch). Ergebnis steht danach an jeder URL (`check_ok` …).
  async checkLinks() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.linkCheckRunning) return;
    this.linkCheckRunning = true;
    this.linkCheckStatus = app.t('recherche.linkCheck.running');
    try {
      const { jobId } = await fetchJson('/jobs/research-link-check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      startPoll(this, {
        timerProp: '_linkCheckTimer',
        jobId,
        onProgress: (job) => { if (job.statusText) this.linkCheckStatus = app.t(job.statusText, job.statusParams || {}); },
        onNotFound: () => { this.linkCheckRunning = false; this.linkCheckStatus = ''; },
        onError: () => {
          this.linkCheckRunning = false;
          this.linkCheckStatus = '';
          this.errorMessage = app.t('recherche.linkCheck.error');
        },
        onDone: async (job) => {
          this.linkCheckRunning = false;
          const r = job.result || {};
          this.linkCheckStatus = app.t(r.dead ? 'recherche.linkCheck.doneDead' : 'recherche.linkCheck.done', { n: r.checked || 0, dead: r.dead || 0 });
          await this.loadRecherche();
        },
      });
    } catch {
      this.linkCheckRunning = false;
      this.linkCheckStatus = '';
      this.errorMessage = app.t('recherche.linkCheck.error');
    }
  },
  urlDead(u) { return !!u?.checked_at && u.check_ok === false; },
  // Ok, aber mit Zugangssperre (401/403/429) — kein toter Link, aber auch kein Beweis.
  urlBlocked(u) { return !!u?.checked_at && u.check_ok === true && [401, 403, 429].includes(u.check_code); },
  urlCheckTip(u) {
    const app = window.__app;
    if (u?.check_code) return app.t('recherche.linkCheck.code', { code: u.check_code });
    return app.t(`recherche.linkCheck.err.${u?.check_error || 'NETWORK'}`);
  },
  // Archivkopie bei der Wayback Machine: reiner Link, kein Server-Request.
  waybackUrl(u) { return `https://web.archive.org/web/*/${u.url}`; },
};
