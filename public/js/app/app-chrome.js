// App-Chrome: Theme-Umschaltung, Logout, Sidebar-Resize und Confirm-Dialog.
// UI-Bereiche, die ausserhalb der normalen Buch-/Seiten-Flows leben und keine
// Querabhängigkeiten zu Job-Queue oder Hash-Router haben.
import { bindScrollFade } from '../scroll-fade.js';
import { lsGet, lsSet, lsRemove } from '../safe-storage.js';

export const appChromeMethods = {
  // ── Theme (Hell/Dunkel/Auto) ─────────────────────────────────────────────
  // Anwenden (data-theme + <meta name="theme-color">) liegt in theme-init.js
  // (`window.__applyTheme`), damit Boot und Umschaltung dieselbe Stelle nutzen.
  _applyTheme() {
    window.__applyTheme(this.$store.shell.themePref);
  },
  setTheme(pref) {
    if (pref !== 'auto' && pref !== 'light' && pref !== 'dark') return;
    if (this.$store.shell.themePref === pref) return;
    this.$store.shell.themePref = pref;
    try { lsSet('theme', this.$store.shell.themePref); } catch (e) {}
    this._applyTheme();
    fetch('/me/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: this.$store.shell.themePref }),
    }).catch(e => console.error('[theme] Persist fehlgeschlagen:', e));
  },
  // Logout: SW-Caches dropen, bevor der Browser zum Login redirected. Sonst
  // liefert die SWR-Strategie nach Re-Login kurz noch /api/* + /config des
  // alten Users, bis Eviction greift.
  async logout(ev) {
    const sw = navigator.serviceWorker;
    if (!sw?.controller) return; // kein SW aktiv → normales Anker-Verhalten
    ev.preventDefault();
    const ctrl = sw.controller;
    const done = new Promise(resolve => {
      const onMsg = (e) => {
        if (e.data?.type === 'auth-logout-done') {
          sw.removeEventListener('message', onMsg);
          resolve();
        }
      };
      sw.addEventListener('message', onMsg);
      setTimeout(() => { sw.removeEventListener('message', onMsg); resolve(); }, 1500);
    });
    ctrl.postMessage({ type: 'auth-logout' });
    await done;
    location.href = '/auth/logout';
  },
  // Update-Banner ("Neu laden"). Delegiert an den selbstheilenden Handler aus
  // der SW-Registrierung (app.js#registerServiceWorker), der den wartenden SW
  // via 'skip-waiting' aktiviert bzw. — wenn keiner existiert und der Build-
  // Mismatch bestehen bleibt — hart heilt (Shell-Caches + SW-Registrierung
  // wegwerfen, neu laden), damit der User nicht im Banner-Loop hängenbleibt.
  // Fallback (SW nicht unterstützt / nicht registriert): harter Reload.
  applyUpdate() {
    if (window.__applyUpdate) { window.__applyUpdate(); return; }
    setTimeout(() => location.reload(), 2000);
  },
  // ── Sidebar-Resize ──────────────────────────────────────────────────────
  // Handle am rechten Rand der `.layout-sidebar`; verändert `--sidebar-w`
  // auf `.layout`. Die Hauptspalte (1fr) gibt Platz, eine Leiste darin behält
  // ihre `--aside-w`. Grenzen und Default stehen nur in tokens/spacing.css
  // (`--sidebar-w-min/-max/-default`); die CSS deckelt zusätzlich auf 40vw.
  // Nach jedem Setzen wird die tatsächlich gerenderte Breite zurückgeschrieben —
  // sonst liefe der Wert beim Ziehen über den 40vw-Deckel hinaus, und der Rückweg
  // hätte eine tote Zone.
  _initSidebarResize() {
    const layout  = document.querySelector('.layout');
    const sidebar = document.querySelector('.layout-sidebar');
    if (!layout || !sidebar) return;
    if (sidebar.querySelector('.sidebar-resize-handle')) return;

    const token = (name) => parseFloat(getComputedStyle(layout).getPropertyValue(name));
    const MIN = token('--sidebar-w-min');
    const MAX = token('--sidebar-w-max');

    const handle = document.createElement('div');
    handle.className = 'sidebar-resize-handle';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', this.t('sidebar.resizeHandle'));
    handle.setAttribute('aria-valuemin', String(MIN));
    handle.setAttribute('aria-valuemax', String(MAX));
    handle.tabIndex = 0;

    const rendered = () => Math.round(sidebar.getBoundingClientRect().width);
    const syncAria = () => handle.setAttribute('aria-valuenow', String(rendered()));
    const set = (w) => layout.style.setProperty('--sidebar-w', Math.max(MIN, Math.min(MAX, Math.round(w))) + 'px');
    // Nur bei einer Bewegung des Users: der gespeicherte Wert beim Boot bleibt
    // stehen, auch wenn das Fenster gerade schmaler ist — beim Verbreitern
    // kehrt die gewählte Breite zurück.
    const apply = (w) => {
      set(w);
      const actual = rendered();
      // Unsichtbare Sidebar (Mobile, x-show) misst 0 — dann nichts zurückschreiben.
      if (actual > 0) layout.style.setProperty('--sidebar-w', actual + 'px');
      syncAria();
    };
    const persist = () => {
      const cur = parseInt(layout.style.getPropertyValue('--sidebar-w'), 10);
      if (Number.isFinite(cur)) lsSet('sidebar-width', String(cur));
    };
    const reset = () => {
      layout.style.removeProperty('--sidebar-w');
      lsRemove('sidebar-width');
      syncAria();
    };

    sidebar.appendChild(handle);
    const saved = parseInt(lsGet('sidebar-width'), 10);
    if (Number.isFinite(saved)) set(saved);
    syncAria();

    let dragging = false;
    let startX = 0;
    let startW = 0;

    const onMove = (e) => {
      if (!dragging) return;
      apply(startW + (e.clientX - startX));
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.classList.remove('sidebar-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      persist();
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = rendered();
      handle.classList.add('dragging');
      document.body.classList.add('sidebar-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    // Tastatur nach dem ARIA-Muster «Window Splitter»: Pfeile in Schritten
    // (Umschalt = grob), Home/End an die Grenzen.
    handle.addEventListener('keydown', (e) => {
      let target;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const step = e.shiftKey ? 32 : 8;
        target = rendered() + (e.key === 'ArrowRight' ? step : -step);
      } else if (e.key === 'Home') target = MIN;
      else if (e.key === 'End') target = MAX;
      else return;
      e.preventDefault();
      apply(target);
      persist();
    });

    handle.addEventListener('dblclick', reset);
    // Fensterbreite ändert den 40vw-Deckel und damit die gerenderte Breite.
    window.addEventListener('resize', syncAria);
  },

  // Scrollbar im Sidebar-Tree initial unsichtbar, erscheint nur während des
  // Scrollens und fadet nach kurzer Idle-Zeit wieder aus. CSS reserviert den
  // Gutter dauerhaft (kein Layout-Shift), JS toggelt nur `.is-scrolling`.
  _initSidebarScrollFade() {
    this._bindScrollFade(document.querySelector('.layout-sidebar > #partial-sidebar > .card'));
  },

  // Dünner Wrapper um die geteilte scroll-fade.js#bindScrollFade — als Methode am
  // Root verfügbar für Sub-Komponenten (z.B. Bucheditor-Inhaltsverzeichnis).
  _bindScrollFade(el) {
    bindScrollFade(el);
  },

  _avatarInitials() {
    const src = (this.$store.session.currentUser && (this.$store.session.currentUser.name || this.$store.session.currentUser.email)) || '';
    if (!src) return '·';
    const local = src.split('@')[0];
    // Erstes alphanumerisches Zeichen pro Wort — ignoriert Klammern/Satzzeichen
    // (sonst ergab z.B. „Dev (lokal)" das Initial „D(" statt „DL").
    const inits = local.split(/[\s._-]+/)
      .map(w => (w.match(/[\p{L}\p{N}]/u) || [''])[0])
      .filter(Boolean);
    if (inits.length >= 2) return (inits[0] + inits[1]).toUpperCase();
    const alnum = local.match(/[\p{L}\p{N}]/gu) || [];
    return (alnum.slice(0, 2).join('') || inits[0] || '·').toUpperCase();
  },

  // Confirm-Dialog via natives HTMLDialogElement.
  // Native showModal() gibt Focus-Trap, Inert-Hintergrund und ESC-Routing
  // (cancel-Event) gratis. Wichtig: window.confirm() reisst Chrome auf macOS
  // aus dem nativen Vollbild-Space; <dialog> ist DOM (kein OS-Modal) und
  // verursacht den Bug nicht.
  // Verwendung:
  //   if (!await this.appConfirm({ message, confirmLabel?, cancelLabel?, danger? })) return;
  appConfirm({ message, confirmLabel, cancelLabel, danger = false } = {}) {
    if (this._confirmDialogResolve) {
      try { this._confirmDialogResolve(false); } catch {}
    }
    this.confirmDialogInput = false;
    this.confirmDialogInputValue = '';
    this.confirmDialogInputPlaceholder = '';
    this.confirmDialogMessage = message || '';
    this.confirmDialogConfirmLabel = confirmLabel || this.t('common.confirm');
    this.confirmDialogCancelLabel = cancelLabel || this.t('common.cancel');
    this.confirmDialogDanger = !!danger;
    return this._openConfirmDialog(false);
  },

  // Prompt-Variante: zeigt Textfeld im Modal, liefert getrimmten String oder
  // null (Cancel/leer). Mit `allowEmpty: true` liefert leer bestätigt '' —
  // für optionale Eingaben, bei denen Abbrechen etwas anderes heisst. Nutzung:
  //   const name = await this.appPrompt({ message, placeholder?, defaultValue? });
  //   if (!name) return;
  appPrompt({ message, placeholder, defaultValue, confirmLabel, cancelLabel, allowEmpty = false } = {}) {
    if (this._confirmDialogResolve) {
      try { this._confirmDialogResolve(null); } catch {}
    }
    this.confirmDialogInput = true;
    this.confirmDialogInputValue = defaultValue || '';
    this.confirmDialogInputPlaceholder = placeholder || '';
    this.confirmDialogMessage = message || '';
    this.confirmDialogConfirmLabel = confirmLabel || this.t('common.confirm');
    this.confirmDialogCancelLabel = cancelLabel || this.t('common.cancel');
    this.confirmDialogDanger = false;
    this.confirmDialogAllowEmpty = !!allowEmpty;
    return this._openConfirmDialog(true);
  },

  _openConfirmDialog(isInput) {
    const dlg = this.$refs.confirmDialog;
    if (!dlg) return Promise.resolve(isInput ? null : false);
    if (!dlg.open) dlg.showModal();
    this.$nextTick(() => {
      if (isInput) {
        const inp = this.$refs.confirmDialogInput;
        if (inp) { inp.focus(); inp.select(); }
      } else {
        const btn = this.$refs.confirmDialogConfirmBtn;
        if (btn) btn.focus();
      }
    });
    return new Promise(resolve => { this._confirmDialogResolve = resolve; });
  },

  _resolveConfirmDialog(value) {
    const r = this._confirmDialogResolve;
    const wasInput = this.confirmDialogInput;
    const inputVal = (this.confirmDialogInputValue || '').trim();
    const allowEmpty = this.confirmDialogAllowEmpty;
    this._confirmDialogResolve = null;
    this.confirmDialogAllowEmpty = false;
    const dlg = this.$refs?.confirmDialog;
    if (dlg && dlg.open) dlg.close();
    this.confirmDialogInput = false;
    this.confirmDialogInputValue = '';
    this.confirmDialogInputPlaceholder = '';
    if (!r) return;
    if (wasInput) r(value ? (inputVal || (allowEmpty ? '' : null)) : null);
    else r(value);
  },

  // Alert-Variante: nur OK-Button, immer truthy. Nutzt dieselbe Modal-DOM,
  // setzt Cancel-Label leer → Cancel-Button wird via x-show ausgeblendet.
  appAlert({ message, confirmLabel } = {}) {
    return this.appConfirm({
      message,
      confirmLabel: confirmLabel || this.t('common.confirm'),
      cancelLabel: '',
    });
  },
};
