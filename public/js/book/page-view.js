// Seitenansicht-Methoden: Formatierte HTML-Ansicht mit Inline-Fehlermarkierung
// und Figurenkontext-Panel. `this` bezieht sich auf die Alpine-Komponente.

import { escHtml, fetchJson, findInHtml, decorateMentions } from '../utils.js';
import { handleEditorCopy } from '../editor/shared/paste.js';
import { isPageConflict, savePage } from '../editor/shared/page-api.js';
import { setTodoCheckedAt, todoBoxIndex, TODO_BOX_SEL } from '../editor/shared/todo-html.js';
import { closestCiteEl } from '../sources/cite-html.js';
import { DIAGRAM_SEL } from '../diagram/mermaid-html.js';
import { MSG_THREAD_SEL } from '../messages/msg-html.js';
import { contentRepo } from '../repo/content.js';
import { tRaw, findingErklaerungRaw } from '../i18n.js';
import { _sanitizeFigur } from './figuren.js';
import { isSelectedBook } from '../cards/book-guard.js';
import { READ_VIEW_SEL, notebookReadView } from '../editor/notebook/read-view.js';
import { placeLektoratTip, hideLektoratTip, activeLektoratMark, setActiveLektoratMark, lektoratTipContains } from './lektorat-tip.js';

// Pauschale Diagrammhöhe, solange nichts zu messen ist (mermaid rendert
// asynchron nach dem ersten Höhen-Update). Grob ein mittleres Flowchart —
// lieber etwas zu gross, `max-height` deckelt nur (siehe `_diagramsPx`).
const DIAGRAM_FALLBACK_PX = 320;

// Pauschale Bildhöhe bis zum `load` (die Abbildungs-Markup-SSoT schreibt keine
// width/height-Attribute, die Höhe ist vorher also unbekannt).
const IMAGE_FALLBACK_PX = 320;

// Drei Klassen von Findings, die Vorauswahl und Einfärbung steuern:
//   hart        — mechanische/Konsistenz-Befunde (rechtschreibung, grammatik,
//                 begriffsinkonsistenz, autorenform …): vorausgewählt, rot.
//   weich       — Stil und Handwerk (SOFT_TYPEN + 'stil'): Autorenentscheid,
//                 nicht vorausgewählt, orange. `hedging` ist weich
//                 (Absicherungs-Mass ist Autorenentscheid).
//   redaktionell — Beleg-/Zuschreibungs-/Wertungsbefunde (EDITORIAL_TYPEN): die
//                 Korrektur schreibt die AUSSAGE um (abschwächen, Zuschreibung
//                 streichen, Wertung neutralisieren), oft ist statt dessen ein
//                 Beleg die richtige Antwort. Nie vorausgewählt, eigene Farbe.
export const SOFT_TYPEN = new Set(['satzbau', 'wiederholung', 'schwaches_verb', 'fuellwort', 'filterwort', 'klischee', 'pleonasmus', 'ki_geruch', 'show_vs_tell', 'passiv', 'perspektivbruch', 'tempuswechsel', 'hedging', 'amtsdeutsch']);
export const EDITORIAL_TYPEN = new Set(['unbelegt', 'zuschreibung', 'wertung']);

/** 'hard' | 'soft' | 'editorial' */
export function findingKind(typ) {
  if (EDITORIAL_TYPEN.has(typ)) return 'editorial';
  if (typ === 'stil' || SOFT_TYPEN.has(typ)) return 'soft';
  return 'hard';
}

// Harte Typen = Default-selektiert → rote Einfärbung (Badge, Border, Inline-Mark --selected).
export function isHardFinding(typ) {
  return findingKind(typ) === 'hard';
}

const _BADGE_BY_KIND = { hard: 'badge-err', soft: 'badge-warn', editorial: 'badge-neutral' };
export function findingBadgeClass(typ) {
  return _BADGE_BY_KIND[findingKind(typ)];
}

/** Sortiert Fehler nach Position im HTML (toleranter Match via `findInHtml`,
 *  damit Originale mit Tags/Entities/Whitespace-Differenzen richtig einsortiert
 *  werden). Findings, deren `original` im HTML nicht gefunden wird (z.B. KI-
 *  Halluzination), werden rausgefiltert – sie hätten in der Seitenansicht
 *  ohnehin keine Markierung. */
export function sortByPosition(html, fehler) {
  return fehler
    .map(f => {
      if (!f.original) return null;
      const m = findInHtml(html, f.original);
      return m ? { f, pos: m.htmlStart } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.pos - b.pos)
    .map(e => e.f);
}

// Spannt der Match einen Block-Tag-Übergang (z.B. </p><p>) auf, würde ein
// einzelnes <mark> phrasing-only sein und vom Parser am ersten </p> implizit
// geschlossen — Folge: nur der erste Absatz erhält die Markierung, das <ins>
// landet weit unten am Ende des letzten Absatzes. Darum den Match an Block-
// Grenzen splitten und pro Text-Segment ein eigenes <mark> emittieren.
// Grenze = ein LAUF von Block-Tags, offen wie geschlossen: am Listenende stehen
// zwei Schliess-Tags vor dem nächsten Öffner (`</li></ul><p>`), am Rand eines
// Matches nur ein einzelnes Tag.
const _BLOCK_TAG = '<\\/?(?:p|div|li|blockquote|h[1-6]|ol|ul|table|thead|tbody|tr|td|th|pre)\\b[^>]*>';
const _BLOCK_BOUNDARY_RE = new RegExp(`((?:\\s*${_BLOCK_TAG})+\\s*)`, 'i');
function _wrapMatchedRange(matched, markOpen) {
  const parts = matched.split(_BLOCK_BOUNDARY_RE);
  if (parts.length === 1) return markOpen + matched + '</mark>';
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out += parts[i]; // Block-Grenzen unverändert
    } else if (parts[i].length > 0) {
      out += markOpen + parts[i] + '</mark>';
    }
  }
  return out;
}

/**
 * Baut eine HTML-Version mit <mark>-Tags um Fehlerstellen und optional
 * Chat-Änderungsvorschläge. Iteriert von hinten nach vorne, damit Offsets
 * stabil bleiben. Bei Überschneidung gewinnt die höhere Position; Lektorat
 * und Chat teilen sich denselben Overlap-Filter.
 */
export function buildHighlightedHtml(html, errors, selected, chatProposals = []) {
  if (!html || (!errors?.length && !chatProposals.length)) return html || '';

  const positions = [];
  for (let i = 0; i < (errors?.length || 0); i++) {
    const f = errors[i];
    if (!f.original) continue;
    const m = findInHtml(html, f.original);
    if (m) {
      positions.push({ idx: m.htmlStart, len: m.htmlEnd - m.htmlStart, kind: 'lektorat', errIdx: i });
    }
  }
  for (let i = 0; i < chatProposals.length; i++) {
    const p = chatProposals[i];
    if (!p.original) continue;
    const m = findInHtml(html, p.original);
    if (m) {
      positions.push({ idx: m.htmlStart, len: m.htmlEnd - m.htmlStart, kind: 'chat', propIdx: i });
    }
  }

  positions.sort((a, b) => b.idx - a.idx);

  const seen = new Set();
  const unique = positions.filter(p => {
    for (const s of seen) {
      if (p.idx < s.end && p.idx + p.len > s.start) return false;
    }
    seen.add({ start: p.idx, end: p.idx + p.len });
    return true;
  });

  let result = html;
  for (const p of unique) {
    const originalText = result.slice(p.idx, p.idx + p.len);
    let markOpen, ins;
    if (p.kind === 'lektorat') {
      const f = errors[p.errIdx];
      const isSel = selected[p.errIdx];
      const sel = isSel ? ' lektorat-mark--selected' : '';
      markOpen = `<mark class="lektorat-mark${sel}" data-error-idx="${p.errIdx}">`;
      ins = isSel && f.korrektur ? `<ins class="lektorat-ins">${escHtml(f.korrektur)}</ins>` : '';
    } else {
      const prop = chatProposals[p.propIdx];
      markOpen = `<mark class="chat-mark" data-chat-msg-idx="${prop.msgIdx}" data-chat-v-idx="${prop.vIdx}">`;
      ins = `<ins class="chat-mark-ins">${escHtml(prop.ersatz)}</ins>`;
    }
    result = result.slice(0, p.idx) + _wrapMatchedRange(originalText, markOpen) + ins + result.slice(p.idx + p.len);
  }

  return result;
}

// ── Singleton-Tooltip (Element + Positionierung: book/lektorat-tip.js) ──────

function showTip(mark, errors) {
  const idx = parseInt(mark.dataset.errorIdx);
  if (isNaN(idx)) return;
  const f = errors[idx];
  if (!f) return;
  const typLabel = tRaw('finding.' + f.typ);
  const badgeCls = findingBadgeClass(f.typ);
  const erkl = findingErklaerungRaw(f);
  placeLektoratTip(mark,
    `<span class="badge ${badgeCls}">${escHtml(typLabel)}</span>`
    + (erkl ? `<span class="lektorat-tip-erkl">${escHtml(erkl)}</span>` : ''));
}

// ── Split-Modus: Hover-Sync ───────────────────────────────────────────────

const splitMQ = window.matchMedia('(min-width: 1100px)');

function flashEl(el) {
  el.classList.remove('hover-sync-flash');
  void el.offsetWidth; // reflow → Animation neu starten
  el.classList.add('hover-sync-flash');
}

// ── Exportierte Methoden ───────────────────────────────────────────────────

export const pageViewMethods = {
  // State-Defaults (in app.js eingebunden)
  // renderedPageHtml: '',
  // chapterFigures: [],
  // showChapterFigures: false,

  /** Ist-Höhe der Leseansicht, wenn ihr DOM zur aktuellen Seite gehört und
   *  fertig aufgebaut ist.
   *
   *  Nur für Seiten mit Diagramm, Bild oder Nachrichtenverlauf: deren Höhe
   *  lässt sich aus dem Text nicht ableiten (zwei Zeilen Mermaid-Code können
   *  400 px Grafik sein, ein `<img>` hat gar keinen Text, ein Verlauf bricht
   *  in schmale Blasen mit Abstand je Nachricht und eigenen Namens-/Meta-Zeilen
   *  um), die Wortzahl-Schätzung kennt sie also nicht.
   *  Ohne Messung deckelt `--pcv-max-h` den Kasten auf die Prosa-Höhe und die
   *  Grafik verschwindet hinter einer inneren Scrollbar.
   *
   *  `scrollHeight` (inkl. Padding) statt einer Summe aus Einzelhöhen: das ist
   *  genau die gesuchte Grösse, misst Ränder und Zeilenumbrüche korrekt mit und
   *  hat keine Rückkopplung — `max-height` ändert die Inhaltshöhe nicht.
   *
   *  Liefert 0 (→ Aufrufer schätzt), solange nicht sicher ist, dass das DOM
   *  steht: nach einem Seitenwechsel steht bis zum nächsten Alpine-Tick die
   *  Vorgängerseite da, vor dem mermaid-Lauf fehlen die Render-Knoten, und ein
   *  Bild vor seinem `load` hat noch keine Höhe. Die Notebook-Karte ruft nach
   *  Rendern, Rückkehr aus dem Edit-Modus und Bild-`load` erneut hier durch
   *  (editor/notebook/card.js#`_setupNotebookPageHeight`).
   *
   *  Der Notebook-Editor braucht das nicht: `.page-content-view--editing`
   *  deckelt fest auf `70vh` und wächst bis dahin mit seinem Inhalt, auch beim
   *  Tippen und mit frisch eingefügten Bildern. */
  _measuredPageViewPx(diagramCount, imageCount, threadCount) {
    const view = notebookReadView();
    if (!view) return 0;
    const imgs = [...view.querySelectorAll('img')];
    if (view.querySelectorAll(DIAGRAM_SEL).length !== diagramCount) return 0;
    if (imgs.length !== imageCount) return 0;
    // Verläufe rendern synchron mit dem HTML — die Zahl stellt nur sicher,
    // dass nicht noch die Vorgängerseite im DOM steht.
    if (view.querySelectorAll(MSG_THREAD_SEL).length !== threadCount) return 0;
    // Fehlgeschlagene Diagramme zählen mit: der Fehlerknoten trägt dieselbe
    // Klasse, und der Quelltext daneben braucht ebenfalls Platz.
    if (view.querySelectorAll('.mermaid-render').length !== diagramCount) return 0;
    // `complete` ist auch bei einem kaputten Bild true — dessen Platzhalter
    // ist dann die richtige Höhe.
    if (imgs.some(img => !img.complete)) return 0;
    if (!view.scrollHeight) return 0;
    // `max-height` rechnet border-box (globales box-sizing), `scrollHeight`
    // nicht — ohne den Rahmenzuschlag bleiben 2 px Scrollrest stehen.
    return view.scrollHeight + (view.offsetHeight - view.clientHeight);
  },

  /** Berechnet max-height für die Seitenansicht basierend auf Textlänge */
  _updatePageViewHeight() {
    // Nach Edits ist tokEsts stale → aktuellen Text aus originalHtml ableiten,
    // sonst auf Cache fallback (bevor die Seite geladen ist).
    let words = 0;
    let blockPx = 0;
    let measuredPx = 0;
    if (this.originalHtml) {
      const doc = new DOMParser().parseFromString(this.originalHtml, 'text/html');
      const diagrams = [...(doc.body?.querySelectorAll(DIAGRAM_SEL) || [])];
      const imageCount = doc.body?.querySelectorAll('img').length || 0;
      const threadCount = doc.body?.querySelectorAll(MSG_THREAD_SEL).length || 0;
      // Diagramm-Notation zählt nirgends als Prosa (gleiche Regel wie
      // html-text/TTS/LanguageTool): Quelltext raus aus der Wortzahl, die
      // Blockhöhe kommt separat dazu.
      for (const d of diagrams) d.remove();
      const text = (doc.body?.textContent || '').trim();
      words = text ? text.split(/\s+/).length : 0;
      if (diagrams.length || imageCount || threadCount) {
        measuredPx = this._measuredPageViewPx(diagrams.length, imageCount, threadCount);
        // Schätzung bis zum Render: Pauschale pro Grafik, mindestens aber die
        // Quelltexthöhe (Edit-Modus, mermaid nicht geladen, ungültiger Code —
        // dort steht der `<pre>` mit ~20 px Zeilenhöhe).
        for (const d of diagrams) {
          const codeLines = (d.textContent || '').split('\n').length;
          blockPx += Math.max(DIAGRAM_FALLBACK_PX, codeLines * 20 + 40);
        }
        blockPx += imageCount * IMAGE_FALLBACK_PX;
      }
    } else {
      words = this.tokEsts?.[this.currentPage?.id]?.words || 0;
    }
    // ~7 Wörter/Zeile bei 64ch Spalte mit langen deutschen Wörtern.
    // line-height 1.7 × 17px = 28.9px; 28px top + 28px bottom Padding = 56px.
    const estLines = Math.ceil(words / 7);
    const contentPx = measuredPx || (estLines * 29 + 56 + blockPx);
    const minPx = window.innerHeight * 0.20;
    const maxPx = window.innerHeight * 0.80;
    const px = Math.round(Math.min(maxPx, Math.max(minPx, contentPx)));
    document.documentElement.style.setProperty('--pcv-max-h', px + 'px');
  },

  /** Aktualisiert die gerenderte Seitenansicht (mit oder ohne Highlights) */
  updatePageView() {
    if (!this.originalHtml) {
      this.renderedPageHtml = '';
      return;
    }
    const allErrors = this.lektoratFindings || [];
    const allSelected = this.selectedFindings || [];
    // Offene Seiten-Chat-Vorschläge (nur die letzte Assistant-Nachricht) kommen
    // über den Store — die Nachrichten selbst leben in der Sub-Karte `chatCard`,
    // nicht am Root (Auswahl: chat/page-chat-marks.js#_publishChatMarks).
    // Nur solange der Seiten-Chat offen ist.
    const chatProposals = this.showChatCard ? (this.$store.pageChat?.proposals || []) : [];
    if (allErrors.length > 0 || chatProposals.length > 0) {
      this.renderedPageHtml = decorateMentions(buildHighlightedHtml(this.originalHtml, allErrors, allSelected, chatProposals));
    } else {
      this.renderedPageHtml = decorateMentions(this.originalHtml);
    }
    this._updatePageViewHeight();
  },

  /** Lädt Figurenkontext für das aktuelle Kapitel (nur bei >1 Seite im Kapitel) */
  async loadChapterFigures() {
    // Der Endpoint verlangt editor (Figuren sind Buchwelt-CRUD, routes/figures.js);
    // Lektor/Viewer bekämen bei jedem Seitenwechsel einen 403.
    if (!this.currentPage?.chapter_id || !this.$store.nav.selectedBookId || !this.canEdit()) {
      this.chapterFigures = [];
      return;
    }
    // Bei nur einer Seite pro Kapitel liefert der Endpoint alle Buchfiguren → nicht hilfreich
    const chapter = this.$store.nav.tree?.find(c => c.id === this.currentPage.chapter_id);
    if (chapter && chapter.pages?.length <= 1) {
      this.chapterFigures = [];
      return;
    }
    // Buch- und Seitenwechsel während des Fetches: die Antwort gehört dann zu
    // einem anderen Kapitel und darf die Figurenleiste der neuen Seite nicht
    // überschreiben (deren eigener Load läuft schon).
    const bookId = this.$store.nav.selectedBookId;
    const pageId = this.currentPage.id;
    const stillCurrent = () => isSelectedBook(bookId) && this.currentPage?.id === pageId;
    try {
      const data = await fetchJson(`/figures/chapter/${bookId}/${this.currentPage.chapter_id}`);
      if (!stillCurrent()) return;
      this.chapterFigures = (data?.figuren || []).map(_sanitizeFigur);
    } catch (e) {
      if (!stillCurrent()) return;
      console.error('[loadChapterFigures]', e);
      this.chapterFigures = [];
    }
  },

  /** Klick auf eine Todo-Checkbox in der LESEANSICHT: der Browser hat den Haken
   *  schon visuell umgelegt (natives Input, kein contenteditable) — hier wird er
   *  ins gespeicherte Seiten-HTML nachgezogen und persistiert. Ohne diesen Pfad
   *  wirkt das Abhaken erledigt und ist beim nächsten Laden wieder weg (im
   *  Edit-Modus pflegt der Toggle-Handler in cards/editor-toolbar-card.js das
   *  `checked`-Attribut). Liefert true, wenn der Klick behandelt wurde. */
  _handleViewTodoClick(e) {
    const box = e.target;
    if (!box || box.tagName !== 'INPUT' || box.type !== 'checkbox') return false;
    const view = box.closest(READ_VIEW_SEL);
    if (!view) return false;
    // Ohne Schreibrecht (viewer/lektor) nichts persistieren und den nativen
    // Toggle zurückdrehen — sonst zeigt die Ansicht einen Haken, den der Server
    // nie bekommt. CSS macht die Box für diese Rollen zusätzlich klick-inert
    // (.page-content-view--readonly in page-view.css); das hier ist die Defense
    // dahinter.
    const page = this.currentPage;
    const idx = this.canEdit?.() && page && this.originalHtml ? todoBoxIndex(view, box) : -1;
    if (idx < 0) {
      box.checked = !box.checked;
      return true;
    }
    // Klicks sammeln statt verwerfen: läuft schon ein Save, wartet der Haken in
    // `_todoPending` und reist mit dem nächsten PUT. Zwei PUTs parallel liefen
    // mit demselben `expectedUpdatedAt` garantiert in einen 409 gegen den
    // eigenen Write. Die Warteschlange gehört genau einer Seite — ein Rest der
    // Vorgängerseite hätte auf dieser Seite einen fremden Index.
    if (this._todoPending?.pageId !== page.id) this._todoPending = { pageId: page.id, boxes: new Map() };
    this._todoPending.boxes.set(idx, { box, checked: box.checked });
    if (!this._todoSaving) this._flushViewTodos();
    return true;
  },


  /** Persistiert die gesammelten Haken der aktuellen Seite, bis die
   *  Warteschlange leer ist. Fehlerpfade drehen die visuellen Toggles zurück,
   *  damit Ansicht und Persistenz nie auseinanderlaufen.
   *
   *  Wechselt die Seite, während ein PUT läuft, gehört dessen Antwort nicht mehr
   *  zur Ansicht: `originalHtml` ist dann schon das HTML der neuen Seite und darf
   *  nicht mit dem der alten überschrieben werden (der nächste Edit-Start ginge
   *  sonst von fremdem Inhalt aus). `page.updated_at` wird trotzdem nachgezogen —
   *  das Objekt gehört der alten Seite. */
  async _flushViewTodos() {
    const page = this.currentPage;
    if (!page) return;
    const stillCurrent = () => this.currentPage?.id === page.id;
    this._todoSaving = true;
    let dirty = false;
    try {
      while (stillCurrent() && this._todoPending?.pageId === page.id && this._todoPending.boxes.size) {
        const batch = this._todoPending.boxes;
        this._todoPending.boxes = new Map();
        let html = this.originalHtml;
        for (const [idx, { checked }] of batch) html = html == null ? null : setTodoCheckedAt(html, idx, checked);
        if (html == null) { this._revertViewTodos(batch); continue; }
        try {
          const saved = await savePage(page.id, {
            html,
            pageName: page.name,
            source: 'main',
            expectedUpdatedAt: page.updated_at || null,
          });
          if (saved?.updated_at) page.updated_at = saved.updated_at;
          if (!stillCurrent()) return;
          this.originalHtml = html;
          this._syncPageStatsAfterSave?.(page, html);
          dirty = true;
        } catch (err) {
          // Was während des gescheiterten PUTs dazukam, baut auf ihm auf und
          // fällt mit: bei 409 ohnehin gegen einen veralteten Stand.
          const queued = this._todoPending?.pageId === page.id ? this._todoPending.boxes : new Map();
          this._todoPending = null;
          if (!stillCurrent()) return;
          this._revertViewTodos(batch);
          this._revertViewTodos(queued);
          await this._handleViewTodoError(page, err);
          return;
        }
      }
    } finally {
      this._todoSaving = false;
      // Seite verlassen: offene Haken der alten Seite verfallen. Blieben sie
      // liegen, reisten sie bei der Rückkehr mit dem nächsten Klick mit.
      if (!stillCurrent() && this._todoPending?.pageId === page.id) this._todoPending = null;
      if (dirty && stillCurrent()) {
        // Sidebar-Lektorat-Status hängt an `updated_at` (Server-Map) — nachladen.
        this.refreshPageAges?.();
        this.updatePageView();
      }
      // Während eines Saves der Vorgängerseite gesammelte Haken der jetzt
      // offenen Seite: deren eigener Flush ist am laufenden Save abgeprallt.
      if (this._todoPending?.pageId === this.currentPage?.id && this._todoPending?.boxes.size) {
        this._flushViewTodos();
      }
    }
  },

  /** Live-Kästen auf den gespeicherten Stand (`originalHtml`) zurückstellen.
   *  Aus dem HTML gelesen statt `!checked`: ein zweimal geklickter Kasten stünde
   *  sonst auf dem falschen Zustand. Ein Re-Render über `updatePageView` hilft
   *  hier nicht — ist `renderedPageHtml` unverändert, rendert x-html nicht neu. */
  _revertViewTodos(entries) {
    if (!entries.size) return;
    const doc = new DOMParser().parseFromString(this.originalHtml || '', 'text/html');
    const saved = doc.body.querySelectorAll(TODO_BOX_SEL);
    for (const [idx, { box }] of entries) box.checked = !!saved[idx]?.hasAttribute('checked');
  },

  async _handleViewTodoError(page, err) {
    if (isPageConflict(err)) {
      // Fremder Schreibvorgang dazwischen: kein Merge-Aufwand für ein Bit —
      // frischen Stand holen, User setzt den Haken erneut.
      try {
        const remote = await contentRepo.loadPage(page.id, { fresh: true });
        if (remote?.html != null && this.currentPage?.id === page.id) {
          this.originalHtml = remote.html;
          if (remote.updated_at) page.updated_at = remote.updated_at;
          this.updatePageView();
        }
      } catch (reloadErr) {
        console.error('[viewTodoConflictReload]', reloadErr);
      }
      this.setStatus(this.t('page.todo.conflict'), false, 6000);
      return;
    }
    console.error('[viewTodoToggle]', err);
    this.setStatus(this.t('page.todo.saveFailed', { msg: err.message }), false, 6000);
  },


  /** Click-Handler für Inline-Marks → togglet Selektion. Links → neuer Tab. */
  handleMarkClick(e) {
    if (this._handleViewTodoClick(e)) return;
    // Beleg-Chip: gehört dem Quellen-Popover (cards/editor-entities-card.js).
    // Liegt der Chip innerhalb eines Lektorat-Marks, würde derselbe Klick sonst
    // zusätzlich das Finding auf-/zuklappen.
    if (closestCiteEl(e.target, e.currentTarget)) return;
    const link = e.target.closest('a[href]');
    if (link && !link.classList.contains('lektorat-mark')) {
      const href = link.getAttribute('href');
      if (href && !href.startsWith('#')) {
        e.preventDefault();
        window.open(link.href, '_blank', 'noopener,noreferrer');
        return;
      }
    }
    const mark = e.target.closest('.lektorat-mark');
    if (!mark) return;
    const idx = parseInt(mark.dataset.errorIdx);
    if (isNaN(idx)) return;
    this.toggleFinding(idx);
  },

  /** Pointer-Handler auf page-content-view: Im Split → Hover-Sync, sonst → Tooltip */
  handleMarkPointer(e) {
    if (e.pointerType !== 'mouse') return;
    const mark = e.target.closest('.lektorat-mark');
    if (mark === activeLektoratMark()) return;
    if (!mark) { hideLektoratTip(); return; }

    if (splitMQ.matches && this.checkDone) {
      // Split-Modus: Finding-Panel mitscrollen
      setActiveLektoratMark(mark);
      const idx = parseInt(mark.dataset.errorIdx);
      if (isNaN(idx)) return;
      const finding = document.querySelector(`.lektorat-split-findings [data-finding-idx="${idx}"]`);
      if (finding) {
        finding.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        flashEl(finding);
      }
    } else {
      // Kein Split: Tooltip wie bisher
      showTip(mark, this.lektoratFindings || []);
    }
  },

  handleMarkPointerLeave(e) {
    if (splitMQ.matches && this.checkDone) return;
    const related = e.relatedTarget;
    if (related && lektoratTipContains(related)) return;
    hideLektoratTip();
  },

  // Copy aus Page-View: nur text/plain ins Clipboard (gemeinsam mit allen
  // Editoren). Browser-Default würde text/html mitsenden, was in Outlook
  // & Co. zusätzliche Absatzabstände, Inline-Styles und Lektorat-Marks
  // rendert. `sel.toString()` liefert den Block-getrennten Plain-Text.
  handleViewCopy(e) { handleEditorCopy(e); },
};
