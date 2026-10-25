// Alpine.data('pdfExportCard') — Custom-PDF-Export-Konfiguration + Trigger.
//
// State: profiles[], aktives Profil, aktiver Tab, Font-Liste, Job-Status.
// `showPdfExportCard` bleibt im Root (Hash-Router + Exklusivität).
//
// Lifecycle:
//   - $watch($app.showPdfExportCard): on-visible → loadProfiles + loadFonts.
//   - book:changed: aktive Auswahl resetten + Profile neu laden.
//   - view:reset: alles leeren.
//
// Render-Job läuft über die Standard-Job-Queue (/jobs/pdf-export). Sobald done,
// wird das PDF-File via /jobs/pdf-export/:id/file als Download geholt.
// Scope-Auswahl, Job-Polling/Download und Kapitel-Chips kommen aus
// export-card-base.js (geteilt mit EPUB + DOCX).

import { EVT } from '../events.js';
import { headingStyleSlice } from './export-heading-style.js';
import { exportScopeSlice, exportJobSlice, unnumberedChipsSlice, exportSnapshotSlice, profileTransferSlice, uniqueProfileName } from './export-card-base.js';
import * as presets from './pdf-export-presets.js';
import * as templates from './pdf-export-templates.js';
import { pdfExportUiSlice } from './pdf-export-ui.js';
import { CARD_REQUEST } from './card-request.js';
import { openBookSettingsTab } from '../book/book-settings/open-tab.js';

export function registerPdfExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('pdfExportCard', () => ({
    ...exportScopeSlice(),
    ...exportSnapshotSlice(),
    ...exportJobSlice({
      jobPath: '/jobs/pdf-export',
      defaultFilename: 'book.pdf',
      i18nPrefix: 'pdfExport',
      // PDF mappt Fehler-Codes in den karteneigenen Namespace `pdfExport.error.*`
      // (nicht den globalen `tError`-Namespace `error.*` wie EPUB/DOCX).
      errorFor: (self, d) => window.__app.t(d.error_code ? 'pdfExport.error.' + d.error_code : 'pdfExport.error.startFailed', d.params),
      resolveDone: (self, result) => {
        self.exportLowRes = result.lowResImages || 0;
        self.exportHyphenOff = Array.isArray(result.hyphenationDisabled) ? result.hyphenationDisabled : [];
        // Alle Befunde als bleibende, wegklickbare Liste (pdf-export-warnings.js).
        self._collectWarnings(result);
        // Ganzes-Buch-Innenteil gerendert → die echte physische Seitenzahl
        // (inkl. manueller Umbrüche/Leerseiten) in die Cover-Innenteil-Seitenzahl
        // spiegeln, die Rückenbreite + KDP-Bundsteg treibt. Nur bei Abweichung
        // schreiben+persistieren, damit ein unveränderter Re-Export nicht speichert.
        // Probeseiten (sample) zählen nur das erste Kapitel — nie übernehmen.
        const cs = self.activeProfile?.config?.coverSpec;
        const pagesCounted = !result.sample && result.target !== 'cover' && result.scope === 'book'
          && Number.isInteger(result.interiorPages) && result.interiorPages > 0
          && cs && cs.pageCount !== result.interiorPages;
        if (pagesCounted) {
          cs.pageCount = result.interiorPages;
          self.saveActiveProfile();
        }
        const statusKey = result.sample ? 'pdfExport.sampleDone'
          : self.exportWarnings.length ? 'pdfExport.doneWithWarnings'
          : pagesCounted ? 'pdfExport.donePagesCounted'
          : 'pdfExport.done';
        return {
          statusKey,
          statusParams: pagesCounted ? { n: result.interiorPages } : { count: self.exportWarnings.length },
          ttl: pagesCounted ? 8000 : 3500,
        };
      },
    }),
    ...unnumberedChipsSlice({
      getIds: (s) => s.activeProfile?.config?.chapter?.unnumberedChapterIds || [],
      setIds: (s, arr) => { s.activeProfile.config.chapter.unnumberedChapterIds = arr; },
    }),
    ...profileTransferSlice({ basePath: '/pdf-export', type: 'pdf-export-profile', i18nPrefix: 'pdfExport' }),
    ...pdfExportUiSlice(),
    ...headingStyleSlice(),

    profiles: [],
    activeProfileId: null,
    activeProfile: null,        // { id, name, config, has_cover, ... }
    // Form-Mount-Gate: getrennt von activeProfile, damit Alpine die x-if-DOM
    // sicher unmounten kann, BEVOR activeProfile auf null/neuen Wert wechselt.
    // Sonst feuern x-model/x-effect-Closures (combobox-x-data) noch ein Mal mit
    // null-activeProfile und werfen "Cannot read properties of null (reading 'config')".
    _formMounted: false,
    _selectSeq: 0,
    activeTab: 'layout',

    fontList: [],
    fontPreviewLoaded: new Set(),

    creating: false,
    newProfileName: '',
    cloneFromId: null,

    // Gestaltungs-Vorlage (pdf-export-templates.js). Sie legt immer ein NEUES
    // Profil an statt das aktive zu überschreiben — eine Vorlage anzusehen darf
    // die eigene Einrichtung nicht kosten.
    templateSel: '',

    saving: false,
    savedAt: null,
    _savedAtTimer: null,

    exportLowRes: 0,
    exportHyphenOff: [],
    trimPresetSel: '',
    paperPresetSel: '',

    // coverPreviewVersion bustet den Cache der Rückseiten-Bild-Vorschau
    // (Umschlag). Front-Cover + Autorfoto leben buch-weit in book_publication
    // und werden im BookSettings → Publikation-Tab gepflegt.
    coverPreviewVersion: 0,

    backCoverUploading: false,
    backCoverError: '',

    spineImageUploading: false,
    spineImageError: '',

    _onBookChanged: null,
    _onViewReset: null,
    _onBeforeUnload: null,
    _onCardRequest: null,

    init() {
      this._initUiMode();
      this.$watch(() => window.__app.showPdfExportCard, async (visible) => {
        if (!visible) { await this._onHiddenWhileDirty(); return; }
        await this.loadFonts();
        // Profile sind user-scoped → einmal geladen reicht; selectedBookId-
        // Wechsel triggert KEINE Neuladung.
        if (!this.profiles.length) await this.loadProfiles();
        // Fassungen sind buch-scoped → bei jedem Öffnen frisch ziehen.
        await this._loadExportSnapshots();
      });
      this._initScopeWatches();
      this._bindPreset(EVT.EXPORT_PRESET, '__exportPreset');

      // book:changed räumt nur den laufenden Export-State (Buchwechsel = neuer
      // Render-Kontext). Profile-Liste bleibt erhalten.
      this._onBookChanged = () => {
        this._resetExportRun();
        this.exportSnapshotId = '';
        if (window.__app?.showPdfExportCard) this._loadExportSnapshots();
        else { this.exportSnapshots = []; }
      };
      window.addEventListener(EVT.BOOK_CHANGED, this._onBookChanged);

      // view:reset (Logout / User-Settings-Danger-Reset) räumt ALLES inkl.
      // Profile-Liste — könnte anderer User sein nach Re-Login.
      this._onViewReset = async () => {
        this._resetExportRun();
        this.exportSnapshots = [];
        this.exportSnapshotId = '';
        await this._unmountFormThen(() => {
          this.profiles = [];
          this.activeProfile = null;
          this.activeProfileId = null;
          this.savedAt = null;
          this._savedSnapshot = '';
          this.exportWarnings = [];
        });
      };
      window.addEventListener(EVT.VIEW_RESET, this._onViewReset);

      // Reload/Tab-Close mit ungespeichertem Profil: nativer Prompt (appConfirm
      // geht in beforeunload nicht — Browser blockiert Modals dort).
      this._onBeforeUnload = (e) => {
        if (!this.isDirty()) return;
        e.preventDefault();
        e.returnValue = '';
      };
      window.addEventListener('beforeunload', this._onBeforeUnload);

      this._onCardRequest = (e) => {
        if (e.detail?.key === CARD_REQUEST.PDF_EXPORT_TAB) this._applyPendingTab();
      };
      window.addEventListener(EVT.CARD_REQUEST, this._onCardRequest);
      this._applyPendingTab();
    },

    destroy() {
      this._stopPoll();
      if (this._savedAtTimer)     { clearTimeout(this._savedAtTimer);     this._savedAtTimer = null; }
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      if (this._onBookChanged)  window.removeEventListener(EVT.BOOK_CHANGED, this._onBookChanged);
      if (this._onViewReset)    window.removeEventListener(EVT.VIEW_RESET,   this._onViewReset);
      if (this._onCardRequest)  window.removeEventListener(EVT.CARD_REQUEST, this._onCardRequest);
      if (this._onBeforeUnload) window.removeEventListener('beforeunload',   this._onBeforeUnload);
      this._unbindPreset();
    },

    // ── Profile-Liste / Auswahl ──────────────────────────────────────────
    async loadFonts() {
      if (this.fontList.length) return;
      try {
        const r = await fetch('/pdf-export/fonts');
        if (!r.ok) return;
        const d = await r.json();
        this.fontList = d.fonts || [];
      } catch {}
    },

    fontsByCategory(cat) {
      return this.fontList.filter(f => f.category === cat);
    },

    async loadProfiles() {
      try {
        const r = await fetch('/pdf-export/profiles');
        const d = await r.json();
        this.profiles = d.profiles || [];
        if (!this.profiles.length) {
          // Erstes Öffnen: ein Standard-Profil anlegen (Server nutzt defaultConfig).
          // Gleiches Verhalten wie die Word-Karte — kein leerer Zwischenzustand.
          await this._createProfileNamed(window.__app.t('pdfExport.defaultProfileName'));
          return;
        }
        const def = this.profiles.find(p => p.is_default) || this.profiles[0];
        const target = this.profiles.some(p => p.id === this.activeProfileId) ? this.activeProfileId : def.id;
        await this.selectProfile(target);
      } catch (e) {
        console.error('loadProfiles', e);
      }
    },

    // Erst laden, dann Form unmounten, State wechseln und neu mounten. Der
    // Wechsel läuft so ohne Netzwerk-Runde dazwischen in Microtasks — kein
    // Frame ohne Formular, die Karte fällt nicht zusammen und der Scroll bleibt.
    async selectProfile(id) {
      const seq = ++this._selectSeq;
      let profile = null;
      try {
        const r = await fetch(`/pdf-export/profiles/${id}`);
        if (r.ok) profile = await r.json();
      } catch {}
      if (seq !== this._selectSeq) return; // ein späterer Wechsel hat übernommen
      await this._unmountFormThen(() => { this.activeProfileId = id; });
      if (!profile) { this.activeProfile = null; this._savedSnapshot = ''; return; }
      this.activeProfile = profile;
      this.coverPreviewVersion++;
      this._formMounted = true;
      // Vergleichsbasis erst nach dem Mount: Felder, die beim Einhängen ihren
      // Wert normalisieren, sollen nicht als „ungespeichert" zählen.
      await this.$nextTick();
      this._takeSnapshot();
    },

    // Profil anlegen (optional als Klon). Profile sind user-scoped — kein
    // book_id im Payload. Nach dem Anlegen wird genau einmal selectProfile
    // gerufen (ein Form-Mount-Zyklus, keine Race mit laufenden Klicks).
    // `config` (optional) legt das Profil auf einer mitgegebenen Konfiguration
    // an — Weg der Gestaltungs-Vorlagen. Sie ist eine Teilkonfiguration; der
    // Server füllt sie über validateConfig aus den Defaults auf.
    async _createProfileNamed(name, cloneFromId, config) {
      const body = { name: String(name || '').trim() };
      if (!body.name) return;
      if (cloneFromId) body.clone_from = cloneFromId;
      else if (config) body.config = config;
      this.creating = true;
      try {
        const r = await fetch('/pdf-export/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.t(d.error_code ? 'pdfExport.error.' + d.error_code : 'pdfExport.error.createFailed', d.params);
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
      if (!(await this._confirmDiscard())) return;
      await this._createProfileNamed(this.newProfileName, this.cloneFromId);
    },

    // ── Gestaltungs-Vorlagen ──────────────────────────────────────────────
    templateOptions() { return templates.templateOptions(window.__app.t); },
    templateDescription() { return templates.templateDescription(this.templateSel, window.__app.t); },

    // Vorlage als neues Profil anlegen. Der Name wird gegen die vorhandenen
    // Profile eindeutig gemacht, damit ein zweiter Klick nicht auf
    // PROFILE_NAME_TAKEN läuft — umbenennen kann der User danach.
    async applyTemplate() {
      const cfg = templates.templateConfig(this.templateSel);
      if (!cfg || this.creating) return;
      if (!(await this._confirmDiscard())) return;
      this.exportError = '';
      const base = templates.templateName(this.templateSel, window.__app.t);
      const name = uniqueProfileName(base, this.profiles);
      await this._createProfileNamed(name, null, cfg);
      if (this.exportError) return;
      this._profileRow = null;
      this.templateSel = '';
    },

    async deleteProfile(id) {
      if (this.profiles.length <= 1) return; // letztes Profil nicht löschen
      const app = window.__app;
      const ok = await app.appConfirm({ message: app.t('pdfExport.confirmDelete'), confirmLabel: app.t('pdfExport.deleteProfile'), danger: true });
      if (!ok) return;
      const wasDefault = !!this.profiles.find(p => p.id === id)?.is_default;
      const r = await fetch(`/pdf-export/profiles/${id}`, { method: 'DELETE' });
      if (!r.ok) return;
      this.profiles = this.profiles.filter(p => p.id !== id);
      // Ohne Standard fiele das nächste Öffnen auf ein beliebiges Profil —
      // das erste verbleibende übernimmt die Rolle.
      if (wasDefault && this.profiles.length && !this.profiles.some(p => p.is_default)) {
        await this.setDefault(this.profiles[0].id);
      }
      if (this.activeProfileId === id) await this.selectProfile(this.profiles[0].id);
    },

    async setDefault(id) {
      const r = await fetch(`/pdf-export/profiles/${id}/default`, { method: 'POST' });
      if (!r.ok) return;
      this.profiles.forEach(p => { p.is_default = p.id === id; });
      // Aktives (separat geladenes) Profil mitziehen, sonst bleibt der
      // „Als Standard"-Icon-Button sichtbar, obwohl es schon Standard ist.
      if (this.activeProfile && this.activeProfile.id === id) this.activeProfile.is_default = true;
    },

    async saveActiveProfile() {
      if (!this.activeProfile) return;
      this.saving = true;
      this.savedAt = null;
      try {
        const r = await fetch(`/pdf-export/profiles/${this.activeProfile.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.activeProfile.name, config: this.activeProfile.config }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.t(d.error_code ? 'pdfExport.error.' + d.error_code : 'pdfExport.error.saveFailed', d.params);
          return;
        }
        this.activeProfile = await r.json();
        this._takeSnapshot();
        this.savedAt = Date.now();
        if (this._savedAtTimer) clearTimeout(this._savedAtTimer);
        this._savedAtTimer = setTimeout(() => { this.savedAt = null; this._savedAtTimer = null; }, 2500);
      } finally {
        this.saving = false;
      }
    },

    // ── Umschlag-Rückseitenbild (separates Cover-PDF) ─────────────────────
    async uploadBackCover(file) {
      if (!file || !this.activeProfile) return;
      this.backCoverUploading = true;
      this.backCoverError = '';
      try {
        const r = await fetch(`/pdf-export/profiles/${this.activeProfile.id}/back-cover`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.backCoverError = window.__app.t(d.message_key || 'pdfExport.error.backCoverInvalid', d.params);
          return;
        }
        // Nur das Flag nachziehen statt das Profil neu zu laden — ein Reload
        // verwürfe ungespeicherte Änderungen in den anderen Tabs.
        this.activeProfile.has_back_cover = true;
        this.coverPreviewVersion++;
      } finally {
        this.backCoverUploading = false;
      }
    },

    async removeBackCover() {
      if (!this.activeProfile) return;
      const r = await fetch(`/pdf-export/profiles/${this.activeProfile.id}/back-cover`, { method: 'DELETE' });
      if (!r.ok) return;
      this.activeProfile.has_back_cover = false;
    },

    backCoverUrl() {
      if (!this.activeProfile?.has_back_cover) return '';
      return `/pdf-export/profiles/${this.activeProfile.id}/back-cover?v=${this.coverPreviewVersion}`;
    },

    // ── Umschlag-Buchrückenbild (separates Cover-PDF) ─────────────────────
    async uploadSpineImage(file) {
      if (!file || !this.activeProfile) return;
      this.spineImageUploading = true;
      this.spineImageError = '';
      try {
        const r = await fetch(`/pdf-export/profiles/${this.activeProfile.id}/spine-image`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.spineImageError = window.__app.t(d.message_key || 'pdfExport.error.spineImageInvalid', d.params);
          return;
        }
        this.activeProfile.has_spine = true;
        this.coverPreviewVersion++;
      } finally {
        this.spineImageUploading = false;
      }
    },

    async removeSpineImage() {
      if (!this.activeProfile) return;
      const r = await fetch(`/pdf-export/profiles/${this.activeProfile.id}/spine-image`, { method: 'DELETE' });
      if (!r.ok) return;
      this.activeProfile.has_spine = false;
    },

    spineImageUrl() {
      if (!this.activeProfile?.has_spine) return '';
      return `/pdf-export/profiles/${this.activeProfile.id}/spine-image?v=${this.coverPreviewVersion}`;
    },

    // Live-Rückenbreite (mm) = Papiervolumen je 1000 Seiten × Seitenzahl / 1000.
    coverSpineMm() {
      const cs = this.activeProfile?.config?.coverSpec;
      if (!cs) return 0;
      return (Math.max(0, cs.pageCount || 0) * Math.max(0, cs.paperBulkMmPer1000 || 0)) / 1000;
    },
    coverSpecReady() {
      const cs = this.activeProfile?.config?.coverSpec;
      return !!(cs && cs.pageCount > 0 && cs.paperBulkMmPer1000 > 0);
    },
    // Klappentext der Rückseite ist der buch-weite (Publikation-Reiter).
    openPublicationSettings() { openBookSettingsTab('publication'); },

    // ── Cover-Tab: Papier-Presets (Trim/KDP: pdf-export-ui.js) ─────────────
    paperPresetOptions() { return presets.paperPresetOptions(window.__app.t); },
    applyPaperPreset(value) {
      if (this.activeProfile) presets.applyPaperPreset(this.activeProfile.config, value);
    },

    // ── Font-Preview ──────────────────────────────────────────────────────
    loadFontPreview(family, weight) {
      const key = `${family}:${weight}`;
      if (this.fontPreviewLoaded.has(key)) return;
      const url = `/pdf-export/fonts/${encodeURIComponent(family)}/${weight}/preview.css`;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      document.head.appendChild(link);
      this.fontPreviewLoaded.add(key);
    },

    fontPreviewStyle(role) {
      if (!this.activeProfile) return '';
      const f = this.activeProfile.config.font[role];
      if (!f) return '';
      this.loadFontPreview(f.family, f.weight || 400);
      const color = f.color && /^#[0-9a-fA-F]{6}$/.test(f.color) ? f.color : '';
      const italic = f.italic ? ' font-style: italic;' : '';
      return `font-family: '${f.family}', serif; font-weight: ${f.weight || 400};${color ? ` color: ${color};` : ''}${italic}`;
    },

    onFontPick(role, family) {
      if (!this.activeProfile) return;
      this.activeProfile.config.font[role].family = family;
      // Vorhandenes Weight-Setting beibehalten, aber gegen Allowed-Liste prüfen.
      const meta = this.fontList.find(f => f.family === family);
      if (meta && !meta.weights.includes(this.activeProfile.config.font[role].weight)) {
        this.activeProfile.config.font[role].weight = meta.weights.includes(400) ? 400 : meta.weights[0];
      }
    },

    // Schriftfamilie einer Rolle auf alle übrigen Font-Rollen übertragen. Nur die
    // Familie wird gesetzt — Grösse/Zeilenhöhe/Farbe/Kursiv bleiben rollenspezifisch
    // (typografische Einheitlichkeit ohne die Feinheiten zu plätten). Das Weight
    // jeder Rolle wird gegen die Allowed-Liste der neuen Familie geclamped.
    applyFamilyToAll(fromRole) {
      if (!this.activeProfile) return;
      const fonts = this.activeProfile.config.font;
      const family = fonts[fromRole]?.family;
      if (!family) return;
      const meta = this.fontList.find(f => f.family === family);
      for (const role of Object.keys(fonts)) {
        const f = fonts[role];
        if (!f || typeof f !== 'object' || !('family' in f)) continue;
        f.family = family;
        if (meta && !meta.weights.includes(f.weight)) {
          f.weight = meta.weights.includes(400) ? 400 : meta.weights[0];
        }
      }
    },

    // ── Export-Trigger ────────────────────────────────────────────────────
    // target: 'interior' (Standard) oder 'cover' (separates Umschlag-PDF).
    // opts.sample: Probeseiten — der Server rendert nur das erste Kapitel.
    async exportPdf(target = 'interior', opts = {}) {
      if (!this.activeProfile) return;
      // Vor Export speichern (Config könnte ungespeichert sein).
      await this.saveActiveProfile();
      if (this.exportError) return;
      // Umschlag-PDF immer Buch-scoped; sonst der gewählte Scope.
      const ref = target === 'cover'
        ? (Alpine.store('nav').selectedBookId ? { scope: 'book', id: parseInt(Alpine.store('nav').selectedBookId) } : null)
        : this._exportEntity();
      if (!ref) { this.exportError = window.__app.t('pdfExport.error.startFailed'); return; }
      // Fassungs-Quelle nur für den Innenteil des ganzen Buchs (Umschlag + Live-Cover
      // kommen weiterhin aus book_publication).
      const snapId = target === 'interior' ? this._exportSnapshotIdForSubmit() : null;
      this.exportLowRes = 0;
      this.exportHyphenOff = [];
      this.dismissWarnings();
      const sample = target === 'interior' && !!opts.sample;
      await this._runExportJob({
        ...(sample ? { sample: true } : {}),
        scope: ref.scope,
        entityId: ref.id,
        profile_id: this.activeProfile.id,
        target,
        ...(snapId ? { snapshot_id: snapId } : {}),
        ...(target === 'interior' && ref.scope === 'chapter' ? { include_subchapters: !!this.exportIncludeSubchapters } : {}),
      });
    },

    // ── Helpers fürs Template ────────────────────────────────────────────
    // Tab-State (activeTab) lebt über die `tabs`-Komponente im Markup
    // (x-modelable an activeTab gekoppelt) — kein setTab/isTab mehr hier.

    // Combobox-Options sind als Inline-Expressions im Template (siehe DESIGN.md
    // "Reaktivitaet bei Datenquelle aus Karten-Scope"). Nested x-data der Combobox
    // trackt this.xxx aus Card-Methods nicht zuverlaessig — deshalb Arrays inline
    // im x-effect aufbauen.
  }));
}
