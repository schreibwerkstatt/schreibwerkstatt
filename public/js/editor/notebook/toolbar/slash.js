// editorToolbarCard: Slash-Menü (Block-Transforms). `this` = Sub-Komponente
// (editorToolbarCard). Im Fokus-Modus deaktiviert (Trigger im keydown-Dispatch
// hinter dem Focus-Hard-Stop).

import { getEditEl, placeCaretIn, replaceBlockOutsideList, ensureSlotAfter, SLASH_ITEMS, _formatStamp } from './_shared.js';
import { createTodoList, TODO_ITEM_SEL, TODO_TEXT_SEL } from '../../shared/todo-html.js';
import { promoteSubLists, isListEl } from '../line-merge.js';
import { htmlToElement } from './caret-panel.js';
import { buildFigureHtml, FIGURE_CAPTION_SEL } from '../../../figure/figure-html.js';
import { contentRepo } from '../../../repo/content.js';

const SLASH_GAP = 4;
// Deckungsgleich mit `max-height` in css/editor/notebook/edit-toolbar.css.
const SLASH_MAX_H = 360;
// Unter dieser Höhe wird die Liste unbrauchbar: dann darf das Menü den
// Trigger-Block überlappen und das ganze sichtbare Band nutzen (bleibt scrollbar).
const SLASH_MIN_H = 140;

// Sichtbares Band in Client-Koordinaten (dieselbe Bezugsebene wie
// `getBoundingClientRect`). Auf Mobile ist das der `visualViewport`: die
// Bildschirmtastatur schrumpft ihn (und kann ihn verschieben), während
// `window.innerHeight` unverändert bleibt — würde man danach positionieren,
// landet das Menü hinter der Tastatur.
function visibleBand() {
  const vv = window.visualViewport;
  return {
    top: vv ? vv.offsetTop : 0,
    left: vv ? vv.offsetLeft : 0,
    height: vv ? vv.height : window.innerHeight,
    width: vv ? vv.width : window.innerWidth,
  };
}

export const slashMethods = {
  // Neu messen, sobald der DOM den aktuellen Stand zeigt. Bewusst per
  // `requestAnimationFrame` und nicht per `$nextTick`: die Trefferliste ist ein
  // verschachtelter `x-for` mit eigenem `x-show` je Gruppen-Header — dessen
  // Effekte laufen erst im Flush NACH dem äusseren Tick, ein einzelnes
  // `$nextTick` misst also eine veraltete Höhe. Vor dem nächsten Frame sind alle
  // Microtasks durch.
  _schedSlashPosition() {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => this._updateSlashPosition());
    } else {
      this._updateSlashPosition();
    }
  },

  // Positioniert das (nach <body> teleportierte) Menü am Trigger-Block.
  // Vorzugsrichtung bleibt oberhalb (näher am Caret in langen Texten, springt
  // nicht unter den Fold); reicht der Platz dort nicht, klappt es nach unten.
  // Die eigene Höhe wird gemessen, nicht geschätzt — sie hängt an der
  // gefilterten Trefferliste und am gedeckelten `max-height`.
  _updateSlashPosition() {
    if (!this.slashShow || !this._slashBlock || !this._slashBlock.isConnected) return;
    const rect = this._slashBlock.getBoundingClientRect();
    const band = visibleBand();
    // Block komplett ausserhalb des sichtbaren Bandes → schliessen.
    if (rect.bottom < band.top || rect.top > band.top + band.height) {
      this._closeSlash();
      return;
    }
    const above = rect.top - band.top - SLASH_GAP;
    const below = (band.top + band.height) - rect.bottom - SLASH_GAP;
    // Höhe deckeln, damit das Menü in sein Fach passt statt aus dem Band zu
    // ragen — mit offener Tastatur bleiben oft weniger als 360 px übrig.
    const avail = Math.min(
      SLASH_MAX_H,
      Math.max(above, below, Math.min(SLASH_MIN_H, band.height - 2 * SLASH_GAP)),
    );
    this.slashMaxH = avail;

    const menu = this.$refs?.slashMenu;
    // `max-height` vor dem Messen anwenden (Alpine schreibt denselben Wert im
    // nächsten Tick via `:style`); versteckt/ungerendert → Deckel als Schätzung.
    if (menu) menu.style.maxHeight = avail + 'px';
    const h = menu?.offsetHeight || avail;
    const w = menu?.offsetWidth || 240;

    const top = (h <= above || above >= below)
      ? rect.top - h - SLASH_GAP
      : rect.bottom + SLASH_GAP;
    this.slashY = Math.max(
      band.top + SLASH_GAP,
      Math.min(top, band.top + band.height - h - SLASH_GAP),
    );
    this.slashX = Math.max(
      band.left + SLASH_GAP,
      Math.min(rect.left, band.left + band.width - w - SLASH_GAP),
    );
  },

  // ── Slash-Menü ────────────────────────────────────────────────────────
  // Labels werden einmalig beim Öffnen aufgelöst (`_slashLabels`, gesetzt in
  // `_openSlashAt`) statt bei jedem Keystroke 14× `t()` aufzurufen.
  // `_buildSlashLabels` ist der Fallback, falls `slashItems` vor dem Öffnen
  // läuft (defensiv) – kein Getter im Data-Spread, sonst würde `this.t` zu
  // früh auf den Methoden selbst aufgerufen.
  _buildSlashLabels() {
    const app = window.__app;
    // Alles, was sich pro Eintrag nicht mit der Query ändert, wird hier einmal
    // beim Öffnen aufgelöst (Label, Gruppen-Label, Modifier-Klasse, Stempel).
    // Das Template liest dann nur noch Properties – keine `t()`-/Funktions-
    // Aufrufe pro Eintrag und Render, die beim Tippen reaktiv neu liefen.
    // Am Anfang eines Blocks mit Text (`_slashConvert`) nur die Blocktypen:
    // Einfügen, Umbruch und Teilen setzen einen leeren Trigger-Block voraus.
    const items = this._slashConvert ? SLASH_ITEMS.filter(it => it.group === 'block') : SLASH_ITEMS;
    return items.map(it => ({
      key: it.key,
      group: it.group,
      groupLabel: app?.t('editor.slash.group.' + it.group) || it.group,
      label: app?.t('editor.slash.' + it.key) || it.key,
      modClass: 'edit-slash-item--' + it.key,
      // Datums-/Zeit-Items zeigen den tatsächlich einzufügenden Wert als
      // Sekundär-Text (beim Öffnen aufgelöst; `_applySlashItem` rechnet beim
      // Einfügen ohnehin frisch).
      preview: it.insertText ? _formatStamp(it.insertText) : '',
    }));
  },
  // Filter: Substring-Match (case-insensitive) auf Label + Key, damit sowohl
  // DE-Labels („Über") als auch interne Keys („h2") tippbar sind. Ergebnis
  // wird pro Query gecacht – Template ruft `slashItems()` zweimal pro Render
  // (x-for + Leer-Check), der zweite Aufruf trifft den Cache statt neu zu
  // filtern.
  slashItems() {
    const q = (this.slashQuery || '').trim().toLowerCase();
    if (this._slashFilterCache && this._slashFilterCache.q === q) {
      return this._slashFilterCache.r;
    }
    const items = this._slashLabels || this._buildSlashLabels();
    const filtered = !q ? items : items.filter(it =>
      it.label.toLowerCase().includes(q) || it.key.toLowerCase().includes(q));
    // `showGroup`: erstes Item seiner Gruppe in der gefilterten Liste → der
    // Gruppen-Header wird gerendert. Einmal pro Query berechnet, damit das
    // Template beim Tippen nicht pro Eintrag erneut `slashItems()` aufruft.
    let prevGroup = null;
    const r = filtered.map(it => {
      const showGroup = it.group !== prevGroup;
      prevGroup = it.group;
      return { ...it, showGroup };
    });
    this._slashFilterCache = { q, r };
    return r;
  },

  // `convert`: Trigger am Anfang eines Blocks mit Text — die Wahl wandelt diesen
  // Block samt Inhalt um (`_convertSlashBlock`), statt einen leeren zu ersetzen.
  _openSlashAt(block, { convert = false } = {}) {
    this._slashBlock = block;
    this._slashConvert = convert;
    this.slashIdx = 0;
    this.slashQuery = '';
    // Labels einmalig in der aktuellen Sprache auflösen; Filter-Cache leeren.
    this._slashLabels = this._buildSlashLabels();
    this._slashFilterCache = null;
    // Beim Öffnen ist das Menü noch `display:none` → keine messbare Höhe.
    // Mit dem Deckel als Schätzung vorpositionieren, damit kein Frame an alter
    // Stelle sichtbar wird, und im nächsten Tick auf die echte Höhe nachziehen.
    const rect = block.getBoundingClientRect();
    const band = visibleBand();
    this.slashMaxH = SLASH_MAX_H;
    this.slashX = rect.left;
    this.slashY = Math.max(band.top + SLASH_GAP, rect.top - SLASH_MAX_H - SLASH_GAP);
    this.slashShow = true;
    this._schedSlashPosition();
  },

  // Bild-Upload: Datei-Dialog → Upload → <figure>-Insert. Der Trigger-Block
  // wird vor dem async Upload gesichert; ist er beim Zurueckkommen weg (User hat
  // weitergetippt), haengen wir das Bild ans Editor-Ende. Hat der User waehrend
  // des Uploads die Seite gewechselt oder den Edit-Modus verlassen, wird nichts
  // eingefuegt — das Bild gehoert zur Seite, fuer die es hochgeladen wurde.
  async _slashInsertImage(block) {
    const app = window.__app;
    const pageId = app?.currentPage?.id;
    if (!pageId) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.hidden = true;
    document.body.appendChild(input);
    // Abgebrochener Datei-Dialog feuert kein `change`, nur `cancel` — ältere
    // Safari nicht einmal das. Fallback: kehrt der Fokus ins Fenster zurück und
    // liegt nach kurzer Frist keine Datei vor, das Feld ebenfalls abräumen
    // (sonst bliebe je abgebrochenem Dialog ein verstecktes <input> im <body>).
    input.addEventListener('cancel', () => input.remove(), { once: true });
    window.addEventListener('focus', () => {
      setTimeout(() => { if (!input.files?.length) input.remove(); }, 1000);
    }, { once: true });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      let result;
      try {
        result = await contentRepo.uploadPageImage(pageId, file);
      } catch {
        app?._showJobToast?.({
          message: app?.t?.('editor.image.uploadError'),
          severity: 'err', jobType: 'image', bookId: null,
        });
        return;
      }
      if (!app.editMode || app.currentPage?.id !== pageId) return;
      this._insertImageFigure(block, result);
    }, { once: true });
    input.click();
  },

  // Markup kommt aus der SSoT (figure/figure-html.js), nicht von Hand: Ersatztext
  // und Bildnachweis haben dort ihre Traeger, und der Bild-Dialog liest dieselbe
  // Form wieder aus. Frisch eingefuegt sind beide leer — der Caret landet in der
  // Legende, das ist der erste Handgriff.
  _insertImageFigure(block, result) {
    const editEl = getEditEl();
    if (!editEl || !result?.url) return;
    const fig = htmlToElement(buildFigureHtml({ src: result.url }));
    if (!fig) return;
    if (block && block.isConnected && block.parentNode && editEl.contains(block)) {
      replaceBlockOutsideList(editEl, block, fig);
    } else {
      editEl.appendChild(fig);
    }
    ensureSlotAfter(fig);
    const cap = fig.querySelector(FIGURE_CAPTION_SEL);
    if (cap) placeCaretIn(cap);
    window.__app?._markEditDirty?.();
  },

  // `literal`: im Umwandeln-Modus war der Schrägstrich vielleicht Text («/usr»,
  // «1/2»): Esc, Caret-Bewegung oder ein Filter ohne Treffer setzen dann
  // «/» + Getipptes an den Caret. Im leeren Block bleibt Schliessen Schliessen.
  _closeSlash({ literal = false } = {}) {
    const text = literal && this._slashConvert ? '/' + (this.slashQuery || '') : '';
    this.slashShow = false;
    this.slashQuery = '';
    this._slashBlock = null;
    this._slashConvert = false;
    this._slashLabels = null;
    this._slashFilterCache = null;
    getEditEl()?.focus();
    if (text) {
      document.execCommand('insertText', false, text);
      window.__app?._markEditDirty?.();
    }
  },

  _applySlashByKey(key) {
    const item = SLASH_ITEMS.find(i => i.key === key);
    if (item) this._applySlashItem(item);
  },

  _applySlashItem(item) {
    const editEl = getEditEl();
    const block = this._slashBlock;
    if (!editEl || !block || !block.parentNode) { this._closeSlash(); return; }
    // Jede Wahl ist ein eigener Undo-Schritt (Vorher-Stand einfrieren).
    window.__app?._historyPushNow?.();

    if (this._slashConvert) {
      this._convertSlashBlock(editEl, block, item);
      window.__app?._markEditDirty?.();
      this._closeSlash();
      return;
    }

    // Querverweis: Picker am Caret (im leeren Trigger-Block). Erst schliessen —
    // das gibt den Fokus an den Editor zurück, an dessen Caret der Picker
    // einfügt.
    if (item.xref) {
      this._closeSlash();
      this.openXrefInput?.();
      return;
    }

    // Bild: oeffnet den Datei-Dialog. Async → Block vor dem Schliessen sichern,
    // Menue sofort schliessen (der Dialog uebernimmt).
    if (item.upload === 'image') {
      this._slashInsertImage(block);
      this._closeSlash();
      return;
    }

    // Diagramm: oeffnet den Quelltext-Dialog. Wie beim Bild uebernimmt der
    // Dialog — der leere Trigger-Block wird erst beim Bestaetigen ersetzt.
    if (item.diagram) {
      this.openDiagramDialog(block);
      this._closeSlash();
      return;
    }

    // Abschnitt teilen: Schnitt vor dem (leeren) Trigger-Block, der dabei
    // wegfaellt. Den Ablauf (Namensdialog, Speichern, Route) traegt die
    // Notebook-Karte; sie haelt den Block fest, bevor der Dialog aufgeht.
    if (item.split) {
      window.__app?.splitSectionHere?.({ block });
      this._closeSlash();
      return;
    }

    // Tabelle: oeffnet den Gitter-Dialog, gleiche Uebergabe wie beim Diagramm.
    if (item.table) {
      this.openTableDialog(block);
      this._closeSlash();
      return;
    }

    // Datums-/Zeit-Stempel: ersetzt den (per Trigger leeren) Block durch
    // einen <p> mit dem formatierten Stempel-String. Caret hinter den Text,
    // damit der User direkt weiterschreiben kann.
    if (item.insertText) {
      const stamp = _formatStamp(item.insertText);
      const p = document.createElement('p');
      p.textContent = stamp;
      replaceBlockOutsideList(editEl, block, p);
      const sel = document.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(p);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      window.__app?._markEditDirty?.();
      this._closeSlash();
      return;
    }

    let replacement;
    let caretTarget;

    if (item.tag === 'hr') {
      replacement = document.createElement('hr');
      if (item.className) replacement.className = item.className;
      replaceBlockOutsideList(editEl, block, replacement);
      const next = document.createElement('p');
      next.appendChild(document.createElement('br'));
      replacement.insertAdjacentElement('afterend', next);
      caretTarget = next;
    } else if (item.todoList) {
      // Struktur kommt aus der Markup-SSoT editor/shared/todo-html.js.
      const todo = createTodoList();
      replacement = todo.list;
      replaceBlockOutsideList(editEl, block, replacement);
      caretTarget = todo.text;
    } else if (item.list) {
      replacement = document.createElement(item.tag);
      const li = document.createElement('li');
      li.appendChild(document.createElement('br'));
      replacement.appendChild(li);
      replaceBlockOutsideList(editEl, block, replacement);
      caretTarget = li;
    } else if (item.wrapP) {
      // blockquote / .poem / .msg-thread → enthält ein <p> als Schreibfläche.
      replacement = document.createElement(item.tag);
      if (item.className) replacement.className = item.className;
      const p = document.createElement('p');
      if (item.innerClass) p.className = item.innerClass;
      p.innerHTML = '<br>';
      replacement.appendChild(p);
      replaceBlockOutsideList(editEl, block, replacement);
      caretTarget = p;
    } else {
      // Einfacher Tag-Swap (p, h2, h3).
      replacement = document.createElement(item.tag);
      replacement.innerHTML = '<br>';
      replaceBlockOutsideList(editEl, block, replacement);
      caretTarget = replacement;
    }

    placeCaretIn(caretTarget);
    window.__app?._markEditDirty?.();
    this._closeSlash();
  },
  // Umwandeln-Modus: `block` (mit Text) wird zum gewählten Blocktyp, sein
  // Inline-Inhalt wandert mit, der Caret steht danach am Anfang. Quelle des
  // Inhalts ist in der Checkbox-Zeile das `.todo-text` (die Checkbox ist
  // Struktur), in einer Listenzeile der Text ohne Unterlisten (die rücken an
  // ihre Stelle). Eingesetzt wird wie beim leeren Block — in einer Liste über
  // `replaceBlockOutsideList` (Invariante 19), in Zitat/Gedicht/Verlauf als
  // eigener Block, der den Wrapper an dieser Zeile teilt. Markup der
  // Checkbox-Liste und des Verlaufs nur aus ihren SSoT-Modulen.
  _convertSlashBlock(editEl, block, item) {
    // Schon von dieser Art (Zeile im Zitat → Zitat, Listenzeile → Liste): nichts
    // umbauen, sonst entstünden zwei gleiche Blöcke direkt nacheinander.
    const parent0 = block.parentNode;
    const isTodo = block.matches?.(TODO_ITEM_SEL);
    if (item.todoList ? isTodo
      : item.list ? (!isTodo && parent0?.tagName === item.tag.toUpperCase())
      : item.wrapP ? (parent0?.tagName === item.tag.toUpperCase()
          && (!item.className || parent0.classList.contains(item.className)))
      : (parent0 === editEl && block.tagName === item.tag.toUpperCase())) {
      placeCaretIn(block.matches?.(TODO_ITEM_SEL) ? (block.querySelector(TODO_TEXT_SEL) || block) : block);
      return;
    }
    if (block.tagName === 'LI') promoteSubLists(block);
    const source = block.matches?.(TODO_ITEM_SEL) ? (block.querySelector(TODO_TEXT_SEL) || block) : block;
    const frag = document.createDocumentFragment();
    while (source.firstChild) frag.appendChild(source.firstChild);
    let replacement;
    let target;
    if (item.todoList) {
      const todo = createTodoList();
      replacement = todo.list;
      target = todo.text;
    } else if (item.list) {
      replacement = document.createElement(item.tag);
      target = document.createElement('li');
      replacement.appendChild(target);
    } else if (item.wrapP) {
      replacement = document.createElement(item.tag);
      if (item.className) replacement.className = item.className;
      target = document.createElement('p');
      if (item.innerClass) target.className = item.innerClass;
      replacement.appendChild(target);
    } else {
      replacement = document.createElement(item.tag);
      target = replacement;
    }
    target.replaceChildren(frag);
    if (!target.childNodes.length) target.appendChild(document.createElement('br'));
    const parent = block.parentNode;
    if (parent === editEl || isListEl(parent) || block.tagName === 'LI') {
      replaceBlockOutsideList(editEl, block, replacement);
    } else {
      // Zeile in Zitat/Gedicht/Verlauf: der neue Block tritt an ihre Stelle
      // HINTER den Wrapper-Teil davor; was nach ihr kam, bleibt als eigener
      // Wrapper dahinter. Eine eigene Hülle statt `cloneNode`, damit keine
      // Block-ID doppelt im Dokument steht.
      const rest = [];
      for (let n = block.nextElementSibling; n; n = n.nextElementSibling) rest.push(n);
      block.remove();
      parent.parentNode.insertBefore(replacement, parent.nextSibling);
      if (rest.length) {
        const tail = document.createElement(parent.localName);
        if (parent.className) tail.className = parent.className;
        rest.forEach((n) => tail.appendChild(n));
        replacement.insertAdjacentElement('afterend', tail);
      }
      if (!parent.children.length) parent.remove();
    }
    placeCaretIn(target);
  },
};
