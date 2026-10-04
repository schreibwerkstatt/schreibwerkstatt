'use strict';
// Reader-Frontend für geteilte Seiten/Kapitel (Beta-Leser-Feedback).
// Standalone, kein Alpine, kein SPA-Bundle. Progressive Enhancement über die
// SSR-View (public/share.html): ohne JS funktioniert die allgemeine Kommentar-
// Form weiter; mit JS kommen verankerte Inline-Anmerkungen + Threads dazu.
//
// Verankerung: jede Anmerkung haftet an einem Block via dessen data-bid
// (lib/html-clean.js#ensureBlockIds) + dem markierten Quote-Text. Beim Rendern
// wird re-verankert (Quote im Block suchen) — der Buchinhalt ist live, Offsets
// driften. Findet sich der Quote nicht mehr, bleibt der Thread gelistet, aber
// ohne Inline-Highlight ("Stelle geändert").
//
// Facade + gekoppelter Kern (State, Highlights, Auswahl, Live-Poll).
// Widgets unter share-reader/: dom/api/identity/menu/theme/toc/layout/composer/
// thread-render/sheet (hier importiert) sowie dwell/read-depth/resume/reading-prefs/back-to-top/feedback/tts
// (direkt aus share.html geladen, lesen #share-config selbst).

import { locateRange, locateApprox, caretPosFromPoint } from './share-anchor.js';
import { groupThreads } from './editor/comment-threads.js';
import { bindScrollFade } from './scroll-fade.js';
import { el, parseTs, submitOnModEnter } from './share-reader/dom.js';
import { createApi } from './share-reader/api.js';
import { createThreadRenderer } from './share-reader/thread-render.js';
import { createThreadSheet } from './share-reader/sheet.js';
import {
  readerToken, savedName, savedEmail, markNameDismissed, closeNameModal, setupIdentity,
} from './share-reader/identity.js';
import { createOptionsMenu } from './share-reader/menu.js';
import { setupThemeSwitcher } from './share-reader/theme.js';
import { setupToc } from './share-reader/toc.js';
import { setupProgressBar } from './share-reader/progress.js';
import { createCardLayout, FLAT_BELOW } from './share-reader/layout.js';
import { setupComposer } from './share-reader/composer.js';
import { setupWakeLock } from './share-reader/wakelock.js';

(function () {
  const cfgEl = document.getElementById('share-config');
  if (!cfgEl) return;
  let CFG;
  try { CFG = JSON.parse(cfgEl.textContent || '{}'); } catch { return; }
  const TOKEN = CFG.token;
  const I18N = CFG.i18n || {};
  if (!TOKEN) return;

  const t = (k) => I18N[k] || k;
  const article = document.getElementById('share-article');
  // Verankerte Anmerkungen leben in der schwebenden Leiste rechts
  // (.share-comments__list = Positionierungs-Ebene), allgemeine Kommentare in der
  // abgesetzten Sektion unten (.share-general__list) mit eigener Form.
  const list = document.querySelector('.share-comments__list');
  const generalList = document.querySelector('.share-general__list');
  // Layout-Wurzel: bekommt .share-has-comments nur, wenn verankerte Anmerkungen
  // existieren. Sonst bleibt im Desktop-Grid die Kommentar-Spalte ungenutzt und
  // der Text säße links daneben statt mittig (siehe share.css ≥1100px).
  const layoutEl = document.querySelector('.share-layout');
  const supportsHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  const RT = readerToken();

  // ── Optionen-Menü (⋯) + sekundäre Cluster (Identität, Theme, TOC) ────────────
  // Reihenfolge bestimmt die Sektions-Folge im Panel: Identität → Theme → TOC.
  const { menuSection } = createOptionsMenu({ t });
  setupIdentity({ t, menuSection, onIdentityChange: syncReaderIdentity });
  setupThemeSwitcher({ t, menuSection });
  setupToc({ menuSection });
  setupProgressBar();
  setupWakeLock();

  // Auto-Hide-Scrollbar am TOC (≥1100px eigener Scroll-Container), gleiches
  // Pattern wie Sidebar-Tree + Bucheditor-Inhaltsverzeichnis in der SPA. Die
  // Kommentar-Leiste scrollt mit dem Fenster mit (schwebende Karten) — kein
  // eigener Scroll-Container, daher kein Scroll-Fade dort.
  bindScrollFade(document.querySelector('.share-toc'));

  // ── State ──────────────────────────────────────────────────────────────────
  let comments = [];          // flache Liste (serverseitig serialisiert)
  const anchorRanges = [];    // { id, range } für Klick-Mapping
  let activeId = null;        // gerade fokussierter Thread

  // Ungelesen-Tracking (#2): welche Kommentar-IDs hat dieser Browser schon
  // gesehen? Rein clientseitig (Leser hat keinen Account), pro Link-Token in
  // localStorage. Ein Thread mit fremden (nicht eigenen) Antworten, deren ID hier
  // fehlt, gilt als „neu beantwortet" → Badge. Wird beim Öffnen des Threads
  // (setActive) als gesehen markiert.
  const SEEN_KEY = 'sw_share_seen_' + TOKEN;
  function loadSeen() {
    try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
  }
  let seen = loadSeen();
  function saveSeen() { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-1000))); } catch {} }
  // Ungelesene fremde Antworten eines Threads (Autor- oder andere Leser-Beiträge,
  // die dieser Browser noch nicht gesehen hat). Eigene Beiträge zählen nie.
  function unseenReplies(node) {
    return node.replies.filter(r => !r.mine && !seen.has(r.id));
  }
  function markThreadSeen(node) {
    if (!node) return false;
    let changed = false;
    for (const c of [node.root, ...node.replies]) {
      if (!seen.has(c.id)) { seen.add(c.id); changed = true; }
    }
    if (changed) saveSeen();
    return changed;
  }
  function threadById(id) {
    return groupThreads(comments).find(n => n.root.id === id) || null;
  }

  // Vertikale Verankerung der schwebenden Karten (Google-Docs-Modell).
  const cardLayout = createCardLayout({
    article: () => article,
    getLayer: () => list,
    getAnchoredCards: () => comments
      .filter(c => !c.parent_id && c.anchor)
      .map(c => ({ id: c.id, anchor: c.anchor })),
    getActiveId: () => activeId,
  });
  cardLayout.init();

  // ── API (share-reader/api.js) ────────────────────────────────────────────────
  const api = createApi({ token: TOKEN, rt: RT, savedEmail });

  // Leichtgewichtige Signatur über die Threads — erkennt neue/aufgelöste
  // Kommentare und Antworten, ohne bei jedem Poll-Tick neu zu rendern (sonst
  // Scroll-Reset + verlorene halb getippte Antwort).
  function commentsSig(arr) {
    return arr.map(c => `${c.id}:${c.parent_id || 0}:${c.resolved ? 1 : 0}:${(c.body || '').length}`).join('|');
  }
  let lastSig = null;
  async function fetchThreads() {
    try {
      const next = await api.fetchThreads();
      if (!next) return;
      const sig = commentsSig(next);
      comments = next;
      if (sig === lastSig) return; // keine Änderung → kein Reflow
      lastSig = sig;
      render();
    } catch {}
  }

  // Identitäts-Änderung (Name + optionale Mail) am Chip auf die bisherigen eigenen
  // Kommentare dieses Browsers (reader_token) übertragen und die Threads neu laden,
  // damit Name/Benachrichtigungs-Status sofort konsistent sind.
  async function syncReaderIdentity(name, email) {
    await api.syncIdentity(name, email);
    lastSig = null; // Re-Render erzwingen (Body-Signatur ändert sich nicht)
    fetchThreads();
  }

  // Re-Anchoring (`locateRange(rootEl, anchor)`) kommt aus share-anchor.js (SSoT,
  // geteilt mit der Owner-Karte) — kein lokales Duplikat. Die Selektions-→Anker-
  // Logik (charOffset) lebt im Composer-Widget (share-reader/composer.js).

  // ── Highlights (CSS Custom Highlight API) ────────────────────────────────────
  function renderHighlights() {
    anchorRanges.length = 0;
    if (!supportsHighlight) return;
    const hl = new Highlight();
    const active = new Highlight();
    const changed = new Highlight();
    for (const c of comments) {
      if (c.parent_id || !c.anchor) continue;
      // Erledigte Kommentare bleiben in der Leiste und anspringbar (anchorRanges +
      // transientes Aktiv-Highlight beim Anklicken), werden aber nicht mehr
      // dauerhaft im Manuskript markiert.
      const resolved = !!c.resolved;
      const range = locateRange(article, c.anchor);
      if (range) {
        c._stale = false; c._approx = false;
        anchorRanges.push({ id: c.id, range });
        if (c.id === activeId) active.add(range);
        else if (!resolved) hl.add(range);
        continue;
      }
      // Quote nicht mehr wörtlich da (Text seither geändert), Block aber noch:
      // ungefähren Fuzzy-Span markieren statt gar nichts.
      const approx = locateApprox(article, c.anchor);
      if (approx) {
        c._stale = false; c._approx = true;
        anchorRanges.push({ id: c.id, range: approx.range });
        if (!resolved) changed.add(approx.range);
        continue;
      }
      c._stale = true; c._approx = false;
    }
    CSS.highlights.set('share-anchor', hl);
    CSS.highlights.set('share-anchor-active', active);
    CSS.highlights.set('share-anchor-changed', changed);
  }

  // ── Thread-Karten (share-reader/thread-render.js) ────────────────────────────
  // Gruppierung kommt aus dem geteilten pure Kern (editor/comment-threads.js,
  // SSoT mit der Owner-Leiste) — Roots + chronologisch sortierte Antworten.
  const { renderThread: renderThreadCard } = createThreadRenderer({
    t, article, api, savedName,
    reload: fetchThreads,
    setActive: (id) => setActive(id),
    scrollToAnchor: (id) => scrollToAnchor(id),
    isAnchorLocated: (c) => !c._stale,
    unseenReplies,
    markThreadSeen,
    onResize: () => cardLayout.schedule(),
  });
  const renderThread = (node) => renderThreadCard(node, { activeId });

  // Mobile: Tipp auf eine Markierung öffnet den Thread als Bottom-Sheet über der
  // Lesestelle (statt ans Ende der Liste zu scrollen).
  const sheet = createThreadSheet({
    t, renderThread,
    onClose: () => { if (activeId != null) { activeId = null; renderHighlights(); clearSelected(); } },
  });
  const isFlat = () => !!(window.matchMedia && window.matchMedia(FLAT_BELOW).matches);

  const byTime = (a, b) => parseTs(a.root.created_at) - parseTs(b.root.created_at);

  // Hinweis „Markiere eine Textstelle …" unter der Überschrift der allgemeinen
  // Sektion, solange es keine verankerten Anmerkungen gibt — die Leiste selbst
  // bleibt dann ausgeblendet (kein zweiter Leer-Zustand).
  let anchorHint = null;
  function syncAnchorHint(show) {
    if (!generalList) return;
    if (show && !anchorHint) {
      anchorHint = el('p', 'share-general__hint', t('threads_empty'));
      generalList.before(anchorHint);
    } else if (!show && anchorHint) {
      anchorHint.remove();
      anchorHint = null;
    }
  }

  function render() {
    // Erst re-verankern: setzt _stale/_approx, das die Karten (Anker-Zeile,
    // Auswahl-Klick) beim Aufbau lesen.
    renderHighlights();
    const tree = groupThreads(comments);
    const anchored = tree.filter(n => n.root.anchor).sort(byTime);
    const general = tree.filter(n => !n.root.anchor).sort(byTime);

    // Kommentar-Leiste (und ihre Grid-Spalte) nur einblenden, wenn es verankerte
    // Anmerkungen gibt — sonst zentriert die Lesespalte, mobil entfällt der Block.
    if (layoutEl) layoutEl.classList.toggle('share-has-comments', anchored.length > 0);
    syncAnchorHint(!anchored.length);

    // Verankerte Anmerkungen → schwebende Leiste rechts. Pro Karte ein Marker-Tick
    // (echte Anker-Höhe, vom Layout positioniert), damit verschobene Karten ihren
    // Bezug zur Textstelle behalten.
    if (list) {
      list.innerHTML = '';
      // Frische, noch unpositionierte Karten → wieder ausblenden, bis das Layout
      // sie platziert hat (kein „Auffliegen" der neuen Karten beim Re-Render).
      list.classList.remove('is-positioned');
      for (const node of anchored) {
        const marker = el('div', 'share-thread-marker');
        marker.setAttribute('data-marker-for', node.root.id);
        marker.setAttribute('aria-hidden', 'true');
        list.appendChild(marker);
        list.appendChild(renderThread(node));
      }
    }

    // Allgemeine Kommentare → abgesetzte Sektion unten (eigene Form darunter).
    if (generalList) {
      generalList.innerHTML = '';
      if (!general.length) {
        generalList.appendChild(el('li', 'share-comments__empty', t('comments_empty')));
      } else {
        for (const node of general) generalList.appendChild(renderThread(node));
      }
    }

    sheet.refresh(threadById);
    cardLayout.schedule();
  }

  function scrollToAnchor(id) {
    sheet.close();
    setActive(id, { reveal: false });
    const found = anchorRanges.find(a => a.id === id);
    if (found) {
      const rect = found.range.getBoundingClientRect();
      if (rect && rect.height) {
        window.scrollTo({ top: window.scrollY + rect.top - 120, behavior: 'smooth' });
      }
    }
  }
  function clearSelected() {
    document.querySelectorAll('.comment-rail__thread--selected').forEach(e => e.classList.remove('comment-rail__thread--selected'));
  }
  // reveal: im Flach-Modus (Mobile) die Karte in der Liste ins Bild scrollen —
  // nicht, wenn die Auswahl aus dem Sheet oder einem Sprung zur Textstelle kommt.
  function setActive(id, { reveal = true } = {}) {
    activeId = id;
    renderHighlights();
    // Öffnen markiert neue Antworten dieses Threads als gesehen.
    if (markThreadSeen(threadById(id))) {
      document.querySelectorAll(`.share-thread[data-comment-id="${id}"] .share-thread__unread`).forEach(b => b.remove());
    }
    clearSelected();
    document.querySelectorAll(`.share-thread[data-comment-id="${id}"]`).forEach(c => c.classList.add('comment-rail__thread--selected'));
    const card = list && list.querySelector(`.share-thread[data-comment-id="${id}"]`);
    if (card) {
      // Auswahl pinnt die aktive Karte auf ihre exakte Anker-Höhe und verteilt die
      // übrigen darum herum → Layout neu rechnen.
      cardLayout.schedule();
      if (reveal && isFlat() && !sheet.isOpen()) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ── Klick auf Highlight → Thread fokussieren ─────────────────────────────────
  if (article) {
    article.addEventListener('click', (ev) => {
      if (!anchorRanges.length) return;
      const pos = caretPosFromPoint(ev.clientX, ev.clientY);
      if (!pos || !pos.node) return;
      for (const a of anchorRanges) {
        try {
          if (!a.range.isPointInRange(pos.node, pos.offset)) continue;
          // Mobile: Thread als Sheet über der Lesestelle, statt zur Liste
          // unter dem Artikel zu springen.
          if (isFlat()) { setActive(a.id, { reveal: false }); sheet.open(threadById(a.id)); }
          else setActive(a.id);
          return;
        } catch {}
      }
    });
  }

  // ── Selektions-Button + Composer-Overlay (Widget) ────────────────────────────
  const composer = setupComposer({
    t, article, postComment: api.postComment, savedName,
    onPosted: fetchThreads,
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('share-name-modal')) { markNameDismissed(); closeNameModal(); }
    composer.closeComposer();
    sheet.close();
  });

  // ── Allgemeine Kommentar-Form (SSR) an JSON-Pfad koppeln ─────────────────────
  const form = document.getElementById('share-comment-form');
  if (form) {
    const status = document.getElementById('share-comment-status');
    // Mit JS kommt der Name global aus dem Identitäts-Chip (oben rechts) — das
    // beschriftete Server-Feld entfällt. Ohne JS bleibt es als Fallback stehen.
    const nameField = form.elements['reader_name'];
    const nameLabel = nameField ? nameField.closest('.share-comments__label') : null;
    if (nameLabel) nameLabel.remove();
    submitOnModEnter(form.elements['body'], () => form.requestSubmit());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      status.textContent = '';
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      const body = (form.elements['body'].value || '').trim();
      const hp = (form.elements['_hp'].value || '').trim();
      if (!body) { status.textContent = form.dataset.emptyMsg; submit.disabled = false; return; }
      try {
        await api.postComment({ body, reader_name: savedName(), _hp: hp });
        form.elements['body'].value = '';
        status.textContent = form.dataset.successMsg;
        await fetchThreads();
      } catch (err) {
        status.textContent = err.status === 429 ? form.dataset.rateMsg
          : form.dataset.errorMsg + (err.message ? ' (' + err.message + ')' : '');
      } finally {
        submit.disabled = false;
      }
    });
  }

  // Re-Anchor bei Resize (Block-Geometrie ändert sich) — Highlights neu malen.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderHighlights, 200);
  });

  // ── Live-Poll: Autor-Antworten ohne Reload sichtbar machen ───────────────────
  // Pendant zum 5-s-Poll der Owner-Karte. fetchThreads() rendert nur bei echter
  // Änderung (Signatur), trotzdem pausieren wir, solange der Leser gerade tippt
  // oder selektiert — sonst würde ein Tick den Composer/Selektions-Flow oder
  // einen halb getippten Beitrag stören. Hintergrund-Tab wird übersprungen.
  const POLL_MS = 10000;
  function readerBusy() {
    if (composer.isBusy()) return true; // Composer offen oder Text gerade markiert
    if (document.getElementById('share-name-modal')) return true;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return true;
    // Halb getippten, gerade unfokussierten Beitrag nicht verwerfen.
    for (const ta of document.querySelectorAll('textarea')) {
      if ((ta.value || '').trim()) return true;
    }
    return false;
  }
  setInterval(() => {
    if (document.hidden || readerBusy()) return;
    fetchThreads();
  }, POLL_MS);

  // Start.
  fetchThreads();
})();
