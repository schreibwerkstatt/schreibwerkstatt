// Verknuepfungs-Ebene der Recherche-Karte: Link-Picker, Sprung zum verknuepften
// Element, die KI-Verknuepfungsvorschlaege (Job /jobs/research-link) und die
// Erreichbarkeits-Pruefung der URLs (Job /jobs/research-link-check).

import { fetchJson, linkText } from '../../utils.js';
import { startPoll } from '../../cards/job-helpers.js';
import { isSelectedBook } from '../../cards/book-guard.js';

// Fehlerarten der Link-Pruefung (lib/url-check.js → `check_error`), je mit Key
// recherche.linkCheck.err.<CODE>. Unbekanntes faellt auf NETWORK zurueck, statt
// den rohen Key zu zeigen.
const LINK_CHECK_ERRORS = new Set(['SSRF_BLOCKED', 'TIMEOUT', 'REDIRECT', 'NETWORK', 'DNS', 'INVALID']);

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

  // true = Verknüpfung steht; false = nichts passiert (Meldung in errorMessage).
  async addLink(itemId, targetKind, targetId) {
    const app = window.__app;
    if (!targetKind || !targetId) return false;
    try {
      const row = await fetchJson(`/research/${itemId}/links`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_kind: targetKind, target_id: parseInt(targetId, 10) }),
      });
      this._replaceItem(row);
      this.cancelLinkPicker();
      if (targetKind === 'page') this._refreshRechercheCounts('page');
      if (targetKind === 'chapter') this._refreshRechercheCounts('chapter');
      return true;
    } catch {
      this.errorMessage = app.t('recherche.error.link');
      return false;
    }
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
  // Parallel je Fundstück: jeder Lauf hat seinen eigenen Poller in
  // `_suggestTimers[itemId]` (die Map ist der ctx von startPoll, der Schlüssel
  // der timerProp) und seine eigene Knopfsperre in `suggestRunning[itemId]`.
  // Ein zweiter Lauf am selben Fundstück wartet auf den ersten.
  suggestBusy(itemId) { return !!this.suggestRunning[itemId]; },
  _setSuggestRunning(itemId, on) {
    const next = { ...this.suggestRunning };
    if (on) next[itemId] = true; else delete next[itemId];
    this.suggestRunning = next;
  },
  // Alle Vorschlags-Poller stoppen (Buchwechsel, View-Reset, destroy). Den
  // Handle nullen statt die Map zu ersetzen: startPoll prüft `ctx[key] === timer`
  // auf der Map, die es bekommen hat — ein genullter Eintrag lässt einen noch
  // fliegenden Tick still aussteigen.
  _stopSuggestPolls() {
    const timers = this._suggestTimers || {};
    for (const k of Object.keys(timers)) {
      if (timers[k]) clearInterval(timers[k]);
      timers[k] = null;
    }
    this._suggestTimers = {};
  },

  async suggestLinks(item) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !item || this.suggestBusy(item.id)) return;
    const itemId = item.id;
    this._setSuggestRunning(itemId, true);
    this.suggestions = { ...this.suggestions, [itemId]: null };
    const fail = () => {
      this._setSuggestRunning(itemId, false);
      this.errorMessage = app.t('recherche.suggest.error');
    };
    try {
      const { jobId } = await fetchJson('/jobs/research-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, item_id: itemId }),
      });
      if (!isSelectedBook(bookId)) return;
      startPoll(this._suggestTimers, {
        timerProp: String(itemId),
        jobId,
        onNotFound: () => this._setSuggestRunning(itemId, false),
        onError: fail,
        onDone: (job) => {
          this._setSuggestRunning(itemId, false);
          const list = job.result?.suggestions || [];
          this.suggestions = { ...this.suggestions, [itemId]: list };
        },
      });
    } catch {
      if (isSelectedBook(bookId)) fail();
    }
  },

  async acceptSuggestion(item, sugg) {
    if (!await this.addLink(item.id, sugg.target_kind, sugg.target_id)) return;
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
          this.linkCheckStatus = app.tn(r.dead ? 'recherche.linkCheck.doneDead' : 'recherche.linkCheck.done', r.checked || 0, { dead: r.dead || 0 });
          await this.loadRecherche();
        },
      });
    } catch {
      this.linkCheckRunning = false;
      this.linkCheckStatus = '';
      this.errorMessage = app.t('recherche.linkCheck.error');
    }
  },
  // Link-Text eines Fundstück-/Vorschlags-Links: Label oder Kurzform der URL
  // (utils/url-display.js); die volle URL steht im Tooltip und im href.
  urlText(u) { return linkText(u?.label, u?.url); },
  urlDead(u) { return !!u?.checked_at && u.check_ok === false; },
  // Ok, aber mit Zugangssperre (401/403/429) — kein toter Link, aber auch kein Beweis.
  urlBlocked(u) { return !!u?.checked_at && u.check_ok === true && [401, 403, 429].includes(u.check_code); },
  urlCheckTip(u) {
    const app = window.__app;
    if (u?.check_code) return app.t('recherche.linkCheck.code', { code: u.check_code });
    const code = LINK_CHECK_ERRORS.has(u?.check_error) ? u.check_error : 'NETWORK';
    return app.t(`recherche.linkCheck.err.${code}`);
  },
  // Archivkopie bei der Wayback Machine: reiner Link, kein Server-Request.
  waybackUrl(u) { return `https://web.archive.org/web/*/${u.url}`; },
};
