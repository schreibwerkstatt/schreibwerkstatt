// Bundle-Vertrag des OTA-Editor-Bundles (`GET /content/editor-bundle.zip`) —
// was eine native Schale (macOS WKWebView, Android WebView) aufrufen darf.
//
// Major: contract/version.json → `editorApi` (auch im bundle-manifest.json).
// Innerhalb eines Majors kommt nur dazu; was hier steht, bleibt. Felder, die
// hier NICHT stehen (z.B. `controller._focusUpdateActive`, beliebige
// `host.*`-Interna), sind keine Zusage — eine Schale, die sie benutzt, bricht
// ohne Vorwarnung. Was die Clients heute tatsächlich anfassen, listet
// contract/editor-surface.json (erzeugt, gegen das Bundle geprüft).
//
// Quelle der Implementierung: public/js/editor/focus/standalone.js
// (Bridge/Handle), public/js/editor/shared/block-merge.js (Merge),
// public/js/cards/editor-spellcheck/controller.js, …/editor-synonyme/controller.js.

/** Ein Abschnitt, wie die Schale ihn dem Editor gibt und zurückbekommt. */
export interface BridgePage {
  id: number | string;
  name?: string;
  /** Abschnitts-HTML; Blöcke tragen `data-bid`. */
  html: string;
}

/** Von der Schale bereitzustellen. `loadPage` und `savePage` sind Pflicht. */
export interface Bridge {
  /** Aktueller Abschnitt beim Mount. */
  loadPage(): Promise<BridgePage>;
  /** Lokal persistieren + Sync-Queue. Saves kommen strikt nacheinander (nie parallel). */
  savePage(page: BridgePage): Promise<unknown>;
  /** Initiale Fokus-Granularität. Unbekannt → `paragraph`. */
  granularity?: FocusGranularity;
  /** Vertikaler Typewriter-Anker 0–1 (0.5 Mitte). Ungültig → 0.5. */
  typewriterAnchor?: number;
  /** Sprache des Textes (`de`/`en`) — Satz-Segmentierung. */
  locale?: string;
}

export type FocusGranularity = 'paragraph' | 'sentence' | 'window-3' | 'typewriter-only';

export interface MountOptions {
  /** Element, in das `.focus-editor > .focus-editor__content[contenteditable]` gebaut wird. */
  mount: HTMLElement;
  bridge: Bridge;
  /** Autosave-Entprellung (Default 1500 ms). */
  autosaveMs?: number;
  /** Neuversuch nach fehlgeschlagenem Save (Default 5000 ms). */
  retryMs?: number;
}

/** Rückgabe von `mountStandaloneFocus`. */
export interface FocusHandle {
  /**
   * Abschnitt wechseln oder frischeren Server-Stand still einspielen. Gleiche
   * Id: kein Save. Andere Id: Ungespeichertes der bisherigen wird vorher
   * gesichert (Promise dieses Saves).
   */
  setPage(next: BridgePage): Promise<void>;
  /**
   * Neuen Server-Stand DESSELBEN Abschnitts einspielen (z.B. `html` aus
   * `PUT …/pages/{id}` → `200 merged: true`). Caret bleibt im selben Block
   * (`data-bid`) an derselben Textstelle, die Caret-Zeile an ihrer
   * Bildschirmposition; kein Sprung ans Ende, kein neuer Auto-Slot, kein Save.
   * Die Undo-Historie bleibt, der Tausch ist ein Schritt. Feuert kein `input`.
   *
   * `false`: abgelehnt, weil seit dem zuletzt gesendeten Stand weitergeschrieben
   * wurde — nichts geändert; der vorgemerkte Autosave pusht die Eingaben (mit
   * dem gesendeten Stand als `base_html`), dessen Merge-Antwort folgt.
   *
   * Seit editorApi 1 additiv: per `typeof handle.replaceContent === 'function'`
   * prüfen, sonst `setPage`.
   */
  replaceContent?(html: string): boolean;
  /** Granularität live umschalten (Klassentausch + Overlay-Neuberechnung). */
  setGranularity(g: FocusGranularity): void;
  /**
   * Ende jedes Save-Laufs abonnieren — Autosave, `save()`, Escape, `destroy()`,
   * auch wenn der Inhalt dem gesicherten Stand gleicht und darum kein
   * `savePage` rausging (Tippen + wieder Löschen). `dirty` ist der Zustand
   * danach: `true`, wenn während des Saves weitergetippt wurde (der Folge-
   * Autosave meldet erneut). Ein fehlgeschlagener Save meldet nichts; der
   * Neuversuch meldet. Ein werfender Callback stört weder den Save noch andere
   * Abonnenten. Rückgabe: Abmelde-Funktion.
   *
   * Seit editorApi 1 additiv: per `typeof handle.onSaved === 'function'` prüfen.
   */
  onSaved?(cb: (e: SavedEvent) => void): () => void;
  /**
   * Caret-Zeile auf den Typewriter-Anker ziehen — dieselbe Geometrie wie beim
   * Tippen (Anker aus `host.typewriterAnchor` bzw. 0.5). Leerer Absatz ohne
   * Text-Rect → Rect seines Blocks. Der Scroll gilt der Engine als eigener,
   * nicht als Lese-Scrollen. `threshold` in px (Default 0 = exakt): darunter
   * bleibt die Zeile stehen — für wiederholtes Nachziehen, solange sich das
   * Layout noch setzt. Rückgabe: gefahrene Strecke in px; 0 = nichts bewegt
   * (schon auf dem Anker, Scroll-Anschlag, kein Caret im Editor).
   *
   * Seit editorApi 1 additiv: per `typeof handle.revealCaret === 'function'`
   * prüfen.
   */
  revealCaret?(opts?: { threshold?: number }): number;
  /**
   * Trennlinie einfügen: `<hr>` hinter dem obersten Block des Carets (ohne
   * Caret im Editor: ans Ende), dahinter ein Folge-Absatz `<p><br></p>` mit dem
   * Caret darin. Feuert `input` (dirty, Autosave) und ist ein Schritt in der
   * Undo-Historie (eine offene Tipp-Strecke davor bleibt ein eigener Schritt).
   * Die Linie zeigt das Bundle-CSS selbst, über die volle Schreibbreite in
   * Hell und Dunkel.
   *
   * Seit editorApi 1 additiv: per `typeof handle.insertHr === 'function'`
   * prüfen.
   */
  insertHr?(): void;
  /** Sofort speichern (vor Fenster-Schliessen, Seitenwechsel). */
  save(): Promise<void>;
  /** Speichern, Listener abräumen, Host lösen. */
  destroy(): Promise<void>;
  /**
   * Undo/Redo gehören dem Editor (pro Abschnitt, nur `setPage`/`destroy`
   * setzen zurück; `replaceContent` trägt einen Schritt ein). Auf macOS erreicht Cmd+Z die WebView nie — das Menü
   * verdrahtet sich hierauf. Ein Restore feuert
   * `InputEvent('input', { inputType: 'historyUndo' | 'historyRedo' })`.
   */
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Lesefelder des Hosts, die eine Schale beobachten darf. */
  host: FocusHostReadable;
  /** Engine-Objekt — intern, KEIN Vertrag (Granularität: `setGranularity`). */
  controller: Record<string, unknown>;
}

/** Argument von `onSaved`. */
export interface SavedEvent {
  /** Ungespeichertes liegt vor (wie `host.editDirty` nach dem Lauf). */
  dirty: boolean;
  /** Offener Abschnitt; `null` ohne Abschnitt. */
  pageId: number | string | null;
}

export interface FocusHostReadable {
  /** true, solange Ungespeichertes vorliegt. */
  readonly editDirty: boolean;
  readonly focusGranularity: FocusGranularity;
  /** Schreibbar per `Object.defineProperty` (Android: Getter auf den nativen Wert). */
  typewriterAnchor: number | undefined;
  /** Serialisierter Save des aktuellen DOM-Stands. Wer das Ende eines Saves erfahren will: `onSaved`, nicht diese Methode überschreiben. */
  quickSave(): Promise<void>;
}

export function mountStandaloneFocus(opts: MountOptions): Promise<FocusHandle>;

// ── Block-Merge (js/editor/shared/block-merge.js) ─────────────────────────────
// Derselbe Merge läuft auf dem Server, wenn ein Push `base_html` mitschickt
// (contract/openapi.json → PUT /content/pages/{page_id}); eine Schale braucht
// ihn nur noch für die Konflikt-Ansicht (Entscheidung pro Block).

export interface Block { bid: string; tag: string; html: string; }
export interface MergedEntry extends Block {
  conflict?: { local_html: string | null; remote_html: string | null; base_html: string | null };
}
export interface MergeResult {
  merged: MergedEntry[];
  conflicts: Array<{ bid: string; tag: string; local_html: string | null; remote_html: string | null; base_html: string | null }>;
}
export function parseBlocks(html: string, opts?: { DOMParser?: typeof DOMParser }): Block[];
export function mergeBlocks(baseHtml: string, localHtml: string, remoteHtml: string, opts?: { DOMParser?: typeof DOMParser }): MergeResult;
export function mergedToHtml(merged: MergedEntry[]): string;
export function buildResolvedHtml(merged: MergedEntry[], decisions?: Record<string, 'local' | 'remote' | 'both'>): string;

// ── Hilfen der Schale ─────────────────────────────────────────────────────────
// Rechtschreibung, Synonyme, Anführungszeichen. Die Options-Namen, die die
// Clients übergeben, stehen in contract/editor-surface.json unter `options`.
export function createSpellcheckController(opts: Record<string, unknown>): SpellcheckController;

/** Rückgabe von `createSpellcheckController`. */
export interface SpellcheckController {
  /** An `root` binden, sofort prüfen; danach prüft jedes `input` (entprellt). */
  attach(): void;
  /** Lösen, Markierungen und Popover entfernen. */
  detach(): void;
  /**
   * Neu prüfen anstossen (entprellt, auch bei unverändertem Text). Für
   * Inhaltswechsel, die kein `input` feuern — z.B. nach `handle.replaceContent`.
   * Vor `attach` / nach `detach` wirkungslos.
   */
  refresh(): void;
  isAttached(): boolean;
}
export function createSynonymController(opts: Record<string, unknown>): unknown;
export function applySpellcheckReplacement(...args: unknown[]): unknown;
export function normalizeQuotes(...args: unknown[]): unknown;
export function resolveQuoteStyle(...args: unknown[]): unknown;

/** `bundle-manifest.json` im ZIP. */
export interface BundleManifest {
  sourceCommit: string;
  /** Major dieses Bundles; die Schale prüft ihn gegen das, was sie kann. */
  editorApi: number;
  jsFiles: string[];
  cssFiles: string[];
  extraAssets?: string[];
}
