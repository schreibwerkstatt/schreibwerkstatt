// Alpine.data('docxExportCard') — Custom-Word-Export: Profile + Konfiguration + Trigger.
//
// Profile (docx_export_profile, user-scoped) halten Layout/Typografie/Struktur.
// Die Titelei-Texte (Titel/Untertitel/Autor/Widmung/Impressum/Copyright/
// Frontmatter/Bio) kommen buch-weit aus book_publication (im BookSettings →
// Publikation-Tab gepflegt) — diese Karte verlinkt nur dorthin und schaltet
// pro Profil, welche Bausteine eingebunden werden.
//
// Render-Job läuft über die Standard-Job-Queue (/jobs/docx-export). Sobald done,
// wird die .docx via /jobs/docx-export/:id/file als Download geholt.
// `showDocxExportCard` bleibt im Root (Hash-Router + Exklusivität).
// Scope-Auswahl, Job-Polling/Download und Kapitel-Chips kommen aus
// export-card-base.js (geteilt mit PDF + EPUB).

import { EVT } from '../events.js';
import { exportScopeSlice, exportJobSlice, unnumberedChipsSlice, exportSnapshotSlice, profileTransferSlice } from './export-card-base.js';

export function registerDocxExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('docxExportCard', () => ({
    ...exportScopeSlice(),
    ...exportSnapshotSlice(),
    ...exportJobSlice({
      jobPath: '/jobs/docx-export',
      defaultFilename: 'book.docx',
      i18nPrefix: 'docxExport',
      errorFor: (self, d) => window.__app.tError(d) || window.__app.t('docxExport.error.startFailed'),
    }),
    ...unnumberedChipsSlice({
      getIds: (s) => s.activeProfile?.config?.chapter?.unnumberedChapterIds || [],
      setIds: (s, arr) => { s.activeProfile.config.chapter.unnumberedChapterIds = arr; },
    }),
    ...profileTransferSlice({ basePath: '/docx-export', type: 'docx-export-profile', i18nPrefix: 'docxExport' }),

    profiles: [],
    activeProfileId: null,
    activeProfile: null,   // { id, name, config }
    _formMounted: false,
    _selectSeq: 0,

    newProfileName: '',
    cloneFromId: null,
    creating: false,

    activeTab: 'layout',

    saving: false,
    savedAt: null,
    _savedAtTimer: null,
    _onBookChanged: null,
    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showDocxExportCard, async (visible) => {
        if (!visible) return;
        if (!this.profiles.length) await this.loadProfiles();
        this._ensureExportPicked();
        await this._loadExportSnapshots();
      });
      this._initScopeWatches();
      this._bindPreset(EVT.EXPORT_DOCX_PRESET, '__docxExportPreset');

      this._onBookChanged = () => {
        this._resetExportRun();
        this._ensureExportPicked();
        this.exportSnapshotId = '';
        if (window.__app?.showDocxExportCard) this._loadExportSnapshots();
        else { this.exportSnapshots = []; }
      };
      window.addEventListener(EVT.BOOK_CHANGED, this._onBookChanged);

      this._onViewReset = () => {
        this._resetExportRun();
        if (this._savedAtTimer) { clearTimeout(this._savedAtTimer); this._savedAtTimer = null; }
        this.exportScope = 'book';
        this.exportChapterId = null;
        this.exportPageId = null;
        this.exportSnapshots = [];
        this.exportSnapshotId = '';
        this.activeTab = 'layout';
      };
      window.addEventListener(EVT.VIEW_RESET, this._onViewReset);
    },

    destroy() {
      this._stopPoll();
      if (this._savedAtTimer)      { clearTimeout(this._savedAtTimer);      this._savedAtTimer = null; }
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      if (this._onBookChanged)  window.removeEventListener(EVT.BOOK_CHANGED, this._onBookChanged);
      if (this._onViewReset)    window.removeEventListener(EVT.VIEW_RESET,   this._onViewReset);
      this._unbindPreset();
    },

    canEdit() {
      const role = window.__app?.currentBookRole;
      return role === 'editor' || role === 'owner' || role == null;
    },

    // ── Profile ───────────────────────────────────────────────────────────
    async loadProfiles() {
      try {
        const r = await fetch('/docx-export/profiles');
        const d = await r.json();
        this.profiles = d.profiles || [];
        if (!this.profiles.length) {
          // Erstes Öffnen: ein Standard-Profil anlegen (Server nutzt defaultConfig).
          await this._createProfileNamed(window.__app.t('docxExport.defaultProfileName'));
          return;
        }
        const def = this.profiles.find(p => p.is_default) || this.profiles[0];
        const target = this.profiles.some(p => p.id === this.activeProfileId) ? this.activeProfileId : def.id;
        await this.selectProfile(target);
      } catch (e) {
        console.error('loadProfiles', e);
      }
    },

    // Erst laden, dann umhängen — kein Frame ohne Formular (wie PDF-Karte).
    async selectProfile(id) {
      const seq = ++this._selectSeq;
      let profile = null;
      try {
        const r = await fetch(`/docx-export/profiles/${id}`);
        if (r.ok) profile = await r.json();
      } catch {}
      if (seq !== this._selectSeq) return;
      await this._unmountFormThen(() => { this.activeProfileId = id; });
      if (!profile) { this.activeProfile = null; return; }
      this.activeProfile = profile;
      this._formMounted = true;
    },

    async _createProfileNamed(name, cloneFromId) {
      const body = { name: String(name || '').trim() };
      if (!body.name) return;
      if (cloneFromId) body.clone_from = cloneFromId;
      this.creating = true;
      try {
        const r = await fetch('/docx-export/profiles', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.tError(d) || window.__app.t('docxExport.error.createFailed');
          return;
        }
        const profile = await r.json();
        this.profiles.push(profile);
        this.newProfileName = '';
        this.cloneFromId = null;
        this._profileRow = null;
        await this.selectProfile(profile.id);
      } finally {
        this.creating = false;
      }
    },

    async createProfile() {
      await this._createProfileNamed(this.newProfileName, this.cloneFromId);
    },

    async deleteProfile(id) {
      if (this.profiles.length <= 1) return; // letztes Profil nicht löschen
      if (!await window.__app.appConfirm({ message: window.__app.t('docxExport.confirmDelete'), danger: true })) return;
      const r = await fetch(`/docx-export/profiles/${id}`, { method: 'DELETE' });
      if (!r.ok) return;
      this.profiles = this.profiles.filter(p => p.id !== id);
      if (this.activeProfileId === id) {
        await this.selectProfile(this.profiles[0].id);
      }
    },

    async setDefaultProfile(id) {
      const r = await fetch(`/docx-export/profiles/${id}/default`, { method: 'POST' });
      if (!r.ok) return;
      this.profiles.forEach(p => { p.is_default = p.id === id; });
      // Auch das separat geladene aktive Profil mitziehen, sonst bleibt der
      // „Als Standard"-Button sichtbar, obwohl das Profil schon Standard ist.
      if (this.activeProfile && this.activeProfile.id === id) this.activeProfile.is_default = true;
    },

    async saveProfile() {
      if (!this.activeProfile) return;
      this.saving = true;
      this.savedAt = null;
      this.exportError = '';
      try {
        const r = await fetch(`/docx-export/profiles/${this.activeProfile.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.activeProfile.name, config: this.activeProfile.config }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.tError(d) || window.__app.t('docxExport.error.saveFailed');
          return;
        }
        this.activeProfile = await r.json();
        const idx = this.profiles.findIndex(p => p.id === this.activeProfile.id);
        if (idx >= 0) this.profiles[idx].name = this.activeProfile.name;
        this.savedAt = Date.now();
        if (this._savedAtTimer) clearTimeout(this._savedAtTimer);
        this._savedAtTimer = setTimeout(() => { this.savedAt = null; this._savedAtTimer = null; }, 2500);
      } finally {
        this.saving = false;
      }
    },

    openBookSettings() { window.__app?.toggleBookSettingsCard?.(); },

    // ── Config-Optionen (Enum → Combobox) ─────────────────────────────────
    _enum(values, prefix) {
      return values.map(v => ({ value: v, label: window.__app.t(`${prefix}.${v}`) }));
    },
    fontFamilyOptions() {
      return ['Times New Roman', 'Calibri', 'Courier New', 'Georgia', 'Arial', 'Garamond', 'Cambria', 'Book Antiqua', 'Palatino Linotype']
        .map(v => ({ value: v, label: v }));
    },
    pageSizeOptions()       { return ['A4', 'A5', 'Letter'].map(v => ({ value: v, label: v })); },
    lineSpacingOptions()    { return this._enum(['single', 'oneAndHalf', 'double'], 'docxExport.lineSpacing'); },
    paragraphStyleOptions() { return this._enum(['indent', 'spaced'], 'docxExport.paragraphStyle'); },
    headerModeOptions()     { return this._enum(['none', 'title', 'manuscript'], 'docxExport.headerMode'); },
    pageNumberOptions()     { return this._enum(['none', 'footer', 'headerRight'], 'docxExport.pageNumber'); },
    titleModeOptions()      { return this._enum(['generated', 'none'], 'docxExport.titleMode'); },
    imprintPositionOptions() { return this._enum(['front', 'back'], 'docxExport.imprintPosition'); },
    tocModeOptions()        { return this._enum(['none', 'field', 'static'], 'docxExport.tocMode'); },
    sceneSeparatorOptions() { return this._enum(['line', 'asterism', 'stars', 'blank'], 'docxExport.sceneSep'); },
    pageStructureOptions()  { return this._enum(['flatten', 'nested'], 'docxExport.pageStructure'); },
    numberingModeOptions()  { return this._enum(['nested', 'flat'], 'docxExport.numberingMode'); },
    chapterNumberingOptions() {
      return [
        { value: 'none',   label: window.__app.t('docxExport.numbering.none') },
        { value: 'arabic', label: '1, 2, 3' },
        { value: 'roman',  label: 'I, II, III' },
        { value: 'word',   label: window.__app.t('docxExport.numbering.word') },
      ];
    },
    tocDepthOptions() {
      return [1, 2, 3].map(n => ({ value: n, label: window.__app.t(`docxExport.tocDepth.${n}`) }));
    },

    // ── Export-Trigger ─────────────────────────────────────────────────────
    async exportDocx() {
      if (this.canEdit() && this.activeProfile) {
        await this.saveProfile();
        if (this.exportError) return;
      }
      const ref = this._exportEntity();
      if (!ref || !this.activeProfile) { this.exportError = window.__app.t('docxExport.error.startFailed'); return; }
      const snapId = this._exportSnapshotIdForSubmit();
      await this._runExportJob({
        scope: ref.scope, entityId: ref.id, profile_id: this.activeProfile.id,
        ...(snapId ? { snapshot_id: snapId } : {}),
        ...(ref.scope === 'chapter' ? { include_subchapters: !!this.exportIncludeSubchapters } : {}),
      });
    },
  }));
}
