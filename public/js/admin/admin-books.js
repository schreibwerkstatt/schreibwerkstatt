// Admin-Karte: Buecher-Uebersicht + Owner-Zuweisung fuer ownerless Buecher.
// Methoden werden in Alpine.data('adminBooksCard') gespreadet.

import { fetchJson, sendJson, charsToNormseiten, formatNumber, fmtBytes } from '../utils.js';
import { tFetchError } from '../i18n.js';

export const adminBooksMethods = {
  async loadAll() {
    this.loading = true;
    this.error = '';
    try {
      const [b, u] = await Promise.all([
        fetchJson('/admin/books'),
        fetchJson('/admin/users'),
      ]);
      this.books = (b.books || []).map(book => ({
        ...book,
        normseiten: charsToNormseiten(book.chars),
      }));
      this.users = (u.users || []).filter(usr => usr.status === 'active');
    } catch (e) {
      this.error = tFetchError(e);
    } finally {
      this.loading = false;
    }
  },

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

  fmtBytes(n) {
    return fmtBytes(Number(n) || 0, Alpine.store('shell').uiLocale);
  },

  async assignOwner(book) {
    const email = (this.assignTarget?.[book.book_id] || '').trim().toLowerCase();
    if (!email) {
      this.error = window.__app.t('admin.books.error.emailRequired');
      return;
    }
    if (!await window.__app.appConfirm({
      message: window.__app.t('admin.books.assignConfirm', { name: book.name, email }),
      confirmLabel: window.__app.t('admin.books.assignBtn'),
    })) return;

    this.busy = true;
    this.error = '';
    try {
      await sendJson(`/admin/books/${book.book_id}/assign-owner`, 'POST', { email });
      await this.loadAll();
    } catch (e) {
      this.error = tFetchError(e);
    } finally {
      this.busy = false;
    }
  },
};
