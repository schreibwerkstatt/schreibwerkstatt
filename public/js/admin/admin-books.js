// Admin-Karte: Buecher-Uebersicht + Owner-Zuweisung fuer ownerless Buecher.
// Methoden werden in Alpine.data('adminBooksCard') gespreadet.
//
// Zuweisen geht als Picker-Popover am Knopf der Zeile auf (DESIGN.md
// „Picker-Popover"); nach dem Zuweisen wird nur diese Zeile nachgezogen — ein
// Neuladen rechnete die Bytegroessen aller Buecher neu.

import { fetchJson, sendJson, charsToNormseiten, formatNumber } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { pickerPopoverMethods } from '../picker-popover.js';
import { adminLoaderMethods } from './admin-loader.js';
import { adminFormatMethods } from './admin-format.js';

export const adminBooksMethods = {
  // ── Lifecycle: adminBooksEnter / adminBooksRefresh / _adminBooksLoad ─────
  ...adminLoaderMethods('adminBooks', {
    request: () => Promise.all([fetchJson('/admin/books'), fetchJson('/admin/users')]),
    apply([b, u]) {
      this.books = (b.books || []).map(book => ({ ...book, normseiten: charsToNormseiten(book.chars) }));
      this.users = (u.users || []).filter(usr => usr.status === 'active');
    },
  }),

  ownerlessBooks() {
    return this.books.filter(b => !b.owner_email);
  },

  ownedBooks() {
    return this.books.filter(b => b.owner_email);
  },

  fmtChars(n) {
    return formatNumber(Number(n) || 0, Alpine.store('shell').uiLocale, 0);
  },

  fmtNormseiten(chars) {
    return formatNumber(charsToNormseiten(chars), Alpine.store('shell').uiLocale, 1);
  },

  ...adminFormatMethods,

  // ── Owner zuweisen (Picker-Popover) ────────────────────────────────────────
  ...pickerPopoverMethods,

  assignBook() {
    return this.books.find(b => b.book_id === this.assignBookId) || null;
  },

  openAssign(ev, book) {
    this.assignBookId = book.book_id;
    this.assignEmail = '';
    this._openPickerPopover(ev, 'assignPopover', () => this.cancelAssign());
  },

  cancelAssign() {
    this.assignBookId = null;
    this.assignEmail = '';
    this._releasePickerPopover();
  },

  async applyAssign() {
    const book = this.assignBook();
    const email = (this.assignEmail || '').trim().toLowerCase();
    if (!book || !email || this.adminBooksBusy) return;
    this.adminBooksBusy = true;
    this.adminBooksError = '';
    try {
      const res = await sendJson(`/admin/books/${book.book_id}/assign-owner`, 'POST', { email });
      this.books = this.books.map(b => (b.book_id === book.book_id
        ? { ...b, owner_email: res.owner_email || email, acl_count: res.acl_count ?? b.acl_count }
        : b));
      this.cancelAssign();
    } catch (e) {
      this.adminBooksError = tFetchError(e);
    } finally {
      this.adminBooksBusy = false;
    }
  },
};
