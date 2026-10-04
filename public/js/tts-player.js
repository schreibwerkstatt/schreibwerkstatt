// Vorlese-Abspielkern (TTS / Proof-Listening) — SSoT beider Oberflaechen:
// Notebook-Leseansicht (editor/notebook/tts-proof.js, Alpine-Root) und
// Share-Reader (share-reader/tts.js, Vanilla). Framework-frei und pre-auth
// ladbar: importiert nur ./tts-segment.js, nichts aus dem App-Bundle (der
// anonyme Leser bekaeme sonst das halbe Bundle bzw. eine Login-Weiterleitung).
//
// Die Oberflaechen liefern nur, was sich unterscheidet: die Segmente (aus
// collectTtsSegments ueber ihren Lese-Container), den Synthese-Request (Route
// + Query), das Scrollen und die Darstellung des Zustands. Abspiel-Schleife,
// Vorausladen, Wiederholen, Pause, Springen, Highlight, Audio-Cache und Media
// Session liegen hier — einmal.
//
// Ablauf pro Segment: markieren → (Lookahead) vorausladen → auf das eigene
// Audio warten → abspielen → Atempause → naechstes. Jedes Warten ist
// unterbrechbar (`kick`): Springen (skip/prev/jumpTo) und Stop wirken auch,
// waehrend ein Satz noch synthetisiert wird.
//
// Session-Objekt `rt` bleibt roh im Closure: an einem reaktiven Alpine-Proxy
// haengend, hielten die Identitaets-Guards (`rt === r`) nie.

import { normalizeForSpeech, ttsBuildRange } from './tts-segment.js';

const HIGHLIGHT = 'tts-sentence';
// Waehlbare Lesetempi (browserseitig via playbackRate, ohne neue Synthese).
export const TTS_RATES = [0.8, 1, 1.25, 1.5];
const FRAGMENT_PAUSE_MS = 250;
const PARAGRAPH_PAUSE_MS = 550;
const MAX_RETRY = 1;
const RETRY_DELAY_MS = 600;
const RETRY_AFTER_CAP_MS = 5000;
// 408 bewusst NICHT: der Server hat dort schon 20 s gewartet — dieselbe Eingabe
// noch einmal hiesse 40 s Stille fuer einen Satz.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// Feature aus / Session weg / kein Zugriff → Session beenden, nicht pro Satz scheitern.
const FATAL = new Set([401, 403, 404]);
const PREFETCH_MAX = 3;
// Ein Satz, der schon so lange laeuft, wird bei „zurueck" neu gestartet statt
// zum vorigen zu springen (Media-Player-Konvention).
const PREV_RESTART_SEC = 2;

// ── Audio-Cache (browserweit, ueber Sessions) ───────────────────────────────
// Wer eine Seite nach einer kleinen Korrektur noch einmal hoert, soll die
// unveraenderten Saetze nicht neu synthetisieren lassen. Schluessel: Scope der
// Oberflaeche (Buch bzw. Share-Token → Stimme) + gesendeter Text. LRU nach Bytes.
const BLOB_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const blobCache = new Map();
let blobBytes = 0;
function cacheGet(key) {
  const b = blobCache.get(key);
  if (!b) return null;
  blobCache.delete(key);
  blobCache.set(key, b);
  return b;
}
function cachePut(key, blob) {
  if (!blob || blobCache.has(key)) return;
  blobCache.set(key, blob);
  blobBytes += blob.size || 0;
  while (blobBytes > BLOB_CACHE_MAX_BYTES && blobCache.size > 1) {
    const [k, v] = blobCache.entries().next().value;
    blobCache.delete(k);
    blobBytes -= v.size || 0;
  }
}
export function clearTtsAudioCache() { blobCache.clear(); blobBytes = 0; }

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

// DOM-Punkt (Textknoten + Offset) unter Bildschirmkoordinaten — fuer „Klick
// springt dorthin". Beide Browser-APIs, je nachdem was existiert.
export function ttsPointAt(x, y) {
  if (typeof document === 'undefined') return null;
  try {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
  } catch { /* noop */ }
  return null;
}

// Tastatur-Ereignis aus einem Eingabe-/Bedienelement? Dann gehoert die Taste
// dem Element, nicht dem Vorlesen.
export function ttsKeyTargetIsInteractive(target) {
  if (!target || target.nodeType !== 1) return false;
  return !!target.closest('input, textarea, select, button, a[href], [contenteditable=""], [contenteditable="true"], [role="button"], [role="textbox"], [role="combobox"], [role="slider"], [role="menuitem"]');
}

/**
 * @param {object} o
 * @param {(text: string, signal: AbortSignal) => Promise<Response>} o.request
 * @param {() => string} [o.cacheScope]      Stimme-relevanter Scope (Buch/Token)
 * @param {() => ({fragmentMs?: number, paragraphMs?: number})} [o.getPause]
 * @param {(s: object) => void} [o.onState]  { playing, paused, loading, index, total, rate }
 * @param {(range: Range) => void} [o.onScroll]
 * @param {() => void} [o.onFailed]          einmal pro Session (Synthese scheitert)
 * @param {(status: number) => void} [o.onFatal]
 * @param {(info: {index: number, total: number, seg: object|null, ended: boolean}) => void} [o.onStop]
 * @param {(msg: string, level?: string) => void} [o.log]
 * @param {() => string} [o.mediaTitle]
 */
export function createTtsPlayer(o) {
  const request = o.request;
  const cacheScope = o.cacheScope || (() => '');
  const getPause = o.getPause || (() => ({}));
  const onState = o.onState || (() => {});
  const onScroll = o.onScroll || (() => {});
  const onFailed = o.onFailed || (() => {});
  const onFatal = o.onFatal || (() => {});
  const onStop = o.onStop || (() => {});
  const log = o.log || (() => {});
  const mediaTitle = o.mediaTitle || (() => (typeof document !== 'undefined' ? document.title : ''));

  let rt = null;
  let rate = 1;
  // Laufende Mittelwerte: Synthese-Dauer vs. Abspiel-Dauer pro Segment. Daraus
  // die Vorauslade-Tiefe — wer langsamer synthetisiert als vorliest, braucht
  // mehr Vorlauf, sonst entstehen Luecken.
  const stats = { synthMs: 0, synthN: 0, audioMs: 0, audioN: 0 };

  const hl = () => typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

  function snapshot() {
    if (!rt) return { playing: false, paused: false, loading: false, index: 0, total: 0, rate };
    return {
      playing: true, paused: rt.paused, loading: rt.loading,
      index: Math.min(rt.i, rt.segs.length - 1) + 1, total: rt.segs.length, rate,
    };
  }
  function emit() {
    onState(snapshot());
    mediaState();
  }

  function newKick(r) { r.kickP = new Promise((res) => { r.kick = res; }); }
  function kick(r) { const k = r.kick; newKick(r); k(); }
  const interrupted = (r) => rt !== r || r.jump != null;

  // Wartet auf `promise`, bricht bei Sprung/Stop ab. Pause unterbricht nicht —
  // das Laden laeuft weiter, gespielt wird erst nach dem Fortsetzen.
  async function waitFor(r, promise) {
    let settled = false;
    let value = null;
    promise.then((v) => { settled = true; value = v; }, () => { settled = true; });
    while (!settled) {
      await Promise.race([promise.catch(() => null), r.kickP]);
      if (interrupted(r)) return { interrupted: true };
    }
    return { value };
  }
  async function waitWhilePaused(r) {
    while (rt === r && r.paused && r.jump == null) await r.kickP;
  }

  // ── Synthese ──────────────────────────────────────────────────────────────
  function prefetchAhead() {
    if (!stats.synthN || !stats.audioN) return 1;
    const ratio = (stats.synthMs / stats.synthN) / Math.max(1, stats.audioMs / stats.audioN);
    if (ratio > 1) return PREFETCH_MAX;
    if (ratio > 0.6) return 2;
    return 1;
  }

  function entryFor(r, idx) {
    const seg = r.segs[idx];
    if (!seg) return null;
    let e = r.pending.get(seg.text);
    if (e) return e;
    const key = `${cacheScope()}\u0000${seg.text}`;
    const hit = cacheGet(key);
    e = { settled: !!hit, promise: null };
    e.promise = hit
      ? Promise.resolve(hit)
      : fetchBlob(r, seg.text, 0).then((b) => { e.settled = true; if (b) cachePut(key, b); return b; });
    r.pending.set(seg.text, e);
    return e;
  }

  function failOnce(r) {
    if (r.failed || rt !== r) return;
    r.failed = true;
    onFailed();
  }

  async function fetchBlob(r, text, attempt) {
    const signal = r.abort.signal;
    if (signal.aborted) return null;
    const t0 = now();
    let res;
    try {
      res = await request(normalizeForSpeech(text), signal);
    } catch (e) {
      if (signal.aborted || e?.name === 'AbortError') return null;
      if (attempt < MAX_RETRY) {
        log(`fetch network error (attempt ${attempt + 1}/${MAX_RETRY + 1}), retrying: ${e?.message || e}`, 'warn');
        await sleep(RETRY_DELAY_MS);
        return fetchBlob(r, text, attempt + 1);
      }
      log(`fetch network error, giving up: ${e?.message || e}`, 'warn');
      failOnce(r);
      return null;
    }
    if (FATAL.has(res.status)) {
      log(`fetch ${res.status} -> stop session`, 'warn');
      if (rt === r) { stop(); onFatal(res.status); }
      return null;
    }
    if (!res.ok) {
      if (RETRYABLE.has(res.status) && attempt < MAX_RETRY && !signal.aborted) {
        const ra = Number(res.headers?.get?.('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, RETRY_AFTER_CAP_MS) : RETRY_DELAY_MS;
        log(`fetch ${res.status} (attempt ${attempt + 1}/${MAX_RETRY + 1}), retrying`, 'warn');
        await sleep(wait);
        return fetchBlob(r, text, attempt + 1);
      }
      log(`fetch ${res.status}, giving up`, 'warn');
      failOnce(r);
      return null;
    }
    try {
      const blob = await res.blob();
      if (!blob || !blob.size) return null;
      stats.synthMs += now() - t0;
      stats.synthN++;
      return blob;
    } catch (e) {
      if (signal.aborted || e?.name === 'AbortError') return null;
      failOnce(r);
      return null;
    }
  }

  // ── Abspielen ─────────────────────────────────────────────────────────────
  // Resolved 'ended' (natuerliches Ende oder defektes Audio → weiter) oder
  // 'interrupted' (Sprung/Stop). Pause/Fortsetzen arbeiten am Media-Element,
  // ohne dieses Promise aufzuloesen.
  function playBlob(r, blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      try { audio.playbackRate = rate; } catch { /* noop */ }
      r.audio = audio;
      let done = false;
      let wake = null;
      const doneP = new Promise((res) => { wake = res; });
      const finish = (how) => {
        if (done) return;
        done = true;
        wake();
        if (r.audio === audio) { r.audio = null; r.resumeAudio = null; }
        try { audio.pause(); } catch { /* noop */ }
        try { URL.revokeObjectURL(url); } catch { /* noop */ }
        resolve(how);
      };
      audio.addEventListener('ended', () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          stats.audioMs += (audio.duration * 1000) / (rate || 1);
          stats.audioN++;
        }
        finish('ended');
      });
      audio.addEventListener('error', () => {
        if (done || rt !== r) return;
        log(`audio playback error, skipping segment: ${audio.error?.message || ''}`, 'warn');
        finish('ended');
      });
      const tryPlay = () => {
        let p;
        try { p = audio.play(); } catch { p = null; }
        p?.catch?.((e) => {
          if (done || r.paused || rt !== r) return;
          log(`audio.play() rejected, skipping segment: ${e?.message || ''}`, 'warn');
          finish('ended');
        });
      };
      r.resumeAudio = () => { if (!done) tryPlay(); };
      (async () => {
        while (!done) {
          await Promise.race([r.kickP, doneP]);
          if (!done && interrupted(r)) finish('interrupted');
        }
      })();
      if (!r.paused) tryPlay();
    });
  }

  async function gap(r, ms) {
    if (!(ms > 0)) return;
    await waitFor(r, sleep(ms));
  }

  async function run(r) {
    while (rt === r) {
      if (r.jump != null) {
        r.i = Math.max(0, Math.min(r.jump, r.segs.length));
        r.jump = null;
      }
      if (r.i >= r.segs.length) break;
      const idx = r.i;
      const seg = r.segs[idx];
      highlight(seg);
      emit();
      await waitWhilePaused(r);
      if (rt !== r) return;
      if (r.jump != null) continue;

      const ahead = prefetchAhead();
      const entry = entryFor(r, idx);
      for (let k = 1; k <= ahead; k++) entryFor(r, idx + k);
      if (!entry.settled) { r.loading = true; emit(); }
      const got = await waitFor(r, entry.promise);
      if (r.loading) { r.loading = false; if (rt === r) emit(); }
      if (rt !== r) return;
      if (got.interrupted) continue;
      if (!got.value) { r.i++; continue; } // Synthese gescheitert → Satz uebersprungen

      await waitWhilePaused(r);
      if (rt !== r) return;
      if (r.jump != null) continue;
      const how = await playBlob(r, got.value);
      if (rt !== r) return;
      if (how === 'interrupted' || r.jump != null) continue;
      r.pending.delete(seg.text); // gespielt: Blob liegt im Cache, Session haelt ihn nicht mehr
      r.i++;

      const next = r.segs[r.i];
      if (next) {
        const p = getPause() || {};
        const ms = next.block !== seg.block
          ? (Number.isFinite(p.paragraphMs) ? p.paragraphMs : PARAGRAPH_PAUSE_MS)
          : (Number.isFinite(p.fragmentMs) ? p.fragmentMs : FRAGMENT_PAUSE_MS);
        await gap(r, ms);
      }
    }
    if (rt === r) end(r, r.i >= r.segs.length);
  }

  // ── Highlight ─────────────────────────────────────────────────────────────
  function highlight(seg) {
    if (!hl()) return;
    CSS.highlights.delete(HIGHLIGHT);
    if (!seg) return;
    const range = ttsBuildRange(seg.block, seg.startOff, seg.endOff);
    if (!range) return;
    try { CSS.highlights.set(HIGHLIGHT, new Highlight(range)); } catch { return; }
    try { onScroll(range); } catch { /* noop */ }
  }
  function clearHighlight() { if (hl()) CSS.highlights.delete(HIGHLIGHT); }

  // ── Media Session (Sperrbildschirm, Kopfhoerer-Tasten) ────────────────────
  const ms = () => (typeof navigator !== 'undefined' && navigator.mediaSession) || null;
  function mediaOn() {
    const m = ms();
    if (!m) return;
    try {
      if (typeof MediaMetadata !== 'undefined') m.metadata = new MediaMetadata({ title: mediaTitle() || '' });
    } catch { /* noop */ }
    const set = (a, fn) => { try { m.setActionHandler(a, fn); } catch { /* nicht unterstuetzt */ } };
    set('play', () => resume());
    set('pause', () => pause());
    set('stop', () => stop());
    set('nexttrack', () => skip());
    set('previoustrack', () => prev());
  }
  function mediaOff() {
    const m = ms();
    if (!m) return;
    for (const a of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack']) {
      try { m.setActionHandler(a, null); } catch { /* noop */ }
    }
    try { m.metadata = null; m.playbackState = 'none'; } catch { /* noop */ }
  }
  function mediaState() {
    const m = ms();
    if (!m || !rt) return;
    try { m.playbackState = rt.paused ? 'paused' : 'playing'; } catch { /* noop */ }
  }

  // ── Steuerung ─────────────────────────────────────────────────────────────
  function start(segs, startIdx = 0) {
    if (rt) stop();
    if (!Array.isArray(segs) || !segs.length) return false;
    const r = {
      segs,
      i: Math.max(0, Math.min(startIdx | 0, segs.length - 1)),
      jump: null,
      paused: false,
      loading: false,
      failed: false,
      pending: new Map(), // Segment-Text → { settled, promise<Blob|null> }
      audio: null,
      resumeAudio: null,
      abort: new AbortController(),
      kick: null,
      kickP: null,
    };
    newKick(r);
    rt = r;
    log(`start segments=${segs.length} from=${r.i}`);
    mediaOn();
    emit();
    run(r);
    return true;
  }

  function teardown(r) {
    rt = null;
    try { r.abort.abort(); } catch { /* noop */ }
    try { r.audio?.pause(); } catch { /* noop */ }
    kick(r);
    r.pending.clear();
    clearHighlight();
    mediaOff();
  }

  function end(r, ended) {
    const info = { index: Math.min(r.i, r.segs.length - 1), total: r.segs.length, seg: r.segs[r.i] || null, ended };
    teardown(r);
    log(`${ended ? 'end' : 'stop'} at segment ${r.i}/${r.segs.length}`);
    emit();
    onStop(info);
  }

  function stop() { if (rt) end(rt, false); }

  function pause() {
    const r = rt;
    if (!r || r.paused) return;
    r.paused = true;
    try { r.audio?.pause(); } catch { /* noop */ }
    emit();
  }
  function resume() {
    const r = rt;
    if (!r || !r.paused) return;
    r.paused = false;
    r.resumeAudio?.();
    kick(r);
    emit();
  }
  function toggle() { if (!rt) return; if (rt.paused) resume(); else pause(); }

  function jumpTo(idx) {
    const r = rt;
    if (!r) return;
    r.jump = Math.max(0, Math.min(idx | 0, r.segs.length));
    kick(r);
  }
  function skip() { if (rt) jumpTo(rt.i + 1); }
  function prev() {
    const r = rt;
    if (!r) return;
    const t = r.audio?.currentTime;
    jumpTo(Number.isFinite(t) && t > PREV_RESTART_SEC ? r.i : r.i - 1);
  }

  // Neu gerenderter Lese-Container (Fremd-Aenderung nachgeladen, Lektorat-
  // Markierungen umgeschaltet): die Session haelt sonst Bloecke, die nicht mehr
  // im Dokument haengen — Highlight weg, Ton liest den alten Text weiter. Die
  // Position wandert zum gleichlautenden Segment (naechstgelegenes bei
  // Duplikaten), sonst bleibt der Index stehen.
  function updateSegments(segs) {
    const r = rt;
    if (!r) return;
    if (!Array.isArray(segs) || !segs.length) { stop(); return; }
    const cur = r.segs[Math.min(r.i, r.segs.length - 1)];
    let ni = -1;
    let best = Infinity;
    if (cur) {
      segs.forEach((s, j) => {
        if (s.text !== cur.text) return;
        const d = Math.abs(j - r.i);
        if (d < best) { best = d; ni = j; }
      });
    }
    if (ni < 0) ni = Math.min(r.i, segs.length - 1);
    r.segs = segs;
    r.i = ni;
    if (r.jump != null) r.jump = Math.min(r.jump, segs.length);
    highlight(segs[ni]);
    emit();
  }

  function setRate(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return;
    rate = n;
    if (rt?.audio) { try { rt.audio.playbackRate = n; } catch { /* noop */ } }
    emit();
  }

  return {
    start, stop, pause, resume, toggle, skip, prev, jumpTo, updateSegments, setRate,
    isActive: () => !!rt,
    segments: () => (rt ? rt.segs : []),
    state: snapshot,
  };
}
