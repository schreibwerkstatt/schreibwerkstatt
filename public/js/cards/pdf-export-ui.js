// UI-Slice der PDF-Export-Karte: ungespeicherte Änderungen, Einfach-/Experten-
// Modus, Satzspiegel-Vorschau, Seitenzahl-Schätzung, Export-Befunde, Probeseiten.
// Per Spread in `Alpine.data('pdfExportCard')` gemischt (pdf-export-card.js);
// ausgelagert, weil die Karte sonst über das 600-LOC-Limit liefe. Die
// Rechnungen selbst liegen pur in pdf-export-geometry.js / -warnings.js.

import { getUserPref, setUserPref } from '../local-prefs.js';
import * as geometry from './pdf-export-geometry.js';
import { buildRenderWarnings } from './pdf-export-warnings.js';
import { HYPHEN_BROKEN_FAMILIES } from './pdf-export-templates.js';
import * as presets from './pdf-export-presets.js';
import { takeCardRequest, CARD_REQUEST } from './card-request.js';

const UI_MODE_PREF = 'pdfExport.uiMode';
// Tabs, die nur der Experten-Modus zeigt: Fussnotenapparat/Tabellensatz und
// Umschlag sind Feinsatz, nicht die Grundentscheidung über ein Buch.
export const EXPERT_ONLY_TABS = ['apparat', 'cover'];

function _email() {
  try { return window.Alpine?.store('session')?.currentUser?.email || ''; } catch { return ''; }
}

export function pdfExportUiSlice() {
  return {
    // 'simple' | 'expert' — per Betrachter im localStorage (local-prefs →
    // safe-storage, werfensfrei). Neue Nutzer starten einfach.
    uiMode: 'simple',
    // JSON-Stand der zuletzt geladenen/gespeicherten Profil-Config. Vergleichs-
    // basis für isDirty(); '' = kein Profil geladen.
    _savedSnapshot: '',
    // Befunde des letzten Exports (pdf-export-warnings.js), bleiben stehen bis
    // zum Wegklicken oder zum nächsten Export.
    exportWarnings: [],
    exportWarningsSample: false,
    // Zuletzt gewählter Trim-Preset-Wert: mehrere Dienste teilen ein Format,
    // die Combobox soll den gewählten Dienst zeigen, solange er noch passt.
    _trimPicked: '',

    _initUiMode() {
      const saved = getUserPref(_email(), UI_MODE_PREF, 'simple');
      this.uiMode = saved === 'expert' ? 'expert' : 'simple';
    },
    setUiMode(mode) {
      this.uiMode = mode === 'expert' ? 'expert' : 'simple';
      setUserPref(_email(), UI_MODE_PREF, this.uiMode);
      if (this.uiMode === 'simple' && EXPERT_ONLY_TABS.includes(this.activeTab)) this.activeTab = 'layout';
    },
    tabVisible(tab) {
      return this.uiMode === 'expert' || !EXPERT_ONLY_TABS.includes(tab);
    },
    // Sprung auf einen Reiter (Command-Palette). Ein Experten-Reiter schaltet
    // nur für diese Sitzung in den Experten-Modus; die gemerkte Wahl bleibt.
    _applyPendingTab() {
      const tab = takeCardRequest(CARD_REQUEST.PDF_EXPORT_TAB);
      if (!tab) return;
      if (EXPERT_ONLY_TABS.includes(tab)) this.uiMode = 'expert';
      this.activeTab = tab;
    },

    // ── Ungespeicherte Änderungen ─────────────────────────────────────────
    _takeSnapshot() {
      this._savedSnapshot = this.activeProfile ? JSON.stringify(this.activeProfile.config) : '';
    },
    isDirty() {
      if (!this.activeProfile || !this._savedSnapshot) return false;
      return JSON.stringify(this.activeProfile.config) !== this._savedSnapshot;
    },
    // true = weitermachen (nichts offen oder Verwerfen bestätigt).
    async _confirmDiscard() {
      if (!this.isDirty()) return true;
      const app = window.__app;
      if (typeof app?.appConfirm !== 'function') return true;
      return !!(await app.appConfirm({
        message: app.t('pdfExport.dirty.confirmDiscard'),
        confirmLabel: app.t('pdfExport.dirty.discard'),
        danger: true,
      }));
    },
    // Für Aktionen aus geteilten Slices (Duplizieren, Import), die vom Wechsel
    // des aktiven Profils leben: erst fragen, dann ausführen.
    async withDirtyGuard(fn) {
      if (!(await this._confirmDiscard())) return;
      await fn();
    },
    async onProfilePick(id) {
      if (this.activeProfile && String(id) === String(this.activeProfile.id)) return;
      if (!(await this._confirmDiscard())) {
        // x-model hat activeProfileId schon umgestellt — zurückdrehen.
        this.activeProfileId = this.activeProfile?.id ?? null;
        return;
      }
      await this.selectProfile(id);
    },
    // Karte wird geschlossen: der State bleibt im Speicher (die Karte ist nur
    // ausgeblendet), aber das Offene soll nicht unbemerkt liegen bleiben.
    async _onHiddenWhileDirty() {
      if (!this.isDirty()) return;
      const app = window.__app;
      if (typeof app?.appConfirm !== 'function') return;
      const save = await app.appConfirm({
        message: app.t('pdfExport.dirty.confirmOnClose'),
        confirmLabel: app.t('common.save'),
        cancelLabel: app.t('pdfExport.dirty.keep'),
      });
      if (save) await this.saveActiveProfile();
    },

    // ── Satzspiegel / Geometrie ───────────────────────────────────────────
    satzspiegel() { return geometry.satzspiegelPreview(this.activeProfile?.config); },
    geometryWarnings() {
      const cfg = this.activeProfile?.config;
      return cfg ? geometry.geometryWarnings(cfg, window.__app.t) : [];
    },
    headingWarnings() {
      const app = window.__app;
      return geometry.headingChainViolations(this.activeProfile?.config).map(v => app.t('pdfExport.font.warnHeadingChain', {
        upper: app.t('pdfExport.font.headingSize.' + v.upper),
        lower: v.lower === 'body' ? app.t('pdfExport.font.body') : app.t('pdfExport.font.headingSize.' + v.lower),
      }));
    },
    isHyphenBroken(family) { return HYPHEN_BROKEN_FAMILIES.includes(family); },

    // ── Seitenzahl-Schätzung (vor dem ersten Ganzbuch-Export) ─────────────
    estimatedPages() {
      const cfg = this.activeProfile?.config;
      if (!cfg) return 0;
      const chars = window.__app?.tokTotals?.chars || 0;
      const tree = window.Alpine?.store('nav')?.tree;
      const chapters = Array.isArray(tree) ? tree.filter(c => c.type === 'chapter').length : 0;
      return geometry.estimatePageCount(cfg, { chars, chapters });
    },
    kdpMarginWarnings() {
      const cfg = this.activeProfile?.config;
      return cfg ? presets.kdpMarginWarnings(cfg, window.__app.t, this.estimatedPages()) : [];
    },
    applyKdpPreset() {
      if (this.activeProfile) presets.applyKdpPreset(this.activeProfile.config, this.estimatedPages());
    },

    // ── Trim-Preset-Combobox spiegelt den Zustand ─────────────────────────
    trimPresetOptions() {
      const t = window.__app.t;
      return [{ value: 'custom', label: t('pdfExport.layout.trimCustom') }, ...presets.trimPresetOptions(t)];
    },
    currentTrimPreset() { return presets.matchTrimPreset(this.activeProfile?.config, this._trimPicked); },
    applyTrimPreset(value) {
      if (!this.activeProfile || !value || value === 'custom') return;
      this._trimPicked = value;
      presets.applyTrimPreset(this.activeProfile.config, value);
    },

    // ── Export-Befunde ────────────────────────────────────────────────────
    _collectWarnings(result) {
      this.exportWarnings = buildRenderWarnings(result, window.__app.t);
      this.exportWarningsSample = !!result?.sample;
    },
    dismissWarnings() {
      this.exportWarnings = [];
      this.exportWarningsSample = false;
    },

    // Probeseiten: nur das erste Kapitel, gleicher Poll-/Download-Weg wie der
    // volle Export (Server hängt «-probe» an den Dateinamen).
    async exportSample() { await this.exportPdf('interior', { sample: true }); },

    // Slot-Auszeichnung (bold/italic/upper) einer Kopf-/Fusszeilen-Zelle
    // umschalten bzw. abfragen. Die Struktur wird beim ersten Toggle lazy
    // angelegt (ältere Profile ohne layout.hfStyle crashen so nicht; Server-
    // Validierung ergänzt den Rest beim Speichern), Alpine wrappt sie reaktiv.
    hfStyleActive(zone, side, pos, attr) {
      return !!this.activeProfile?.config?.layout?.hfStyle?.[zone]?.[side]?.[pos]?.[attr];
    },
    toggleHfStyle(zone, side, pos, attr) {
      const lay = this.activeProfile?.config?.layout;
      if (!lay) return;
      const hf = lay.hfStyle || (lay.hfStyle = {});
      const zo = hf[zone] || (hf[zone] = {}), si = zo[side] || (zo[side] = {});
      const cell = si[pos] || (si[pos] = { bold: false, italic: false, upper: false });
      cell[attr] = !cell[attr];
    },

    // ── PDF-eigene Picker (Seitenzähler-Skip) ─────────────────────────────
    // Picker fuer Seitenzaehler-Skip: gleicher Tree-Lookup wie bei
    // unnumberedChapterPickOptions; Kapitel-Auswahl ohne Numbering-Mode-Gate
    // (gilt auch wenn Kapitel-Titel-Nummern aus sind).
    skipPageCounterChapterPickOptions() {
      return this.unnumberedChapterPickOptions();
    },
    skipPageCounterChapterChips() {
      const ids = this.activeProfile?.config?.chapter?.skipPageCounterChapterIds || [];
      const opts = this.skipPageCounterChapterPickOptions();
      return ids.map(id => {
        const o = opts.find(x => x.value === id);
        return o ? { id, label: o.label } : { id, label: '#' + id };
      });
    },
    removeSkipPageCounterChapter(id) {
      if (!this.activeProfile) return;
      const arr = this.activeProfile.config.chapter.skipPageCounterChapterIds || [];
      this.activeProfile.config.chapter.skipPageCounterChapterIds = arr.filter(v => v !== id);
    },
    // Seiten-Picker: Pages mit Kapitel-Prefix gruppiert (Label "Kapitel — Seite").
    skipPageCounterPagePickOptions() {
      const app = window.__app;
      if (!app || !Array.isArray(Alpine.store('nav').pages)) return [];
      const chapterById = new Map();
      if (Array.isArray(Alpine.store('nav').tree)) {
        for (const c of Alpine.store('nav').tree) {
          if (c.type === 'chapter') chapterById.set(c.id, c.name);
        }
      }
      return Alpine.store('nav').pages.map(p => {
        const chName = p.chapter_id ? chapterById.get(p.chapter_id) : null;
        return {
          value: p.id,
          label: chName ? `${chName} — ${p.name}` : p.name,
        };
      });
    },
    skipPageCounterPageChips() {
      const ids = this.activeProfile?.config?.chapter?.skipPageCounterPageIds || [];
      const opts = this.skipPageCounterPagePickOptions();
      return ids.map(id => {
        const o = opts.find(x => x.value === id);
        return o ? { id, label: o.label } : { id, label: '#' + id };
      });
    },
    removeSkipPageCounterPage(id) {
      if (!this.activeProfile) return;
      const arr = this.activeProfile.config.chapter.skipPageCounterPageIds || [];
      this.activeProfile.config.chapter.skipPageCounterPageIds = arr.filter(v => v !== id);
    },
  };
}
