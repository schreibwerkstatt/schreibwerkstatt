// Admin-Karte fuer den Kategorien-Pool. CRUD-Methoden werden in
// Alpine.data('adminCategoriesCard') gespreadet. Jede Aenderung laeuft unter
// `adminCategoriesBusy` — ein zweiter Klick waehrend des Requests tut nichts.

import { fetchJson, sendJson } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { adminLoaderMethods, assignIfChanged } from './admin-loader.js';

export const adminCategoriesMethods = {
  // ── Lifecycle: adminCategoriesEnter / …Refresh / _adminCategoriesLoad ────
  ...adminLoaderMethods('adminCategories', {
    request: () => fetchJson('/local/categories'),
    apply(c, { silent }) { assignIfChanged(this, 'categories', c.categories || [], silent); },
  }),

  // Fuehrt `fn` unter dem Busy-Guard aus und laedt danach die Liste neu.
  async _adminCategoriesMutate(fn) {
    if (this.adminCategoriesBusy) return;
    this.adminCategoriesBusy = true;
    this.adminCategoriesError = '';
    try {
      await fn();
      await this._adminCategoriesLoad();
    } catch (e) {
      this.adminCategoriesError = tFetchError(e);
    } finally {
      this.adminCategoriesBusy = false;
    }
  },

  async createCategory() {
    const name = (this.newCategoryName || '').trim();
    if (!name) return;
    await this._adminCategoriesMutate(async () => {
      await sendJson('/local/categories', 'POST', { name });
      this.newCategoryName = '';
    });
  },

  async renameCategory(cat) {
    if (this.adminCategoriesBusy) return;
    const next = await window.__app.appPrompt({ message: window.__app.t('admin.cat.renamePrompt'), defaultValue: cat.name });
    if (!next || next.trim() === cat.name) return;
    await this._adminCategoriesMutate(() => sendJson(`/local/categories/${cat.id}`, 'PUT', { name: next.trim() }));
  },

  async deleteCategory(cat) {
    if (this.adminCategoriesBusy) return;
    if (!await window.__app.appConfirm({
      message: window.__app.t('admin.cat.deleteConfirm', { name: cat.name }),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    })) return;
    await this._adminCategoriesMutate(() => sendJson(`/local/categories/${cat.id}`, 'DELETE'));
  },
};
