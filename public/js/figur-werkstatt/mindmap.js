// jsMind-Lifecycle: Mount/Destroy, Config, Listener, Topic-i18n-Marker, Fullscreen.
// Topic-Marker: Server persistiert Default-Knoten als `__i18n:werkstatt.tree.foo__`.
// Beim Show resolved zur User-Locale; beim Save werden unveränderte resolved
// Strings via Marker-Map zurück in Marker geschrieben — Locale-Wechsel später
// bleibt funktionsfähig.

import { loadJsMind } from '../lazy-libs.js';
import { toggleWrapFullscreen } from '../fullscreen.js';
import { observeThemeChange } from '../graph-kit/theme.js';
import { uuid } from '../utils/uuid.js';
import { installGrowingEditor } from './mindmap-editor.js';
import { patchJmView, depthAttr } from './mindmap-view.js';

const I18N_MARKER = /^__i18n:([a-zA-Z0-9_.-]+)__$/;

export function resolveTopic(topic) {
  const m = I18N_MARKER.exec(topic || '');
  return m ? window.__app.t(m[1]) : (topic || '');
}

// Klont Mindmap-Tree mit resolved Topics für Display und befüllt markers
// (id → { marker, shown }) als Seitenkanal. _exportMindmap nutzt die Map, um
// Default-Topics nach dem Save in Marker zurückzuverwandeln. `shown` ist der
// Text, der beim Mount angezeigt wurde: ein Locale-Wechsel bei offener Mindmap
// ändert t(), nicht aber den Knoten — der Vergleich gegen die neue Übersetzung
// liesse den Marker sonst fallen und speicherte die alte Sprache als Klartext.
export function resolveMindmapForDisplay(mindmap, markers) {
  if (!mindmap?.data) return mindmap;
  const clone = (n) => {
    const shown = resolveTopic(n.topic);
    if (markers && I18N_MARKER.test(n.topic || '')) markers[n.id] = { marker: n.topic, shown };
    return {
      ...n,
      topic: shown,
      children: (n.children || []).map(clone),
    };
  };
  return { ...mindmap, data: clone(mindmap.data) };
}

// jsMind zeichnet die Verbindungslinien mit einer festen Farbe auf SVG — kein
// CSS-Target. Darum Token lesen und bei Theme-Wechsel neu setzen.
function _token(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
function _lineColor() { return _token('--color-border', '#888'); }
// Drag-Plugin zeichnet seine Andock-Linie auf Canvas — auch hier kein CSS.
function _accentColor() { return _token('--color-primary', '#357ebd'); }
function _dangerColor() { return _token('--color-err-text', '#c33'); }

export function _newNodeId() {
  return 'n' + uuid();
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
    // Patches an der ROHEN Instanz: this._jm ist danach ein Alpine-Proxy, und
    // jsMind reicht intern rohe Knoten herum — ein Wrapper, der über den Proxy
    // vergleicht (editing_node === node), sähe nie Gleichheit.
    const jmRaw = new jsMind(this._buildJmConfig(container));
    patchJmView(jmRaw);
    installGrowingEditor(jmRaw);
    this._jm = jmRaw;
    this._mindmapEl = container;
    this._attachJmListeners();
    this._themeObs = observeThemeChange(() => this._applyLineColor());
    this._mmAbort = new AbortController();
    container.addEventListener('contextmenu', (ev) => this._onMindmapContextMenu(ev), { signal: this._mmAbort.signal });
    this._attachTouchPan(container, this._mmAbort.signal);
    this._topicMarkers = {};
    const display = resolveMindmapForDisplay(sel.mindmap, this._topicMarkers);
    // Wurzel = Figurname (Server-Invariante); ungespeicherte Umbenennung im
    // Formular gilt schon beim Mount.
    const name = (this.editName || '').trim();
    if (display?.data && name) display.data.topic = name;
    this._jm.show(display);
    this._jmDraftId = sel.id;
    // Startansicht (Ebene 2 offen, eingepasst) erst nach jsMinds Plugin-Init
    // (setTimeout 0 im Konstruktor): das Drag-Plugin legt seine Zeichenfläche
    // beim ersten resize-Event an, das _applyStartView über _show auslöst.
    this._applyStartView();
    this._resetMindmapHistory();
    this.selectedKnotenId = sel.mindmap?.data?.id || 'root';
    const kid = this._pendingKnotenId;
    this._pendingKnotenId = null;
    const jm = this._jm;
    setTimeout(() => {
      if (this._jm !== jm) return;
      this.fitMindmap();
      if (kid && jm.get_node?.(kid)) {
        this._revealNode(kid);
        this._tagMindmapNodes();
        this._selectNodeQuiet(kid);
        this.selectedKnotenId = kid;
        this._centerNodeInView(kid);
      }
    }, 0);
    this.$nextTick(() => {
      const panel = container.querySelector('.jsmind-inner');
      if (panel) {
        panel.focus({ preventScroll: true });
        // Esc blurt Mindmap-Panel: Tab=9 ist als addchild gemappt, sonst
        // kein Tab-Forward möglich. Esc gibt Tab-Reihenfolge frei.
        // Cmd/Ctrl+Z bzw. +Umschalt (oder +Y): Rückgängig/Wiederholen der
        // Mindmap (history.js) — nicht, solange ein Knoten-Topic editiert wird.
        panel.addEventListener('keydown', (e) => {
          if (!this._jm || this._jm.view?.is_editing?.()) return;
          if (e.key === 'Escape') { panel.blur(); return; }
          if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
          const k = e.key.toLowerCase();
          if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undoMindmap(); }
          else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); this.redoMindmap(); }
        });
      }
    });
  },

  _buildJmConfig(container) {
    const lineColor = _lineColor();
    return {
      container,
      editable: true,
      // Kein Vendor-Theme: `jmnodes.theme-*` schlägt die App-Brücke in
      // figur-werkstatt.css an Spezifität. Optik kommt ganz aus der App.
      theme: null,
      // SECURITY: support_html=false — KI-Brainstorm-Topics gehen via add_node
      // in jsMind-Knoten. Mit support_html=true (Default) würde innerHTML
      // gerendert → XSS bei manipulierter KI-Antwort. Der Render-Hook unten
      // schreibt ebenfalls nur textContent.
      support_html: false,
      view: {
        engine: 'svg',
        hmargin: 60, vmargin: 40,
        line_width: 1.5, line_color: lineColor, line_style: 'curved',
        draggable: true,
        expander_style: 'number',
        custom_node_render: (_jm, el, node) => {
          el.textContent = node.topic;
          el.dataset.depth = depthAttr(node);
          return true;
        },
        // Lange Titel umbrechen statt abschneiden (max-width im CSS).
        node_overflow: 'wrap',
        // Strg+Mausrad (macOS: Pinch) zoomt; Untergrenze für grosse Figuren.
        zoom: { min: 0.25, max: 2, step: 0.1, mask_key: 4096 },
      },
      layout: { hspace: 40, vspace: 14, pspace: 14 },
      // Knoten per Ziehen umhängen (vendor/jsmind-0.9.1.draggable-node.js).
      // Die Kern-IDs bleiben dabei erhalten — Bogen/Verankerung finden sie
      // überall im Baum (lib/draft-mindmap-extract.js#_find).
      plugin: {
        draggable_node: {
          line_width: 2,
          line_color: _accentColor(),
          line_color_invalid: _dangerColor(),
          shadow_node_class_name: 'jsmind-draggable-shadow-node',
        },
      },
      // Mac kein Insert; Tab als Mindmap-Standard. Esc-Handler im Mount blurt
      // Panel, sonst Tab-Trap (a11y).
      // Entf läuft NICHT über jsMinds eingebautes `delnode` (löscht ohne
      // Rückfrage, auch die Kern-Container), sondern über denselben Weg wie
      // das Kontextmenü: _requestDeleteNode. Der eingebaute Name lässt sich
      // nicht überschreiben (jsMind setzt seine Handler nach den eigenen), darum
      // eigener Name + leeres Mapping für `delnode`.
      // Gleiches gilt für Tab/Enter: jsMinds addchild/addbrother legen einen
      // englischen „New Node" mit eigener ID an — die eigenen Handler nehmen
      // Label und ID der App und gehen über _mutateMindmapQuiet.
      shortcut: {
        enable: true,
        handles: {
          safedel: (jm) => { this._requestDeleteNode(jm.get_selected_node()?.id); },
          swaddchild: (jm, e) => { e?.preventDefault?.(); this._addNodeAt(jm.get_selected_node()?.id, 'child'); },
          swaddbrother: (jm, e) => { e?.preventDefault?.(); this._addNodeAt(jm.get_selected_node()?.id, 'sibling'); },
        },
        mapping: {
          addchild: [],
          addbrother: [],
          swaddchild: [9, 45, 4109],
          swaddbrother: 13,
          editnode: 113,
          delnode: [],
          safedel: 46,
          toggle: 32,
          left: 37, up: 38, right: 39, down: 40,
        },
      },
    };
  },

  // Neuer Knoten unter (child) bzw. nach (sibling) dem Ziel, sofort im Edit.
  // Gemeinsamer Weg für Tab/Enter und das Kontextmenü.
  _addNodeAt(id, where) {
    // Roh statt über den Alpine-Proxy: begin_edit landet im mitwachsenden
    // Editor (mindmap-editor.js), der Knoten per Identität vergleicht.
    const jm = this._jm && window.Alpine?.raw ? window.Alpine.raw(this._jm) : this._jm;
    const target = id && jm?.get_node?.(id);
    if (!target || (where === 'sibling' && target.isroot)) return;
    const newId = _newNodeId();
    const label = window.__app.t('werkstatt.tree.newNode');
    this._mutateMindmapQuiet(() => {
      if (where === 'sibling') jm.insert_node_after(id, newId, label);
      else jm.add_node(id, newId, label);
      this._tagMindmapNodes();
      jm.select_node(newId);
      jm.begin_edit(newId);
    });
  },

  // type=4 → Selection (User+programmatic). type=3 → Edit (add/remove/rename/move).
  // type=1 → Show (auch Auf-/Zuklappen): Knoten-Markierung nachziehen.
  _attachJmListeners() {
    this._jm.add_event_listener((type, data) => {
      if (type === 1) {
        this._tagMindmapNodes();
      } else if (type === 4) {
        const id = data?.node || null;
        // jsMind stellt Events per Timeout zu: ein sofort danach gelöschter
        // Knoten (Auswahl + Entf) ist beim Eintreffen schon weg.
        if (id && !this._jm.mind?.nodes?.[id]) return;
        this.selectedKnotenId = id;
        if (id && !this._suppressCenter) this._centerNodeInView(id);
      } else if (type === 3) {
        this._tagMindmapNodes();
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
    const drag = this._jm.options?.plugin?.draggable_node;
    if (drag) { drag.line_color = _accentColor(); drag.line_color_invalid = _dangerColor(); }
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
    this._mmAbort?.abort();
    this._mmAbort = null;
    this.closeActionMenu();
    this._jm = null;
    this._jmDraftId = null;
    this._mindmapEl = null;
    this._topicMarkers = null;
    this._clearMindmapHistory();
    if (document.fullscreenElement?.classList?.contains?.('werkstatt-mindmap-section')) {
      try { document.exitFullscreen?.(); } catch {}
    }
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
        const m = markers[n.id];
        if (m && n.topic === m.shown) {
          n.topic = m.marker;
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
    // Fullscreen umfasst nur die Mindmap-Section (Titel + Canvas + Knoten-Menü),
    // nicht das Detail-Pane drumherum. Das Knoten-Menü liegt in der Section und
    // bleibt so im Vollbild-Teilbaum sichtbar.
    const wrap = document.querySelector('.card--werkstatt .werkstatt-mindmap-section');
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
