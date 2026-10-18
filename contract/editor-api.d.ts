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
  /** Granularität live umschalten (Klassentausch + Overlay-Neuberechnung). */
  setGranularity(g: FocusGranularity): void;
  /** Sofort speichern (vor Fenster-Schliessen, Seitenwechsel). */
  save(): Promise<void>;
  /** Speichern, Listener abräumen, Host lösen. */
  destroy(): Promise<void>;
  /**
   * Undo/Redo gehören dem Editor (pro Abschnitt, nur `setPage`/`destroy`
   * setzen zurück). Auf macOS erreicht Cmd+Z die WebView nie — das Menü
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

export interface FocusHostReadable {
  /** true, solange Ungespeichertes vorliegt. */
  readonly editDirty: boolean;
  readonly focusGranularity: FocusGranularity;
  /** Schreibbar per `Object.defineProperty` (Android: Getter auf den nativen Wert). */
  typewriterAnchor: number | undefined;
  /** Serialisierter Save des aktuellen DOM-Stands. */
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
export function createSpellcheckController(opts: Record<string, unknown>): unknown;
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
