// Alpine.data('tabs') — wiederverwendbare Tab-/Modus-Reihe.
//
// SSoT für das DESIGN.md-Pattern `.tabs` / `.tabs-btn` / `.tabs-btn--active`.
// Besitzt den aktiven Tab, die Umschalt-Logik, die WAI-ARIA-Tablist-Semantik
// (role=tablist/tab/tabpanel, aria-selected, Roving-Tabindex, Pfeil-Tastatur-
// Navigation) — Konsumenten verdrahten `:class`/`@click`/ARIA nicht mehr von Hand.
//
// Die Komponente rendert die Buttons NICHT selbst (anders als combobox/
// radioGroup): Tab-Labels sind pro Karte unterschiedlich i18n-präfixiert und
// einzelne Tabs können bedingt sichtbar sein. Das Markup bleibt im Template,
// die Komponente liefert nur State + x-bind-Spreads.
//
// Pflicht-Markup (Wrapper umschliesst Button-Reihe UND Panels):
//
//   <div x-data="tabs(['layout','font','cover'])"
//        x-modelable="value" x-model="activeTab">
//     <div class="tabs tabs--scrollable" x-bind="tablist">
//       <template x-for="tab in tabs" :key="tab">
//         <button class="tabs-btn" x-bind="tabBtn(tab)"
//                 x-text="$app.t('xxx.tab.' + tab)"></button>
//       </template>
//     </div>
//     <div class="xxx-tab-panel" x-bind="panel('layout')"> … </div>
//     <div class="xxx-tab-panel" x-bind="panel('font')"> … </div>
//   </div>
//
// - `x-modelable="value" x-model="ref"` koppelt den aktiven Tab ans äussere
//   Feld. Die Karte behält damit das Feld (z. B. für programmatisches Reset
//   `this.activeTab = 'layout'` auf `view:reset`); Default = der Initialwert
//   dieses Feldes.
// - Config: positionales Array `tabs(['a','b'])` ODER Object-Form
//   `tabs({ tabs: ['a','b'], persistKey: 'pdfExport' })`.
//   - `tabs`  Whitelist gültiger Keys (auch Quelle für `x-for="tab in tabs"`).
//   - `persistKey`  optional → aktiver Tab überlebt Reload via localStorage.
// - Einzelne bedingte Tabs (z. B. nur für Buchtyp `blog`): Button behält sein
//   eigenes `x-show`; `tabBtn(key)` daneben spreaden.
// - Bei Umschaltung wird `tab-change` dispatcht (Detail = neuer Key) für
//   optionale Side-Effects.
// - Tab und Panel verweisen per ID aufeinander (`aria-controls` am Tab,
//   `aria-labelledby` am Panel). Die IDs bildet die Komponente selbst aus einem
//   Instanz-Präfix — Panels müssen darum über `panel(key)` derselben Instanz laufen.

let _tabsInstance = 0;
const _idPart = (tab) => String(tab).replace(/[^a-zA-Z0-9_-]/g, '_');

export function registerTabs() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('tabs', (cfg = {}) => {
    const opts = Array.isArray(cfg) ? { tabs: cfg } : (cfg || {});
    const list = Array.isArray(opts.tabs) ? opts.tabs : [];
    return {
      // Öffentlich, damit das Template `x-for="tab in tabs"` darauf iteriert.
      tabs: list,
      // Aktiver Tab. Wird via x-modelable vom äusseren Feld überschrieben;
      // tabs[0] dient nur als Fallback ohne x-model.
      value: list[0] ?? '',
      _persistKey: opts.persistKey || null,
      _idPrefix: `tabs${++_tabsInstance}`,

      init() {
        if (this._persistKey) {
          let saved = null;
          try { saved = localStorage.getItem('tabs:' + this._persistKey); } catch (_) {}
          if (saved && (!this.tabs.length || this.tabs.includes(saved))) this.value = saved;
        }
      },

      isTab(tab) { return this.value === tab; },

      setTab(tab) {
        if (this.tabs.length && !this.tabs.includes(tab)) return;
        if (this.value === tab) return;
        this.value = tab;
        if (this._persistKey) {
          try { localStorage.setItem('tabs:' + this._persistKey, tab); } catch (_) {}
        }
        this.$dispatch('tab-change', tab);
      },

      // Spread auf den `.tabs`-Button-Container (role=tablist + Pfeil-Nav).
      get tablist() {
        return {
          role: 'tablist',
          ['@keydown']: (e) => this._onKeydown(e),
          ['@wheel']: (e) => this._onWheel(e),
        };
      },

      // Mausrad → horizontal scrollen. Die Reihe scrollt horizontal ohne
      // sichtbare Scrollbar (tabs.css); ein Rad ohne Shift liefert nur deltaY
      // und käme sonst nie an die hinteren Tabs. Nur abfangen, solange die
      // Reihe in diese Richtung noch scrollen kann — am Anschlag scrollt die
      // Seite wie gewohnt weiter.
      _onWheel(e) {
        const el = e.currentTarget;
        if (!el || el.scrollWidth <= el.clientWidth) return;
        if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
        const max = el.scrollWidth - el.clientWidth;
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        if ((dy < 0 && el.scrollLeft <= 0) || (dy > 0 && el.scrollLeft >= max - 1)) return;
        e.preventDefault();
        el.scrollLeft += dy;
      },

      // Spread pro Tab-<button>. Roving-Tabindex: aktiver Tab tabbar (0),
      // restliche nur per Pfeiltaste erreichbar (-1).
      tabBtn(tab) {
        return {
          type: 'button',
          role: 'tab',
          id: `${this._idPrefix}-tab-${_idPart(tab)}`,
          'aria-controls': `${this._idPrefix}-panel-${_idPart(tab)}`,
          [':aria-selected']: () => this.value === tab,
          [':tabindex']: () => (this.value === tab ? 0 : -1),
          [':class']: () => ({ 'tabs-btn--active': this.value === tab }),
          ['@click']: () => this.setTab(tab),
        };
      },

      // Spread pro Tab-Panel.
      panel(tab) {
        return {
          role: 'tabpanel',
          id: `${this._idPrefix}-panel-${_idPart(tab)}`,
          'aria-labelledby': `${this._idPrefix}-tab-${_idPart(tab)}`,
          ['x-show']: () => this.value === tab,
        };
      },

      _onKeydown(e) {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
        // Aus dem DOM lesen, damit bedingt versteckte Tabs (display:none →
        // offsetParent null) natürlich übersprungen werden.
        const btns = Array.from(this.$el.querySelectorAll('[role=tab]'))
          .filter((b) => b.offsetParent !== null && !b.disabled);
        if (!btns.length) return;
        const cur = btns.findIndex((b) => b.getAttribute('aria-selected') === 'true');
        let next = cur < 0 ? 0 : cur;
        if (e.key === 'ArrowRight') next = (cur + 1) % btns.length;
        else if (e.key === 'ArrowLeft') next = (cur - 1 + btns.length) % btns.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = btns.length - 1;
        e.preventDefault();
        btns[next].focus();
        btns[next].click();
      },
    };
  });
}
