// Undo/Redo-Kern für contenteditable-Editoren — Snapshot-Stack aus dem rohen
// HTML der Top-Level-Blöcke plus Caret-Text-Offset, entprellt zu satzweisen
// Schritten. Restore tauscht nur die geänderten Blöcke (siehe «Blockweise
// Momentaufnahmen»).
//
// Framework-frei und ohne Import: keine Alpine-Bindung, kein Host-Zugriff, kein
// DOM-Modul. Konsumenten sind der Notebook-Editor (editor/notebook/history.js,
// Alpine-Karte, inkl. SPA-Fokusmodus), der Fokusmodus in einer fremden Schale
// (editor/focus/standalone.js, WKWebView ohne Alpine) und der Bucheditor
// (cards/book-editor/history.js, eine Instanz pro Seite). Jeder bekommt eigene
// Instanzen, alle teilen diese eine Implementierung.
//
// WARUM ÜBERHAUPT EIN EIGENER STACK (zwei unabhängige Gründe):
//   1. Der browsereigene Stack kollabiert, sobald ein Editor-Modul `innerHTML`
//      oder `replaceChild` aufruft (Slash-Menü, HR-Insert, Paste-Cleaner).
//   2. WebKit (Safari/iOS/WKWebView) hält seinen TypingCommand offen, bis ein
//      echter Mausklick kommt — gemessen am 2026-08-22 gegen WebKit 26.x mit
//      echten NSEvent-Anschlägen: 66 in einem Rutsch getippte Zeichen fielen
//      einem einzigen Cmd+Z zum Opfer, danach `canUndo === false`. Wirkungslos
//      als Trennung waren Pfeiltasten, Enter, Backspace, Auto-Save,
//      blur()/focus(), Fenster-Deaktivierung, ein JS-Selektions-Reset,
//      execCommand('bold'), insertText('') und die AppKit-Kommandos
//      moveLeft:/moveRight:/moveWordLeft:. Nur ein echter `leftMouseDown`
//      trennte. Wer also eine Weile durchschreibt, ohne in den Text zu klicken,
//      verliert mit einem versehentlichen Cmd+Z alles davon — und der Auto-Save
//      persistiert die Löschung anschliessend still. Chromium ist von dieser
//      Körnung nicht in dieser Härte betroffen, weshalb Chromium-Tests die
//      Fehlerklasse strukturell nicht sehen (wie bei focus-selection.webkit).
//
// Vertrag mit dem Aufrufer:
//   getRoot()            → das contenteditable (oder null, wenn gerade keins da ist)
//   mountHtml(el, html)  → HTML einhängen — in den Editor (Rückfall: komplett)
//                          ODER in einen losgelösten <div> mit den
//                          auszutauschenden Blöcken (Normalfall). Die Pipeline
//                          darf sich also nicht auf «el ist der Editor»
//                          verlassen. Bewusst injiziert, nicht importiert:
//                          der Notebook-Editor braucht die volle Mount-Pipeline
//                          (Block-Normalisierung, Caret-Slot, atomare Chips),
//                          die Standalone-Schale genau ihren eigenen Mount
//                          (`innerHTML` + collapseSoftNewlines). Ein Import der
//                          Notebook-Pipeline zöge cite-/xref-/mermaid-/table-html
//                          in die Import-Closure und damit ins OTA-Bundle des
//                          nativen Clients.
//   onRestored(el, snap) → optional, nach Mount + Caret + Fokus. Hier setzt der
//                          Aufrufer sein Dirty-Flag und plant Draft/Autosave.
//   onChange()           → optional, nach jeder Änderung an canUndo/canRedo
//                          (Push, Debounce-Start, Undo, Redo, Reset, Clear,
//                          Rebase).
//                          Der Stack lebt in einer Closure und ist für ein
//                          reaktives Framework unsichtbar — ohne diesen Hook
//                          blieben gebundene Undo-/Redo-Buttons stehen.
//
// XSS: Snapshots stammen ausschliesslich aus `getRoot().innerHTML` — Inhalt, der
// zuvor durch die Paste-Cleaner-Kette gelaufen ist. Kein externer String landet
// hier.

const DEFAULT_DEBOUNCE_MS = 500;
// Höchstdauer einer Tipp-Strecke als EIN Schritt. Der Debounce allein trennt
// nur an Pausen: wer ohne 500-ms-Lücke durchschreibt, bekäme sonst einen
// Riesenschritt — dieselbe Fehlerklasse wie der WebKit-Stack (Modulkopf), nur
// abgeschwächt. Etwa ein Satz.
const DEFAULT_MAX_WAIT_MS = 3000;
const DEFAULT_MAX = 100;

// Gleicher Inhalt bis auf Block-IDs. Die IDs setzen Save und Merge-Vorbereitung
// als reine Attribute ins Live-DOM (shared/block-ids.js) — ohne `input`, also
// ohne Push. Ein danach eingefrorener Vorher-Stand (Paste, Cut, Ersetzen)
// unterschiede sich von der Spitze nur darin und würde ein eigener Schritt,
// dessen Undo nichts Sichtbares tut.
const BID_ATTR_RE = /\sdata-bid="[^"]*"/g;
const sameContent = (a, b) => a === b || a.replace(BID_ATTR_RE, '') === b.replace(BID_ATTR_RE, '');

// Caret-Position als reiner Text-Offset ab Editor-Anfang. Robust genug über
// strukturelle Mutationen (Slash-Menü, HR-Insert, Block-Wrap im Mount): Wrapping
// verändert keine Textinhalte, `<br>`/`<p>` sind kein Text.
export function captureCaretOffset(root) {
  if (!root) return null;
  const sel = root.ownerDocument?.defaultView?.getSelection?.()
    ?? (typeof document !== 'undefined' ? document.getSelection?.() : null);
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

// Gemeinsamer Anfang und gemeinsames Ende zweier Folgen (Strings oder Arrays),
// ohne Überlappung: `pre + suf <= min(a.length, b.length)`. `same(i, j)`
// vergleicht a[i] mit b[j]. Basis für die Caret-Rechnung (Zeichen) und für den
// Block-Abgleich des Restores (Top-Level-Blöcke).
export function commonAffix(a, b, same) {
  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && same(pre, pre)) pre++;
  let suf = 0;
  while (suf < max - pre && same(a.length - 1 - suf, b.length - 1 - suf)) suf++;
  return { pre, suf };
}

const textAffix = (a, b) => commonAffix(a, b, (i, j) => a.charCodeAt(i) === b.charCodeAt(j));

// Text-Offset durch eine Umschreibung tragen (Rebase nach Remote-Merge): im
// gemeinsamen Anfang bleibt er, im gemeinsamen Ende verschiebt er sich um die
// Längendifferenz, mitten im geänderten Bereich landet er an dessen Ende.
// Sonst zeigte ein später gemerkter Offset nach eingefügten Remote-Absätzen
// oberhalb in den falschen Absatz.
export function mapCaretOffset(oldText, newText, offset) {
  if (offset == null || oldText === newText) return offset;
  const { pre, suf } = textAffix(oldText, newText);
  if (offset <= pre) return offset;
  if (offset >= oldText.length - suf) return offset + (newText.length - oldText.length);
  return newText.length - suf;
}

// Caret nach einem Restore: ans Ende des geänderten Bereichs im NEUEN Text —
// bei einem Undo einer Eingabe also an die Einfügestelle, bei einem Redo hinter
// das wiederhergestellte Stück. Der im Snapshot gemerkte Offset ist die
// Position beim Aufnehmen des Ziel-Stands und taugt dafür nicht (die Baseline
// hat 0 → jedes erste Undo sprang an den Seitenanfang). Nur bei unverändertem
// Text (reine Formatierung) zählt der gemerkte Offset.
export function changedCaretOffset(oldText, newText, fallback) {
  if (oldText === newText) return fallback;
  return newText.length - textAffix(oldText, newText).suf;
}

export function restoreCaretAtOffset(root, offset) {
  if (!root || offset == null) return;
  const doc = root.ownerDocument;
  if (!doc?.createTreeWalker || !doc?.createRange) return;
  try {
    const filterText = (typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4);
    const walker = doc.createTreeWalker(root, filterText);
    let remaining = offset;
    let target = null;
    let targetOffset = 0;
    let n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (remaining <= len) {
        target = n;
        targetOffset = remaining;
        break;
      }
      remaining -= len;
    }
    const range = doc.createRange();
    if (typeof range.setStart !== 'function') return;
    if (target) {
      range.setStart(target, targetOffset);
    } else {
      range.selectNodeContents(root);
      range.collapse(false);
    }
    range.collapse(true);
    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    const sel = win?.getSelection?.()
      ?? (typeof document !== 'undefined' ? document.getSelection?.() : null);
    if (sel?.removeAllRanges && sel?.addRange) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch {
    // Caret-Restore ist Best-Effort — bei Edge-Cases (Tree-Walker-Limits,
    // disconnected Nodes) lieber kein Caret als crash.
  }
}

// `input`-Event nach einem Restore. `inputType` ist HARTER VERTRAG, nicht Kosmetik:
// die Boot-Glue des nativen macOS-Clients erkennt genau 'historyUndo'/'historyRedo',
// um den Umfang-Hinweis zu zeigen, und braucht das Event ausserdem für Dirty-Flag,
// Auto-Save, Live-Statistik und die Rechtschreib-Neuprüfung. Der `Event`-Rückfall
// deckt Umgebungen ohne `InputEvent` ab (linkedom in den Unit-Tests).
function dispatchHistoryInput(el, inputType) {
  const win = el.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
  const InputEventCtor = win?.InputEvent || (typeof InputEvent !== 'undefined' ? InputEvent : null);
  const EventCtor = win?.Event || (typeof Event !== 'undefined' ? Event : null);
  try {
    if (InputEventCtor) {
      el.dispatchEvent(new InputEventCtor('input', { bubbles: true, inputType }));
      return;
    }
  } catch { /* fällt unten auf Event zurück */ }
  try {
    if (EventCtor) el.dispatchEvent(new EventCtor('input', { bubbles: true }));
  } catch { /* last-resort swallow */ }
}

// ── Blockweise Momentaufnahmen ────────────────────────────────────────────
// Ein Snapshot hält das HTML als Liste seiner Top-Level-Kinder (`blocks`, je
// `outerHTML`; reiner Leerraum zwischen Blöcken als eigener Eintrag). `html`
// ist daraus abgeleitet. Zwei Gewinne:
//   - Restore ersetzt nur die Blöcke, in denen sich Ausgangs- und Zielstand
//     unterscheiden (restorePartial). Ein Undo ändert fast immer ein, zwei
//     Absätze — ein komplettes Neu-Einhängen kostete auf einem 34K-Abschnitt
//     Parse + Stil + Layout des ganzen Texts und riss alle Highlight-Ranges ab.
//   - Unveränderte Blöcke teilen sich über alle Snapshots denselben String
//     (shareBlocks), der Stack wächst je Schritt um die geänderten Blöcke statt
//     um den ganzen Abschnitt (Bucheditor: eine Historie pro Seite).
// Nicht blockweise darstellbar (Text-/Inline-Runs, Kommentare direkt unter der
// Wurzel) → `blocks: null`, der Snapshot trägt `html`, Restore hängt komplett
// neu ein wie zuvor.
const WS_ONLY_RE = /^[ \t\n\r]*$/;

function serializeBlocks(parent) {
  const kids = parent.childNodes;
  const out = new Array(kids.length);
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType === 1) out[i] = n.outerHTML;
    else if (n.nodeType === 3 && WS_ONLY_RE.test(n.nodeValue)) out[i] = n.nodeValue;
    else return null;
  }
  return out;
}

// Gleiche Blöcke am Anfang/Ende auf die Strings des Vorgängers umbiegen — der
// neue, inhaltsgleiche String wird damit frei.
function shareBlocks(prev, next) {
  if (!prev || !next) return next;
  const { pre, suf } = commonAffix(prev, next, (i, j) => prev[i] === next[j]);
  for (let i = 0; i < pre; i++) next[i] = prev[i];
  for (let k = 1; k <= suf; k++) next[next.length - k] = prev[prev.length - k];
  return next;
}

function makeSnap(blocks, html, caretOffset) {
  if (!blocks) return { blocks: null, html: html ?? '', caretOffset };
  return { blocks, caretOffset, get html() { return this.blocks.join(''); } };
}

// Blöcke eines nur als HTML vorliegenden Snapshots (Baseline, Rebase) — einmal
// inert geparst und am Snapshot gemerkt.
function blocksOf(snap, doc) {
  if (snap.blocks) return snap.blocks;
  if (snap._parsed !== undefined) return snap._parsed;
  let blocks = null;
  try {
    const t = doc.createElement('template');
    t.innerHTML = snap.html || '';
    blocks = t.content ? serializeBlocks(t.content) : null;
  } catch { blocks = null; }
  snap._parsed = blocks;
  return blocks;
}

function sameSnapContent(a, b) {
  if (a.blocks && b.blocks) {
    if (a.blocks.length !== b.blocks.length) return false;
    for (let i = 0; i < a.blocks.length; i++) if (!sameContent(a.blocks[i], b.blocks[i])) return false;
    return true;
  }
  return sameContent(a.html, b.html);
}

const textOfNodes = (nodes) => {
  let t = '';
  for (const n of nodes) t += n.textContent || '';
  return t;
};

// Caret in eine Knotenfolge setzen: Text-Offset innerhalb dieser Knoten. Ohne
// Textknoten (leerer Absatz `<p><br></p>`) an den Anfang des ersten Knotens —
// genau das konnte der Offset ab Editor-Anfang nicht: er traf an einer
// Absatzgrenze immer das Ende des vorigen Absatzes.
function placeCaretInNodes(doc, nodes, offset) {
  if (!nodes.length || !doc?.createRange) return;
  try {
    const range = doc.createRange();
    if (typeof range.setStart !== 'function') return;
    const showText = (typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4);
    let remaining = Math.max(0, offset);
    let placed = false;
    outer: for (const node of nodes) {
      if (node.nodeType === 3) {
        if (remaining <= node.nodeValue.length) { range.setStart(node, remaining); placed = true; break; }
        remaining -= node.nodeValue.length;
        continue;
      }
      const walker = doc.createTreeWalker(node, showText);
      let t;
      while ((t = walker.nextNode())) {
        if (remaining <= t.nodeValue.length) { range.setStart(t, remaining); placed = true; break outer; }
        remaining -= t.nodeValue.length;
      }
    }
    if (!placed) {
      const hasText = nodes.some(n => (n.textContent || '').length > 0);
      if (hasText) { range.selectNodeContents(nodes[nodes.length - 1]); range.collapse(false); }
      else if (nodes[0].nodeType === 1) range.setStart(nodes[0], 0);
      else range.setStart(nodes[0], 0);
    }
    range.collapse(true);
    const sel = doc.defaultView?.getSelection?.()
      ?? (typeof document !== 'undefined' ? document.getSelection?.() : null);
    if (sel?.removeAllRanges && sel?.addRange) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch { /* Best-Effort wie restoreCaretAtOffset */ }
}

export function createEditHistory({
  getRoot,
  mountHtml,
  onRestored = null,
  onChange = null,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  max = DEFAULT_MAX,
} = {}) {
  if (typeof getRoot !== 'function') throw new Error('createEditHistory: getRoot erforderlich');
  if (typeof mountHtml !== 'function') throw new Error('createEditHistory: mountHtml erforderlich');

  let stack = [];
  let idx = -1;
  let timer = null;
  // Beginn der laufenden Tipp-Strecke (erster pushSoon nach Leerlauf).
  let burstStart = 0;
  // Während eines Restores: kein Push. Das Restore mutiert das DOM und feuert
  // selbst ein `input` — ohne dieses Flag würde der Restore-Stand als neuer
  // Stack-Eintrag landen und Redo wäre nach einem Undo sofort tot.
  let applying = false;

  const cancelTimer = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  const notify = () => {
    if (typeof onChange === 'function') {
      try { onChange(); } catch { /* Aufrufer-Glue darf den Stack nicht kippen */ }
    }
  };

  function pushNow() {
    if (applying) return;
    cancelTimer();
    const el = getRoot();
    if (!el) return;
    const top = stack[idx];
    const blocks = shareBlocks(top?.blocks, serializeBlocks(el));
    const snap = makeSnap(blocks, blocks ? null : el.innerHTML, null);
    // Dedupe gegen die Spitze; reine ID-Änderungen frischen sie nur auf, damit
    // ein Restore dorthin die IDs nicht wieder abzieht.
    if (top && sameSnapContent(top, snap)) {
      snap.caretOffset = top.caretOffset;
      stack[idx] = snap;
      return;
    }
    if (idx < stack.length - 1) stack.length = idx + 1;   // Redo-Ast abschneiden
    snap.caretOffset = captureCaretOffset(el);
    stack.push(snap);
    if (stack.length > max) stack.splice(0, stack.length - max);
    idx = stack.length - 1;
    notify();
  }

  // Nur die Blöcke austauschen, in denen sich `from` (= Live-DOM) und `snap`
  // unterscheiden. Die neuen Blöcke laufen in einem losgelösten Container durch
  // dieselbe `mountHtml`-Pipeline; erst wenn das glatt ging, wird das Live-DOM
  // angefasst. null = nicht anwendbar → Aufrufer hängt komplett neu ein.
  function restorePartial(el, from, snap) {
    const doc = el.ownerDocument;
    if (!from || !doc) return null;
    const a = blocksOf(from, doc);
    const b = blocksOf(snap, doc);
    if (!a || !b) return null;
    const kids = el.childNodes;
    // Live-DOM muss dem Ausgangsstand entsprechen, sonst trifft der Index nicht.
    if (kids.length !== a.length) return null;
    const { pre, suf } = commonAffix(a, b, (i, j) => sameContent(a[i], b[j]));
    const insert = b.slice(pre, b.length - suf);
    // Trennlinie als letzter Block: die Pipeline hängt dahinter einen
    // Schreib-Absatz an (Caret-Slot) — das kann nur das komplette Einhängen.
    if (suf === 0 && /^<hr[\s>]/i.test(b[b.length - 1] || '')) return null;
    let nodes = [];
    if (insert.length) {
      const scratch = doc.createElement('div');
      mountHtml(scratch, insert.join(''));
      // Die Pipeline hat Blöcke ergänzt oder verschmolzen → nicht 1:1 tauschbar.
      if (scratch.childNodes.length !== insert.length) return null;
      nodes = Array.from(scratch.childNodes);
    }
    const removed = Array.prototype.slice.call(kids, pre, a.length - suf);
    const after = kids[a.length - suf] ?? null;
    const before = pre > 0 ? kids[pre - 1] : null;
    const oldText = textOfNodes(removed);
    for (const n of removed) n.remove();
    for (const n of nodes) el.insertBefore(n, after);
    return { nodes, oldText, after, before };
  }

  function restore(from, snap, inputType) {
    const el = getRoot();
    if (!el || !snap) return;
    applying = true;
    try {
      let part = null;
      try { part = restorePartial(el, from, snap); } catch { part = null; }
      if (part) {
        const doc = el.ownerDocument;
        const newText = textOfNodes(part.nodes);
        if (!part.nodes.length) {
          // Nur Blöcke entfernt: Caret an den Anfang des Nachfolgers bzw. ans
          // Ende des Vorgängers — dorthin, wo die Blöcke standen.
          if (part.after) placeCaretInNodes(doc, [part.after], 0);
          else if (part.before) placeCaretInNodes(doc, [part.before], Infinity);
        } else if (part.oldText === newText) {
          restoreCaretAtOffset(el, snap.caretOffset);
        } else {
          // Ans Ende des geänderten Bereichs — innerhalb der getauschten Blöcke,
          // damit eine Absatzgrenze nicht in den Vorgänger kippt.
          placeCaretInNodes(doc, part.nodes,
            newText.length - textAffix(part.oldText, newText).suf);
        }
      } else {
        const oldText = el.textContent || '';
        mountHtml(el, snap.html || '');
        restoreCaretAtOffset(el, changedCaretOffset(oldText, el.textContent || '', snap.caretOffset));
      }
      el.focus?.();
      if (typeof onRestored === 'function') {
        try { onRestored(el, snap); } catch { /* Aufrufer-Glue darf das Restore nicht kippen */ }
      }
      dispatchHistoryInput(el, inputType);
    } finally {
      applying = false;
    }
  }

  return {
    // Baseline setzen — Session-Start bzw. Seitenwechsel. Historie ist pro Seite.
    reset(html) {
      cancelTimer();
      stack = [makeSnap(null, html ?? '', 0)];
      idx = 0;
      applying = false;
      notify();
    },

    // Historie komplett verwerfen (Session-Ende / Unmount). NICHT beim Speichern
    // aufrufen: im Fokusmodus wird ununterbrochen weitergeschrieben und alle
    // 1,5 s automatisch gespeichert — ein Clear am Save nähme dem User genau
    // die Schritte weg, die er zurückholen will.
    clear() {
      cancelTimer();
      stack = [];
      idx = -1;
      applying = false;
      notify();
    },

    // Entprellt: eine Tipp-Serie wird zu EINEM Schritt — höchstens `maxWaitMs`
    // lang, dann wird sie eingelöst und die nächste Strecke beginnt.
    pushSoon() {
      if (applying) return;
      if (timer && Date.now() - burstStart >= maxWaitMs) pushNow();
      const wasIdle = !timer;
      if (wasIdle) burstStart = Date.now();
      cancelTimer();
      timer = setTimeout(() => { timer = null; pushNow(); }, debounceMs);
      // Offene Tipp-Strecke macht Undo schon jetzt möglich (siehe canUndo).
      if (wasIdle) notify();
    },

    pushNow,

    // Offener Debounce zählt: undo() löst ihn zuerst ein, es gibt also einen
    // Schritt — sonst wäre der Button die ersten 500 ms nach dem Tippen grau.
    canUndo() { return idx > 0 || (idx >= 0 && timer !== null); },
    // Offener Debounce schneidet den Redo-Ast beim Einlösen ab (siehe redo).
    canRedo() { return timer === null && idx >= 0 && idx < stack.length - 1; },

    undo() {
      if (applying) return false;
      // Offenen Debounce zuerst einlösen, sonst ginge die gerade getippte
      // Strecke verloren statt rückgängig gemacht zu werden.
      if (timer) { cancelTimer(); pushNow(); }
      // Ohne Container kein Restore — den Index dann auch nicht bewegen, sonst
      // zeigt er auf einen Stand, der nie eingehängt wurde.
      if (idx <= 0 || !getRoot()) return false;
      const from = stack[idx];
      idx--;
      restore(from, stack[idx], 'historyUndo');
      notify();
      return true;
    },

    redo() {
      if (applying) return false;
      // Offenen Debounce zuerst einlösen: die frische Eingabe schneidet den
      // Redo-Ast ab. Ohne das mountete Redo den alten Stand über die gerade
      // getippte Strecke, und die wäre nicht mehr herstellbar.
      if (timer) { cancelTimer(); pushNow(); }
      if (idx < 0 || idx >= stack.length - 1 || !getRoot()) return false;
      const from = stack[idx];
      idx++;
      restore(from, stack[idx], 'historyRedo');
      notify();
      return true;
    },

    // Der Inhalt wurde von aussen umgeschrieben (kollisionsfreier Remote-Merge):
    // Verlauf anpassen statt verwerfen. Vertrag: der Aufrufer hat UNMITTELBAR
    // VOR der Umschreibung `pushNow()` gerufen — die Spitze ist damit der
    // Vorher-Stand und wird durch den jetzigen Inhalt ersetzt. Jeder ältere
    // Stand läuft durch `mapHtml(html)` (string = übertragener Stand, sonst
    // nicht übertragbar). Ab dem ersten nicht übertragbaren Stand fällt er samt
    // allen älteren weg: ein Undo darf nie über eine Lücke springen. Der
    // Redo-Ast fällt immer weg — er setzte auf dem Vorher-Stand auf.
    rebase(mapHtml) {
      if (applying) return;
      cancelTimer();
      const el = getRoot();
      if (!el) return;
      const kept = [];
      const scratch = el.ownerDocument.createElement('div');
      const textOf = (h) => { scratch.innerHTML = h; return scratch.textContent || ''; };
      for (let i = idx - 1; i >= 0; i--) {
        let html = null;
        try { html = mapHtml(stack[i].html); } catch { html = null; }
        if (typeof html !== 'string') break;
        // Gemerkter Caret mitwandern: Remote-Blöcke verschieben die Offsets.
        const caretOffset = stack[i].caretOffset == null ? stack[i].caretOffset
          : mapCaretOffset(textOf(stack[i].html), textOf(html), stack[i].caretOffset);
        kept.unshift(makeSnap(null, html, caretOffset));
      }
      const liveBlocks = serializeBlocks(el);
      kept.push(makeSnap(liveBlocks, liveBlocks ? null : el.innerHTML, captureCaretOffset(el)));
      stack = [];
      for (const e of kept) {
        const top = stack[stack.length - 1];
        if (top && sameContent(top.html, e.html)) stack[stack.length - 1] = e;
        else stack.push(e);
      }
      idx = stack.length - 1;
      notify();
    },

    // Nur für Tests/Diagnose — kein Konsument steuert damit Verhalten.
    size() { return stack.length; },
    index() { return idx; },
    isApplying() { return applying; },
  };
}
