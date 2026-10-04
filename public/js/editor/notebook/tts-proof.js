import { EVT } from '../../events.js';
import {
  computeTtsSentences, coalesceTtsRanges, splitLongRange, chunkTtsRanges,
  collectTtsSegments, hasTtsText, ttsSegmentAt,
  TTS_MIN_CHUNK_CHARS, TTS_MAX_CHUNK_CHARS,
} from '../../tts-segment.js';
import { createTtsPlayer, ttsPointAt, ttsKeyTargetIsInteractive, TTS_RATES } from '../../tts-player.js';
import { lsGet, lsSet, lsGetJSON, lsSetJSON, lsRemove } from '../../safe-storage.js';

// Proof-Listening / Text-to-Speech (Notebook-Seitenansicht, Read-Modus). Liest
// den gerenderten Seitentext satzweise vor, markiert den gerade gehoerten Satz
// per CSS Custom Highlight und scrollt ihn ins Sichtfeld. Den eigenen Text
// gehoert aufzudecken Stolperstellen, die das Auge ueberliest.
//
// Laeuft in der Leseansicht (`.page-content-view`), NICHT im Edit-Modus —
// Korrekturhoeren am fertigen Text, nicht waehrend des Tippens. Reines Lesen:
// keine DOM-Mutation, kein Save-Pfad.
//
// Abspiel-Schleife, Vorausladen, Wiederholen, Springen, Audio-Cache und Media
// Session liegen im geteilten Kern ../../tts-player.js (SSoT mit dem
// Share-Reader), Segmentierung in ../../tts-segment.js. Hier nur, was das
// Notebook ausmacht: Lese-Container, Store-Spiegel, Toasts/Telemetrie,
// Leseposition pro Seite, „ab hier", Tastatur und Weiterlesen auf der
// naechsten Seite.
//
// Diese Methoden werden in den Root (`Alpine.data('lektorat')`) gespreaded —
// der Vorlese-Dock laeuft im Root-Scope.

// Gemerkte Leseposition pro Seite: wie lange sie gilt.
const TTS_POS_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
// Weiterlesen: so lange wird auf den Inhalt der naechsten Seite gewartet.
const TTS_CONTINUE_WAIT_MS = 15_000;
// Klicks auf diese Elemente gehoeren ihnen (Lektorat-Popover, Links, Chips) —
// kein Sprung dorthin.
const TTS_CLICK_IGNORE_SEL = 'a, button, input, textarea, mark.lektorat-mark, mark.chat-mark, .mention, .entity-ref, span.cite';

// Spieler-Instanz: modul-scoped (es gibt genau einen Root). Bewusst nicht auf
// `this` — siehe tts-player.js, der reaktive Proxy braeche die Guards.
let player = null;
// Memo fuer die Dock-Sichtbarkeit (wird im x-show pro Render gefragt).
let readableMemo = { html: null, ok: false };

const posKey = (pageId) => `tts.pos.${pageId}`;

export const ttsProofMethods = {
  // Diagnostik-Logger: meldet reine Vorlese-Frontend-Events fire-and-forget an
  // POST /telemetry/tts-log, sodass sie zentral in schreibwerkstatt.log landen
  // (der /tts/speak-Proxy loggt nur die einzelnen Synthese-Calls). Best-effort.
  _ttsLog(msg, level = 'info') {
    const body = { level, msg, bookId: this.$store.nav.selectedBookId || null };
    try {
      fetch('/telemetry/tts-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    } catch { /* noop */ }
  },

  // ── Pure Compute (SSoT tts-segment.js) ───────────────────────────────────
  // Duenne Delegationen, damit bestehende Aufrufer + Unit-Tests
  // (`ttsProofMethods._computeTtsSentences`) unveraendert bleiben.
  _computeTtsSentences(text, locale = 'de') { return computeTtsSentences(text, locale); },
  _coalesceTtsRanges(ranges, text, minLen = TTS_MIN_CHUNK_CHARS, maxLen = Infinity) {
    return coalesceTtsRanges(ranges, text, minLen, maxLen);
  },
  _splitLongRange(range, text, maxLen = TTS_MAX_CHUNK_CHARS) { return splitLongRange(range, text, maxLen); },
  _chunkTtsRanges(ranges, text, minLen = TTS_MIN_CHUNK_CHARS, maxLen = TTS_MAX_CHUNK_CHARS) {
    return chunkTtsRanges(ranges, text, minLen, maxLen);
  },

  // ── Spieler ──────────────────────────────────────────────────────────────

  _ttsPlayer() {
    if (player) return player;
    const store = () => this.$store.tts;
    player = createTtsPlayer({
      request: (text, signal) => {
        const params = new URLSearchParams();
        if (this.$store.nav.selectedBookId) params.set('bookId', this.$store.nav.selectedBookId);
        if (this.currentPage?.id) params.set('pageId', this.currentPage.id);
        const qs = params.toString() ? `?${params}` : '';
        return fetch(`/tts/speak${qs}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal,
        });
      },
      // Stimme haengt an der Buch-Locale → Cache pro Buch.
      cacheScope: () => `book:${this.$store.nav.selectedBookId || '-'}`,
      getPause: () => store().pause || {},
      onState: (s) => {
        const st = store();
        st.playing = s.playing;
        st.paused = s.paused;
        st.loading = s.loading;
        st.index = s.index;
        st.total = s.total;
      },
      onScroll: (range) => {
        let rect = null;
        try { rect = range.getBoundingClientRect(); } catch { /* noop */ }
        this._ttsScrollViewIntoView(rect);
      },
      onFailed: () => {
        this._showJobToast?.({ message: this.t('tts.error.failed'), severity: 'err', jobType: 'tts', bookId: null });
      },
      onStop: (info) => this._ttsOnStop(info),
      log: (msg, level) => this._ttsLog(msg, level),
      mediaTitle: () => {
        const book = this._ttsCurrentBook();
        return [this.currentPage?.name, book?.name].filter(Boolean).join(' · ');
      },
    });
    const rate = Number(lsGet('tts.rate'));
    if (TTS_RATES.includes(rate)) { player.setRate(rate); store().rate = rate; }
    store().continueReading = lsGet('tts.continue') === '1';
    return player;
  },

  // ── Lifecycle ────────────────────────────────────────────────────────────

  _initTtsProof(signal) {
    const stop = () => { if (player?.isActive()) player.stop(); };
    window.addEventListener(EVT.BOOK_CHANGED, stop, { signal });
    window.addEventListener(EVT.VIEW_RESET, stop, { signal });
    // In den Edit-Modus wechseln (Dock ist read-only) / Seite gewechselt ->
    // Vorlesen beenden, Audio freigeben.
    this.$watch('editMode', (on) => { if (on) stop(); });
    this.$watch(() => this.currentPage?.id, () => stop());
    // Leseansicht neu gerendert (Fremd-Aenderung nachgeladen, Lektorat-
    // Markierungen ein/aus): Segmente auf die neuen Knoten umhaengen, sonst
    // liest der Ton weiter, waehrend die Markierung verschwunden ist.
    this.$watch('renderedPageHtml', () => {
      if (!player?.isActive()) return;
      this.$nextTick(() => { if (player?.isActive()) player.updateSegments(this._ttsCollectSegments()); });
    });
    // Waehrend des Vorlesens: Klick in den Text springt dorthin.
    document.addEventListener('click', (e) => this._ttsOnClick(e), { signal });
    // Waehrend des Vorlesens: Leertaste = Pause/Weiter, ←/→ = Satz zurueck/vor.
    document.addEventListener('keydown', (e) => this._ttsOnKey(e), { signal });
  },

  _ttsCurrentBook() {
    const id = this.$store.nav.selectedBookId;
    if (!id) return null;
    return (this.$store.nav.books || []).find(b => String(b.id) === String(id)) || null;
  },

  // Sprache der Satztrennung = Buchsprache (dieselbe, nach der der Server die
  // Stimme waehlt). Die UI-Sprache waere falsch: ein deutsches Buch bei
  // englischer Oberflaeche zerfiele an „z. B." in Pseudo-Saetze.
  _ttsLocaleCode() {
    const lang = this._ttsCurrentBook()?.language || this.$store.shell.uiLocale || 'de';
    return String(lang).split('-')[0].trim().toLowerCase() || 'de';
  },

  // Hat die aktuelle Seite vorlesbaren Text? Steuert die Sichtbarkeit des
  // Docks. Gleiche Regel wie die Segmentierung (hasTtsText): eine Seite aus nur
  // einer Tabelle oder einem Diagramm hat keinen. Parst in ein inertes
  // <template> (laedt keine Bilder), gemerkt pro HTML-Stand.
  _ttsHasReadableText() {
    const html = this.renderedPageHtml;
    if (!html) return false;
    if (readableMemo.html === html) return readableMemo.ok;
    let ok = false;
    try {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      ok = hasTtsText(tpl.content);
    } catch {
      ok = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').trim().length > 0;
    }
    readableMemo = { html, ok };
    return ok;
  },

  // Container der Leseansicht (Read-Modus). Bewusst nicht der Edit-Container
  // (`_getEditEl`): TTS liest den gerenderten Seitentext.
  _ttsGetReadEl() {
    return document.querySelector('#editor-card .page-content-view:not(.page-content-view--editing)');
  },

  _ttsCollectSegments() {
    const el = this._ttsGetReadEl();
    return el ? collectTtsSegments(el, this._ttsLocaleCode()) : [];
  },

  // Rect des aktuellen Satzes ins Sichtfeld nudgen. Die `.page-content-view`
  // ist ihr eigener Scroll-Container (max-height + overflow-y:auto) ->
  // scrollTop direkt nachziehen, nur wenn der Satz ueber/unter den Rand rutscht.
  _ttsScrollViewIntoView(rect) {
    const el = this._ttsGetReadEl();
    if (!el || !rect || (!rect.height && !rect.top && !rect.bottom)) return;
    const host = el.getBoundingClientRect();
    const margin = 28;
    if (rect.bottom > host.bottom - margin) {
      el.scrollTop += rect.bottom - (host.bottom - margin);
    } else if (rect.top < host.top + margin) {
      el.scrollTop -= (host.top + margin) - rect.top;
    }
  },

  // ── Steuerung ────────────────────────────────────────────────────────────

  // Hauptbutton: idle -> starten; aktiv -> pausieren <-> fortsetzen.
  toggleTtsProof() {
    if (!this.$store.tts.enabled) return;
    const p = this._ttsPlayer();
    if (!p.isActive()) { this._ttsStart(); return; }
    p.toggle();
  },
  skipTtsProof() { player?.skip(); },
  prevTtsProof() { player?.prev(); },
  stopTtsProof() { player?.stop(); },

  cycleTtsRate() {
    const p = this._ttsPlayer();
    const cur = Number(this.$store.tts.rate) || 1;
    const next = TTS_RATES[(TTS_RATES.indexOf(cur) + 1) % TTS_RATES.length] ?? 1;
    p.setRate(next);
    this.$store.tts.rate = next;
    lsSet('tts.rate', String(next));
  },

  toggleTtsContinue() {
    this._ttsPlayer();
    const on = !this.$store.tts.continueReading;
    this.$store.tts.continueReading = on;
    lsSet('tts.continue', on ? '1' : '0');
  },

  // Start-Position: markierter Text > gemerkte Position dieser Seite > Anfang.
  _ttsStart({ fromIdx = null } = {}) {
    if (!this.$store.tts.enabled) return;
    const p = this._ttsPlayer();
    const segs = this._ttsCollectSegments();
    if (!segs.length) {
      this._ttsLog('start aborted: no segments (empty text)');
      this._showJobToast?.({ message: this.t('tts.error.empty'), severity: 'info', jobType: 'tts', bookId: null });
      return;
    }
    let idx = fromIdx;
    if (idx == null) idx = this._ttsSelectionIndex(segs);
    if (idx < 0) idx = this._ttsSavedIndex(segs);
    this._ttsLog(`start locale=${this._ttsLocaleCode()} book=${this.$store.nav.selectedBookId || '-'} page=${this.currentPage?.id || '-'}`);
    p.start(segs, Math.max(0, idx));
  },

  // Nicht-leere Markierung in der Leseansicht → Start ab dem Satz, in dem sie
  // beginnt. Eine blosse Einfuegemarke zaehlt nicht (zufaelliger Klick).
  _ttsSelectionIndex(segs) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return -1;
    const el = this._ttsGetReadEl();
    const r = sel.getRangeAt(0);
    if (!el || !el.contains(r.startContainer)) return -1;
    return ttsSegmentAt(segs, r.startContainer, r.startOffset);
  },

  _ttsSavedIndex(segs) {
    const id = this.currentPage?.id;
    if (!id) return 0;
    const saved = lsGetJSON(posKey(id));
    if (!saved || !(Date.now() - (saved.at || 0) < TTS_POS_MAX_AGE_MS)) return 0;
    if (segs[saved.i]?.text === saved.text) return saved.i;
    const j = segs.findIndex(s => s.text === saved.text);
    return j >= 0 ? j : 0;
  },

  // Session vorbei: Position merken (abgebrochen) bzw. vergessen (zu Ende
  // gehoert), am Ende ggf. auf der naechsten Seite weiterlesen.
  _ttsOnStop({ index, seg, ended }) {
    const id = this.currentPage?.id;
    if (id) {
      if (ended || !seg || index <= 0) lsRemove(posKey(id));
      else lsSetJSON(posKey(id), { i: index, text: seg.text, at: Date.now() });
    }
    if (ended && this.$store.tts.continueReading) this._ttsContinue();
  },

  // Naechste Seite desselben Kapitels oeffnen und von vorn vorlesen. Kapitel-
  // grenze = Ende (ein neues Kapitel ist ein bewusster Schritt).
  async _ttsContinue() {
    const pages = this.$store.nav.pages || [];
    const cur = this.currentPage;
    const i = cur ? pages.findIndex(p => p.id === cur.id) : -1;
    const next = i >= 0 ? pages[i + 1] : null;
    if (!next || (next.chapter_id ?? null) !== (pages[i].chapter_id ?? null)) return;
    this._ttsLog(`continue to page ${next.id}`);
    await this.selectPage(next);
    const t0 = Date.now();
    while (Date.now() - t0 < TTS_CONTINUE_WAIT_MS) {
      if (this.currentPage?.id !== next.id || this.editMode) return; // User hat woanders hin navigiert
      if (this.renderedPageHtml && !this.pageContentLoading && this._ttsGetReadEl()) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await this.$nextTick();
    if (this.currentPage?.id !== next.id || this.editMode || player?.isActive()) return;
    this._ttsStart({ fromIdx: 0 });
  },

  _ttsOnClick(e) {
    if (!player?.isActive() || e.defaultPrevented || e.button !== 0) return;
    const el = this._ttsGetReadEl();
    if (!el || !el.contains(e.target)) return;
    if (e.target.closest?.(TTS_CLICK_IGNORE_SEL)) return;
    if (window.getSelection?.()?.isCollapsed === false) return; // markiert gerade Text
    const pt = ttsPointAt(e.clientX, e.clientY);
    if (!pt) return;
    const idx = ttsSegmentAt(player.segments(), pt.node, pt.offset);
    if (idx >= 0) player.jumpTo(idx);
  },

  _ttsOnKey(e) {
    if (!player?.isActive() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    // Leertaste gehoert einem fokussierten Bedienelement (auch der Dock-Taste,
    // die damit selbst umschaltet); ←/→ wirken zusaetzlich im Dock, wo nach
    // einem Klick auf eine Taste der Fokus liegt.
    const interactive = ttsKeyTargetIsInteractive(e.target);
    const inDock = !!e.target?.closest?.('.tts-dock');
    if (e.key === ' ') {
      if (interactive) return;
      e.preventDefault(); player.toggle();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (interactive && !inDock) return;
      e.preventDefault();
      if (e.key === 'ArrowRight') player.skip(); else player.prev();
    }
  },
};
