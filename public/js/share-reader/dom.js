'use strict';
// Geteilte DOM-Mini-Helfer für die Reader-Module (Standalone, kein Alpine).

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// DB-Zeitstempel → Date. Ältere Zeilen tragen das SQLite-Format ohne Zone
// ("YYYY-MM-DD HH:MM:SS", UTC) — ohne Normalisierung läse der Browser es als
// Lokalzeit.
export function parseTs(iso) {
  const s = String(iso || '');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return new Date(s.replace(' ', 'T') + 'Z');
  return new Date(s);
}

// Locale der Seite (<html lang>, serverseitig aus Accept-Language), verfeinert um
// die Region des Browsers, wenn die Sprache übereinstimmt (de + de-CH → de-CH).
function readerLocale() {
  const lang = (document.documentElement.lang || '').toLowerCase();
  const nav = (navigator.language || '').toLowerCase();
  if (lang && nav.startsWith(lang)) return navigator.language;
  return lang || undefined;
}

// Reader-lokale Browserzeit (anonymer Leser, keine app.timezone-Setting).
// Kurzform ohne Sekunden für die Meta-Zeile, Langform für den Tooltip.
export function fmtDate(iso, style = 'short') {
  const d = parseTs(iso);
  if (isNaN(d)) return String(iso || '');
  const opts = style === 'full'
    ? { dateStyle: 'full', timeStyle: 'short' }
    : { dateStyle: 'medium', timeStyle: 'short' };
  try { return d.toLocaleString(readerLocale(), opts); } catch { return d.toLocaleString(); }
}

// <time datetime> mit Kurzform als Text und Langform als Tooltip.
export function timeEl(iso, cls) {
  const t = el('time', cls, fmtDate(iso));
  const d = parseTs(iso);
  if (!isNaN(d)) t.dateTime = d.toISOString();
  t.title = fmtDate(iso, 'full');
  return t;
}

// Strg/Cmd+Enter in einem Textfeld löst `fn` aus (Senden ohne Maus).
export function submitOnModEnter(field, fn) {
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); fn(); }
  });
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type=hidden]), [tabindex]:not([tabindex="-1"])';

// Overlay als modalen Dialog auszeichnen: role/aria-modal/aria-labelledby, Tab
// zirkuliert innerhalb von `card`. Liefert `release()`, das den Fokus an das
// vorher fokussierte Element zurückgibt.
export function makeModal(overlay, card, titleEl) {
  const prev = document.activeElement;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  if (titleEl) {
    if (!titleEl.id) titleEl.id = 'share-dlg-' + Math.random().toString(36).slice(2, 9);
    card.setAttribute('aria-labelledby', titleEl.id);
  }
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...card.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  return function release() {
    if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
      try { prev.focus({ preventScroll: true }); } catch {}
    }
  };
}
