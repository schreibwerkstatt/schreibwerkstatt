// jsMind-Lifecycle: Mount/Destroy, Config, Listener, Topic-i18n-Marker, Fullscreen.
// Topic-Marker: Server persistiert Default-Knoten als `__i18n:werkstatt.tree.foo__`.
// Beim Show resolved zur User-Locale; beim Save werden unveränderte resolved
// Strings via Marker-Map zurück in Marker geschrieben — Locale-Wechsel später
// bleibt funktionsfähig.

import { loadJsMind } from '../lazy-libs.js';
import { toggleWrapFullscreen } from '../fullscreen.js';
import { observeThemeChange } from '../graph-kit/theme.js';

const I18N_MARKER = /^__i18n:([a-zA-Z0-9_.-]+)__$/;

export function resolveTopic(topic) {
  const m = I18N_MARKER.exec(topic || '');
  return m ? window.__app.t(m[1]) : (topic || '');
}

// Klont Mindmap-Tree mit resolved Topics für Display und befüllt markers
// (id → Original-Marker-String) als Seitenkanal. _exportMindmap nutzt die Map,
// um Default-Topics nach dem Save in Marker zurückzuverwandeln.
export function resolveMindmapForDisplay(mindmap, markers) {
  if (!mindmap?.data) return mindmap;
  const clone = (n) => {
    if (markers && I18N_MARKER.test(n.topic || '')) markers[n.id] = n.topic;
    return {
      ...n,
      topic: resolveTopic(n.topic),
      children: (n.children || []).map(clone),
    };
  };
  return { ...mindmap, data: clone(mindmap.data) };
}

// jsMind zeichnet die Verbindungslinien mit einer festen Farbe auf SVG — kein
// CSS-Target. Darum Token lesen und bei Theme-Wechsel neu setzen.
function _lineColor() {
  const cs = getComputedStyle(document.documentElement);
  return cs.getPropertyValue('--color-border').trim() || '#888';
}

// iOS feuert bei langem Druck kein `contextmenu` — ohne Long-Press waeren
// Umbenennen/Anlegen/Loeschen auf einem Tablet ohne Tastatur unerreichbar.
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

export function _newNodeId() {
  return 'n' + crypto.randomUUID();
}

export const mindmapMethods = {
  async _mountMindmap(container) {
    if (!container) return;
    const sel = this.selectedDraft();
    if (!sel) return;
    if (!container.offsetParent) {
      if (!container.isConnected) return;
      const tries = (this._mountTries = (this._mountTries || 0) + 1);
      if (tries > 60) { this._mountTries = 0; return; }
      const draftId = this.selectedDraftId;
      requestAnimationFrame(() => {
        if (!container.isConnected) return;
        if (this.selectedDraftId === draftId && window.__app?.showFigurWerkstattCard) {
          this._mountMindmap(container);
        }
      });
      return;
    }
    this._mountTries = 0;
    let jsMind;
    try {
      jsMind = await loadJsMind();
    } catch (e) {
      this.errorMessage = window.__app.t('werkstatt.error.libLoad');
      return;
    }
    if (this.selectedDraftId !== sel.id || !container.isConnected) return;
    this._jm = new jsMind(this._buildJmConfig(container));
    this._mindmapEl = container;
    this._attachJmListeners();
    this._themeObs = observeThemeChange(() => this._applyLineColor());
    container.addEventListener('contextmenu', (ev) => this._onMindmapContextMenu(ev));
    this._attachLongPress(container);
    container.addEventListener('mousedown', (ev) => {
      if (ev.button !== 2 && this.contextMenuOpen) this._hideContextMenu();
    });
    this._topicMarkers = {};
    const display = resolveMindmapForDisplay(sel.mindmap, this._topicMarkers);
    // Wurzel = Figurname (Server-Invariante); ungespeicherte Umbenennung im
    // Formular gilt schon beim Mount.
    const name = (this.editName || '').trim();
    if (display?.data && name) display.data.topic = name;
    this._jm.show(display);
    this._jmDraftId = sel.id;
    this.selectedKnotenId = sel.mindmap?.data?.id || 'root';
    if (this._pendingKnotenId) {
      const kid = this._pendingKnotenId;
      this._pendingKnotenId = null;
      if (this._jm.get_node && this._jm.get_node(kid)) {
        this._selectNodeQuiet(kid);
        this.selectedKnotenId = kid;
        this._centerNodeInView?.(kid);
      }
    }
    this.$nextTick(() => {
      const panel = container.querySelector('.jsmind-inner');
      if (panel) {
        panel.focus({ preventScroll: true });
        // Esc blurt Mindmap-Panel: Tab=9 ist als addchild gemappt, sonst
        // kein Tab-Forward möglich. Esc gibt Tab-Reihenfolge frei.
        panel.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && this._jm) {
            const editing = container.querySelector('jmnode input');
            if (editing) return;
            panel.blur();
          }
        });
      }
    });
  },

  _buildJmConfig(container) {
    const lineColor = _lineColor();
    return {
      container,
      editable: true,
      theme: 'primary',
      // SECURITY: support_html=false — KI-Brainstorm-Topics gehen via add_node
      // in jsMind-Knoten. Mit support_html=true (Default) würde innerHTML
      // gerendert → XSS bei manipulierter KI-Antwort.
      support_html: false,
      view: {
        engine: 'svg',
        hmargin: 80, vmargin: 40,
        line_width: 1.5, line_color: lineColor,
        draggable: true,
        expander_style: 'number',
      },
      layout: { hspace: 30, vspace: 18, pspace: 14 },
      // Mac kein Insert; Tab als Mindmap-Standard. Esc-Handler im Mount blurt
      // Panel, sonst Tab-Trap (a11y).
      shortcut: {
        enable: true,
        mapping: {
          addchild: [9, 45, 4109],
          addbrother: 13,
          editnode: 113,
          delnode: 46,
          toggle: 32,
          left: 37, up: 38, right: 39, down: 40,
        },
      },
    };
  },

  // type=4 → Selection (User+programmatic). type=3 → Edit (add/remove/rename/move).
  _attachJmListeners() {
    this._jm.add_event_listener((type, data) => {
      if (type === 4) {
        const id = data?.node || null;
        this.selectedKnotenId = id;
        if (id && !this._suppressCenter) this._centerNodeInView(id);
      } else if (type === 3) {
        this._markMindmapDirty();
        // Umbenennung der Wurzel im Canvas → Namensfeld. Die Gegenrichtung
        // macht _syncRootTopic; update_node mit gleichem Topic feuert nicht,
        // die beiden schaukeln sich also nicht auf.
        if (data?.evt === 'update_node' && data.node === this._jm?.get_root?.()?.id) {
          const topic = data.data?.[1];
          if (typeof topic === 'string' && topic.trim()) this.editName = topic;
        }
      }
    });
  },

  // Namensfeld → Wurzel-Knoten, live. Nur fuer den Canvas der aktuellen
  // Figur; leerer Name bleibt stehen (jsMind lehnt leere Topics ab, das
  // Formular zeigt den Fehler).
  _syncRootTopic(name) {
    const n = (name || '').trim();
    if (!n || !this._jm || this._jmDraftId !== this.selectedDraftId) return;
    const root = this._jm.get_root?.();
    if (!root || root.topic === n) return;
    try { this._jm.update_node(root.id, n); } catch {}
  },

  _applyLineColor() {
    const view = this._jm?.view;
    if (!view?.opts) return;
    view.opts.line_color = _lineColor();
    try { view.show_lines(); } catch {}
  },

  // Long-Press oeffnet dasselbe Knoten-Menue wie der Rechtsklick. Loest der
  // Browser nativ `contextmenu` aus (Android), raeumt dessen Handler den Timer
  // ab. Nach dem Ausloesen verhindert touchend die emulierten Maus-Events —
  // sonst schlosse der nachgereichte mousedown das Menue sofort wieder.
  _attachLongPress(container) {
    let timer = null, startX = 0, startY = 0, fired = false;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    this._cancelLongPress = cancel;
    container.addEventListener('touchstart', (ev) => {
      fired = false;
      cancel();
      if (ev.touches.length !== 1) return;
      const t = ev.touches[0];
      const node = t.target?.closest?.('jmnode');
      if (!node) return;
      startX = t.clientX; startY = t.clientY;
      timer = setTimeout(() => {
        timer = null;
        fired = true;
        this._openNodeMenu(node, startX, startY);
      }, LONG_PRESS_MS);
    }, { passive: true });
    container.addEventListener('touchmove', (ev) => {
      const t = ev.touches[0];
      if (t && Math.hypot(t.clientX - startX, t.clientY - startY) > LONG_PRESS_SLOP_PX) cancel();
    }, { passive: true });
    container.addEventListener('touchend', (ev) => {
      cancel();
      if (fired) { ev.preventDefault(); fired = false; }
    });
    container.addEventListener('touchcancel', cancel);
  },

  _selectNodeQuiet(id) {
    if (!this._jm || !id) return;
    this._suppressCenter = true;
    try { this._jm.select_node(id); } finally { this._suppressCenter = false; }
  },

  // Wrapper für API-Mutationen: jsMind feuert type=3 nicht zuverlässig bei
  // programmatischem add_node/remove_node — markiert dirty zentral.
  _mutateMindmap(fn) {
    if (!this._jm) return false;
    try {
      fn(this._jm);
      this._markMindmapDirty();
      return true;
    } catch (e) {
      return false;
    }
  },

  // Wie _mutateMindmap, unterdrückt Auto-Center bei internem select_node —
  // verhindert smooth-scroll-Jank während begin_edit.
  _mutateMindmapQuiet(fn) {
    if (!this._jm) return false;
    this._suppressCenter = true;
    try {
      fn(this._jm);
      this._markMindmapDirty();
      return true;
    } catch (e) {
      return false;
    } finally {
      this._suppressCenter = false;
    }
  },

  _destroyMindmap() {
    const container = this._mindmapEl;
    if (container) {
      while (container.firstChild) container.removeChild(container.firstChild);
    }
    this._themeObs?.disconnect();
    this._themeObs = null;
    this._cancelLongPress?.();
    this._cancelLongPress = null;
    this._jm = null;
    this._jmDraftId = null;
    this._mindmapEl = null;
    this._topicMarkers = null;
    if (document.fullscreenElement?.classList?.contains?.('werkstatt-detail')) {
      try { document.exitFullscreen?.(); } catch {}
    }
    this._hideContextMenu?.();
  },

  // Zentriert nur, wenn Knoten ausserhalb Viewport — Pfeil-Nav sonst jankig.
  _centerNodeInView(id) {
    if (!this._jm || !id) return;
    const inner = this._mindmapEl?.querySelector?.('.jsmind-inner');
    const node = inner?.querySelector?.(`jmnode[nodeid="${CSS.escape(id)}"]`);
    if (inner && node) {
      const innerRect = inner.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const visible =
        nodeRect.left   >= innerRect.left   &&
        nodeRect.right  <= innerRect.right  &&
        nodeRect.top    >= innerRect.top    &&
        nodeRect.bottom <= innerRect.bottom;
      if (visible) return;
    }
    try {
      this._jm.scroll_node_to_center(id);
    } catch {
      if (!inner || !node) return;
      const innerRect = inner.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      inner.scrollTo({
        left: Math.max(0, inner.scrollLeft + (nodeRect.left - innerRect.left) + nodeRect.width / 2 - innerRect.width / 2),
        top:  Math.max(0, inner.scrollTop  + (nodeRect.top  - innerRect.top)  + nodeRect.height / 2 - innerRect.height / 2),
        behavior: 'smooth',
      });
    }
  },

  // Restored i18n-Marker für unveränderte Default-Knoten; User-umbenannte
  // Knoten behalten neuen Topic.
  _exportMindmap() {
    if (!this._jm) return null;
    try {
      const exported = this._jm.get_data('node_tree');
      if (!exported?.data) return null;
      const markers = this._topicMarkers || {};
      const restore = (n) => {
        const marker = markers[n.id];
        if (marker && n.topic === resolveTopic(marker)) {
          n.topic = marker;
        }
        (n.children || []).forEach(restore);
      };
      restore(exported.data);
      return exported;
    } catch (e) {
      return null;
    }
  },

  async toggleMindmapFullscreen() {
    // Fullscreen umfasst das ganze Detail-Pane (Header + Form + Mindmap + Runs),
    // nicht nur die Mindmap-Section: Save/Brainstorm/Konsistenz und Notes
    // bleiben im Vollbild erreichbar. `$el` würde im @click-Kontext das Button-
    // Element liefern (kein Descendant von .werkstatt-detail) — globale Suche.
    const wrap = document.querySelector('.werkstatt-detail');
    if (!wrap) return;
    // State-Sync via `fullscreenchange`-Listener in figur-werkstatt-card.js —
    // mindmapFullscreen wird dort gesetzt, jsMind resize ebenfalls.
    try {
      await toggleWrapFullscreen(wrap);
    } catch {
      this.errorMessage = window.__app.t('werkstatt.error.fullscreen');
    }
  },
};
