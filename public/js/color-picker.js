// Alpine.data('colorPicker') — Farbwähler einer Entität (Swatch + Palette-Popover).
// EIN Markup ([partials/color-picker.html], Fragment-Include) + EINE Optik
// ([components/color-picker.css]); die Karte liefert nur Daten und Aktion.
// Konsumenten: Plot-Werkstatt (Akt-Kopf flach + Grid, Strang-Lane) und
// Motiv-Werkstatt (Themen-Baum, Themen-Editor).
//
//   <div class="color-picker" x-data="colorPicker({
//          value: () => act.farbe,               // aktuelle Farbe (Palette-Key | null)
//          keys: () => actPalette(),             // Palette-Keys
//          pick: (key) => setActColor(act, key), // null = keine/automatische Farbe
//          tipKey: 'plot.act.color',             // Tooltip/Label des Swatches
//          noneKey: 'plot.act.colorNone',        // Tooltip/Label der „keine Farbe"-Option
//          swatch: () => themeSwatchKey(g.theme) // optional: Key für die Swatch-Farbe;
//        })">                                     // ohne erbt der Swatch --col-accent
//     <!-- Fragment-Include color-picker -->
//   </div>
//
// Die Funktionen werden im Scope der Einbettungsstelle ausgewertet (Loop-Variable,
// Karten-Methoden) — der Open-Zustand lebt in der Instanz, keine `…ColorPickerId`
// je Karte. Klick daneben und Esc schliessen; Esc bei offenem Popover hält die
// Taste an (ein umgebendes `$editKeys` verwürfe sonst den Entwurf).

export function colorPickerData(cfg = {}) {
  return {
    open: false,
    value() { return typeof cfg.value === 'function' ? (cfg.value() || null) : null; },
    keys() { return typeof cfg.keys === 'function' ? (cfg.keys() || []) : []; },
    tip() { return window.__app.t(cfg.tipKey || 'plot.act.color'); },
    noneLabel() { return window.__app.t(cfg.noneKey || 'plot.act.colorNone'); },
    optLabel(key) { return window.__app.t('plot.palette.' + key); },
    swatchStyle() {
      const k = typeof cfg.swatch === 'function' ? cfg.swatch() : null;
      return k ? { '--col-accent': 'var(--palette-' + k + ')' } : {};
    },
    optStyle(key) { return { '--col-accent': 'var(--palette-' + key + ')' }; },
    toggle() { this.open = !this.open; },
    close() { this.open = false; },
    onEsc(ev) {
      if (!this.open) return;
      ev.stopPropagation();
      ev.preventDefault();
      this.open = false;
    },
    choose(key) {
      this.open = false;
      if (typeof cfg.pick === 'function') cfg.pick(key);
    },
  };
}

export function registerColorPicker() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('colorPicker', colorPickerData);
}
