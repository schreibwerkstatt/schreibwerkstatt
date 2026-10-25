// Alpine.data('paletteCard') — Command-Palette (Cmd/Ctrl+K bzw. /).
// Modal mit Such-Input + Sektionen aus Karten + globalen Aktionen + Such-Providern.
// Prefix-Modi: `>` Befehle, `#` Abschnitte, `!` Kapitel, `@` Figuren, `$` Orte,
// `%` Szenen, `&` Ereignisse, `?` Volltext. Ohne Prefix: alles fuzzy gemixt.
// Sektions-Aufbau (rein, testbar): palette-sections.js.
//
// Trigger:
//  - Hero-Bar Klick → CustomEvent('palette:open')
//  - Globaler Shortcut Cmd/Ctrl+K bzw. `/` (shortcuts.js) → CustomEvent('palette:open')
//
// Activate:
//  - Klick auf Item oder Enter mit aktiver Idx → activateItem(item)
//  - Schliesst Palette und ruft passende Aktion (Toggle/Action/Provider-Run).

import { EXCLUSIVE_CARDS } from './feature-registry.js';
import { highlight } from './palette-fuzzy.js';
import { PROVIDERS, parseQuery } from './palette-providers.js';
import { buildPaletteSections } from './palette-sections.js';
import { memoMethods } from './card-memo.js';
import { markNextUsageSource } from '../features-usage.js';
import { EVT } from '../events.js';
import { mountInTopLayer } from '../fullscreen.js';

const NO_SECTIONS = Object.freeze([]);

export function registerPaletteCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('paletteCard', () => ({
    paletteOpen: false,
    paletteQuery: '',
    paletteIdx: 0,
    paletteToast: '',
    _paletteAbort: null,
    _toastTimer: null,
    _memos: {},
    _returnFocusEl: null,
    _lastPointer: null,
    ...memoMethods,

    init() {
      const abort = new AbortController();
      this._paletteAbort = abort;
      const signal = abort.signal;

      window.addEventListener(EVT.PALETTE_OPEN, () => this.openPalette(), { signal });
      window.addEventListener(EVT.PALETTE_CLOSE, () => this.closePalette(), { signal });
      // Async-Provider (Fulltext) signalisiert via 'palette:rerender', dass
      // sich sein Cache geaendert hat — Memo leeren, damit paletteSections()
      // neu rechnet.
      window.addEventListener(EVT.PALETTE_RERENDER, () => { this._memos = {}; }, { signal });
    },

    destroy() {
      this._paletteAbort?.abort();
      if (this._toastTimer) clearTimeout(this._toastTimer);
      document.body.classList.remove('palette-open');
    },

    openPalette() {
      const active = document.activeElement;
      this._returnFocusEl = (active && active !== document.body) ? active : null;
      // Ist gerade eine Karte im Native-Vollbild (Plot/Motiv/Recherche/Bucheditor),
      // muss das Overlay in deren Top-Layer — als <body>-Kind laege es hinter dem
      // ::backdrop und Cmd+K wuerde scheinbar nichts tun. Bewusst umhaengen statt
      // das Vollbild zu beenden: die Palette wird oft mit Esc wieder verworfen, und
      // wer dafuer aus dem Vollbild-Board faellt, verliert seinen Kontext fuer
      // nichts. Waehlt man wirklich ein Ziel, endet das Vollbild ohnehin von selbst
      // (_closeOtherMainCards setzt die Karte auf display:none).
      this._remountPaletteOverlay();
      this.paletteOpen = true;
      this.paletteQuery = '';
      this.paletteIdx = 0;
      this.paletteToast = '';
      this._lastPointer = null;
      document.body.classList.add('palette-open');
      // Leere Datenquellen (Orte/Szenen/Ereignisse/Werkstatt-Figuren) jetzt
      // nachladen — sonst fände der Mix-Modus sie erst, wenn die jeweilige Karte
      // einmal offen war. Einmal pro Buch, siehe palette-providers#_ensureLoaded.
      const root = window.__app;
      if (root) {
        for (const p of PROVIDERS) {
          try { p.prepare?.(root); } catch (e) { console.error('[palette prepare]', e); }
        }
      }
      this.$nextTick(() => {
        const input = document.querySelector('.palette-input');
        if (input) input.focus();
      });
    },

    // Overlay in den aktuell obersten Layer haengen (Fullscreen-Element, sonst
    // <body>). Ebenen-Wahl in fullscreen.js#topLayerHost; hier ohne `target`,
    // weil die Palette global ist und nicht an einem Trigger haengt.
    _remountPaletteOverlay() {
      mountInTopLayer(document.querySelector('.palette-overlay'));
    },

    closePalette() {
      this.paletteOpen = false;
      this.paletteQuery = '';
      this.paletteIdx = 0;
      this.paletteToast = '';
      for (const p of PROVIDERS) p.cancel?.();
      document.body.classList.remove('palette-open');
      // Zurueck an <body>, solange kein Vollbild aktiv ist: sonst haengt das
      // Overlay in einer Karte, die spaeter geschlossen (display:none) wird und
      // es mit sich unsichtbar macht.
      this._remountPaletteOverlay();
      const el = this._returnFocusEl;
      this._returnFocusEl = null;
      if (el && typeof el.focus === 'function' && document.contains(el)) {
        try { el.focus(); } catch {}
      }
    },

    onPaletteInput() {
      this.paletteIdx = 0;
    },

    onPaletteKeydown(event) {
      const k = event.key;
      if (k === 'Escape') {
        event.preventDefault();
        this.closePalette();
        return;
      }
      const flat = this._flatItems();
      if (!flat.length) {
        if (k === 'Tab') event.preventDefault();
        return;
      }
      const idx = this._activeIdx(flat);
      if (k === 'ArrowDown' || (k === 'Tab' && !event.shiftKey)) {
        event.preventDefault();
        this.paletteIdx = (idx + 1) % flat.length;
        this._scrollActiveIntoView();
      } else if (k === 'ArrowUp' || (k === 'Tab' && event.shiftKey)) {
        event.preventDefault();
        this.paletteIdx = (idx - 1 + flat.length) % flat.length;
        this._scrollActiveIntoView();
      } else if (k === 'Enter') {
        event.preventDefault();
        const item = flat[idx];
        if (item) this.activateItem(item);
      }
    },

    // paletteIdx auf die aktuelle Liste geklemmt: trifft die Volltextsuche nach
    // dem letzten Tastendruck ein, kann die Liste kuerzer geworden sein.
    _activeIdx(flat) {
      return flat.length ? Math.min(this.paletteIdx, flat.length - 1) : -1;
    },

    _scrollActiveIntoView() {
      this.$nextTick(() => {
        const el = document.querySelector('.palette-item--active');
        if (el) el.scrollIntoView({ block: 'nearest' });
      });
    },

    _ctx() {
      const root = window.__app || {};
      return {
        selectedBookId: Alpine.store('nav').selectedBookId,
        hasBooks: (Alpine.store('nav').books || []).length > 0,
        pages: Alpine.store('nav').pages,
        bookRole: root.currentBookRole || null,
        buchtyp: (typeof root.currentBuchtyp === 'function' ? root.currentBuchtyp() : null) || null,
        cloudModelEffective: (Alpine.store('config')?.effectiveProviderClass || 'cloud') === 'cloud',
        config: { languagetoolEnabled: !!Alpine.store('config')?.languagetoolEnabled },
      };
    },

    // ── Sektionen-Aufbau ──────────────────────────────────────────────────
    // Pro Render vielfach gelesen (jedes Item fragt paletteIsActive) → _memo.
    // Deps sind Referenzen: Catalog-Loader weisen ihre Listen neu zu; `pages`
    // und `tree` mutiert der Buchorganizer in-place, darum dort zusaetzlich die
    // Laenge. Geschlossen rechnet die Palette gar nicht — das x-for steht
    // hinter x-show und liefe sonst bei jeder Store-Aenderung mit.
    paletteSections() {
      if (!this.paletteOpen) return NO_SECTIONS;
      const root = window.__app || {};
      const ctx = this._ctx();
      const nav = Alpine.store('nav');
      const catalog = Alpine.store('catalog');
      const devMode = !!Alpine.store('session')?.devMode;
      const deps = [
        this.paletteQuery,
        ctx.selectedBookId, ctx.bookRole, ctx.buchtyp, ctx.cloudModelEffective,
        ctx.config.languagetoolEnabled,
        nav.pages, (nav.pages || []).length,
        nav.tree, (nav.tree || []).length, root._chapterLabelMap,
        nav.werkstattDrafts,
        catalog.figuren, catalog.orte, catalog.szenen, catalog.globalZeitstrahl,
        root.recentFeatureKeys, root.recentPageIds,
        Alpine.store('shell').uiLocale, devMode,
      ];
      return this._memo('sections', deps, () => buildPaletteSections({
        query: this.paletteQuery,
        ctx,
        devMode,
        recentFeatureKeys: root.recentFeatureKeys,
        recentPageIds: root.recentPageIds,
        t: (k, p) => this._t(k, p),
        root,
        providers: PROVIDERS,
      }));
    },

    // ── Flach-Liste für Tastatur-Navigation ──────────────────────────────
    // Memo an der Sections-Referenz — spart O(N) Spread pro paletteIsActive.
    _flatItems() {
      const sections = this.paletteSections();
      return this._memo('flat', [sections], () => {
        const out = [];
        for (const sec of sections) {
          for (const it of sec.items) out.push({ ...it, sectionKey: sec.key });
        }
        return out;
      });
    },

    // ── Render-Helfer für Template ────────────────────────────────────────
    paletteItemId(sectionKey, itemKey) {
      return 'palette-opt-' + sectionKey + '-' + String(itemKey).replace(/[^\w-]/g, '_');
    },

    paletteSectionLabelId(sectionKey) {
      return 'palette-sec-' + sectionKey;
    },

    paletteIsActive(sectionKey, itemKey) {
      const flat = this._flatItems();
      const cur = flat[this._activeIdx(flat)];
      return !!cur && cur.sectionKey === sectionKey && cur.key === itemKey;
    },

    activeItemDomId() {
      const flat = this._flatItems();
      const cur = flat[this._activeIdx(flat)];
      if (!cur) return '';
      return this.paletteItemId(cur.sectionKey, cur.key);
    },

    // Aktueller Modus für Mode-Pill (nur wenn Prefix erkannt).
    // Memo pro paletteQuery — Template ruft die Funktion 3× pro Render.
    paletteCurrentMode() {
      return this._memo('mode', [this.paletteQuery], () => {
        const parsed = parseQuery(this.paletteQuery);
        if (parsed.mode === 'commands') return { key: 'commands', labelKey: 'palette.mode.commands', prefix: '>' };
        if (parsed.mode === 'provider') return { key: parsed.provider.key, labelKey: parsed.provider.sectionKey, prefix: parsed.provider.prefix };
        return null;
      });
    },

    // Statische Legende der Prefix-Modi (für Empty-State).
    paletteLegendItems() {
      return [
        { prefix: '>', labelKey: 'palette.legend.commands' },
        { prefix: '#', labelKey: 'palette.legend.pages' },
        { prefix: '!', labelKey: 'palette.legend.chapters' },
        { prefix: '@', labelKey: 'palette.legend.figuren' },
        { prefix: '$', labelKey: 'palette.legend.orte' },
        { prefix: '%', labelKey: 'palette.legend.szenen' },
        { prefix: '&', labelKey: 'palette.legend.ereignisse' },
        { prefix: '?', labelKey: 'palette.legend.fulltext' },
      ];
    },

    // Hover markiert nur bei ECHTER Zeigerbewegung. mouseenter feuert auch,
    // wenn die Pfeiltasten-Navigation die Liste unter dem ruhenden Zeiger
    // durchscrollt — die Markierung spraenge dann auf das Item unter der Maus.
    onItemPointerMove(event, sectionKey, itemKey) {
      const last = this._lastPointer;
      if (last && last.x === event.clientX && last.y === event.clientY) return;
      this._lastPointer = { x: event.clientX, y: event.clientY };
      const flat = this._flatItems();
      const idx = flat.findIndex(it => it.sectionKey === sectionKey && it.key === itemKey);
      if (idx >= 0 && idx !== this.paletteIdx) this.paletteIdx = idx;
    },

    // t() darf nicht aus dem Root extrahiert werden — i18n.t liest `this.$store.shell.uiLocale`,
    // ein unbound-Aufruf wirft TypeError und kappt das gesamte Alpine-Rendering.
    _t(key, params) {
      const root = window.__app;
      if (root && typeof root.t === 'function') return root.t(key, params);
      return key;
    },

    renderLabelHtml(item) {
      if (item.labelKey) return highlight(this._t(item.labelKey), item.indices || []);
      return highlight(item.label || '', item.indices || []);
    },

    renderSubText(item) {
      if (item.kind === 'toggle' || item.kind === 'action') {
        return item.descKey ? this._t(item.descKey) : '';
      }
      return item.sub || '';
    },

    // ── Aktion ausführen ──────────────────────────────────────────────────
    activateItem(item) {
      if (!item) return;
      if (!item.available) {
        if (item.reasonKey) this._showToast(item.reasonKey);
        return;
      }
      const root = window.__app;
      if (!root) return;

      // Karten-Toggle
      // Palette-Semantik = "zur Karte gehen", nie zumachen. Manche
      // toggleXxxCard-Methoden schliessen beim 2. Klick; bei bereits offener
      // Karte daher nicht togglen, sondern nur hinscrollen.
      if (item.kind === 'toggle') {
        const fn = root[item.feature.toggle];
        if (typeof fn !== 'function') return;
        const alreadyOpen = !!root[item.feature.flag];
        this.closePalette();
        if (alreadyOpen) {
          const card = EXCLUSIVE_CARDS.find(c => c.flag === item.feature.flag);
          if (card) root._scrollToCardByKey?.(card.key);
          return;
        }
        // Gezaehlt wird die Oeffnung vom Show-Flag-Watch (features-usage.js);
        // die Palette gibt ihm nur die Quelle mit — ein eigener Track-Call
        // zaehlte jede Oeffnung doppelt.
        markNextUsageSource(item.feature.key, 'palette');
        fn.call(root);
        return;
      }
      // Globale Aktion bzw. Provider-Item. `run` darf async sein — dann faengt
      // erst das `.catch` am Promise den Fehler, nicht das try.
      const run = item.kind === 'action' ? item.feature.run : item.run;
      if (typeof run !== 'function') return;
      this.closePalette();
      const label = item.kind === 'action' ? '[palette action]' : '[palette provider]';
      try {
        Promise.resolve(run(root)).catch(e => console.error(label, e));
      } catch (e) { console.error(label, e); }
    },

    onOverlayClick(event) {
      if (event.target === event.currentTarget) this.closePalette();
    },

    // ── Disabled-Toast ───────────────────────────────────────────────────
    _showToast(key) {
      this.paletteToast = this._t(key);
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.paletteToast = ''; }, 2200);
    },
  }));
}
