// „Buch offline halten" — Client-Hälfte. Die Ablage selbst macht der Service
// Worker (public/sw-offline.js): Buchliste, Buch, Baum und jeder Abschnitt
// eines angehefteten Buchs liegen dort in einem eigenen Cache ohne Deckel.
//
// Hier liegt die ABSICHT, pro Konto in localStorage: welche Bücher offline
// gehalten werden sollen. Der SW-Cache fällt bei jedem Sitzungswechsel (sonst
// läge ein fremdes Buch auf dem Gerät); die Absicht überlebt das, und der Boot
// stösst den Sync danach neu an. Der Sync ist inkrementell — nur geänderte
// Abschnitte gehen übers Netz.
//
// Zusätzlich zur ausdrücklichen Anheftung hält die App die ZULETZT GEÖFFNETEN
// Bücher automatisch offline (höchstens `AUTO_OFFLINE_MAX`, abschaltbar pro
// Konto und Gerät, Benutzer-Einstellungen). **Why:** angeheftet wird vor der
// Zugfahrt vergessen, und dann fehlt genau das Buch, an dem man gerade
// schreibt. Gewünscht ist damit die Menge „angeheftet ∪ zuletzt geöffnet";
// was der SW darüber hinaus hält, räumt der Abgleich (`_reconcileOfflineBooks`).
// Bei `saveData` (Datensparmodus) lädt der automatische Teil nichts vor.
//
// Mehrere Tabs teilen Absicht und SW-Ablage: die Absicht wird darum vor jedem
// Abgleich frisch aus localStorage gelesen (`_refreshOfflineIntent`), und die
// Automatik merkt sich mehr als ein Buch. **Why:** mit einem einzigen Merker
// machte ein zweiter Tab mit einem anderen Buch dessen Buch zum „zuletzt
// geöffneten" und räumte die Kopie des ersten weg, an dem dort geschrieben wird.
//
// `navigator.storage.persist()` fragt die App, sobald sie etwas offline ablegt
// (also schon beim ersten automatischen Sync, nicht erst beim Anheften): ohne
// diese Freigabe darf der Browser Caches, IndexedDB und localStorage bei
// Speicherdruck räumen (Safari nach 7 Tagen ohne Nutzung) — samt der
// Offline-Kopie und der offline geschriebenen Entwürfe.
//
// Als Methoden-Modul in die `lektorat`-Root gespreadet (app.js). Nur
// Plain-Methoden, keine Getter (Spread-Getter-Falle).
import { lsGetJSON, lsSetJSON } from '../safe-storage.js';
import { tzOpts, localeTag } from '../utils.js';
import { EVT } from '../events.js';
import { trackUsageEvent } from '../features-usage.js';

// Wartezeit nach dem Boot, bevor der Hintergrund-Sync startet: der Boot
// selbst (Baum, Plaketten, offene Seite) hat Vorrang vor dem Vorladen.
export const OFFLINE_SYNC_BOOT_DELAY_MS = 8000;

// Mindestabstand zwischen zwei „braucht Verbindung"-Toasts.
const NET_REQUIRED_TOAST_GAP_MS = 8000;

export const offlineBooksKey = (email) => `offline_books_u:${email}`;

// Gepflegte Buch-IDs eines Kontos — immer als Strings, dedupliziert.
export function readPinned(email) {
  if (!email) return [];
  const raw = lsGetJSON(offlineBooksKey(email), []);
  return Array.isArray(raw) ? [...new Set(raw.map(String))] : [];
}

export function writePinned(email, ids) {
  if (!email) return false;
  return lsSetJSON(offlineBooksKey(email), [...new Set(ids.map(String))]);
}

export const offlineAutoKey = (email) => `offline_auto_u:${email}`;

// So viele zuletzt geöffnete Bücher hält die Automatik — zwei Tabs mit je
// einem Buch sind der Normalfall.
export const AUTO_OFFLINE_MAX = 2;

function normIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((x) => x != null).map(String))].slice(0, AUTO_OFFLINE_MAX);
}

// Automatik eines Kontos auf diesem Gerät: { enabled, bookIds } (neuestes
// zuerst). Default an. Liest auch den Einzel-Merker `bookId` älterer Stände.
export function readOfflineAuto(email) {
  const raw = email ? lsGetJSON(offlineAutoKey(email), null) : null;
  const ids = Array.isArray(raw?.bookIds) ? raw.bookIds : (raw?.bookId != null ? [raw.bookId] : []);
  return { enabled: raw?.enabled !== false, bookIds: normIds(ids) };
}

export function writeOfflineAuto(email, auto) {
  if (!email) return false;
  return lsSetJSON(offlineAutoKey(email), { enabled: auto.enabled !== false, bookIds: normIds(auto.bookIds) });
}

// Neues „zuletzt geöffnet" vorne einreihen, gedeckelt. Reine Funktion.
export function noteAutoBook(bookIds, id) {
  return normIds([String(id), ...(bookIds || []).filter((x) => String(x) !== String(id))]);
}

// Bücher, die offline liegen SOLLEN: angeheftet plus (Automatik an) die
// zuletzt geöffneten. Reine Funktion, Strings, dedupliziert.
export function desiredOfflineBooks(pinned, auto) {
  const out = new Set((pinned || []).map(String));
  if (auto?.enabled !== false) for (const id of auto?.bookIds || []) out.add(String(id));
  return [...out];
}

// Bücher, die der SW hält, aber niemand mehr will (Automatik weitergezogen,
// abgeschaltet, Anheftung in einem anderen Tab aufgehoben).
export function staleOfflineBooks(held, desired) {
  const want = new Set((desired || []).map(String));
  return Object.keys(held || {}).filter((id) => !want.has(String(id)));
}

function saveDataOn() {
  try { return !!navigator.connection?.saveData; } catch { return false; }
}

// Registrierung mit aktivem Worker, sobald `serviceWorker.ready` aufgelöst hat.
let swReg = null;

// Empfänger für Nachrichten an den SW: der Controller dieses Tabs, sonst der
// aktive Worker der Registrierung. **Why:** sw.js ruft bewusst kein
// clients.claim() — nach dem Erst-Install und nach jedem harten Reload hat der
// Tab keinen Controller, obwohl ein SW läuft. Nur am Controller gemessen fehlte
// der Offline-Knopf dann bis zum nächsten normalen Reload. Ablage und Abgleich
// gehören dem SW des ganzen Origins, nicht diesem Tab (Muster:
// repo/content.js#_invalidateContentCache).
function swController() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null;
  return navigator.serviceWorker.controller || swReg?.active || null;
}

export const appOfflineBooksMethods = {
  // Einmalig im Root-init() (mit dem AbortController-Signal).
  _installOfflineBooks(signal) {
    // Ohne Verbindung abgewiesene Server-Aktion (app/boot/net-required.js):
    // einmal sagen, warum — nicht bei jedem Klick derselbe Toast.
    window.addEventListener(EVT.NET_REQUIRED, () => this._announceNetRequired(), { signal });
    // Klasse am Dokument für die gedimmten Server-Aktionen (layout-base.css).
    const markOffline = () => document.documentElement.classList.toggle('is-offline', navigator.onLine === false);
    window.addEventListener('online', markOffline, { signal });
    window.addEventListener('offline', markOffline, { signal });
    markOffline();
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    navigator.serviceWorker.addEventListener('message', (e) => this._onOfflineBookMessage(e.data), { signal });
    window.addEventListener('online', () => this._syncOfflineBooks(), { signal });
    navigator.serviceWorker.addEventListener('controllerchange', () => this._refreshOfflineCapable(), { signal });
    // Automatik: jedes geöffnete Buch wird das neue „zuletzt geöffnete".
    this.$watch(() => this.$store.nav.selectedBookId, (id) => this._noteBookOpenedForOffline(id));
    this._refreshOfflineCapable();
    // Erst-Install bzw. unkontrollierter Tab: `ready` löst auf, sobald ein
    // Worker aktiv ist (ohne Registrierung nie — dann bleibt der Knopf weg).
    navigator.serviceWorker.ready?.then((reg) => {
      if (signal?.aborted) return;
      swReg = reg;
      const wasCapable = this.$store.session.offlineCapable;
      this._refreshOfflineCapable();
      // Der Boot-Sync (_initOfflineBooksForUser) fand eventuell noch keinen
      // Worker vor — jetzt nachholen.
      if (!wasCapable && this._offlineUserReady && this._desiredOfflineBooks().length) {
        setTimeout(() => this._syncOfflineBooks(), OFFLINE_SYNC_BOOT_DELAY_MS);
      }
    }, () => {});
  },

  _announceNetRequired(now = Date.now()) {
    if (this._netRequiredAt && now - this._netRequiredAt < NET_REQUIRED_TOAST_GAP_MS) return;
    this._netRequiredAt = now;
    this._showJobToast?.({ message: this.t('offline.needsNetwork'), severity: 'warn', jobType: 'offline', bookId: null });
  },

  _refreshOfflineCapable() {
    const ctrl = swController();
    this.$store.session.offlineCapable = !!ctrl;
    if (ctrl) { try { ctrl.postMessage({ type: 'offline-book-status' }); } catch {} }
  },

  // Nach dem Config-Load (Konto bekannt): Absicht lesen, später einmal syncen.
  _initOfflineBooksForUser() {
    const email = this.$store.session.currentUser?.email;
    this.$store.session.offlinePinned = readPinned(email);
    this.$store.session.offlineAuto = readOfflineAuto(email);
    this._offlineUserReady = true;
    // Stand ohne Nachfrage lesen (persisted() fragt nie, persist() ggf. schon).
    try {
      navigator.storage?.persisted?.().then((v) => { if (v) this.$store.session.storagePersisted = true; }, () => {});
    } catch {}
    // Ein Buch, das vor dem Config-Load schon offen war, zählt jetzt.
    const open = this.$store.nav.selectedBookId;
    if (open != null) this._noteBookOpenedForOffline(open, { sync: false });
    this._reconcileOfflineBooks();
    if (this._desiredOfflineBooks().length) {
      setTimeout(() => this._syncOfflineBooks(), OFFLINE_SYNC_BOOT_DELAY_MS);
    }
  },

  _desiredOfflineBooks() {
    const s = this.$store.session;
    return desiredOfflineBooks(s.offlinePinned, saveDataOn() ? { enabled: false } : s.offlineAuto);
  },

  _syncOfflineBooks() {
    const ctrl = swController();
    if (!ctrl || navigator.onLine === false) return;
    // Offline aufgeschobenes Räumen (Buchwechsel, Automatik aus) nachholen.
    this._reconcileOfflineBooks();
    this._refreshOfflineIntent();
    const ids = this._desiredOfflineBooks();
    for (const bookId of ids) {
      try { ctrl.postMessage({ type: 'offline-book-sync', bookId }); } catch {}
    }
    if (ids.length) this._requestPersistentStorage();
  },

  // Absicht frisch aus localStorage: ein anderer Tab kann angeheftet,
  // gelöst oder ein Buch geöffnet haben.
  _refreshOfflineIntent() {
    const s = this.$store.session;
    const email = s.currentUser?.email;
    if (!email || !this._offlineUserReady) return;
    s.offlinePinned = readPinned(email);
    s.offlineAuto = readOfflineAuto(email);
  },

  // Buch geöffnet: wird das neueste „zuletzt geöffnete". Das älteste über
  // `AUTO_OFFLINE_MAX` fällt aus der Ablage, sofern es nicht angeheftet ist
  // (`_reconcileOfflineBooks`).
  _noteBookOpenedForOffline(bookId, { sync = true } = {}) {
    if (bookId == null || !this._offlineUserReady) return;
    const s = this.$store.session;
    const id = String(bookId);
    this._refreshOfflineIntent();
    if (s.offlineAuto.bookIds[0] === id) return;
    const email = s.currentUser?.email;
    s.offlineAuto = { ...s.offlineAuto, bookIds: noteAutoBook(s.offlineAuto.bookIds, id) };
    writeOfflineAuto(email, s.offlineAuto);
    if (!s.offlineAuto.enabled || saveDataOn()) return;
    this._reconcileOfflineBooks();
    if (!sync || s.offlinePinned.includes(id)) return;
    const ctrl = swController();
    if (!ctrl || navigator.onLine === false) return;
    try { ctrl.postMessage({ type: 'offline-book-sync', bookId: id }); } catch {}
    this._requestPersistentStorage();
  },

  // Schalter in den Benutzer-Einstellungen (pro Gerät).
  setOfflineAutoEnabled(enabled) {
    const s = this.$store.session;
    this._refreshOfflineIntent();
    s.offlineAuto = { ...s.offlineAuto, enabled: !!enabled };
    writeOfflineAuto(s.currentUser?.email, s.offlineAuto);
    if (enabled) {
      const ids = s.offlineAuto.bookIds;
      const ctrl = swController();
      if (ids.length && ctrl && navigator.onLine !== false && !saveDataOn()) {
        for (const id of ids) {
          try { ctrl.postMessage({ type: 'offline-book-sync', bookId: id }); } catch {}
        }
        this._requestPersistentStorage();
      }
    } else {
      this._reconcileOfflineBooks();
    }
  },

  // Räumt im SW, was nicht mehr gewünscht ist. Läuft erst, wenn sowohl das
  // Konto (Absicht) als auch der SW-Bestand bekannt sind — vorher wüsste der
  // Abgleich nicht, was gewollt ist, und würde ein angeheftetes Buch werfen.
  // Ohne Verbindung wird nie geräumt; nachgeholt wird mit dem nächsten Sync
  // (`online`-Event). **Why:** ein Buchwechsel im Zug machte das neue Buch zum
  // „zuletzt geöffneten" und warf die Kopie des vorigen weg — das neue lässt
  // sich offline nicht laden, das vorige war danach auch nicht mehr da.
  _reconcileOfflineBooks() {
    if (!this._offlineUserReady || !this._offlineStatusKnown) return;
    if (navigator.onLine === false) return;
    const ctrl = swController();
    if (!ctrl) return;
    this._refreshOfflineIntent();
    for (const id of staleOfflineBooks(this.$store.session.offlineBooks, this._desiredOfflineBooks())) {
      try { ctrl.postMessage({ type: 'offline-book-remove', bookId: id }); } catch {}
      const { [id]: _, ...rest } = this.$store.session.offlineBooks;
      this.$store.session.offlineBooks = rest;
    }
  },

  _onOfflineBookMessage(msg) {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('offline-book-')) return;
    const s = this.$store.session;
    const id = msg.bookId != null ? String(msg.bookId) : null;
    if (msg.type === 'offline-book-status') {
      s.offlineBooks = msg.books || {};
      const first = !this._offlineStatusKnown;
      this._offlineStatusKnown = true;
      if (first) this._reconcileOfflineBooks();
    } else if (msg.type === 'offline-book-progress' && id) {
      s.offlineProgress = { ...s.offlineProgress, [id]: { done: msg.done, total: msg.total } };
    } else if (msg.type === 'offline-book-synced' && id) {
      const { [id]: _, ...rest } = s.offlineProgress;
      s.offlineProgress = rest;
      s.offlineBooks = { ...s.offlineBooks, [id]: { at: msg.at, total: msg.total, failed: msg.failed || 0 } };
      this._reportOfflinePinResult(id, { result: msg.failed ? 'partial' : 'done', total: msg.total, failed: msg.failed || 0 });
    } else if (msg.type === 'offline-book-failed' && id) {
      const { [id]: _, ...rest } = s.offlineProgress;
      s.offlineProgress = rest;
      this._reportOfflinePinResult(id, { result: 'failed', status: msg.status || 0 });
      // Buch weg oder Zugriff entzogen: Anheftung aufheben. Bei einem
      // Netzfehler (status 0) bleibt sie — der nächste Sync versucht es erneut.
      if (msg.status === 403 || msg.status === 404) {
        if (this.isBookOffline(id)) this._unpinOfflineBook(id);
        else if (s.offlineAuto.bookIds.includes(id)) {
          s.offlineAuto = { ...s.offlineAuto, bookIds: s.offlineAuto.bookIds.filter((x) => x !== id) };
          writeOfflineAuto(s.currentUser?.email, s.offlineAuto);
          try { swController()?.postMessage({ type: 'offline-book-remove', bookId: id }); } catch {}
        }
      }
    }
  },

  // Ausgang des Erst-Syncs nach einem Anheften als Nutzungs-Event
  // (`offline.pin.result`). Nur der Tab, der angeheftet hat, kennt den Start —
  // die SW-Nachricht geht an alle Tabs, gemeldet wird trotzdem einmal.
  _reportOfflinePinResult(id, meta) {
    const startedAt = this._offlinePinStarted?.[id];
    if (startedAt == null) return;
    delete this._offlinePinStarted[id];
    trackUsageEvent('offline.pin.result', {
      ...meta,
      durationSec: Math.round((Date.now() - startedAt) / 1000),
      persisted: this.$store.session.storagePersisted ? 'yes' : 'no',
    }, Number(id));
  },

  isBookOffline(bookId) {
    return bookId != null && this.$store.session.offlinePinned.includes(String(bookId));
  },

  // Liegt allein über die Automatik offline (nicht angeheftet).
  isBookAutoOffline(bookId) {
    if (bookId == null || this.isBookOffline(bookId)) return false;
    const a = this.$store.session.offlineAuto;
    return a.enabled && a.bookIds.includes(String(bookId)) && !saveDataOn();
  },

  async toggleBookOffline(bookId) {
    if (bookId == null) return;
    if (this.isBookOffline(bookId)) {
      this._unpinOfflineBook(bookId);
      trackUsageEvent('offline.pin', { action: 'unpin' }, Number(bookId));
      return;
    }
    const email = this.$store.session.currentUser?.email;
    const next = [...this.$store.session.offlinePinned, String(bookId)];
    if (!writePinned(email, next)) return;
    this.$store.session.offlinePinned = next;
    trackUsageEvent('offline.pin', { action: 'pin' }, Number(bookId));
    this._offlinePinStarted = { ...this._offlinePinStarted, [String(bookId)]: Date.now() };
    this.$store.session.offlineProgress = {
      ...this.$store.session.offlineProgress, [String(bookId)]: { done: 0, total: 0 },
    };
    try { swController()?.postMessage({ type: 'offline-book-sync', bookId: String(bookId) }); } catch {}
    await this._requestPersistentStorage();
  },

  _unpinOfflineBook(bookId) {
    const id = String(bookId);
    const email = this.$store.session.currentUser?.email;
    const next = this.$store.session.offlinePinned.filter((x) => x !== id);
    writePinned(email, next);
    this.$store.session.offlinePinned = next;
    // Das zuletzt geöffnete Buch bleibt über die Automatik liegen.
    if (this._desiredOfflineBooks().includes(id)) return;
    const { [id]: _, ...books } = this.$store.session.offlineBooks;
    this.$store.session.offlineBooks = books;
    try { swController()?.postMessage({ type: 'offline-book-remove', bookId: id }); } catch {}
  },

  // Einmal anfragen; der Browser merkt sich die Antwort (Chromium entscheidet
  // ohne Dialog nach Nutzungs-Heuristik, Firefox fragt, Safari gewährt für
  // installierte Web-Apps).
  async _requestPersistentStorage() {
    const st = navigator.storage;
    if (!st?.persist || this.$store.session.storagePersisted || this._persistAsked) return;
    this._persistAsked = true;
    try {
      this.$store.session.storagePersisted = (await st.persisted?.()) || (await st.persist());
    } catch {}
  },

  // Tooltip des Sidebar-Knopfs: Zustand in einem Satz.
  offlineBookTip(bookId) {
    const id = String(bookId ?? '');
    const s = this.$store.session;
    const auto = this.isBookAutoOffline(id);
    if (!this.isBookOffline(id) && !auto) return this.t('offline.book.enable');
    const prog = s.offlineProgress[id];
    if (prog) return this.t('offline.book.syncing', { done: prog.done, total: prog.total || '…' });
    const info = s.offlineBooks[id];
    if (!info?.at) return this.t('offline.book.pending');
    const at = new Date(info.at).toLocaleString(localeTag(this.$store.shell.uiLocale),
      tzOpts({ dateStyle: 'short', timeStyle: 'short' }));
    const key = auto
      ? (info.failed ? 'offline.book.autoReadyPartial' : 'offline.book.autoReady')
      : (info.failed ? 'offline.book.readyPartial' : 'offline.book.ready');
    return this.t(key, { at, total: info.total, failed: info.failed });
  },
};
