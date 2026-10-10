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
// Beim ersten Anheften fragt die App `navigator.storage.persist()` an: ohne
// diese Freigabe darf der Browser Caches und localStorage bei Speicherdruck
// räumen (Safari nach 7 Tagen ohne Nutzung) — samt der Offline-Kopie und der
// offline geschriebenen Entwürfe.
//
// Als Methoden-Modul in die `lektorat`-Root gespreadet (app.js). Nur
// Plain-Methoden, keine Getter (Spread-Getter-Falle).
import { lsGetJSON, lsSetJSON } from '../safe-storage.js';
import { tzOpts, localeTag } from '../utils.js';

// Wartezeit nach dem Boot, bevor der Hintergrund-Sync startet: der Boot
// selbst (Baum, Plaketten, offene Seite) hat Vorrang vor dem Vorladen.
export const OFFLINE_SYNC_BOOT_DELAY_MS = 8000;

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

function swController() {
  return (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) || null;
}

export const appOfflineBooksMethods = {
  // Einmalig im Root-init() (mit dem AbortController-Signal).
  _installOfflineBooks(signal) {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    navigator.serviceWorker.addEventListener('message', (e) => this._onOfflineBookMessage(e.data), { signal });
    window.addEventListener('online', () => this._syncOfflineBooks(), { signal });
    // Kontrolliert erst nach dem Erst-Install — dann wird der Knopf sichtbar.
    navigator.serviceWorker.addEventListener('controllerchange', () => this._refreshOfflineCapable(), { signal });
    this._refreshOfflineCapable();
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
    if (this.$store.session.offlinePinned.length) {
      setTimeout(() => this._syncOfflineBooks(), OFFLINE_SYNC_BOOT_DELAY_MS);
    }
  },

  _syncOfflineBooks() {
    const ctrl = swController();
    if (!ctrl || navigator.onLine === false) return;
    for (const bookId of this.$store.session.offlinePinned) {
      try { ctrl.postMessage({ type: 'offline-book-sync', bookId }); } catch {}
    }
  },

  _onOfflineBookMessage(msg) {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('offline-book-')) return;
    const s = this.$store.session;
    const id = msg.bookId != null ? String(msg.bookId) : null;
    if (msg.type === 'offline-book-status') {
      s.offlineBooks = msg.books || {};
    } else if (msg.type === 'offline-book-progress' && id) {
      s.offlineProgress = { ...s.offlineProgress, [id]: { done: msg.done, total: msg.total } };
    } else if (msg.type === 'offline-book-synced' && id) {
      const { [id]: _, ...rest } = s.offlineProgress;
      s.offlineProgress = rest;
      s.offlineBooks = { ...s.offlineBooks, [id]: { at: msg.at, total: msg.total, failed: msg.failed || 0 } };
    } else if (msg.type === 'offline-book-failed' && id) {
      const { [id]: _, ...rest } = s.offlineProgress;
      s.offlineProgress = rest;
      // Buch weg oder Zugriff entzogen: Anheftung aufheben. Bei einem
      // Netzfehler (status 0) bleibt sie — der nächste Sync versucht es erneut.
      if (msg.status === 403 || msg.status === 404) this._unpinOfflineBook(id);
    }
  },

  isBookOffline(bookId) {
    return bookId != null && this.$store.session.offlinePinned.includes(String(bookId));
  },

  async toggleBookOffline(bookId) {
    if (bookId == null) return;
    if (this.isBookOffline(bookId)) { this._unpinOfflineBook(bookId); return; }
    const email = this.$store.session.currentUser?.email;
    const next = [...this.$store.session.offlinePinned, String(bookId)];
    if (!writePinned(email, next)) return;
    this.$store.session.offlinePinned = next;
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
    const { [id]: _, ...books } = this.$store.session.offlineBooks;
    this.$store.session.offlineBooks = books;
    try { swController()?.postMessage({ type: 'offline-book-remove', bookId: id }); } catch {}
  },

  // Einmal anfragen; der Browser merkt sich die Antwort (Chromium entscheidet
  // ohne Dialog nach Nutzungs-Heuristik, Firefox fragt, Safari gewährt für
  // installierte Web-Apps).
  async _requestPersistentStorage() {
    const st = navigator.storage;
    if (!st?.persist) return;
    try {
      this.$store.session.storagePersisted = (await st.persisted?.()) || (await st.persist());
    } catch {}
  },

  // Tooltip des Sidebar-Knopfs: Zustand in einem Satz.
  offlineBookTip(bookId) {
    const id = String(bookId ?? '');
    const s = this.$store.session;
    if (!this.isBookOffline(id)) return this.t('offline.book.enable');
    const prog = s.offlineProgress[id];
    if (prog) return this.t('offline.book.syncing', { done: prog.done, total: prog.total || '…' });
    const info = s.offlineBooks[id];
    if (!info?.at) return this.t('offline.book.pending');
    const at = new Date(info.at).toLocaleString(localeTag(this.$store.shell.uiLocale),
      tzOpts({ dateStyle: 'short', timeStyle: 'short' }));
    const key = info.failed ? 'offline.book.readyPartial' : 'offline.book.ready';
    return this.t(key, { at, total: info.total, failed: info.failed });
  },
};
