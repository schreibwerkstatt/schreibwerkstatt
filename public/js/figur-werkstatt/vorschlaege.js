// Vorschlagskarten der Figur-Werkstatt (DESIGN.md „Chat-Vorschlagskarte"):
// Brainstorm-Ideen und Konsistenz-Befunde mit übernehmbarer Mindmap-Änderung,
// je Eintrag Übernehmen und Verwerfen. Übernehmen ändert nur die Mindmap im
// Formular (dirty) — gespeichert wird über den normalen Weg (✓, Cmd+S,
// Auto-Save beim Figurwechsel), nie direkt.
//
// Zustand je Eintrag (`applied`/`discarded`) lebt in der Sitzung, geschlüsselt
// nach Lauf + Index: ein Lauf bleibt in der Historie unverändert, das
// Wiederöffnen zeigt ihn wieder vollständig.

import { _newNodeId } from './mindmap.js';

function _key(self, kind, idx) {
  return `${kind}:${self.selectedRunId ?? 'live'}:${idx}`;
}

// Knoten der offenen Mindmap, dessen angezeigter Text wortgleich `text` ist.
// Mehrdeutig (zwei Knoten gleichen Texts) gilt als nicht gefunden — eine
// Umbenennung am falschen Knoten wäre schlimmer als keine.
function _findNodeByTopic(jm, text) {
  const want = String(text || '').trim();
  if (!jm?.mind?.nodes || !want) return null;
  let hit = null;
  for (const node of Object.values(jm.mind.nodes)) {
    if (String(node?.topic || '').trim() !== want) continue;
    if (hit) return null;
    hit = node;
  }
  return hit;
}

export const vorschlaegeMethods = {
  vorschlagState(kind, idx) {
    return this.vorschlagStates[_key(this, kind, idx)] || null;
  },

  _setVorschlagState(kind, idx, state) {
    this.vorschlagStates = { ...this.vorschlagStates, [_key(this, kind, idx)]: state };
  },

  // Verwerfen schaltet um (Wiederherstellen), ein übernommener Eintrag bleibt.
  discardVorschlag(kind, idx) {
    const s = this.vorschlagState(kind, idx);
    if (s === 'applied') return;
    this._setVorschlagState(kind, idx, s === 'discarded' ? null : 'discarded');
  },

  vorschlagLabel(kind, idx, fallback) {
    const s = this.vorschlagState(kind, idx);
    const app = window.__app; const t = (k, p) => app.t(k, p);
    return s === 'applied' ? t('chat.applied') : s === 'discarded' ? t('chat.discarded') : fallback;
  },

  vorschlagClass(kind, idx) {
    const s = this.vorschlagState(kind, idx);
    return { 'chat-vorschlag--applied': s === 'applied', 'chat-vorschlag--discarded': s === 'discarded' };
  },

  // ── Konsistenz-Befund ────────────────────────────────────────────────────
  // Übernehmbar, wenn der Befund eine Aktion samt Text trägt und das Ziel in
  // der offenen Mindmap eindeutig auffindbar ist (Umbenennen braucht den
  // Knoten, Ergänzen fällt ohne Treffer auf die Figur selbst zurück).
  konfliktApplicable(k) {
    if (!k || !k.neu || !['umbenennen', 'ergaenzen'].includes(k.aktion)) return false;
    if (k.aktion === 'ergaenzen') return !!this._jm;
    return !!_findNodeByTopic(this._jm, k.feld);
  },

  // Warum ein Befund mit Aktion (noch) nicht übernehmbar ist.
  konfliktNote(k) {
    if (!k?.neu || k.aktion === 'keine' || this.konfliktApplicable(k)) return '';
    return window.__app.t('werkstatt.consistency.nodeGone', { feld: k.feld });
  },

  applyKonflikt(idx) {
    const app = window.__app;
    const k = this.consistencyResult?.konflikte?.[idx];
    if (!k || this.vorschlagState('consistency', idx) || !this.konfliktApplicable(k)) return;
    let ok;
    if (k.aktion === 'umbenennen') {
      const node = _findNodeByTopic(this._jm, k.feld);
      this._revealNode(node.id);
      ok = this._mutateMindmap(jm => jm.update_node(node.id, k.neu));
    } else {
      const parent = _findNodeByTopic(this._jm, k.feld) || this._jm.get_root?.();
      if (!parent) { ok = false; } else {
        this._revealNode(parent.id);
        ok = this._mutateMindmap(jm => jm.add_node(parent.id, _newNodeId(), k.neu));
      }
    }
    if (ok) this._setVorschlagState('consistency', idx, 'applied');
    else this.errorMessage = app.t('werkstatt.error.applyFailed');
  },
};
