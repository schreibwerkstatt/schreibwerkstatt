// Geteilte Basis der drei Export-Karten (PDF/EPUB/DOCX).
//
// Die drei Karten unterscheiden sich im Profil-/Publikations-Modell, in den
// Konfig-Tabs und im Done-Handling — teilen aber den format-agnostischen Kern:
// Scope-Auswahl (Buch/Kapitel/Seite), Job-Submit + Polling + Download und die
// Kapitel-ohne-Nummer-Chips. Diese Slices werden per Spread in die jeweilige
// `Alpine.data(...)` gemischt; die Methodennamen bleiben exakt erhalten, sodass
// die Partials (exportScopeOptions, cancelExport, unnumberedChapterChips, …)
// unverändert funktionieren.
//
// Bewusst NICHT geteilt: init/destroy (book:changed/view:reset divergieren stark
// — PDF unmountet das Form, EPUB lädt Publikation neu, DOCX resettet Scope),
// Profil-/Publikations-CRUD (PDF+DOCX user-scoped Profile, EPUB book_publication)
// und die Fehler-Namespaces (PDF mappt `pdfExport.error.<code>`, DOCX/EPUB nutzen
// `tError` → `error.<code>`) — letzteres bleibt der `errorFor`-Hook.

import { startPoll } from './job-helpers.js';

// ── Scope-Auswahl (Buch/Kapitel/Seite) ───────────────────────────────────────
// Vollständig format-unabhängig, keine Config. Liefert State + Methoden +
// Watch-/Preset-Verdrahtung; die Karte ruft _initScopeWatches()/_bindPreset()
// in ihrem init() auf.
export function exportScopeSlice() {
  return {
    exportScope: 'book',
    exportChapterId: null,
    exportPageId: null,
    exportIncludeSubchapters: false,

    _onExportPreset: null,
    _presetEvent: null,

    _initScopeWatches() {
      this.$watch(() => this.exportScope, () => this._ensureExportPicked());
      this.$watch(() => this.exportChapterId, () => { this.exportIncludeSubchapters = false; });
      this.$watch(() => window.__app?.currentPage?.id, () => this._ensureExportPicked());
    },

    // Preset (Deep-Link/Quick-Action „dieses Kapitel exportieren") binden.
    // event/globalKey sind pro Karte verschieden, das Muster ist identisch.
    _bindPreset(event, globalKey) {
      this._presetEvent = event;
      this._onExportPreset = (e) => this._applyExportPreset(e.detail);
      window.addEventListener(event, this._onExportPreset);
      const pending = window.__app?.[globalKey];
      if (pending) {
        this._applyExportPreset(pending);
        window.__app[globalKey] = null;
      }
    },
    _unbindPreset() {
      if (this._onExportPreset) window.removeEventListener(this._presetEvent, this._onExportPreset);
    },

    exportScopeOptions() {
      const app = window.__app;
      const opts = [{ value: 'book', label: app?.t?.('export.scope.book') || 'Buch' }];
      if (this.exportChapterOptions().length) opts.push({ value: 'chapter', label: app.t('export.scope.chapter') });
      if (this.exportPageOptions().length)    opts.push({ value: 'page',    label: app.t('export.scope.page') });
      return opts;
    },
    exportChapterOptions() {
      const app = window.__app;
      if (!app || !Array.isArray(Alpine.store('nav').tree)) return [];
      return Alpine.store('nav').tree
        .filter(c => c.type === 'chapter' && !c.solo)
        .map(c => ({ value: c.id, label: c.name }));
    },
    selectedChapterHasSubs() {
      const app = window.__app;
      if (!app || !Array.isArray(Alpine.store('nav').tree) || !this.exportChapterId) return false;
      const ch = Alpine.store('nav').tree.find(c => c.type === 'chapter' && c.id === this.exportChapterId);
      return !!ch?.hasChildren;
    },
    exportPageOptions() {
      const app = window.__app;
      if (!app || !Array.isArray(Alpine.store('nav').pages)) return [];
      return Alpine.store('nav').pages.map(p => ({ value: p.id, label: p.name }));
    },
    _applyExportPreset({ kind, id } = {}) {
      if (kind === 'page' && id != null) {
        this.exportPageId = id;
        this.exportScope = 'page';
      } else if (kind === 'chapter' && id != null) {
        this.exportChapterId = id;
        this.exportScope = 'chapter';
      }
    },
    _ensureExportPicked() {
      const app = window.__app;
      const cur = app?.currentPage;
      if (this.exportScope === 'chapter') {
        const opts = this.exportChapterOptions();
        const valid = opts.some(o => o.value === this.exportChapterId);
        if (!valid) this.exportChapterId = cur?.chapter_id || opts[0]?.value || null;
      }
      if (this.exportScope === 'page') {
        const opts = this.exportPageOptions();
        const valid = opts.some(o => o.value === this.exportPageId);
        if (!valid) this.exportPageId = cur?.id || opts[0]?.value || null;
      }
    },
    _exportEntity() {
      const app = window.__app;
      if (!app) return null;
      const scope = this.exportScope || 'book';
      if (scope === 'page' && this.exportPageId) return { scope: 'page', id: this.exportPageId };
      if (scope === 'chapter' && this.exportChapterId) return { scope: 'chapter', id: this.exportChapterId };
      const bid = Alpine.store('nav').selectedBookId;
      return bid ? { scope: 'book', id: parseInt(bid) } : null;
    },
  };
}

// ── Fassungs-Quelle (book_snapshots) ──────────────────────────────────────────
// Optional auf Buch-Scope: statt des Live-Buchs eine gespeicherte Fassung als
// Export-Quelle wählen. Fassungen sind ganze-Buch-Snapshots — daher nur bei
// exportScope === 'book' relevant; bei Kapitel/Seite ignoriert. exportSnapshotId
// === '' bedeutet „aktueller Stand" (Live-Buch). Die Karten laden die Liste in
// ihrem Visibility-Watch + book:changed-Handler via _loadExportSnapshots().
export function exportSnapshotSlice() {
  return {
    exportSnapshots: [],
    exportSnapshotId: '',   // '' = aktueller Stand (Live-Buch)

    async _loadExportSnapshots() {
      const bid = Alpine.store('nav').selectedBookId;
      if (!bid) { this.exportSnapshots = []; this.exportSnapshotId = ''; return; }
      try {
        const r = await fetch(`/snapshots/${parseInt(bid)}`);
        if (!r.ok) { this.exportSnapshots = []; this.exportSnapshotId = ''; return; }
        const d = await r.json();
        this.exportSnapshots = Array.isArray(d.snapshots) ? d.snapshots : [];
        // Auswahl invalidieren, wenn die gemerkte Fassung nicht mehr existiert.
        if (this.exportSnapshotId && !this.exportSnapshots.some(s => String(s.id) === String(this.exportSnapshotId))) {
          this.exportSnapshotId = '';
        }
      } catch {
        this.exportSnapshots = [];
        this.exportSnapshotId = '';
      }
    },

    // Server persistiert Auto-Sicherungs-Labels als __i18n:key__-Marker — in der
    // Locale des Betrachters auflösen (analog snapshots-card).
    _exportSnapLabel(snap) {
      const app = window.__app;
      const base = app.t('snapshots.fassung', { n: snap.seq });
      const m = /^__i18n:([a-zA-Z0-9_.-]+)__$/.exec(snap.label || '');
      const label = m ? app.t(m[1]) : snap.label;
      const when = app.formatDate ? app.formatDate(snap.created_at) : snap.created_at;
      const head = label ? `${base} · ${label}` : base;
      return `${head} — ${when}`;
    },

    exportSnapshotOptions() {
      const app = window.__app;
      const opts = [{ value: '', label: app?.t?.('export.snapshot.current') || 'Current version' }];
      for (const s of this.exportSnapshots) opts.push({ value: String(s.id), label: this._exportSnapLabel(s) });
      return opts;
    },

    // Submit-Helper: liefert die zu sendende snapshot_id (Number) oder null.
    // Nur auf Buch-Scope; bei Kapitel/Seite immer null.
    _exportSnapshotIdForSubmit() {
      if (this.exportScope !== 'book') return null;
      const id = parseInt(this.exportSnapshotId);
      return Number.isFinite(id) && id > 0 ? id : null;
    },
  };
}

// ── Job-Submit + Polling + Download ───────────────────────────────────────────
// cfg:
//   jobPath          — POST-Endpunkt + Datei-Basis (`${jobPath}/${id}/file`)
//   defaultFilename  — Fallback-Dateiname
//   i18nPrefix       — Karten-Prefix für starting/done/error.network/error.generic
//   errorFor(self,d) — baut die Fehlermeldung bei !ok-POST (Namespace pro Karte)
//   resolveDone(self,result) → { statusKey, statusParams?, ttl? } — Done-Status
//                              (Warnungen etc.), Default: { statusKey:
//                              `${prefix}.done`, ttl: 3500 }
export function exportJobSlice(cfg) {
  return {
    exporting: false,
    exportProgress: 0,
    exportStatus: '',
    exportError: '',
    currentJobId: null,
    _pollTimer: null,
    _exportStatusTimer: null,

    // Laufenden Export-Run räumen (book:changed / view:reset). Profil-/Publikations-
    // State bleibt unberührt — das ist Sache der jeweiligen Karte.
    _resetExportRun() {
      this._stopPoll();
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      this.exporting = false;
      this.exportProgress = 0;
      this.exportStatus = '';
      this.exportError = '';
      this.currentJobId = null;
    },

    // Body bauen die Karten selbst (Cover-Target, include_subchapters, profile_id);
    // hier nur der gemeinsame POST → jobId → Poll-Pfad inkl. Fehlerbehandlung.
    async _runExportJob(body) {
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      this.exporting = true;
      this.exportProgress = 0;
      this.exportStatus = window.__app.t(`${cfg.i18nPrefix}.starting`);
      this.exportError = '';
      try {
        const r = await fetch(cfg.jobPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = cfg.errorFor(this, d);
          this.exporting = false;
          return;
        }
        const { jobId } = await r.json();
        this.currentJobId = jobId;
        this._startPoll(jobId);
      } catch {
        this.exportError = window.__app.t(`${cfg.i18nPrefix}.error.network`);
        this.exporting = false;
      }
    },

    _startPoll(jobId) {
      this._stopPoll();
      startPoll(this, {
        timerProp: '_pollTimer',
        jobId,
        progressProp: 'exportProgress',
        intervalMs: 1000,
        onProgress: (job) => {
          this.exportStatus = job.statusText ? window.__app.t(job.statusText, job.statusParams) : '';
        },
        onError: (job) => {
          this.exporting = false;
          this.exportError = job.error
            ? window.__app.t(job.error, job.errorParams)
            : window.__app.t(`${cfg.i18nPrefix}.error.generic`);
        },
        onDone: (job) => {
          this.exporting = false;
          this.exportProgress = 100;
          const result = job.result || {};
          const { statusKey, statusParams, ttl = 3500 } = cfg.resolveDone
            ? cfg.resolveDone(this, result)
            : { statusKey: `${cfg.i18nPrefix}.done`, ttl: 3500 };
          this.exportStatus = window.__app.t(statusKey, statusParams);
          this._triggerDownload(jobId, result.filename);
          if (this._exportStatusTimer) clearTimeout(this._exportStatusTimer);
          this._exportStatusTimer = setTimeout(() => {
            this.exportStatus = '';
            this.exportProgress = 0;
            this._exportStatusTimer = null;
          }, ttl);
        },
      });
    },

    _stopPoll() {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    },

    _triggerDownload(jobId, filename) {
      const a = document.createElement('a');
      a.href = `${cfg.jobPath}/${jobId}/file`;
      a.download = filename || cfg.defaultFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    async cancelExport() {
      if (!this.currentJobId) return;
      try { await fetch(`/jobs/${this.currentJobId}`, { method: 'DELETE' }); } catch {}
      // Poll deckt das `cancelled`-Status-Update bereits ab; UI-Reset im Polling.
    },
  };
}

// ── Profil umbenennen + Import/Export (PDF/DOCX) ──────────────────────────────
// Beide Karten haben user-scoped Profile mit { id, name, config }. Umbenennen
// schickt nur den neuen Namen an die PUT-Route (config bleibt serverseitig
// erhalten). Export lädt das aktive Profil als selbsttragende JSON-Datei
// herunter (nur name+config — keine BLOBs; Cover/Rückseite bleiben buch-/profil-
// gebunden). Import legt daraus über die POST-Route ein neues Profil an; der
// Server validiert die Config (validateConfig verwirft unbekannte Keys, clamped
// Numerik). Fehler landen im karteneigenen `${prefix}.error.*`-Namespace.
//
// cfg:
//   basePath   — '/pdf-export' | '/docx-export' (CRUD-Route)
//   type       — Marker in der Exportdatei ('pdf-export-profile' | 'docx-export-profile')
//   i18nPrefix — 'pdfExport' | 'docxExport'
function _profileNameSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
export function uniqueProfileName(base, profiles) {
  const names = new Set((profiles || []).map(p => p.name));
  if (!names.has(base)) return base.slice(0, 80);
  for (let n = 2; n < 1000; n++) {
    const cand = `${base} (${n})`.slice(0, 80);
    if (!names.has(cand)) return cand;
  }
  return base.slice(0, 80);
}

export function profileTransferSlice(cfg) {
  return {
    // Unter der Profil-Leiste ist höchstens eine Eingabezeile offen
    // ('create' | 'template' | 'rename'); derselbe Knopf schliesst sie wieder.
    _profileRow: null,
    renameValue: '',
    importing: false,

    // Formular (`x-if="_formMounted && activeProfile"`) aushängen, Teardown
    // abwarten, dann mutieren — die x-if-Kinder (combobox x-data, x-model)
    // sehen so nie ein null-activeProfile. Gewartet wird auf Alpines
    // Effekt-Flush (Microtask), nicht auf `$nextTick`: das löst erst per
    // setTimeout auf, der Browser zeichnete dazwischen einen Frame ohne
    // Formular, die Karte fiel zusammen und der Scroll sprang nach oben.
    async _unmountFormThen(mutate) {
      this._formMounted = false;
      await new Promise(queueMicrotask);
      mutate();
    },

    toggleProfileRow(row) {
      this._profileRow = this._profileRow === row ? null : row;
    },

    beginRename() {
      if (!this.activeProfile) return;
      if (this._profileRow === 'rename') { this._profileRow = null; return; }
      this.renameValue = this.activeProfile.name;
      this._profileRow = 'rename';
    },

    async renameProfile() {
      const name = String(this.renameValue || '').trim().slice(0, 80);
      if (!this.activeProfile || !name) return;
      if (name === this.activeProfile.name) { this._profileRow = null; return; }
      try {
        const r = await fetch(`${cfg.basePath}/profiles/${this.activeProfile.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.t(d.error_code === 'PROFILE_NAME_TAKEN'
            ? `${cfg.i18nPrefix}.error.nameTaken`
            : `${cfg.i18nPrefix}.error.saveFailed`);
          return;
        }
        const updated = await r.json();
        this.activeProfile.name = updated.name;
        const idx = this.profiles.findIndex(p => p.id === updated.id);
        if (idx >= 0) this.profiles[idx].name = updated.name;
        this._profileRow = null;
      } catch {
        this.exportError = window.__app.t(`${cfg.i18nPrefix}.error.saveFailed`);
      }
    },

    // Aktives Profil duplizieren — ein Klick, kein Anlege-Formular. Server-seitig
    // via `clone_from` (kopiert Config, NICHT profil-gebundene BLOBs wie das
    // Rückseitenbild — gleiche Semantik wie die Klon-Combobox im Anlege-Formular).
    // Name = «<Name> (Kopie)», bei Kollision durchnummeriert.
    async duplicateProfile() {
      if (!this.activeProfile) return;
      const base = `${this.activeProfile.name} (${window.__app.t('common.copySuffix')})`;
      const name = uniqueProfileName(base, this.profiles);
      try {
        const r = await fetch(`${cfg.basePath}/profiles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, clone_from: this.activeProfile.id }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.t(`${cfg.i18nPrefix}.error.createFailed`, d.params);
          return;
        }
        const profile = await r.json();
        this.profiles.push(profile);
        await this.selectProfile(profile.id);
      } catch {
        this.exportError = window.__app.t(`${cfg.i18nPrefix}.error.createFailed`);
      }
    },

    exportProfileConfig() {
      if (!this.activeProfile) return;
      const payload = {
        app: 'schreibwerkstatt',
        type: cfg.type,
        version: 1,
        name: this.activeProfile.name,
        config: this.activeProfile.config,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${_profileNameSlug(this.activeProfile.name) || 'profil'}.${cfg.type}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },

    async importProfileConfig(file) {
      if (!file || this.importing) return;
      this.importing = true;
      this.exportError = '';
      try {
        let data;
        try { data = JSON.parse(await file.text()); }
        catch { this.exportError = window.__app.t(`${cfg.i18nPrefix}.error.importInvalid`); return; }
        if (!data || data.type !== cfg.type || !data.config || typeof data.config !== 'object') {
          this.exportError = window.__app.t(`${cfg.i18nPrefix}.error.importInvalid`);
          return;
        }
        const base = String(data.name || '').trim() || window.__app.t(`${cfg.i18nPrefix}.importedName`);
        const name = uniqueProfileName(base, this.profiles);
        const r = await fetch(`${cfg.basePath}/profiles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, config: data.config }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.t(`${cfg.i18nPrefix}.error.importFailed`, d.params);
          return;
        }
        const profile = await r.json();
        this.profiles.push(profile);
        await this.selectProfile(profile.id);
      } finally {
        this.importing = false;
      }
    },
  };
}

// ── Kapitel-ohne-Nummer-Chips ─────────────────────────────────────────────────
// Pick-Optionen sind identisch (Tree-basiert); nur die Id-Quelle unterscheidet
// sich (PDF/DOCX: activeProfile.config.chapter.unnumberedChapterIds, EPUB:
// pub.epub_unnumbered_chapter_ids). Daher Accessor-Paar via cfg.
//   getIds(self) → number[]      (Lese-Quelle, robust gegen null)
//   setIds(self, arr)            (Schreib-Ziel)
export function unnumberedChipsSlice({ getIds, setIds }) {
  return {
    unnumberedChapterPickOptions() {
      const app = window.__app;
      if (!app || !Array.isArray(Alpine.store('nav').tree)) return [];
      return Alpine.store('nav').tree
        .filter(c => c.type === 'chapter' && !c.solo)
        .map(c => ({
          value: c.id,
          label: ((c.depth || 1) > 1 ? '— '.repeat((c.depth || 1) - 1) : '') + c.name,
        }));
    },
    unnumberedChapterChips() {
      const ids = getIds(this) || [];
      const opts = this.unnumberedChapterPickOptions();
      return ids.map(id => {
        const o = opts.find(x => x.value === id);
        return o ? { id, label: o.label } : { id, label: '#' + id };
      });
    },
    removeUnnumberedChapter(id) {
      const arr = getIds(this) || [];
      setIds(this, arr.filter(v => v !== id));
    },
  };
}
