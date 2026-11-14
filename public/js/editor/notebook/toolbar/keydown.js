// editorToolbarCard: zentraler Keydown-Dispatcher für den Edit-Container
// (delegiert aus editor-toolbar-card.js). Statt eines Megaswitch eine geordnete
// Kette benannter Handler: jeder gibt `true` zurück, wenn er das Event
// konsumiert hat — dann bricht der Dispatcher ab. `this` = Sub-Komponente
// (editorToolbarCard), Root-Zugriffe via window.__app.
// Enter in Checkbox-Liste/Gedicht: toolbar/keydown-enter.js; Backspace/Delete
// an Blockgrenzen und über Auswahlen: toolbar/keydown-delete.js; Verlauf:
// toolbar/msg-thread.js; geschützte Nachbarn: toolbar/block-edge.js.

import { getEditEl, softBreakNoop, _formatStamp, findBlock, caretAtBlockStart, caretRangeIn } from './_shared.js';
import { matchHistoryCommand } from '../../shared/shortcuts.js';
import { isImeComposing } from '../../../utils/keys.js';
import { closestMsgLine, isEmptyMsgLine } from '../../../messages/msg-html.js';

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);
// Tasten, die bei offenem Slash-Menü den Caret bewegen: das Menü schliesst, die
// Taste wirkt (sonst wanderte der Caret, während das Menü am alten Block hängt).
const SLASH_CLOSE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

export const keydownMethods = {
  // Reihenfolge ist verhaltensrelevant (z.B. Shift+Enter vor Enter-in-Todo).
  // Die Handler bis zum Focus-Hard-Stop laufen in BEIDEN Modi (Notebook +
  // Focus); danach sind Slash + Block-Transforms tabu. Ausnahme Shift+Enter:
  // im Focus fängt focus/listeners.js#onSoftBreak die Taste am Container ab
  // (stopPropagation), `_kbSoftBreak` greift dort nie.
  _onEditKeydown(e) {
    const app = window.__app;
    if (!app?.editMode) return;
    // Enter, das eine IME-Komposition bestaetigt, ist keine Struktur-Taste.
    // Safari meldet den bestaetigenden Enter mit `isComposing: false` und nur
    // `keyCode 229` — darum der geteilte Guard aus utils/keys.js.
    if (isImeComposing(e)) return;
    // Ein offenes Slash-Menue besitzt die Tastatur zuerst: sonst wandelte
    // `_kbTodoEnter`/`_kbPoemEnter` die leere Zeile, aus der das Menue geoeffnet
    // wurde, und das Menue bliebe verwaist ueber einem geloesten Block stehen.
    // Im Focus-Modus oeffnet es nie (siehe Hard-Stop unten).
    if (!app.focusActive && this._kbSlashNav(e)) return;
    // Die Klick-Markierung einer <hr> gilt nur fuer den naechsten Loeschgriff.
    // Wer stattdessen tippt oder den Caret bewegt, hat sich umentschieden —
    // sonst loeschte das naechste Backspace die Linie statt des Zeichens.
    if (e.key !== 'Backspace' && e.key !== 'Delete' && !MODIFIER_KEYS.has(e.key)) {
      getEditEl()?.querySelectorAll('hr.hr-selected').forEach((h) => h.classList.remove('hr-selected'));
    }

    // Auswahl vor Enter/Shift+Enter/Datumsstempel selbst löschen (toolbar/
    // keydown-delete.js) — konsumiert nicht, die Kette läuft danach weiter.
    if (!app.focusActive) this._kbCollapseForInsert(e, app);
    // Alt+Enter neben einer Tabelle → Gitter-Dialog (toolbar/table.js).
    // Vor allen Enter-Handlern, die sonst den Absatz teilen würden.
    if (!app.focusActive && this._kbTableEdit(e)) return;
    if (this._kbSoftBreak(e, app)) return;
    if (this._kbTodoEnter(e, app)) return;
    if (this._kbPoemEnter(e, app)) return;
    if (this._kbDateStamp(e, app)) return;
    if (this._kbInlineFormat(e)) return;
    if (this._kbHorizontalRule(e, app)) return;
    if (this._kbLink(e, app)) return;
    if (this._kbUndoRedo(e, app)) return;
    if (this._kbProtectedNeighbour(e, app)) {
      if (app.focusActive) getEditEl()?.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // Ab hier hört die Toolbar im Focus-Modus auf — Slash-Menü und Block-
    // Transforms sind dort nicht erlaubt. B/I/U liefen oben bzw. via Browser-
    // Default weiter. Ausnahme sind Enter im Nachrichtenverlauf (Doppel-Enter
    // verlässt ihn, sonst wurde weitergetippte Erzählung zur Nachricht) und
    // Backspace/Delete an Blockgrenzen: dort laufen dieselben Handler wie im
    // Notebook (Verlauf, Wrapper, Checkbox-Liste), und den schlichten Merge
    // zweier Geschwisterblöcke übernimmt der Focus-Editor selbst. Der aktive
    // Absatz trägt eine eigene Spotlight-Farbe, Chromium bäckt diesen
    // Unterschied beim Merge als Inline-`style` ein; im `.poem` (Focus-CSS:
    // `display: contents`) verwirft der Default sogar ganze Verse.
    if (app.focusActive) {
      if (this._kbMsgThread(e, app) || this._kbTodoDelete(e, app) || this._kbFigureCaption(e, app)
          || this._kbBlockBoundary(e, app) || this._kbFocusMerge(e, app)) {
        // Manuelle DOM-Mutation feuert kein `input`: Absatz-Markierung und
        // Fokus-Undo hängen daran (Invarianten 18 + 19 in docs/focus-editor.md).
        getEditEl()?.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }

    // Auswahl über eine Blockgrenze (löschen/überschreiben) vor allen
    // Caret-Handlern — die setzen eine leere Auswahl voraus.
    if (this._kbRangeDelete(e, app)) return;
    if (this._kbDeleteBlock(e, app)) return;
    // Nachrichtenverlauf vor den generischen Grenzen: Zeilen-Merges innerhalb
    // des Verlaufs, Enter/Tab für Zeilenarten (toolbar/msg-thread.js).
    if (this._kbMsgThread(e, app)) return;
    if (this._kbFigureEnter(e, app)) return;
    if (this._kbQuoteEnter(e, app)) return;
    if (this._kbPreEnter(e, app)) return;
    if (this._kbHeadingStartEnter(e, app)) return;
    // Struktur-Grenzen: spezifisch vor generisch. `_kbTodoDelete` und
    // `_kbFigureCaption` schützen je ein Void-Element (Checkbox bzw. Bild),
    // `_kbBlockBoundary` deckt die übrigen formatierten Wrapper ab.
    if (this._kbTodoDelete(e, app)) return;
    if (this._kbFigureCaption(e, app)) return;
    if (this._kbBlockBoundary(e, app)) return;
    this._kbSlashTrigger(e);
  },

  // Shift+Enter = weicher Zeilenumbruch (<br>). In Safari/WebKit splittet die
  // Default-Aktion stattdessen den Absatz in zwei <p> – in Gedichten/Dialogen
  // der falsche Umbruch. execCommand('insertLineBreak') setzt das <br> cross-
  // browser konsistent (WebKit + Chromium getestet). Auf einer bereits leeren
  // Soft-Break-Zeile (links steht ein <br>) keinen zweiten <br> einfügen — der
  // würde beim Save eh kollabieren (No-Op statt Doppel-Umbruch, der nach Reload
  // verschwindet). Ausnahme Code-Block: dort ist die Leerzeile Inhalt
  // (shared/soft-break.js#softBreakNoop).
  // In einer leeren Nachrichtenzeile (Notebook) ebenfalls No-Op: das <br>
  // stünde vor der ersten getippten Zeile, die Blase begänne mit einer
  // Leerzeile — nach Enter ist die neue Nachricht schon da.
  _kbSoftBreak(e, app) {
    if (!(e.key === 'Enter' && e.shiftKey)) return false;
    e.preventDefault();
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (sel && softBreakNoop(sel)) return true;
    const msgLine = sel?.rangeCount && !app.focusActive ? closestMsgLine(sel.anchorNode, editEl) : null;
    if (msgLine && isEmptyMsgLine(msgLine)) return true;
    document.execCommand('insertLineBreak');
    app._markEditDirty?.();
    return true;
  },

  // Cmd/Ctrl + Taste rechts neben L → Datum, mit Shift → Datum+Zeit.
  // Ausgewertet wird die PHYSISCHE Taste (`e.code === 'Semicolon'`): auf US-
  // Layout trägt sie «;», auf DE/CH «ö». Das Zeichen (`e.key === ';'`) taugt
  // nicht — auf DE liegt «;» auf Shift+Komma, der Griff wäre dort immer der
  // Datum+Zeit-Fall.
  _kbDateStamp(e, app) {
    if (!((e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'Semicolon')) return false;
    e.preventDefault();
    const stamp = _formatStamp(e.shiftKey ? 'datetime' : 'date');
    document.execCommand('insertText', false, stamp);
    app._markEditDirty?.();
    return true;
  },

  // Ctrl/Cmd+B und Ctrl/Cmd+I: Bold/Italic auch im Fokus-Modus, in dem die
  // Bubble-Toolbar ausgeblendet ist. Explizit statt Browser-Default, damit
  // _markEditDirty + Bubble-Reposition konsistent laufen.
  _kbInlineFormat(e) {
    if (!((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey)) return false;
    if (e.key === 'b' || e.key === 'B') { e.preventDefault(); this._applyInline('bold'); return true; }
    if (e.key === 'i' || e.key === 'I') { e.preventDefault(); this._applyInline('italic'); return true; }
    return false;
  },

  // Ctrl/Cmd+Shift+H: Trennlinie (<hr>) am Caret einfügen.
  _kbHorizontalRule(e, app) {
    if (!((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'h' || e.key === 'H'))) return false;
    e.preventDefault();
    app.insertHorizontalRule?.();
    return true;
  },

  // Link-Input öffnen:
  //   • Cmd/Ctrl+K mit Markierung im Notebook-Text. Ohne Markierung (oder
  //     ausserhalb des Editors) bleibt Cmd/Ctrl+K die Befehlspalette — das
  //     `preventDefault` hier lässt den globalen Griff (editor/shortcuts.js#
  //     handleNavHotkey) aussetzen.
  //   • Cmd/Ctrl+Shift+K immer. Im Focus konsumiert die Kombo, tut aber nichts
  //     (kein preventDefault); Cmd/Ctrl+K fällt dort zur Palette durch.
  _kbLink(e, app) {
    if (!((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K'))) return false;
    if (e.shiftKey) {
      if (app.focusActive) return true;
      e.preventDefault();
      this.openLinkInput();
      return true;
    }
    if (app.focusActive) return false;
    const range = caretRangeIn(getEditEl());
    if (!range || range.collapsed) return false;
    e.preventDefault();
    this.openLinkInput();
    return true;
  },

  // Undo/Redo. Griffe kommen aus `matchHistoryCommand` (shared/shortcuts.js) —
  // dieselbe Funktion bindet der Fokusmodus (focus/listeners.js). Browser-Default
  // bewusst überschrieben: der eigene Stack ist nach Slash/HR-Mutationen
  // konsistent, der Browser-Stack ist es nicht.
  //
  // Der Fokusmodus fällt hier durch (→ Hard-Stop im Dispatcher) und wird von
  // seinem eigenen Container-Listener bedient, der VOR diesem document-Level-
  // Dispatcher läuft und das Event per stopPropagation verbraucht. Beide Wege
  // landen auf derselben Historie (siehe notebook/history.js).
  _kbUndoRedo(e, app) {
    if (app.focusActive) return false;
    const cmd = matchHistoryCommand(e);
    if (!cmd) return false;
    e.preventDefault();
    if (cmd === 'undo') app.notebookUndo?.(); else app.notebookRedo?.();
    return true;
  },

  // Slash-Menü-Navigation, wenn geöffnet. Bei offenem Menü werden die Tasten
  // konsumiert (druckbare Zeichen filtern die Liste statt das Menü zu schliessen;
  // Modifier-Combos durchlaufen die Filter-Zeile nicht, konsumieren aber).
  // Caret-Bewegungen (← → Pos1 Ende Bild↑ Bild↓) schliessen das Menü und
  // wirken danach normal.
  _kbSlashNav(e) {
    if (!this.slashShow) return false;
    if (e.key === 'Escape') { e.preventDefault(); this._closeSlash({ literal: true }); return true; }
    if (SLASH_CLOSE_KEYS.has(e.key)) { this._closeSlash({ literal: true }); return true; }
    // Konsumiert, aber nie zum Browser durchlassen: dessen Undo-Stack liefe an
    // der eigenen Historie vorbei (siehe _kbUndoRedo).
    if (matchHistoryCommand(e)) { e.preventDefault(); return true; }
    const filtered = this.slashItems();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length) this.slashIdx = (this.slashIdx + 1) % filtered.length;
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length) this.slashIdx = (this.slashIdx - 1 + filtered.length) % filtered.length;
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[this.slashIdx];
      if (pick) this._applySlashByKey(pick.key);
      return true;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (!this.slashQuery) { this._closeSlash(); return true; }
      this.slashQuery = this.slashQuery.slice(0, -1);
      this.slashIdx = 0;
      return true;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.slashQuery += e.key;
      this.slashIdx = 0;
      // Am Absatzanfang war der Schrägstrich vielleicht gemeint («/usr»): passt
      // kein Eintrag mehr, wird das Getippte als Text gesetzt.
      if (this._slashConvert && !this.slashItems().length) this._closeSlash({ literal: true });
      return true;
    }
    // Kürzel (Einfügen, Ausschneiden, Fett …): Menü schliessen, das Kürzel
    // wirkt normal. Sonst liefe es nativ in den Block, und die Wahl danach
    // verwürfe das Ergebnis mit dem Trigger-Block.
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (MODIFIER_KEYS.has(e.key)) return true;
      this._closeSlash({ literal: true });
      return false;
    }
    // Übrige Tasten (Delete, Tab, …) verändern den Block nicht, solange das
    // Menü offen ist.
    e.preventDefault();
    return true;
  },

  // Slash-Trigger: `/` öffnet das Block-Menü
  //   • in einem leeren Block (Umwandeln, Einfügen, Umbruch, Teilen) und
  //   • am Anfang eines Blocks mit Text (Caret auf Position 0, keine Auswahl):
  //     dann nur die Blocktypen — der Block wird samt Inhalt umgewandelt
  //     (toolbar/slash.js, `_slashConvert`).
  // Überall sonst bleibt `/` ein Zeichen.
  _kbSlashTrigger(e) {
    if (e.key !== '/') return false;
    const editEl = getEditEl();
    if (!editEl) return false;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!editEl.contains(range.startContainer)) return false;
    const block = findBlock(range.startContainer, editEl);
    if (!block) return false;
    const empty = (block.textContent || '').trim() === '';
    if (!empty && !(range.collapsed && caretAtBlockStart(range, block))) return false;
    e.preventDefault();
    this._openSlashAt(block, { convert: !empty });
    return true;
  },
};
