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
// Outside-Close (document-Mousedown, nur solange offen), Element-Keydown
// (Tastatur-Nav), Focusout (Tab schliesst) und
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
// abzubauen — jede Instanz kostet eine Alpine-Komponente mit Trigger-Bindings
// (Buchorganizer: organizer-page-actions.html).
export function comboboxData(cfg = {}) {
  if (cfg.compact === undefined) cfg.compact = true;
  // Memo fuer `filtered`/`groupedRows` ausserhalb des reaktiven Objekts: ein
  // Schreiben auf `this` aus einem Getter heraus wuerde Alpine-Effekte
  // anstossen. Pro Render greifen Liste, Leer-Zeile und Tastatur-Nav mehrfach
  // zu — ohne Memo filtert jeder Zugriff alle Optionen neu. Schluessel ist die
  // Identitaet des (rohen) Options-Arrays: Konsumenten weisen per `x-effect`
  // immer ein neues Array zu, mutieren es nie an Ort.
  const memo = { filtered: { key: null, val: null }, rows: { key: null, val: null } };
  const rawOf = (v) => (typeof window !== 'undefined' && window.Alpine?.raw) ? window.Alpine.raw(v) : v;
  const sameKey = (a, b) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
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
      _onFocusOut: null,
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
        // Alle reaktiven Abhaengigkeiten werden VOR dem Memo-Vergleich gelesen,
        // damit Effekte sie auch bei einem Treffer weiter verfolgen.
        const all = this._allOptions;
        const query = this.query;
        const key = [rawOf(this.options), all.length, all[0]?.label, query];
        if (sameKey(memo.filtered.key, key)) return memo.filtered.val;
        let val = all;
        if (query) {
          const q = query.toLowerCase();
          // Optionale sublabel (Zweitzeile, z. B. Figuren-Kontext) ist mitsuchbar.
          val = all.filter(o =>
            String(o.label).toLowerCase().includes(q) ||
            (o.sublabel && String(o.sublabel).toLowerCase().includes(q)));
        }
        memo.filtered = { key, val };
        return val;
      },
      // Render-Plan der Liste: optionale Gruppen-Header (opt.group) zwischen den
      // Optionen. Trägt KEINE Option ein `group`, fällt das auf eine reine
      // Options-Liste zurück (byte-gleich zum ungruppierten Verhalten — additiv).
      // Header-Zeilen sind nicht fokussierbar/auswählbar; `highlighted` indexiert
      // weiterhin nur die Optionen (= Index in `filtered`), sodass Tastatur-Nav
      // die Header automatisch überspringt.
      get groupedRows() {
        const f = this.filtered;
        if (memo.rows.key === f) return memo.rows.val;
        const rows = [];
        // Keys muessen EINDEUTIG sein (Alpine wirft bei doppelten Keys eine Zeile
        // weg — sichtbar als fehlende Kopfzeile, wenn dieselbe Gruppe spaeter
        // noch einmal auftaucht) und STABIL ueber das Filtern hinweg: steckte der
        // Listen-Index im Key, aenderte jedes getippte Zeichen alle Keys, und
        // Alpine baute jede Zeile neu statt sie wiederzuverwenden. Darum Gruppe
        // + Wert, und nur bei einer Kollision ein Zaehler-Suffix.
        const used = new Set();
        const uniq = (base) => {
          let k = base;
          for (let n = 1; used.has(k); n++) k = base + '#' + n;
          used.add(k);
          return k;
        };
        let lastGroup;
        for (let i = 0; i < f.length; i++) {
          const opt = f[i];
          const g = (opt.group == null || opt.group === '') ? null : opt.group;
          if (g !== null && g !== lastGroup) rows.push({ kind: 'header', label: g, key: uniq('h:' + g) });
          lastGroup = g;
          rows.push({ kind: 'option', opt, optIndex: i, key: uniq('o:' + (g ?? '') + ':' + String(opt.value)) });
        }
        memo.rows = { key: f, val: rows };
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
        if (this.open) { this.close(true); return; }
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
        const trig = this.$refs.cbTrigger;
        const w = trig ? Math.max(trig.offsetWidth, this._compact ? 180 : 0) : 0;
        this.ddWidth = w ? w + 'px' : null;
        this._listen(true);
        // Das Dropdown haengt an `x-if="open"` und existiert erst nach Alpines
        // naechstem Effekt-Durchlauf — bei frisch montierten Comboboxen (Lazy-
        // Muster mit `autoOpen`) auch erst einen Frame spaeter. Ein focus() vor
        // dem Einfuegen verpufft, und Tippen filterte nicht. Darum pro Frame
        // pruefen, mit Obergrenze.
        const focusWhenShown = (framesLeft) => {
          if (!this.open) return;
          const input = this.$refs.cbInput;
          if (!input && framesLeft > 0) {
            requestAnimationFrame(() => focusWhenShown(framesLeft - 1));
            return;
          }
          // Auf Mobile/Touch NICHT auto-fokussieren: der Fokus oeffnet die
          // Bildschirm-Tastatur, deren resize das am Trigger verankerte Dropdown
          // verschieben wuerde. Die Liste ist auch ohne Fokus voll bedienbar.
          // `preventScroll`: geht das Dropdown nahe am Viewport-Rand auf, wuerde
          // der Browser zum Suchfeld scrollen — und der Scroll-Listener schloesse
          // die frisch geoeffnete Liste sofort wieder.
          if (!this._isMobile()) input?.focus({ preventScroll: true });
          // Aktuell gewaehlten Eintrag beim Oeffnen in den sichtbaren Bereich
          // scrollen, damit lange Listen nicht am Anfang stehen bleiben.
          this._syncHl(true);
        };
        this.$nextTick(() => focusWhenShown(10));
      },
      // `restoreFocus`: nur wenn die Combobox selbst schliesst (Escape, Auswahl,
      // Trigger-Klick). Das Suchfeld verschwindet mit dem Dropdown, und ohne
      // Rueckgabe fiele der Fokus auf <body> — Tastatur-User muessten von vorn
      // tabben. Beim Klick ausserhalb oder Scroll gehoert der Fokus dem Ziel.
      close(restoreFocus = false) {
        const wasOpen = this.open;
        if (restoreFocus && wasOpen && this._rootEl.contains(document.activeElement)
            && document.activeElement !== this.$refs.cbTrigger) {
          this.$refs.cbTrigger?.focus({ preventScroll: true });
        }
        this.open = false;
        this.query = '';
        this.highlighted = -1;
        this.ddWidth = null;
        this._listen(false);
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
        this.close(true);
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
          this._syncHl(true);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.highlighted = Math.max(this.highlighted - 1, 0);
          this._syncHl(true);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (this.highlighted >= 0 && this.filtered[this.highlighted]) this.select(this.filtered[this.highlighted].value);
        } else if (e.key === 'Escape') {
          // Dropdown offen → Escape schliesst NUR das Dropdown. stopPropagation, damit
          // ein umschliessender Editor (Motiv-/Beat-Panel mit panel-weitem Escape=Abbrechen)
          // den Tastendruck nicht zusätzlich als „Bearbeitung verwerfen" auffasst.
          e.preventDefault(); e.stopPropagation(); this.close(true);
        }
      },
      // Maus-Hover setzt die Markierung nur bei echter Bewegung und nur, wenn
      // sie wechselt: `mouseenter` feuert auch, wenn die Liste unter dem
      // stehenden Zeiger scrollt (Pfeiltasten), und risse die Tastatur-
      // Markierung an die Zeigerposition zurueck.
      hoverHl(i) {
        if (this.highlighted !== i) {
          this.highlighted = i;
          this._syncHl(false);
        }
      },
      // Markierungs-Klasse imperativ setzen statt ueber `:class` je Zeile: als
      // Binding haengt jede Zeile von `highlighted` ab, und jeder Wechsel
      // (Hover, Pfeiltaste) wertete die Klassen ALLER Zeilen neu aus — bei
      // langen Listen das Ruckeln beim Ueberfahren. So sind es zwei Zeilen.
      // Im naechsten Tick, damit ein frisch gefiltertes `x-for` schon steht.
      _syncHl(scroll) {
        this.$nextTick(() => {
          const list = this._rootEl.querySelector('.combobox-list');
          if (!list) return;
          const want = this.highlighted >= 0
            ? list.querySelector(`[data-opt-index="${this.highlighted}"]`) : null;
          for (const el of list.querySelectorAll('.combobox-option--hl')) {
            if (el !== want) el.classList.remove('combobox-option--hl');
          }
          if (!want) return;
          want.classList.add('combobox-option--hl');
          if (scroll) this._scrollIntoList(list, want);
        });
      },
      // Nur die Liste scrollen, nicht `scrollIntoView`: das scrollt auch
      // aeussere Container mit, und deren Scroll-Ereignis schloesse das
      // Dropdown. Sticky-Gruppen-Header oben abziehen, sonst laege die
      // markierte Zeile darunter.
      _scrollIntoList(list, el) {
        const lr = list.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        let prev = el.previousElementSibling;
        while (prev && !prev.classList.contains('combobox-group')) prev = prev.previousElementSibling;
        const stickyH = prev ? prev.offsetHeight : 0;
        if (r.top < lr.top + stickyH) list.scrollTop -= (lr.top + stickyH) - r.top;
        else if (r.bottom > lr.bottom) list.scrollTop += r.bottom - lr.bottom;
      },
      // Globale Listener nur, solange die Liste offen ist — bei Dutzenden
      // Comboboxen auf einer Karte haetten sonst alle bei jedem Klick und
      // jedem Scroll-Frame mitgehoert.
      _listen(on) {
        if (on && !this._onOutside) {
          this._onOutside = (e) => { if (!this._rootEl.contains(e.target)) this.close(); };
          // Beim Scrollen des restlichen Screens das Dropdown schliessen (wie
          // ein natives <select>). Scrollen INNERHALB des Dropdowns (Options-
          // Liste) laesst es offen — Capture-Phase, um jeden Scroll zu sehen,
          // target-Check schliesst Eigen-Scroll aus.
          this._onScroll = (e) => {
            const dd = this._rootEl.querySelector('.combobox-dropdown');
            if (dd && (e.target === dd || dd.contains(e.target))) return;
            this.close();
          };
          document.addEventListener('mousedown', this._onOutside);
          window.addEventListener('scroll', this._onScroll, { capture: true, passive: true });
        } else if (!on && this._onOutside) {
          document.removeEventListener('mousedown', this._onOutside);
          window.removeEventListener('scroll', this._onScroll, { capture: true });
          this._onOutside = null;
          this._onScroll = null;
        }
      },
      init() {
        // Wrap-Element (x-data-Root) cachen. `this.$el` zeigt zur Laufzeit
        // (z. B. aus dem @click-Handler des Triggers) auf den Trigger-Button,
        // nicht auf den Wrap — Methoden brauchen aber zuverlaessig den Wrap.
        this._rootEl = this.$el;
        this._rootEl.classList.add('combobox-wrap');
        if (this._compact) this._rootEl.classList.add('combobox-wrap--compact');

        this._rootEl.addEventListener('keydown', (e) => this.onKeydown(e));
        // Tab aus der Combobox heraus schliesst die Liste. Nur Tastatur-Fokus-
        // wechsel zaehlen: ein Klick auf eine (nicht fokussierbare) Option nimmt
        // dem Suchfeld den Fokus — in einem <dialog> mit dem Dialog als
        // `relatedTarget` — und darf die Liste nicht vor dem `click` schliessen.
        // Darum Fokuswechsel waehrend eines Zeigerdrucks in der Combobox
        // ignorieren; Klicks ausserhalb deckt der Mousedown-Listener ab.
        this._pointerInside = false;
        this._rootEl.addEventListener('pointerdown', () => {
          this._pointerInside = true;
          window.addEventListener('pointerup', () => setTimeout(() => { this._pointerInside = false; }), { once: true, capture: true });
        });
        this._onFocusOut = (e) => {
          if (this._pointerInside || !this.open) return;
          if (e.relatedTarget && !this._rootEl.contains(e.relatedTarget)) this.close();
        };
        this._rootEl.addEventListener('focusout', this._onFocusOut);

        this._rootEl.setAttribute('role', 'combobox');
        this._rootEl.setAttribute('aria-haspopup', 'listbox');
        if (this._multiple) {
          this._rootEl.classList.add('combobox-wrap--multi');
          this._rootEl.setAttribute('aria-multiselectable', 'true');
        }
        this.$watch('query', () => {
          this.highlighted = this.filtered.length > 0 ? 0 : -1;
          this._syncHl(true);
        });
        const template = [
          '<button type="button" class="combobox-trigger" @click="toggle()" x-ref="cbTrigger"',
          '        :aria-expanded="open ? \'true\' : \'false\'"',
          '        :aria-label="selectedLabel || placeholder">',
          '  <span class="combobox-value" x-text="selectedLabel || placeholder"></span>',
          '  <svg class="combobox-chevron" :class="{\'combobox-chevron--open\': open}" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1.5 3.5L5 7L8.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          '</button>',
          // Das Dropdown existiert nur, solange es offen ist (`x-if`, nicht
          // `x-show`). x-anchor startet beim Einfuegen die Positions-
          // Nachfuehrung von Floating UI — Scroll-Listener auf jedem scroll-
          // baren Vorfahren plus Resize-/Intersection-Observer — und baut sie
          // erst beim Entfernen ab. Mit `x-show` liefe sie fuer jede Combobox
          // ab Mount dauernd mit, auch geschlossen: jeder Scroll-Frame
          // rechnete die Position ALLER Comboboxen der Karte nach (Ruckeln
          // beim Scrollen). Dazu rendert eine geschlossene Combobox so auch
          // ihre Optionen nicht, und `options`-Updates kosten nichts.
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
          '<template x-if="open">',
          '<div class="combobox-dropdown" x-id="[\'cb-opt\']" :style="ddWidth ? { width: ddWidth } : {}" x-anchor:bottom-start.fixed="$refs.cbTrigger">',
          '  <input type="text" class="combobox-search" x-model="query" x-ref="cbInput"',
          '         :placeholder="$app.t(\'common.searchShort\')" role="searchbox" :aria-label="$app.t(\'common.searchShort\')">',
          '  <ul class="combobox-list" role="listbox"',
          '      :aria-activedescendant="highlighted >= 0 ? ($id(\'cb-opt\') + \'-\' + highlighted) : null">',
          '    <template x-for="row in groupedRows" :key="row.key">',
          // Die Markierung (`combobox-option--hl`) setzt `_syncHl` imperativ —
          // NICHT hier ins `:class` aufnehmen (siehe dort).
          '      <li :class="row.kind === \'header\' ? \'combobox-group\' : {\'combobox-option\': true, \'combobox-option--selected\': _isSelected(row.opt.value)}"',
          '          :role="row.kind === \'header\' ? \'presentation\' : \'option\'"',
          '          :data-opt-index="row.kind === \'option\' ? row.optIndex : null"',
          '          :id="row.kind === \'option\' ? ($id(\'cb-opt\') + \'-\' + row.optIndex) : null"',
          '          :aria-selected="row.kind === \'option\' ? (_isSelected(row.opt.value) ? \'true\' : \'false\') : null"',
          '          @click="row.kind === \'option\' && select(row.opt.value)" @mousemove="row.kind === \'option\' && hoverHl(row.optIndex)">',
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
          '</template>',
        ].join('\n');
        this._rootEl.innerHTML = template;
        // Alpine processed das frisch gesetzte Markup nicht zuverlaessig, wenn
        // die Combobox innerhalb eines spaet hydratisierten Subtrees liegt
        // (template x-if mit nested x-data-Wrappern, Beispiel pdfExportCard).
        window.Alpine.initTree(this._rootEl);
        if (this._autoOpen) this.$nextTick(() => this.toggle());
      },
      destroy() {
        this._listen(false);
        if (this._onFocusOut) {
          this._rootEl?.removeEventListener('focusout', this._onFocusOut);
          this._onFocusOut = null;
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
