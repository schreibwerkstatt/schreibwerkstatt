// Vorlesen / Proof-Listening im Share-Reader (Vanilla, kein Alpine). Pendant zum
// Notebook-Proof-Listening (editor/notebook/tts-proof.js), aber standalone fuer
// die anonyme Leseansicht.
//
// Datenfluss: pro Satz ein POST /share/:token/tts { text } (token-skopiert,
// ohne Session — der authed /tts/speak-Proxy ist fuer den Leser nicht
// erreichbar). Der Server prueft, dass der Text aus dem geteilten Inhalt
// stammt, und forwarded an den Speech-Endpunkt (Kern lib/tts-synth.js).
//
// Abspiel-Schleife, Vorausladen, Wiederholen, Springen, Audio-Cache und Media
// Session kommen aus dem geteilten Kern ../tts-player.js, die Segmentierung
// aus ../tts-segment.js (beide SSoT mit dem Notebook). Hier nur: Dock-DOM,
// Scrollen gegen das Fenster, Leseposition pro Link, „ab hier" und Tastatur.
//
// Selbst-bootstrappend: share.html laedt dieses Modul als eigenes
// <script type="module">. Es liest die Reader-Config (#share-config) selbst und
// baut den Dock nur, wenn der Betreiber Vorlesen aktiviert hat (tts.enabled)
// und Lesetext vorhanden ist.
//
// Imports nur aus /js/share-reader/ und den beiden pre-auth-freien TTS-Kernen
// unter /js/ — nichts aus editor/ (zoege dem anonymen Leser das App-Bundle).

import { collectTtsSegments, hasTtsText, ttsSegmentAt } from '../tts-segment.js';
import { createTtsPlayer, ttsPointAt, ttsKeyTargetIsInteractive, TTS_RATES } from '../tts-player.js';
import { el } from './dom.js';

const ERROR_SHOW_MS = 4000;        // wie lange der Fehler-Status stehen bleibt
const POS_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const CLICK_IGNORE_SEL = 'a, button, input, textarea, span.cite, mark, .share-anchor-btn';

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* privat/blockiert */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* noop */ } }

export function setupTts({ token, article, t, locale, pause }) {
  if (!token || !article || !hasTtsText(article)) return;
  const posKey = `sw.tts.pos.${token}`;
  let errorTimer = null;
  let st = { playing: false, paused: false, loading: false, index: 0, total: 0, rate: 1 };

  // ── Dock-DOM ───────────────────────────────────────────────────────────────
  // Neutrale .dock-*-Klassen tragen Form/Tasten/Pille (css/components/floating-dock.css,
  // geteilt mit den Notebook-Docks); die tts-*-Klassen daneben tragen
  // Verankerung + Zustaende aus css/share/tts.css.
  const dock = el('div', 'dock tts-dock');
  dock.setAttribute('role', 'group');
  dock.setAttribute('aria-label', t('tts_listen'));

  const status = el('span', 'dock-status tts-status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  const subCls = 'dock-btn dock-btn--sub tts-dock-btn tts-dock-btn--sub';
  const rateBtn = el('button', `${subCls} dock-btn--text`);
  rateBtn.type = 'button';
  const prevBtn = iconButton(subCls, 'chevron-first', t('tts_prev'));
  const skipBtn = iconButton(subCls, 'chevron-last', t('tts_skip'));
  const stopBtn = iconButton(subCls, 'square', t('tts_stop'));
  const mainBtn = iconButton('dock-btn tts-dock-btn', 'headphones', t('tts_listen'));
  for (const b of [rateBtn, prevBtn, skipBtn, stopBtn]) b.hidden = true;

  dock.append(status, rateBtn, prevBtn, skipBtn, stopBtn, mainBtn);
  document.body.appendChild(dock);

  function iconButton(cls, icon, label) {
    const b = el('button', cls);
    b.type = 'button';
    b.setAttribute('data-tip', label);
    b.setAttribute('aria-label', label);
    setIcon(b, icon);
    return b;
  }
  function setIcon(btn, icon) {
    btn.innerHTML = `<svg class="icon" aria-hidden="true"><use href="/icons.svg#${icon}"/></svg>`;
  }
  function fmt(tpl, params) {
    return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`));
  }

  // ── Spieler ────────────────────────────────────────────────────────────────
  const player = createTtsPlayer({
    request: (text, signal) => fetch(`/share/${encodeURIComponent(token)}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    }),
    cacheScope: () => `share:${token}`,
    getPause: () => pause || {},
    onState: (s) => { st = s; render(); },
    // Der Reader scrollt das Fenster (kein eigener Scroll-Container wie im
    // Notebook) — nur wenn der Satz ausserhalb des sichtbaren Bereichs liegt.
    onScroll: (range) => {
      let rect = null;
      try { rect = range.getBoundingClientRect(); } catch { return; }
      if (!rect || !rect.height) return;
      const marginTop = 120;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      if (rect.top < marginTop || rect.bottom > vh - 64) {
        window.scrollTo({ top: window.scrollY + rect.top - marginTop, behavior: 'smooth' });
      }
    },
    onFailed: () => showError(),
    onStop: ({ index, seg, ended }) => {
      if (ended || !seg || index <= 0) lsDel(posKey);
      else lsSet(posKey, JSON.stringify({ i: index, text: seg.text, at: Date.now() }));
    },
  });
  const savedRate = Number(lsGet('sw.tts.rate'));
  if (TTS_RATES.includes(savedRate)) player.setRate(savedRate);

  // ── UI-Sync ──────────────────────────────────────────────────────────────
  // Tasten folgen IMMER dem Zustand; ein Fehler belegt nur kurz den Statustext.
  function render() {
    const { playing, paused } = st;
    mainBtn.setAttribute('aria-pressed', playing && !paused ? 'true' : 'false');
    mainBtn.classList.toggle('is-reading', playing && !paused);
    const mainLabel = !playing ? t('tts_listen') : (paused ? t('tts_resume') : t('tts_pause'));
    setIcon(mainBtn, !playing ? 'headphones' : (paused ? 'play' : 'pause'));
    mainBtn.setAttribute('data-tip', !playing ? t('tts_listen_hint') : mainLabel);
    mainBtn.setAttribute('aria-label', mainLabel);

    for (const b of [rateBtn, prevBtn, skipBtn, stopBtn]) b.hidden = !playing;
    rateBtn.textContent = `${st.rate}×`;
    const rateLabel = fmt(t('tts_rate'), { rate: st.rate });
    rateBtn.setAttribute('data-tip', rateLabel);
    rateBtn.setAttribute('aria-label', rateLabel);

    if (errorTimer) return;
    status.hidden = !playing;
    status.classList.remove('is-error');
    if (playing) {
      status.classList.toggle('is-paused', paused);
      status.classList.toggle('is-reading', !paused);
      status.textContent = paused
        ? t('tts_paused')
        : (st.loading ? t('tts_loading') : fmt(t('tts_reading'), { i: st.index, n: st.total }));
    }
  }
  function showError() {
    status.hidden = false;
    status.classList.remove('is-reading', 'is-paused');
    status.classList.add('is-error');
    status.textContent = t('tts_error');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { errorTimer = null; render(); }, ERROR_SHOW_MS);
  }

  // ── Steuerung ──────────────────────────────────────────────────────────────
  function collect() { return collectTtsSegments(article, locale); }

  // Start: markierter Text > gemerkte Stelle dieses Links > Anfang.
  function start() {
    const segs = collect();
    if (!segs.length) { showError(); return; }
    let idx = -1;
    const sel = window.getSelection?.();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      if (article.contains(r.startContainer)) idx = ttsSegmentAt(segs, r.startContainer, r.startOffset);
    }
    if (idx < 0) {
      let saved = null;
      try { saved = JSON.parse(lsGet(posKey) || 'null'); } catch { /* noop */ }
      if (saved && Date.now() - (saved.at || 0) < POS_MAX_AGE_MS) {
        idx = segs[saved.i]?.text === saved.text ? saved.i : segs.findIndex(s => s.text === saved.text);
      }
    }
    player.start(segs, Math.max(0, idx));
  }

  mainBtn.addEventListener('click', () => { if (player.isActive()) player.toggle(); else start(); });
  prevBtn.addEventListener('click', () => player.prev());
  skipBtn.addEventListener('click', () => player.skip());
  stopBtn.addEventListener('click', () => player.stop());
  rateBtn.addEventListener('click', () => {
    const next = TTS_RATES[(TTS_RATES.indexOf(st.rate) + 1) % TTS_RATES.length] ?? 1;
    player.setRate(next);
    lsSet('sw.tts.rate', String(next));
  });

  // Waehrend des Vorlesens: Klick in den Text springt dorthin.
  article.addEventListener('click', (e) => {
    if (!player.isActive() || e.defaultPrevented || e.button !== 0) return;
    if (e.target.closest?.(CLICK_IGNORE_SEL)) return;
    if (window.getSelection?.()?.isCollapsed === false) return;
    const pt = ttsPointAt(e.clientX, e.clientY);
    if (!pt) return;
    const idx = ttsSegmentAt(player.segments(), pt.node, pt.offset);
    if (idx >= 0) player.jumpTo(idx);
  });
  // Waehrend des Vorlesens: Leertaste = Pause/Weiter, ←/→ = Satz zurueck/vor.
  document.addEventListener('keydown', (e) => {
    if (!player.isActive() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
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
  });

  // Kein Stop beim Wechsel in den Hintergrund: wer das Display ausschaltet, um
  // zuzuhoeren, soll weiterhoeren. Steuerung dann ueber die Media Session
  // (Sperrbildschirm, Kopfhoerer-Tasten) aus dem Kern.
  render();
}

// ── Selbst-Bootstrap (share.html laedt dieses Modul direkt) ──────────────────
// DOM-guarded, damit der Import in Node/Tests keinen ReferenceError wirft.
if (typeof document !== 'undefined') {
  const boot = () => {
    const cfgEl = document.getElementById('share-config');
    if (!cfgEl) return;
    let cfg;
    try { cfg = JSON.parse(cfgEl.textContent || '{}'); } catch { return; }
    if (!cfg.token || !cfg.tts?.enabled) return;
    const article = document.getElementById('share-article');
    if (!article) return;
    const i18n = cfg.i18n || {};
    setupTts({
      token: cfg.token,
      article,
      t: (k) => i18n[k] || k,
      // Satztrennung nach der Buchsprache (dieselbe, nach der der Server die
      // Stimme waehlt) — nicht nach der Browsersprache des Lesers.
      locale: cfg.tts.lang || cfg.lang || 'de',
      pause: cfg.tts.pause,
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
