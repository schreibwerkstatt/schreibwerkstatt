// Sprung-Slice der Referenz-Karte (Alpine.data('referenceCard'), cards/reference-card.js):
// alles, was aus dem Slot in ein anderes Objekt führt — Zeilen (Figur/Ort/Szene/
// Ereignis, Plan, Recherche, Quelle, Verwandt) und die `x-entity-ref`-Chips darin.
//
// SPEICHERN VOR DEM SPRUNG: ein Sprung in eine Buchkarte oder einen anderen
// Abschnitt schliesst den Editor (Exklusivität, resetPage). Verloren geht dabei
// nichts — der Entwurf bleibt, die Outbox speichert ihn im Hintergrund nach —,
// aber der Server-Stand hinkt bis dahin hinterher, und ein Konflikt käme erst
// beim nächsten Besuch ans Licht. Darum speichert der Slot eine ungespeicherte
// Bearbeitung vorher selbst (`quickSave`, der stille Pfad wie Ctrl+S) und
// springt danach — auch wenn der Save scheitert, denn der Entwurf hält den Text.
//
// Abgefangen wird zentral in der Capture-Phase am Karten-Element: so laufen
// Zeilen-Klicks (Alpine `@click`) und Chip-Klicks (entity-ref.js, eigene
// Navigation aus TYPES) durch dieselbe Stelle, ohne dass ein Chip eine
// karteneigene `onOpen` bräuchte. Sprungziele tragen `data-ref-jump` (Zeilen)
// bzw. sind klickbare `.entity-ref` (Chips); alles andere — Reiter, Scope-
// Knopf, O-Ton-Einfügen, Transkript aufklappen — bleibt unberührt.
//
// Nur der Notebook-Editor hat diesen Slot; Focus- und Bucheditor sind nicht betroffen.

import { resolveEntityRef } from '../entity-ref.js';

const JUMP_SEL = '[data-ref-jump], .entity-ref:not(.entity-ref--static):not(.entity-ref--unresolved)';

export const referenceJumpState = () => ({
  // Re-Entry-Guard: der nach dem Save erneut ausgelöste Klick darf nicht wieder
  // abgefangen werden; zugleich sperrt er Doppelklicks während des Saves.
  _refJumpPending: false,
});

export const referenceJumpMethods = {
  /** In init() aufrufen: Capture-Listener am Karten-Element (Lifecycle-Signal). */
  _installReferenceJumpGuard(signal) {
    this.$el.addEventListener('click', (ev) => this._guardReferenceJump(ev), { capture: true, signal });
  },

  /** Muss vor diesem Sprung gespeichert werden? Nur mit ungespeicherter
   *  Bearbeitung im Notebook-Editor (Prädikat, ohne DOM — testbar). */
  _needsSaveBeforeJump() {
    const app = window.__app;
    return !!(app?.editMode && app?.editDirty && typeof app.quickSave === 'function');
  },

  _guardReferenceJump(ev) {
    if (this._refJumpPending === 'replay') return;      // der erneute Klick nach dem Save
    const el = ev.target?.closest?.(JUMP_SEL);
    if (!el || !this.$el.contains(el)) return;
    if (this._refJumpPending) { ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    if (!this._needsSaveBeforeJump()) return;
    // Markierter Text in einer Zeile: die Zeile springt ohnehin nicht
    // (openReferenceEntity) — dann auch nicht speichern.
    if (el.hasAttribute('data-ref-jump') && String(window.getSelection?.() || '').trim()) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    this._saveThenReplay(el);
  },

  async _saveThenReplay(el) {
    this._refJumpPending = true;
    try {
      await window.__app.quickSave();
    } catch (e) {
      // Der Entwurf hält den Text; der Sprung findet trotzdem statt.
      console.error('[reference] quickSave vor Sprung', e);
    }
    if (!el.isConnected) { this._refJumpPending = false; return; }
    this._refJumpPending = 'replay';
    try { el.click(); } finally { this._refJumpPending = false; }
  },

  /** Zeile Figur/Ort/Szene/Ereignis → Katalog-Karte, Eintrag aufgeklappt.
   *  Sprungziel aus der Entitäts-Referenz-Registry (entity-ref.js#TYPES), damit
   *  Zeile und Chip dasselbe Ziel haben. Wer in der Zeile Text markiert (etwa
   *  aus der Beschreibung kopieren), springt nicht — sonst schlösse das
   *  Loslassen der Maus den Editor. Unauflösbar (Figur nur im Kapitel-Index,
   *  Katalog noch nicht geladen) → kein Sprung. */
  openReferenceEntity(type, id) {
    if (id == null || id === '') return;
    if (String(window.getSelection?.() || '').trim()) return;
    resolveEntityRef({ type, id }, window.__app)?.open?.();
  },
};
