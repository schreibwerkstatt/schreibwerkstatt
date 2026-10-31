// Alpine.data('snapshotsCard') — Manuskript-Meilensteine („Fassung 1/2/3").
// Hauptkarte auf Buchebene. Liste aller Fassungen + „Neue Fassung erstellen"
// (Capture des ganzen Buchs) + Vergleich zweier Fassungen (Buch-Level-Diff via
// book-snapshot-diff.js, Seiten-Diff via page-revision-diff.js#renderSideBySide)
// + Reader (Fassung nur-lesend oeffnen) + Export (HTML/TXT/MD/EPUB/DOCX sync,
// PDF via Job) + Restore (ganzes Buch / einzelne Seite, snapshots-restore.js).

import { fetchJson, numberFormat, fmtBytes } from '../utils.js';
import { loadDiff } from '../lazy-libs.js';
import { fromSnapshotTree } from '../manuscript-stream.js';
import { renderInline } from '../page-revision-diff.js';
import { snapshotsPdfMethods } from './snapshots-pdf-export.js';
import { snapshotsCompareMethods } from './snapshots-compare.js';
import { snapshotsDriftMethods } from './snapshots-drift.js';
import { snapshotsTrashMethods } from './snapshots-trash.js';
import { snapshotsRestoreMethods } from './snapshots-restore.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { loadToken } from './book-guard.js';

// Modul-Cache fuer Fassungs-Vollzeilen. Das `content_json` einer Fassung kann
// MB gross sein; es ist aber unveraenderlich pro id (kein retroaktives Update,
// siehe docs/fassungen.md) → cachebar, damit weder der Combobox-Wechsel im
// Vergleich noch das erneute Oeffnen im Reader die Zeile neu ziehen muss.
// Snapshot-id ist ein globaler PK, deshalb kein book-Scoping noetig. Der
// (mutierbare) `published_at`-Badge kommt fuer die Anzeige aus der Liste, nicht
// aus dieser gecachten Zeile. LRU mit kleiner Obergrenze: ein Vergleich braucht
// zwei Zeilen, der Reader eine — mehr haelt den Tab nur mit MB-Bloecken voll.
const SNAPSHOT_CACHE_MAX = 4;
const _snapshotCache = new Map(); // snapshotId(String) -> snapshot object

export function registerSnapshotsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('snapshotsCard', () => ({
    ...snapshotsPdfMethods,
    ...snapshotsCompareMethods,
    ...snapshotsDriftMethods,
    ...snapshotsTrashMethods,
    ...snapshotsRestoreMethods,
    snapshots: [],
    loading: false,
    capturing: false,
    deletingId: null,
    restoringId: null,
    restoringNodeKey: null, // Reader: Sektions-Key der gerade wiederhergestellten Seite/des Kapitels
    publishingId: null,
    newLabel: '',
    newDescription: '',
    _bookId: null,

    // Drift-Check: lohnt sich seit der letzten Fassung eine neue?
    drift: null,           // { hasBaseline, baseline?, drift? } aus GET …/drift
    driftLoading: false,
    driftDismissed: false, // Hinweis weggeklickt (fuer die aktuelle Drift-Signatur)

    // Papierkorb: geloeschte, wiederherstellbare Seiten (GET /content/books/:id/trash).
    trash: [],
    trashRestoringId: null,

    // Vergleich.
    compareFrom: '',
    compareTo: '',
    diff: null,            // { summary, entries }
    pubDiff: [],           // [{ key, kind, from, to }] — geaenderte Publikations-Metadaten
    diffLoading: false,
    diffError: '',
    showUnchanged: false,
    expanded: {},          // srcId -> rendered side-by-side HTML (lazy)
    expandLoading: {},     // srcId -> bool

    // Reader (Fassung nur-lesend oeffnen, Bucheditor-Look) + Export.
    readerOpen: false,
    readerSnap: null,      // Meta der geoeffneten Fassung
    readerSections: [],    // [{ kind:'chapter'|'page', name, depth, html, id, status, renderHtml, key }]
    readerLoading: false,
    readerAddedSince: 0,   // Seiten, die seit der Fassung neu dazugekommen sind
    readerCurrentFailed: false, // aktueller Buchstand nicht ladbar → Fassung ohne Vergleich
    readerExtras: null,    // { figures, locations, … } — eingefrorener Weltaufbau-/Lektorat-Stand
    readerPublication: null, // eingefrorene Publikations-Metadaten (Titelei/ISBN/Cover-Flags) zum Fassungs-Zeitpunkt
    pdfProfiles: [],
    pdfProfileId: '',
    pdfExporting: false,
    pdfStatus: '',
    pdfError: '',
    pdfJobId: null,
    _pdfPollTimer: null,   // transienter Timer-Guard (siehe startPoll)
    _snapshotsLoadSeq: 0,  // Lade-Token (book-guard.js#loadToken)
    _lifecycle: null,

    init() {
      const app = window.__app;
      if (Alpine.store('nav').selectedBookId && app?.showSnapshotsCard) this.loadSnapshots(Alpine.store('nav').selectedBookId);

      this.$watch(() => window.__app?.showSnapshotsCard, (on) => {
        if (on && Alpine.store('nav').selectedBookId) this.loadSnapshots(Alpine.store('nav').selectedBookId);
      });

      this._lifecycle = setupCardLifecycle(this, {
        name: 'snapshots',
        // Reset + bei offener Karte gleich das neue Buch laden — sonst bliebe
        // die Karte leer stehen, bis jemand sie neu öffnet.
        onBookChanged: () => {
          this.reset();
          const bookId = Alpine.store('nav').selectedBookId;
          if (bookId && window.__app?.showSnapshotsCard) this.loadSnapshots(bookId);
        },
        onViewReset: () => this.reset(),
        onCardRefresh: () => this.loadSnapshots(Alpine.store('nav').selectedBookId, { fresh: true }),
      });
    },

    destroy() {
      this._lifecycle?.destroy();
      this._stopPdfPoll();
      document.body.classList.remove('snapshot-reader-open');
    },

    reset() {
      this.snapshots = [];
      this.loading = false;
      this.capturing = false;
      this.deletingId = null;
      this.restoringId = null;
      this.restoringNodeKey = null;
      this.publishingId = null;
      this.newLabel = '';
      this.newDescription = '';
      this._bookId = null;
      this.drift = null;
      this.driftLoading = false;
      this.driftDismissed = false;
      this.trash = [];
      this.trashRestoringId = null;
      this._resetCompare();
      this.closeReader();
    },

    _resetCompare() {
      this.compareFrom = '';
      this.compareTo = '';
      this.diff = null;
      this.pubDiff = [];
      this.diffLoading = false;
      this.diffError = '';
      this.expanded = {};
      this.expandLoading = {};
    },

    async loadSnapshots(bookId, { fresh = false } = {}) {
      if (!bookId) return;
      const isCurrent = loadToken(this, '_snapshotsLoadSeq', bookId);
      this._bookId = bookId;
      this.loading = true;
      try {
        const url = `/snapshots/${bookId}${fresh ? '?__fresh=1' : ''}`;
        const data = await fetchJson(url);
        if (!isCurrent()) return;
        this.snapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
        this._autoSelectCompare();
      } catch (e) {
        console.error('[snapshots:load]', e);
        if (!isCurrent()) return;
        this.snapshots = [];
      } finally {
        if (isCurrent.latest()) this.loading = false;
      }
      if (!isCurrent()) return;
      // Drift gegen die juengste Fassung nachladen (nur wenn es eine gibt).
      this.loadDrift(bookId);
      this.loadTrash(bookId);
    },

    // Default: juengste vs. zweitjuengste Fassung (Liste ist DESC sortiert).
    _autoSelectCompare() {
      if (this.snapshots.length >= 2) {
        this.compareTo = String(this.snapshots[0].id);
        this.compareFrom = String(this.snapshots[1].id);
      } else {
        this.compareFrom = '';
        this.compareTo = '';
      }
      this.diff = null;
      this.pubDiff = [];
      this.expanded = {};
    },

    // ── Capture ─────────────────────────────────────────────────────────────────
    async captureSnapshot() {
      const app = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId || this.capturing) return;
      this.capturing = true;
      try {
        const r = await fetch(`/snapshots/${bookId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: this.newLabel.trim() || null,
            description: this.newDescription.trim() || null,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error_code || `HTTP ${r.status}`);
        }
        this.newLabel = '';
        this.newDescription = '';
        await this.loadSnapshots(bookId, { fresh: true });
        app.setStatus?.(app.t('snapshots.captured'), false, 4000);
      } catch (e) {
        console.error('[snapshots:capture]', e);
        const msg = e.message === 'BOOK_EMPTY' ? app.t('snapshots.errorEmpty') : (app.t('snapshots.captureFailed') + ' ' + (e.message || ''));
        app.setStatus?.(msg, true, 6000);
      } finally {
        this.capturing = false;
      }
    },

    isPublished(snap) {
      return !!snap?.published_at;
    },

    // Fassungs-Vollzeile (content/publication/extras) — unveraenderlich, daher
    // aus dem Modul-Cache bedient; erst beim Miss ein Fetch. Genutzt von Vergleich
    // (runCompare) und Reader (openSnapshot).
    async _fetchSnapshot(bookId, id) {
      const key = String(id);
      if (_snapshotCache.has(key)) {
        const hit = _snapshotCache.get(key);
        _snapshotCache.delete(key);
        _snapshotCache.set(key, hit);
        return hit;
      }
      const data = await fetchJson(`/snapshots/${bookId}/${id}`);
      const snap = data?.snapshot || null;
      if (snap) {
        _snapshotCache.set(key, snap);
        while (_snapshotCache.size > SNAPSHOT_CACHE_MAX) _snapshotCache.delete(_snapshotCache.keys().next().value);
      }
      return snap;
    },

    async deleteSnapshot(snap, force = false) {
      const app = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      if (!snap?.id || !bookId || this.deletingId) return;
      if (!force) {
        const ok = await app.appConfirm({
          message: app.t('snapshots.deleteConfirm', { n: snap.seq }),
          confirmLabel: app.t('snapshots.delete'),
          danger: true,
        });
        if (!ok) return;
      }
      this.deletingId = snap.id;
      try {
        const url = `/snapshots/${bookId}/${snap.id}${force ? '?force=1' : ''}`;
        const r = await fetch(url, { method: 'DELETE' });
        if (r.status === 409) {
          // Veroeffentlichte Fassung ist schreibgeschuetzt → staerkere Bestaetigung,
          // dann mit force erneut.
          this.deletingId = null;
          const ok = await app.appConfirm({
            message: app.t('snapshots.deletePublishedConfirm', { n: snap.seq }),
            confirmLabel: app.t('snapshots.delete'),
            danger: true,
          });
          if (ok) return this.deleteSnapshot(snap, true);
          return;
        }
        if (r.status === 403 && force) {
          // Veroeffentlichte Fassung: nur der Owner darf sie loeschen.
          app.setStatus?.(app.t('snapshots.deletePublishedOwnerOnly'), true, 6000);
          return;
        }
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error_code || `HTTP ${r.status}`);
        }
        await this.loadSnapshots(bookId, { fresh: true });
        app.setStatus?.(app.t('snapshots.deleted'), false, 3000);
      } catch (e) {
        console.error('[snapshots:delete]', e);
        app.setStatus?.(app.t('snapshots.deleteFailed') + ' ' + (e.message || ''), true, 6000);
      } finally {
        this.deletingId = null;
      }
    },

    // ── Veroeffentlichen (Fassung als Auflage markieren) ───────────────────────────
    async togglePublish(snap) {
      const app = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      if (!snap?.id || !bookId || this.publishingId) return;
      const next = !this.isPublished(snap);
      this.publishingId = snap.id;
      try {
        const r = await fetch(`/snapshots/${bookId}/${snap.id}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ published: next }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error_code || `HTTP ${r.status}`);
        }
        await this.loadSnapshots(bookId, { fresh: true });
        app.setStatus?.(app.t(next ? 'snapshots.publishedOn' : 'snapshots.publishedOff', { n: snap.seq }), false, 4000);
      } catch (e) {
        console.error('[snapshots:publish]', e);
        app.setStatus?.(app.t('snapshots.publishFailed') + ' ' + (e.message || ''), true, 6000);
      } finally {
        this.publishingId = null;
      }
    },

    // Restore (ganzes Buch + einzelne Seite/Kapitel): ...snapshotsRestoreMethods.

    // ── Reader (Fassung nur-lesend, Bucheditor-Look, Diff gegen aktuell) ────────────
    async openSnapshot(snap) {
      const app = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      if (!snap?.id || !bookId) return;
      this.readerSnap = snap;
      this.readerOpen = true;
      document.body.classList.add('snapshot-reader-open');
      this.readerLoading = true;
      this.readerSections = [];
      this.readerAddedSince = 0;
      this.readerCurrentFailed = false;
      this.readerExtras = null;
      this.readerPublication = null;
      this._resetPdfExport();
      // PDF-Profile lazy laden (fuer das Export-Menue im Reader).
      this.loadPdfProfiles();
      try {
        // Fassungs-Inhalt + aktueller Buchstand parallel. Letzterer liefert die
        // Vergleichsbasis fuer den Inline-Diff (Match via srcId == page_id).
        // Fassungs-Zeile aus dem Cache (unveraenderlich); der aktuelle Buchstand
        // muss frisch sein (mutierbar) → immer Fetch.
        // Scheitert der aktuelle Stand, zeigt der Reader die Fassung ohne
        // Vergleich — sonst sahen alle Abschnitte „im aktuellen Buch geloescht"
        // aus und boten „übernehmen" an.
        const [snapshot, curData] = await Promise.all([
          this._fetchSnapshot(bookId, snap.id),
          fetchJson(`/book-editor/${bookId}/contents`).catch((e) => {
            console.error('[snapshots:open:current]', e);
            return null;
          }),
        ]);
        this.readerCurrentFailed = !curData;
        this.readerExtras = snapshot?.extras_summary || null;
        this.readerPublication = snapshot?.publication || null;
        const sections = this._buildReaderSections(snapshot?.content);
        const currentById = new Map();
        for (const p of (curData?.pages || [])) currentById.set(p.pageId, p.html || '');

        const diffLib = curData ? await loadDiff().catch(() => null) : null;
        const snapIds = new Set();
        for (const s of sections) {
          if (s.kind !== 'page') continue;
          if (s.id != null) snapIds.add(s.id);
          if (!curData) { s.status = ''; s.renderHtml = s.html; continue; }
          const curHtml = s.id != null ? currentById.get(s.id) : undefined;
          if (curHtml === undefined) {
            // In der Fassung vorhanden, im aktuellen Buch geloescht.
            s.status = 'removed';
            s.renderHtml = s.html;
            continue;
          }
          if (!diffLib) { s.status = ''; s.renderHtml = s.html; continue; }
          try {
            const out = renderInline(s.html, curHtml, diffLib);
            s.status = out.unchanged ? 'unchanged' : 'changed';
            s.renderHtml = out.unchanged ? s.html : out.html;
          } catch (e) {
            console.error('[snapshots:inlineDiff]', e);
            s.status = ''; s.renderHtml = s.html;
          }
        }
        // Seiten, die seit der Fassung neu dazugekommen sind.
        let added = 0;
        if (curData) for (const pid of currentById.keys()) if (!snapIds.has(pid)) added += 1;
        this.readerAddedSince = added;
        this.readerSections = sections;
      } catch (e) {
        console.error('[snapshots:open]', e);
        this.readerSections = [];
      } finally {
        this.readerLoading = false;
      }
    },

    closeReader() {
      this.readerOpen = false;
      document.body.classList.remove('snapshot-reader-open');
      this.readerSnap = null;
      this.readerSections = [];
      this.readerAddedSince = 0;
      this.readerCurrentFailed = false;
      this.readerExtras = null;
      this.readerPublication = null;
      this._resetPdfExport();
      this._stopPdfPoll();
    },

    // Eingefrorener Weltaufbau-/Lektorat-Stand als anzeigbare Liste
    // [{ label, value }] — nur Bloecke mit >0. Publikations-Nachweis im Reader.
    readerExtraItems() {
      const e = this.readerExtras;
      if (!e) return [];
      const app = window.__app;
      const keys = ['figures', 'locations', 'scenes', 'events', 'worldFacts', 'continuityIssues', 'ideen', 'lektoratFindings'];
      return keys
        .filter(k => Number(e[k]) > 0)
        .map(k => ({ label: app.t('snapshots.extras.' + k), value: this.formatNum(e[k]) }));
    },

    // Eingefrorene Publikations-Metadaten als kompakter Tag-Strip
    // [{ key, text }] — nur gesetzte Felder. Kurze Wertfelder als „Label: Wert",
    // Prosa-/Bild-Felder als reines Vorhandensein-Tag. Reuse der pub.*-Labels
    // (dieselben wie im Vergleichs-Publikations-Diff).
    readerPublicationItems() {
      const p = this.readerPublication;
      if (!p) return [];
      const app = window.__app;
      const label = (k) => app.t('snapshots.pub.' + k);
      const out = [];
      const valueKeys = ['author_name', 'subtitle', 'isbn', 'year', 'publisher', 'series', 'series_index'];
      for (const k of valueKeys) {
        const v = (p[k] == null ? '' : String(p[k])).trim();
        if (v) out.push({ key: k, text: `${label(k)}: ${v}` });
      }
      const presenceKeys = ['dedication', 'imprint', 'copyright', 'frontmatter', 'author_bio', 'has_cover', 'has_author_image'];
      for (const k of presenceKeys) {
        const has = k.startsWith('has_') ? !!p[k] : !!String(p[k] == null ? '' : p[k]).trim();
        if (has) out.push({ key: k, text: label(k) });
      }
      return out;
    },

    // Snapshot-Tree (buildBookJson-Format) → kanonisches Stream-Modell
    // (fromSnapshotTree, geteilt mit Bucheditor/Share). Page-Entries werden um
    // die Reader-Diff-State-Felder (status/renderHtml) ergaenzt; `id` ist die
    // alte page_id (srcId), gegen die der Inline-Diff matcht.
    _buildReaderSections(content) {
      return fromSnapshotTree(content?.tree).map((e) =>
        e.kind === 'page' ? { ...e, status: '', renderHtml: e.html } : e);
    },

    // ── Export (aus dem Reader) ─────────────────────────────────────────────────────
    // Schnell-Formate: direkter Download-Link auf die Sync-Route.
    quickFormats() {
      return ['html', 'epub', 'docx', 'md', 'txt'];
    },

    formatLabel(fmt) {
      return window.__app.t('book.export.' + fmt);
    },

    exportUrl(fmt) {
      const app = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId || !this.readerSnap?.id) return '#';
      return `/snapshots/${bookId}/${this.readerSnap.id}/export/${fmt}`;
    },

    // PDF-Export (Job + Polling + Download): ...snapshotsPdfMethods, siehe unten.

    // ── Anzeige-Helfer ────────────────────────────────────────────────────────────
    // Server kann ein Label als __i18n:key__-Marker persistieren (z.B. die
    // Auto-Sicherung vor einem Restore) — in der Locale des Betrachters aufloesen.
    _resolveLabel(label) {
      const m = /^__i18n:([a-zA-Z0-9_.-]+)__$/.exec(label || '');
      return m ? window.__app.t(m[1]) : label;
    },

    fassungLabel(snap) {
      const app = window.__app;
      const base = app.t('snapshots.fassung', { n: snap.seq });
      const label = this._resolveLabel(snap.label);
      return label ? `${base} · ${label}` : base;
    },

    publishedDateLabel(snap) {
      if (!snap?.published_at) return '';
      const app = window.__app;
      const when = app?.formatDate ? app.formatDate(snap.published_at) : snap.published_at;
      return app.t('snapshots.publishedBadge', { when });
    },

    snapOptionLabel(snap) {
      const app = window.__app;
      const when = app?.formatDate ? app.formatDate(snap.created_at) : snap.created_at;
      return `${this.fassungLabel(snap)} — ${when}`;
    },

    snapshotOptions() {
      return this.snapshots.map(s => ({ value: String(s.id), label: this.snapOptionLabel(s) }));
    },

    formatNum(n) {
      return numberFormat(Alpine.store('shell').uiLocale).format(Number(n || 0));
    },

    formatSize(bytes) {
      return fmtBytes(bytes, Alpine.store('shell').uiLocale);
    },

    formatDelta(d) {
      if (d == null) return '';
      return numberFormat(Alpine.store('shell').uiLocale, { signDisplay: 'exceptZero' }).format(Number(d));
    },

    // Delta gegen die naechstaeltere Fassung (Liste DESC → idx+1).
    charsDelta(idx) {
      const cur = this.snapshots[idx];
      const prev = this.snapshots[idx + 1];
      if (!cur || !prev) return null;
      return Number(cur.chars || 0) - Number(prev.chars || 0);
    },

    isOwn(snap) {
      const me = Alpine.store('session').currentUser?.email;
      return !!me && !!snap?.user_email && String(me).toLowerCase() === String(snap.user_email).toLowerCase();
    },

    // Vergleich zweier Fassungen: ...snapshotsCompareMethods (siehe oben).
  }));
}
