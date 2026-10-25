// Admin-Karte fuer den Kategorien-Pool. CRUD-Methoden werden in
// Alpine.data('adminCategoriesCard') gespreadet.

import { fetchJson, sendJson } from '../utils.js';
import { tFetchErrorRaw } from '../i18n.js';

export const adminCategoriesMethods = {
  async loadAll() {
    this.loading = true;
    this.error = '';
    try {
      const c = await fetchJson('/local/categories');
      this.categories = c.categories || [];
    } catch (e) {
      this.error = tFetchErrorRaw(e);
    } finally {
      this.loading = false;
    }
  },

  async createCategory() {
    const name = (this.newCategoryName || '').trim();
    if (!name) return;
    this.busy = true;
    try {
      await sendJson('/local/categories', 'POST', { name });
      this.newCategoryName = '';
      await this.loadAll();
    } catch (e) {
      this.error = tFetchErrorRaw(e);
    } finally {
      this.busy = false;
    }
  },

  async renameCategory(cat) {
    const next = await window.__app.appPrompt({ message: window.__app.t('admin.cat.renamePrompt'), defaultValue: cat.name });
    if (!next || next.trim() === cat.name) return;
    try {
      await sendJson(`/local/categories/${cat.id}`, 'PUT', { name: next.trim() });
      await this.loadAll();
    } catch (e) {
      this.error = tFetchErrorRaw(e);
    }
  },

  async deleteCategory(cat) {
    if (!await window.__app.appConfirm({
      message: window.__app.t('admin.cat.deleteConfirm', { name: cat.name }),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    })) return;
    try {
      await sendJson(`/local/categories/${cat.id}`, 'DELETE');
      await this.loadAll();
    } catch (e) {
      this.error = tFetchErrorRaw(e);
    }
  },

};
