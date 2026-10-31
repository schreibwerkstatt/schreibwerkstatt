import { EVT } from './events.js';
// Alpine.data('fileDrop') — Datei-Auswahl per Klick + Drag&Drop.
//
// Behaviorales Primitive (wie combobox/numInput): kapselt das versteckte
// <input type="file">, Klick-zum-Öffnen, den Drag-Over-State und (optional)
// den Drop. Lädt NICHTS hoch — emittet die gewählte Datei als `@file-drop`-
// CustomEvent; der Konsument entscheidet, was passiert (lokal in State
// ablegen oder direkt an einen Endpoint POSTen).
//
// Verwendung (init() verdrahtet alles — kein @change/@dragover/@drop nötig):
//
//   <div class="folder-import-drop"
//        x-data="fileDrop({ accept: '.zip', drag: true })"
//        @file-drop="setFile($event.detail.file)">
//     <!-- Slot-Inhalt: Drop-Text, Dateiname, Vorschau … -->
//   </div>
//
// Config:
//   accept     String ODER Funktion (für reaktiven Filter). Wird als
//                `accept`-Attribut am Input gesetzt (filtert nur den nativen
//                Picker). Drag&Drop filtert der Browser NICHT — die Validierung
//                der gedroppten Datei macht der Konsument im @file-drop-Handler.
//   drag       Default true. false = nur Klick (kein Drop, keine Drag-Klasse).
//   multiple   Default false. true = Mehrfachauswahl; detail.files hält alle.
//   disabled   Boolean ODER Funktion. true ⇒ Klick + Drop werden ignoriert.
//
// Event:
//   @file-drop   detail = { file, files }. Feuert nur, wenn mind. eine Datei kam.
//
// CSS-Hook: während Drag setzt die Komponente die Klasse `is-drag` auf $el.

export function registerFileDrop() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('fileDrop', (cfg = {}) => ({
    _cfg: {
      accept: cfg.accept || '',
      drag: cfg.drag !== false,
      multiple: cfg.multiple === true,
      disabled: cfg.disabled,
    },
    _input: null,

    _isDisabled() {
      const d = this._cfg.disabled;
      return typeof d === 'function' ? !!d() : !!d;
    },
    _resolveAccept() {
      const a = this._cfg.accept;
      return typeof a === 'function' ? (a() || '') : a;
    },
    _emit(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      this.$el.dispatchEvent(new CustomEvent(EVT.FILE_DROP, {
        detail: { file: files[0], files },
      }));
    },

    init() {
      const el = this.$el;
      if (!el.classList.contains('file-drop')) el.classList.add('file-drop');

      // Verstecktes Input einmalig anlegen — kein Markup im Konsumenten nötig.
      const input = document.createElement('input');
      input.type = 'file';
      input.hidden = true;
      input.accept = this._resolveAccept();
      if (this._cfg.multiple) input.multiple = true;
      input.addEventListener('change', () => {
        this._emit(input.files);
        input.value = ''; // erneute Auswahl derselben Datei zulassen
      });
      el.appendChild(input);
      this._input = input;

      // Klick öffnet den Picker — ausser auf interaktiven Kindern (z.B. ein
      // "Entfernen"-Button im Slot), die ihre eigene Aktion haben.
      const open = () => {
        input.accept = this._resolveAccept(); // reaktiven Filter frisch lesen
        input.click();
      };
      el.addEventListener('click', (e) => {
        if (this._isDisabled()) return;
        if (e.target.closest('button, a, input, label')) return;
        open();
      });

      // Tastatur: die Fläche ist meist ein <div> — ohne role/tabindex wäre der
      // Picker nur mit der Maus erreichbar. Enter/Leertaste öffnen ihn, solange
      // der Fokus auf der Fläche selbst liegt (nicht auf einem Kind-Button).
      if (el.tagName !== 'BUTTON') {
        if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
        if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
        el.addEventListener('keydown', (e) => {
          if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          if (!this._isDisabled()) open();
        });
      }
      this.$watch(() => this._isDisabled(), (d) => el.setAttribute('aria-disabled', d ? 'true' : 'false'));

      if (!this._cfg.drag) return;

      el.addEventListener('dragover', (e) => {
        if (this._isDisabled()) return;
        e.preventDefault();
        el.classList.add('is-drag');
      });
      el.addEventListener('dragleave', (e) => {
        e.preventDefault();
        el.classList.remove('is-drag');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('is-drag');
        if (this._isDisabled()) return;
        this._emit(e.dataTransfer?.files);
      });
    },
  }));
}
