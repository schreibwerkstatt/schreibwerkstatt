// Aktionsmenue (teleportiert): EIN `.context-menu` je Karte ausserhalb ihrer
// Liste, das sich an einem Element oeffnet — per ⋯-Knopf (am Knopf verankert,
// klappt nach oben, wenn unten kein Platz ist), per Rechtsklick (an der Maus)
// und per Long-Press auf Touch (`x-long-press` loest dort `contextmenu` aus,
// am Finger). Alle drei Wege
// zeigen DASSELBE Menue mit denselben Eintraegen. Regeln und Markup-Rahmen:
// DESIGN.md „Aktionsmenü (teleportiert)"; Optik components/context-menu.css.
//
// Warum eine Instanz statt eines Popovers je Zeile: die Liste scrollt bzw.
// klippt (`overflow`, `will-change`, Detail-Dialog) — ein darin verankertes
// Menue waere abgeschnitten oder eingesperrt. Ein `x-ref` im `x-for` taugt
// ausserdem nicht (die letzte Instanz gewinnt).
//
// Das am Knopf verankerte Menue in einem NICHT klippenden Kopfbereich bleibt
// `Alpine.data('menu')` (menu.js) — dort gibt es kein Element mit Rechtsklick.
//
//   ...actionMenuState(),               // in den Karten-State
//   ...actionMenuMethods,               // in die Karten-Methoden
//
//   <div class="idee-item" @contextmenu="openActionMenu($event, 'idee:' + idee.id, idee)" x-long-press>
//     <button class="icon-btn icon-btn--ghost" aria-haspopup="menu"
//             :aria-expanded="isActionMenuOpen('idee:' + idee.id)"
//             @click="openActionMenu($event, 'idee:' + idee.id, idee)">…more-horizontal…</button>
//   </div>
//   <template x-teleport="body">
//     <div class="context-menu" x-ref="actionMenu" x-bind="actionMenuPanel()" x-cloak>
//       <template x-if="actionMenuTarget"><div>… Eintraege, lesen actionMenuTarget …</div></template>
//     </div>
//   </template>
//
// Verhalten, das jedes Menue gleich bekommt:
//   - Knopf toggelt (mit Doppelklick-Frist), Rechtsklick/Long-Press oeffnen
//     immer neu an der neuen Stelle.
//   - Per Tastatur (Kontextmenue-Taste, Shift+F10) liegt die gemeldete Position
//     nicht im Element — dann am Element selbst verankert.
//   - Schaetzung im ersten Frame, danach die echte Groesse messen (Flip-Regel,
//     popover-anchor.js). rAF nach $nextTick: x-if-Bloecke im Menue haben eigene
//     Effects, die in einem einzelnen Tick noch nicht gerendert sind.
//   - Schliesst bei Klick daneben, Esc (Fokus zurueck), Tab, Resize, einem
//     Scroll, der den Anker bewegt (ein Scroll im Menue selbst oder daneben
//     laesst es stehen), nach einem Eintrag (Klick-Delegation am Menue, der
//     Klick endet dort — Eintraege brauchen weder `.stop` noch ein eigenes
//     Schliessen) und bei `closeOn`-Events.
//   - Fokus auf den ersten Eintrag, Pfeile/Home/End wandern.
//   - Im Native-Vollbild bzw. offenen <dialog> wird das Menue zur Anzeigezeit
//     unter den sichtbaren Host gehaengt (topLayerHost), sofern es nicht schon
//     darin liegt.

import { EVT } from './events.js';
import { computePopoverPos } from './popover-anchor.js';
import { topLayerHost } from './fullscreen.js';

// Erst-Schaetzung, bevor das Menue gerendert ist; danach wird gemessen.
const MENU_W_EST = 220;
const MENU_H_EST = 240;
const EDGE = 8;
// Derselbe Knopf binnen dieser Frist ist ein durchgerutschter Doppelklick
// (schnelle Maus, unempfindliches Touch, ein Test-Runner, der eine Aktion
// wiederholt) und schliesst NICHT — sonst waere das Menue im selben Frame zu.
const TOGGLE_GRACE_MS = 300;
const ITEM_SEL = '.context-menu-item, [role=menuitem]';

export function actionMenuState() {
  return {
    actionMenuKey: null,        // offene Instanz (z. B. 'idee:12'), null = zu
    actionMenuTarget: null,     // woran das Menue haengt (frei, vom Konsumenten)
    actionMenuPos: { top: 0, left: 0 },
    _actionMenu: null,          // Laufzeit des offenen Menues (Anker, Listener)
  };
}

function clampToViewport(x, y, w, h) {
  return {
    left: Math.max(EDGE, Math.min(window.innerWidth - w - EDGE, x)),
    top: Math.max(EDGE, Math.min(window.innerHeight - h - EDGE, y)),
  };
}

export const actionMenuMethods = {
  // `ev` = Klick auf den ⋯-Knopf oder `contextmenu`-Event (Rechtsklick,
  // Kontextmenue-Taste, Long-Press via `x-long-press`). `key` identifiziert die Instanz (Typ + ID),
  // `target` steht danach als `actionMenuTarget` im Menue.
  // `opts.closeOn` = weitere Window-Events, die schliessen (z. B. Buchwechsel).
  openActionMenu(ev, key, target = null, opts = {}) {
    if (key == null) return;
    const isButton = ev?.type === 'click';
    const anchorEl = ev?.currentTarget instanceof Element ? ev.currentTarget : null;
    if (!isButton) ev?.preventDefault?.();
    ev?.stopPropagation?.();
    const run = this._actionMenu;
    if (isButton && run && this.actionMenuKey === key) {
      if (Date.now() - run.openedAt < TOGGLE_GRACE_MS) return;
      this.closeActionMenu();
      return;
    }
    // Hover-Tooltip des Triggers wegblenden — er hinge sonst ueber dem Menue.
    window.dispatchEvent(new CustomEvent(EVT.TOOLTIP_HIDE));

    let point = null;
    const rect = anchorEl?.getBoundingClientRect?.() || null;
    if (!isButton) {
      let x = ev?.clientX ?? 0, y = ev?.clientY ?? 0;
      if (rect && (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom)) {
        x = rect.left + EDGE * 2;
        y = rect.bottom;
      }
      point = { x, y };
    }

    const prevFocus = run ? run.returnFocus : document.activeElement;
    this._teardownActionMenu();
    this.actionMenuKey = key;
    this.actionMenuTarget = target;
    this.actionMenuPos = point
      ? clampToViewport(point.x, point.y, MENU_W_EST, MENU_H_EST)
      : computePopoverPos(rect || { top: 0, bottom: 0, left: 0, right: 0 }, MENU_W_EST, MENU_H_EST);

    const ctrl = new AbortController();
    const { signal } = ctrl;
    this._actionMenu = {
      trigger: anchorEl,
      rect: rect && { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      point,
      openedAt: Date.now(),
      returnFocus: prevFocus,
      ctrl,
    };
    const panel = () => this.$refs.actionMenu;
    // Im Native-Vollbild bzw. offenen <dialog> laege ein Menue ausserhalb des
    // sichtbaren Hosts hinter dem ::backdrop: dann zur Anzeigezeit umhaengen.
    // Liegt es schon im richtigen Host (Teleport in die Karten-Wurzel, Menue in
    // der Karte), bleibt es, wo es ist. Zurueck geht es ebenso: ein Menue, das
    // zuletzt in einem inzwischen geschlossenen Dialog aufging, kommt wieder
    // unter den Host des neuen Ankers.
    const host = topLayerHost(anchorEl);
    const el = panel();
    if (el && (topLayerHost(el) !== host || el.closest('dialog:not([open])'))) host.appendChild(el);

    // Klick daneben (Capture-mousedown, vor dem Klick): Menue und eigener
    // Knopf ausgenommen — der Knopf toggelt selbst.
    document.addEventListener('mousedown', (e) => {
      const el = panel();
      if (el?.contains(e.target)) return;
      if (isButton && anchorEl?.contains(e.target)) return;
      this.closeActionMenu();
    }, { capture: true, signal });
    document.addEventListener('keydown', (e) => this._onActionMenuKeydown(e), { signal });
    window.addEventListener('resize', () => this.closeActionMenu(), { signal });
    window.addEventListener('scroll', (e) => {
      // Ziel ist bei einem Seiten-Scroll das document/window, kein Element.
      if (e.target instanceof Node && panel()?.contains(e.target)) return;
      if (this._actionMenuAnchorMoved()) this.closeActionMenu();
    }, { capture: true, passive: true, signal });
    for (const type of opts.closeOn || []) {
      window.addEventListener(type, () => this.closeActionMenu(), { signal });
    }

    this.$nextTick(() => requestAnimationFrame(() => {
      if (this.actionMenuKey !== key) return;
      this._remeasureActionMenu();
      const items = this._actionMenuItems();
      items[0]?.focus({ preventScroll: true });
    }));
  },

  closeActionMenu({ restoreFocus = false } = {}) {
    const run = this._actionMenu;
    if (!run && this.actionMenuKey == null) return;
    this._teardownActionMenu();
    this.actionMenuKey = null;
    this.actionMenuTarget = null;
    // Fokus zurueck, wenn er noch im Menue steht (eine Folgeaktion darf ihn
    // behalten) und das Ausgangselement noch im Dokument haengt.
    const back = run?.returnFocus;
    if (!restoreFocus || !back?.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body && !this.$refs.actionMenu?.contains(active)) return;
    back.focus?.({ preventScroll: true });
  },

  isActionMenuOpen(key) {
    return this.actionMenuKey === key;
  },

  // Der Knopf/das Element, an dem das Menue aufging. Anker fuer Picker, die aus
  // dem Menue oeffnen: der Menue-Eintrag verschwindet mit dem Menue, ein daran
  // verankertes Popover stuende sonst unter dem Menue statt am Element.
  actionMenuAnchor() {
    return this._actionMenu?.trigger || null;
  },

  // x-bind-Objekt fuer das Menue-Element (neben `x-ref="actionMenu"`).
  // `:style` in Objekt-Form: die String-Form ueberschriebe das `display:none`
  // von x-show.
  actionMenuPanel() {
    return {
      role: 'menu',
      'x-show': () => this.actionMenuKey != null,
      ':style': () => ({ top: this.actionMenuPos.top + 'px', left: this.actionMenuPos.left + 'px' }),
      '@contextmenu.prevent': () => {},
      // Nach dem Eintrag (Bubble-Phase, der Item-Handler lief schon) zu. Der
      // Klick endet am Menue: ein Eintrag, der ein Inline-Formular oder einen
      // Picker mit `@click.outside` oeffnet, saehe denselben Klick sonst am
      // document ankommen und schloesse das Frischgeoeffnete sofort wieder.
      '@click': (e) => {
        e.stopPropagation();
        const item = e.target.closest?.(ITEM_SEL);
        if (item && !item.disabled) this.closeActionMenu();
      },
    };
  },

  _actionMenuItems() {
    const el = this.$refs.actionMenu;
    if (!el) return [];
    return [...el.querySelectorAll(ITEM_SEL)].filter((it) => it.offsetParent !== null && !it.disabled);
  },

  // Echte Groesse messen und neu verankern — nach dem Oeffnen und erneut, wenn
  // sich der Inhalt des offenen Menues aendert.
  _remeasureActionMenu() {
    const run = this._actionMenu;
    const el = this.$refs.actionMenu;
    if (!run || !el || !el.offsetHeight) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    this.actionMenuPos = run.point
      ? clampToViewport(run.point.x, run.point.y, w, h)
      : computePopoverPos(run.rect, w, h);
  },

  // Hat sich der Anker seit dem Oeffnen bewegt? 1px Toleranz gegen Rundung.
  // Ohne Anker-Element (synthetisch geoeffnet) schliesst jeder Scroll.
  _actionMenuAnchorMoved() {
    const run = this._actionMenu;
    if (!run) return false;
    if (!run.trigger?.isConnected || !run.rect) return true;
    const now = run.trigger.getBoundingClientRect();
    return Math.abs(now.top - run.rect.top) > 1 || Math.abs(now.left - run.rect.left) > 1;
  },

  _onActionMenuKeydown(e) {
    if (this.actionMenuKey == null) return;
    if (e.key === 'Escape') {
      // Esc gilt nur dem Menue: preventDefault haelt einen nativen <dialog>
      // darunter offen (dessen cancel ist die Standardaktion der Taste),
      // stopPropagation die Esc-Griffe der Karte.
      e.preventDefault();
      e.stopPropagation();
      this.closeActionMenu({ restoreFocus: true });
      return;
    }
    if (e.key === 'Tab') { this.closeActionMenu(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = this._actionMenuItems();
    if (!items.length) return;
    e.preventDefault();
    const cur = items.indexOf(document.activeElement);
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = cur < 0 ? 0 : (cur + 1) % items.length;
    else next = cur < 0 ? items.length - 1 : (cur - 1 + items.length) % items.length;
    items[next].focus({ preventScroll: true });
  },

  _teardownActionMenu() {
    this._actionMenu?.ctrl.abort();
    this._actionMenu = null;
  },
};

// ── x-long-press ────────────────────────────────────────────────────────────
// Touch-Long-Press = Rechtsklick: `x-long-press` (ohne Ausdruck) neben
// `@contextmenu` am selben Element. Nach dem Halten loest die Direktive am
// Element unter dem Finger ein `contextmenu`-Event aus (bubbelt, mit
// `clientX`/`clientY`) — derselbe Handler bedient so Maus und Touch, und ein
// per addEventListener gebundener Handler (Mindmap) sieht das echte Ziel.
// Nur Touch/Stift (die Maus hat den Rechtsklick). Nach dem Ausloesen schluckt
// die Direktive den nachgereichten Klick und die emulierten Maus-Events —
// sonst oeffnete der Klick das Element darunter bzw. schloesse der mousedown
// das Menue gleich wieder. Loest der Browser zusaetzlich nativ `contextmenu`
// aus (Android), oeffnet der Handler an derselben Stelle neu.
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

export function registerLongPress() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.directive('long-press', (el, _dir, { cleanup }) => {
    let timer = null, startX = 0, startY = 0, fired = false, swallow = null;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    // Den Klick NACH einem Long-Press schlucken — aber nur diesen einen: kommt
    // keiner (touchend.preventDefault unterdrueckt ihn meist), darf der
    // Schlucker nicht scharf bleiben und den naechsten echten Klick fressen.
    const disarm = () => { swallow?.abort(); swallow = null; };
    el.addEventListener('pointerdown', (e) => {
      cancel();
      disarm();
      fired = false;
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      startX = e.clientX; startY = e.clientY;
      timer = setTimeout(() => {
        timer = null;
        fired = true;
        const hit = document.elementFromPoint(startX, startY);
        const at = hit && el.contains(hit) ? hit : el;
        at.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: startX, clientY: startY, button: 2,
        }));
        disarm();
        swallow = new AbortController();
        el.addEventListener('click', (c) => { c.preventDefault(); c.stopPropagation(); disarm(); },
          { capture: true, signal: swallow.signal });
      }, LONG_PRESS_MS);
    }, { signal });
    el.addEventListener('pointermove', (e) => {
      if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > LONG_PRESS_SLOP_PX) cancel();
    }, { passive: true, signal });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      el.addEventListener(type, cancel, { signal });
    }
    el.addEventListener('touchend', (e) => {
      if (!fired) return;
      e.preventDefault();
      fired = false;
      // Ein nachgereichter Klick kommt sofort nach dem Loslassen oder gar nicht.
      setTimeout(disarm, 400);
    }, { signal });
    cleanup(() => { cancel(); disarm(); ctrl.abort(); });
  });
}
