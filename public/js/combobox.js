// Searchable Dropdown-Combobox.
//
// Ersetzt `<select>` mit Tastatur-Nav, Such-Filter, optionaler Multi-Auswahl
// und Footer-Aktion. `init()` rendert Trigger + Dropdown + Search + Liste
// komplett selbst und ueberschreibt den Inhalt des Wrapper-Divs.
//
// Verwendung (DESIGN.md-konform, Pattern wie num-input):
//
//   <div x-data="combobox(placeholder, emptyLabel?)"
//        x-modelable="value" x-model="selectedRef"
//        x-effect="options = computeOptionsInline()"></div>
//
// Pflicht-Attribute (3): `x-data="combobox(...)"`, `x-modelable="value"`,
// `x-model="..."`. `init()` setzt `combobox-wrap[--compact]`-Klassen,
// document-Mousedown (Outside-Close), Element-Keydown (Tastatur-Nav) und
// ARIA-Rollen — Konsumenten brauchen kein `@click.outside`, kein `@keydown`,
// keine `class`-Attribute.

// comboboxData: pure Factory ohne Alpine-Registrierung. Wird von
// `registerCombobox` UND von Wrapper-Komponenten (z. B. `catalogFilter`)
// genutzt, damit Spezialisierungen die volle Combobox-Mechanik erben statt
// sie zu reimplementieren. cfg-Form deckt sich mit der Object-Variante von
// `combobox(...)` aus den Templates: { placeholder, emptyLabel, compact,
// multiple, transient, footer, autoOpen }. Sowohl `placeholder` als auch
// `emptyLabel` duerfen Funktionen sein (fuer reaktive i18n-Aufloesung).
//
// `autoOpen` klappt die Liste direkt nach dem Mount auf. Zusammen mit dem
// `combobox-close`-Event (feuert, wenn eine offene Liste schliesst) erlaubt das
// Listen mit vielen Zeilen, die echte Combobox erst beim Klick auf einen
// gleich aussehenden Platzhalter-Trigger zu montieren und danach wieder
// abzubauen — jede Instanz kostet eine Alpine-Komponente plus zwei globale
// Listener (Buchorganizer: organizer-page-actions.html).
export function comboboxData(cfg = {}) {
  if (cfg.compact === undefined) cfg.compact = true;
  return {
      open: false,
      query: '',
      // Single mode: scalar; Multi mode: Array. x-modelable seeded from parent.
      value: cfg.multiple ? [] : null,
      options: [],
      _disabled: false,
      _placeholder: cfg.placeholder ?? null,
      _emptyLabel: cfg.emptyLabel ?? null,
      _compact: cfg.compact !== false,
      _multiple: !!cfg.multiple,
      _transient: !!cfg.transient,
      _autoOpen: !!cfg.autoOpen,
      _footer: (cfg.footer && typeof cfg.footer.action === 'function') ? cfg.footer : null,
      _onOutside: null,
      _onScroll: null,
      _rootEl: null,
      // Nur noch die BREITE wird an den Trigger angeglichen (damit das Dropdown
      // wie ein <select> mindestens trigger-breit ist). POSITION + Flip +
      // Overflow-Escape + Reposition-bei-Scroll macht x-anchor (Floating UI).
      ddWidth: null,
      highlighted: -1,

      // Mobile = schmaler Viewport ODER Touch-Geraet (keine Maus). Steuert nur
      // den Auto-Fokus: auf Touch NICHT aufs Suchfeld fokussieren, sonst oeffnet
      // die Bildschirm-Tastatur und ihr resize verschiebt das am Trigger
      // verankerte Dropdown. Touch-Erkennung ist Pflicht — sonst landen breitere
      // Touch-Geraete (Tablet, grosses Phone im Querformat) im Auto-Fokus-Pfad.
      _isMobile() {
        if (typeof window === 'undefined') return false;
        if (window.innerWidth <= 600) return true;
        return window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches ?? false;
      },

      get placeholder() {
        const p = this._placeholder;
        if (typeof p === 'function') return p() ?? window.__app?.t?.('common.choose') ?? 'Auswählen…';
        return p ?? window.__app?.t?.('common.choose') ?? 'Auswählen…';
      },
      get emptyLabel() {
        const e = this._emptyLabel;
        if (typeof e === 'function') return e() ?? null;
        return e;
      },
      get _allOptions() {
        if (this._multiple) return this.options;
        return this.emptyLabel
          ? [{ value: '', label: this.emptyLabel }, ...this.options]
          : this.options;
      },
      get filtered() {
        if (!this.query) return this._allOptions;
        const q = this.query.toLowerCase();
        // Optionale sublabel (Zweitzeile, z. B. Figuren-Kontext) ist mitsuchbar.
        return this._allOptions.filter(o =>
          String(o.label).toLowerCase().includes(q) ||
          (o.sublabel && String(o.sublabel).toLowerCase().includes(q)));
      },
      // Render-Plan der Liste: optionale Gruppen-Header (opt.group) zwischen den
      // Optionen. Trägt KEINE Option ein `group`, fällt das auf eine reine
      // Options-Liste zurück (byte-gleich zum ungruppierten Verhalten — additiv).
      // Header-Zeilen sind nicht fokussierbar/auswählbar; `highlighted` indexiert
      // weiterhin nur die Optionen (= Index in `filtered`), sodass Tastatur-Nav
      // die Header automatisch überspringt.
      get groupedRows() {
        const rows = [];
        let lastGroup;
        const f = this.filtered;
        for (let i = 0; i < f.length; i++) {
          const opt = f[i];
          const g = (opt.group == null || opt.group === '') ? null : opt.group;
          // Der Index gehoert in den Key: `x-for` braucht EINDEUTIGE Keys, und
          // weder Gruppenname noch Wert sind das zwangslaeufig — eine Liste, in
          // der dieselbe Gruppe spaeter noch einmal auftaucht, haette zweimal
          // denselben Header-Key, und Alpine wirft davon eine Zeile weg
          // (sichtbar als fehlende Kopfzeile ganz oben).
          if (g !== null && g !== lastGroup) rows.push({ kind: 'header', label: g, key: 'h:' + i + ':' + g });
          lastGroup = g;
          rows.push({ kind: 'option', opt, optIndex: i, key: 'o:' + i + ':' + (g ?? '') + ':' + String(opt.value) });
        }
        return rows;
      },
      _isSelected(val) {
        if (this._multiple) {
          const arr = Array.isArray(this.value) ? this.value : [];
          return arr.some(v => String(v) === String(val));
        }
        return String(this.value ?? '') === String(val);
      },
      get selectedLabel() {
        if (this._multiple) {
          const arr = Array.isArray(this.value) ? this.value : [];
          if (!arr.length) return '';
          const app = window.__app;
          return app?.t ? app.t('common.multiSelected', { n: arr.length }) : `${arr.length}`;
        }
        const v = this.value ?? '';
        const opt = this._allOptions.find(o => String(o.value) === String(v));
        if (opt) return opt.label;
        return this.emptyLabel || '';
      },

      toggle() {
        if (this._disabled) return;
        if (this.open) { this.close(); return; }
        this.open = true;
        this.query = '';
        if (this._multiple) {
          const arr = Array.isArray(this.value) ? this.value : [];
          this.highlighted = arr.length
            ? this._allOptions.findIndex(o => arr.some(v => String(v) === String(o.value)))
            : 0;
        } else {
          this.highlighted = this._allOptions.findIndex(o => String(o.value) === String(this.value));
        }
        // Breite an den Trigger angleichen, damit das Dropdown wie ein <select>
        // mindestens trigger-breit ist.
        const trig = this._rootEl.querySelector('.combobox-trigger');
        const w = trig ? Math.max(trig.offsetWidth, this._compact ? 180 : 0) : 0;
        this.ddWidth = w ? w + 'px' : null;
        // Erst fokussieren, wenn das Dropdown wirklich sichtbar ist: Alpines
        // `x-show` blendet verzoegert ein (eigener Timer, bei frisch montierten
        // Comboboxen auch erst nach einem Frame). Ein focus() auf das noch
        // `display: none`-Suchfeld verpufft — der Fokus bliebe auf dem Trigger
        // (bzw. auf <body>, wenn der Trigger dabei verschwindet), und Tippen
        // filterte nicht. Darum pro Frame pruefen, mit Obergrenze.
        const focusWhenShown = (framesLeft) => {
          if (!this.open) return;
          const dd = this._rootEl.querySelector('.combobox-dropdown');
          if (dd?.style.display === 'none' && framesLeft > 0) {
            requestAnimationFrame(() => focusWhenShown(framesLeft - 1));
            return;
          }
          // Auf Mobile/Touch NICHT auto-fokussieren: der Fokus oeffnet die
          // Bildschirm-Tastatur, deren resize das am Trigger verankerte Dropdown
          // verschieben wuerde. Die Liste ist auch ohne Fokus voll bedienbar.
          if (!this._isMobile()) this.$refs.cbInput?.focus();
          // Aktuell gewaehlten Eintrag beim Oeffnen in den sichtbaren Bereich
          // scrollen, damit lange Listen nicht am Anfang stehen bleiben.
          this._scrollHl();
        };
        this.$nextTick(() => focusWhenShown(10));
      },
      close() {
        const wasOpen = this.open;
        this.open = false;
        this.query = '';
        this.highlighted = -1;
        this.ddWidth = null;
        if (wasOpen) this.$dispatch('combobox-close');
      },
      select(val) {
        if (this._multiple) {
          const arr = Array.isArray(this.value) ? this.value : [];
          const idx = arr.findIndex(v => String(v) === String(val));
          this.value = idx >= 0
            ? arr.filter((_, i) => i !== idx)
            : [...arr, val];
          this.$dispatch('combobox-change', this.value);
          return;
        }
        this.value = val;
        this.close();
        this.$dispatch('combobox-change', val);
        if (this._transient) this.value = null;
      },
      triggerFooter() {
        const f = this._footer;
        if (!f || typeof f.action !== 'function') return;
        this.close();
        try { f.action(); } catch (e) { console.error('[combobox.footer]', e); }
      },
      get _footerLabel() {
        const f = this._footer;
        if (!f) return '';
        return typeof f.label === 'function' ? f.label() : (f.label || '');
      },
      onKeydown(e) {
        if (!this.open) {
          if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); this.toggle(); }
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.highlighted = Math.min(this.highlighted + 1, this.filtered.length - 1);
          this._scrollHl();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.highlighted = Math.max(this.highlighted - 1, 0);
          this._scrollHl();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (this.highlighted >= 0 && this.filtered[this.highlighted]) this.select(this.filtered[this.highlighted].value);
        } else if (e.key === 'Escape') {
          // Dropdown offen → Escape schliesst NUR das Dropdown. stopPropagation, damit
          // ein umschliessender Editor (Motiv-/Beat-Panel mit panel-weitem Escape=Abbrechen)
          // den Tastendruck nicht zusätzlich als „Bearbeitung verwerfen" auffasst.
          e.preventDefault(); e.stopPropagation(); this.close();
        }
      },
      _scrollHl() {
        // Per Klasse statt Kind-Index scrollen — bei gruppierten Listen liegen
        // Header-Zeilen dazwischen, sodass `children[highlighted]` danebenläge.
        this.$nextTick(() => {
          this._rootEl.querySelector('.combobox-option--hl')?.scrollIntoView({ block: 'nearest' });
        });
      },
      init() {
        // Wrap-Element (x-data-Root) cachen. `this.$el` zeigt zur Laufzeit
        // (z. B. aus dem @click-Handler des Triggers) auf den Trigger-Button,
        // nicht auf den Wrap — Methoden brauchen aber zuverlaessig den Wrap.
        this._rootEl = this.$el;
        this._rootEl.classList.add('combobox-wrap');
        if (this._compact) this._rootEl.classList.add('combobox-wrap--compact');

        this._onOutside = (e) => { if (!this._rootEl.contains(e.target)) this.close(); };
        document.addEventListener('mousedown', this._onOutside);
        // Beim Scrollen des restlichen Screens das Dropdown schliessen (wie ein
        // natives <select>). Das fixed-positionierte, am Trigger verankerte
        // Dropdown wuerde sonst bei jedem Scroll-Frame nachgerechnet und flackert
        // sichtbar hinter dem Trigger her. Scrollen INNERHALB des Dropdowns
        // (Options-Liste) laesst es offen — Capture-Phase, um window-Scroll zu
        // sehen, target-Check schliesst Eigen-Scroll aus.
        this._onScroll = (e) => {
          if (!this.open) return;
          const dd = this._rootEl.querySelector('.combobox-dropdown');
          if (dd && (e.target === dd || dd.contains(e.target))) return;
          this.close();
        };
        window.addEventListener('scroll', this._onScroll, { capture: true, passive: true });
        this._rootEl.addEventListener('keydown', (e) => this.onKeydown(e));

        this._rootEl.setAttribute('role', 'combobox');
        this._rootEl.setAttribute('aria-haspopup', 'listbox');
        if (this._multiple) {
          this._rootEl.classList.add('combobox-wrap--multi');
          this._rootEl.setAttribute('aria-multiselectable', 'true');
        }
        this.$watch('query', () => {
          this.highlighted = this.filtered.length > 0 ? 0 : -1;
        });
        const template = [
          '<button type="button" class="combobox-trigger" @click="toggle()" x-ref="cbTrigger"',
          '        :aria-expanded="open ? \'true\' : \'false\'"',
          '        :aria-label="selectedLabel || placeholder">',
          '  <span class="combobox-value" x-text="selectedLabel || placeholder"></span>',
          '  <svg class="combobox-chevron" :class="{\'combobox-chevron--open\': open}" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1.5 3.5L5 7L8.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          '</button>',
          // Position via x-anchor (Floating UI): `.fixed` entkommt overflow-
          // clippenden Vorfahren (Plot-Swimlane-Grid), Flip nach oben passiert
          // automatisch, wenn unten kein Platz ist (auch auf Mobile). Breite via
          // ddWidth (= Trigger-Breite).
          // `x-id` ist Pflicht und nicht bloss Kosmetik: `$id()` memoisiert pro
          // ELEMENT und zieht ohne einen solchen Scope bei jedem Aufruf auf einem
          // anderen Element eine neue Nummer. `aria-activedescendant` steht am
          // <ul>, die `id` an jedem <li> (und im x-for je Zeile ein eigenes
          // Element) — ohne die Klammer zeigt der Verweis auf eine ID, die es
          // nicht gibt, und der Screenreader verliert die aktive Option. Der
          // Scope sitzt am Dropdown, weil es beide Seiten umschliesst; pro
          // Combobox-Instanz vergibt Alpine darin genau eine Nummer.
          '<div class="combobox-dropdown" x-id="[\'cb-opt\']" :style="ddWidth ? { width: ddWidth } : {}" x-anchor:bottom-start.fixed="$refs.cbTrigger" x-show="open" x-cloak>',
          '  <input type="text" class="combobox-search" x-model="query" x-ref="cbInput"',
          '         :placeholder="$app.t(\'common.searchShort\')" role="searchbox" :aria-label="$app.t(\'common.searchShort\')">',
          '  <ul class="combobox-list" role="listbox"',
          '      :aria-activedescendant="highlighted >= 0 ? ($id(\'cb-opt\') + \'-\' + highlighted) : null">',
          '    <template x-for="row in groupedRows" :key="row.key">',
          '      <li :class="row.kind === \'header\' ? \'combobox-group\' : {\'combobox-option\': true, \'combobox-option--selected\': _isSelected(row.opt.value), \'combobox-option--hl\': row.optIndex === highlighted}"',
          '          :role="row.kind === \'header\' ? \'presentation\' : \'option\'"',
          '          :id="row.kind === \'option\' ? ($id(\'cb-opt\') + \'-\' + row.optIndex) : null"',
          '          :aria-selected="row.kind === \'option\' ? (_isSelected(row.opt.value) ? \'true\' : \'false\') : null"',
          '          @click="row.kind === \'option\' && select(row.opt.value)" @mouseenter="row.kind === \'option\' && (highlighted = row.optIndex)">',
          '        <span class="combobox-group__label" x-show="row.kind === \'header\'" x-text="row.label"></span>',
          '        <span class="combobox-option__label" x-show="row.kind === \'option\'" x-text="row.opt?.label"></span>',
          '        <span class="combobox-option__sub" x-show="row.kind === \'option\' && row.opt?.sublabel" x-cloak x-text="row.opt?.sublabel"></span>',
          '      </li>',
          '    </template>',
          '    <li class="combobox-empty" x-show="filtered.length === 0" x-text="$app.t(\'find.noMatches\')"></li>',
          '  </ul>',
          '  <button type="button" class="combobox-footer-btn"',
          '          x-show="_footer" x-cloak',
          '          @click="triggerFooter()"',
          '          x-text="_footerLabel"></button>',
          '</div>',
        ].join('\n');
        this._rootEl.innerHTML = template;
        // Alpine processed das frisch gesetzte Markup nicht zuverlaessig, wenn
        // die Combobox innerhalb eines spaet hydratisierten Subtrees liegt
        // (template x-if mit nested x-data-Wrappern, Beispiel pdfExportCard).
        window.Alpine.initTree(this._rootEl);
        if (this._autoOpen) this.$nextTick(() => this.toggle());
      },
      destroy() {
        if (this._onOutside) {
          document.removeEventListener('mousedown', this._onOutside);
          this._onOutside = null;
        }
        if (this._onScroll) {
          window.removeEventListener('scroll', this._onScroll, { capture: true });
          this._onScroll = null;
        }
      },
    };
}

export function registerCombobox() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('combobox', (placeholderOrCfg = null, emptyLabelArg = null) => {
    const cfg = (placeholderOrCfg && typeof placeholderOrCfg === 'object')
      ? placeholderOrCfg
      : { placeholder: placeholderOrCfg, emptyLabel: emptyLabelArg, compact: true };
    return comboboxData(cfg);
  });
}
