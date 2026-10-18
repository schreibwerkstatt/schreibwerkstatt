// Neues Buch direkt aus der App anlegen. Trigger: Combobox-Footer-Eintrag
// "+ Neues Buch …" → Modal mit Name + Buchtyp (Pflicht) + Kategorie (Pflicht nur
// wenn der globale Pool nicht leer ist) → contentRepo.createBook, danach Buchtyp/
// Kategorie persistieren → Liste neu laden + ins neue Buch (Übersicht). Buchtyp ist Pflicht, weil alle KI-Jobs den Genre-Kontext
// über getBookPrompts ziehen; Kategorie analog zur Save-Pflicht in den Settings.
//
// Methods der Karte Alpine.data('bookCreateCard') (cards/book-create-card.js) auf
// dem <dialog>: State + Methoden leben in der Karte, nicht am Root. Root-Methoden
// (loadBooks/toggleBookSettingsCard/t) laufen über window.__app; der Trigger im
// Root-Header dispatcht `book-create:open`, die Karte hört darauf.

import { contentRepo } from '../repo/content.js';
import { fetchJson } from '../utils.js';

export const bookCreateMethods = {
  openCreateBook() {
    this.bookCreateName = '';
    // Vorschlag statt leerer Pflichtauswahl: Profil-Standard, sonst Roman —
    // der häufigste Fall; ändern kann man ihn hier und später in den Settings.
    this.bookCreateBuchtyp = this._defaultBuchtyp();
    this.bookCreateCategoryId = '';
    this.bookCreateError = '';
    this.bookCreateBusy = false;
    this._loadBookCreateCategories();
    const dlg = this.$refs?.bookCreateDialog;
    if (dlg && !dlg.open) dlg.showModal();
    this.$nextTick(() => {
      const input = this.$refs?.bookCreateInput;
      input?.focus();
    });
  },

  async _loadBookCreateCategories() {
    try {
      const pool = await fetchJson('/local/categories');
      this.bookCreateCategoryPool = pool.categories || [];
    } catch {
      this.bookCreateCategoryPool = [];
    }
  },

  _defaultBuchtyp() {
    const pref = this.$store.shell.defaultBuchtyp || '';
    const keys = this.bookCreateBuchtypOptions().map(o => o.value);
    if (pref && keys.includes(pref)) return pref;
    return keys.includes('roman') ? 'roman' : (keys[0] || '');
  },

  // Sprache/Region des neuen Buchs: Profil-Standard, sonst UI-Sprache. Die
  // Region muss zur Sprache passen (de: CH/DE, en: US/GB) — eine Profil-Region
  // der anderen Sprache fällt auf deren Default zurück.
  _newBookLangRegion() {
    const shell = this.$store.shell;
    const lang = ['de', 'en'].includes(shell.defaultBookLanguage) ? shell.defaultBookLanguage : (shell.uiLocale === 'en' ? 'en' : 'de');
    const allowed = lang === 'en' ? ['US', 'GB'] : ['CH', 'DE'];
    const region = allowed.includes(shell.defaultRegion) ? shell.defaultRegion : allowed[0];
    return { lang, region };
  },

  // Buchtyp-Labels in der UI-Sprache; Keys sind sprachübergreifend identisch.
  bookCreateBuchtypOptions() {
    const lang = this.$store.shell.uiLocale || 'de';
    const typen = this.$store.shell.promptConfig?.buchtypen?.[lang] || this.$store.shell.promptConfig?.buchtypen?.de || {};
    return Object.entries(typen).map(([key, val]) => ({ value: key, label: val.label }));
  },

  bookCreateCategoryOptions() {
    return (this.bookCreateCategoryPool || []).map(c => ({ value: String(c.id), label: c.name }));
  },

  cancelCreateBook() {
    if (this.bookCreateBusy) return;
    const dlg = this.$refs?.bookCreateDialog;
    if (dlg && dlg.open) dlg.close();
    this.bookCreateName = '';
    this.bookCreateBuchtyp = '';
    this.bookCreateCategoryId = '';
    this.bookCreateError = '';
  },

  async submitCreateBook() {
    if (this.bookCreateBusy) return;
    const app = window.__app;
    const name = (this.bookCreateName || '').trim();
    if (!name) {
      this.bookCreateError = app.t('book.create.errorEmpty');
      return;
    }
    if (!this.bookCreateBuchtyp) {
      this.bookCreateError = app.t('book.settings.buchtypRequired');
      return;
    }
    if ((this.bookCreateCategoryPool || []).length > 0 && !this.bookCreateCategoryId) {
      this.bookCreateError = app.t('book.category.required');
      return;
    }
    this.bookCreateBusy = true;
    this.bookCreateError = '';
    try {
      const created = await contentRepo.createBook({ name });
      // Buchtyp + Kategorie am frisch angelegten Buch persistieren. Best-effort:
      // schlägt es fehl, existiert das Buch trotzdem und die Werte lassen sich in
      // den Settings nachpflegen (wohin wir gleich navigieren) — kein Doppelanlegen.
      try {
        const { lang, region } = this._newBookLangRegion();
        await fetch(`/booksettings/${created.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language: lang, region, buchtyp: this.bookCreateBuchtyp }),
        });
        if (this.bookCreateCategoryId) {
          await fetch(`/books/${created.id}/category`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category_id: parseInt(this.bookCreateCategoryId, 10) }),
          });
        }
      } catch (persistErr) {
        console.error('[book-create] Buchtyp/Kategorie persistieren fehlgeschlagen:', persistErr);
      }
      const dlg = this.$refs?.bookCreateDialog;
      if (dlg && dlg.open) dlg.close();
      this.bookCreateName = '';
      this.bookCreateBuchtyp = '';
      this.bookCreateCategoryId = '';
      await app.loadBooks({ fresh: true });
      // Ins neue Buch wie beim Beispielbuch über den Hash: `_applyHash` lädt den
      // (leeren) Baum und öffnet die Übersicht; die Sidebar bietet dort «Erstes
      // Kapitel anlegen». Buchtyp/Sprache sind schon gesetzt — die Settings
      // wären ein Umweg vor der ersten Zeile.
      window.location.hash = '#book/' + created.id;
    } catch (e) {
      const msg = e.detail || e.code || e.message || String(e);
      this.bookCreateError = app.t('book.create.errorGeneric', { msg });
    } finally {
      this.bookCreateBusy = false;
    }
  },
};
