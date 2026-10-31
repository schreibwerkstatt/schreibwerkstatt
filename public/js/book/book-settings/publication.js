// Teil von bookSettingsMethods (siehe Facade book-settings.js).
// Reiter «Publikation»: book_publication (Cover/Titelei/Bio/Klappentext,
// geteilt mit PDF- und EPUB-Export). Eigener Schreibpfad /publication/:id,
// gespeichert über den Kopf-Knopf (save-paths.js).

import { fetchJson } from './_shared.js';

export const publicationMethods = {
  /** Vergleichsstand für «ungespeichert»: ohne die Bild-Flags — die setzen
   *  Upload/Entfernen sofort auf dem Server, sie sind keine Formular-Eingabe. */
  _publicationSnapshot() {
    const { has_cover, has_author_image, ...rest } = this.bookPublication || {};
    return rest;
  },

  async loadPublication(bookId = this._selectedBookId()) {
    if (!bookId) return;
    try {
      const data = await fetchJson(`/publication/${bookId}`);
      if (!this._isFormBook(bookId)) return;
      this.bookPublication = data;
      this.bookPublicationLoaded = true;
      this._markClean('publication');
    } catch (e) {
      console.error('[book-settings] Publikation laden fehlgeschlagen:', e);
    }
  },

  async savePublication(bookId = this._formBookId) {
    // Nicht speichern, bevor die Meta geladen ist — ein ungeladenes Default-
    // Objekt würde den DB-Stand überschreiben.
    if (!bookId || !this.bookPublicationLoaded) return false;
    this.pubSaving = true; this.pubSaved = false; this.pubError = '';
    const sent = this._snapKey('publication');
    try {
      // Volle geladene Meta zurückschreiben: validateMeta whitelistet
      // serverseitig (Extra-Keys wie has_cover ignoriert), so bleiben auch die
      // Felder der EPUB-Karte (Typografie/OPF) erhalten.
      const r = await fetch(`/publication/${bookId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(this.bookPublication || {}) }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(window.__app.tError(d)); }
      const saved = await r.json();
      if (this._isFormBook(bookId)) {
        this._settleSave('publication', sent, () => {
          // Bild-Flags sind lokal ggf. frischer als die Antwort des PUT.
          const { has_cover, has_author_image } = this.bookPublication || {};
          this.bookPublication = { ...saved, has_cover, has_author_image };
        });
      }
      this.pubSaved = true;
      this._flash('pubSaved');
      return true;
    } catch (e) {
      this.pubError = e.message;
      return false;
    } finally {
      this.pubSaving = false;
    }
  },

  // Co-Autoren (Schreib-Duos) + freie Vor-/Nachsatz-Seiten: rein lokale Array-
  // Mutation der geladenen Meta, persistiert über savePublication.
  addCoAuthor() {
    if (!this.bookPublication) return;
    if (!Array.isArray(this.bookPublication.co_authors)) this.bookPublication.co_authors = [];
    this.bookPublication.co_authors.push({ name: '', file_as: '' });
  },

  removeCoAuthor(i) {
    this.bookPublication?.co_authors?.splice(i, 1);
  },

  addExtraSection() {
    if (!this.bookPublication) return;
    if (!Array.isArray(this.bookPublication.extra_sections)) this.bookPublication.extra_sections = [];
    this.bookPublication.extra_sections.push({ placement: 'back', title: '', body: '', link_url: '', link_label: '', toc: true });
  },

  removeExtraSection(i) {
    this.bookPublication?.extra_sections?.splice(i, 1);
  },

  // ── Cover + Autorfoto ─────────────────────────────────────────────────────
  // Upload/Entfernen schreiben sofort und setzen nur das Bild-Flag — kein
  // Neuladen der Meta, sonst wären ungespeicherte Eingaben im Reiter weg.
  // `kind`: 'cover' | 'author'.
  _pubImage(kind) {
    return kind === 'cover'
      ? { path: 'cover', flag: 'has_cover', busy: 'pubCoverUploading', error: 'pubCoverError' }
      : { path: 'author-image', flag: 'has_author_image', busy: 'pubAuthorUploading', error: 'pubAuthorError' };
  },

  async _uploadPubImage(kind, file) {
    const bookId = this._formBookId;
    const m = this._pubImage(kind);
    if (!file || !bookId || this[m.busy]) return;
    this[m.busy] = true; this[m.error] = '';
    try {
      const r = await fetch(`/publication/${bookId}/${m.path}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!r.ok) { const d = await r.json().catch(() => null); throw new Error(d ? window.__app.tError(d) : window.__app.t('publication.imageInvalid')); }
      if (!this._isFormBook(bookId)) return;
      this.bookPublication[m.flag] = true;
      this.pubPreviewVersion++;
    } catch (e) {
      this[m.error] = e.message || window.__app.t('publication.imageInvalid');
    } finally {
      this[m.busy] = false;
    }
  },

  async _removePubImage(kind) {
    const bookId = this._formBookId;
    const m = this._pubImage(kind);
    if (!bookId || this[m.busy]) return;
    if (!await window.__app.appConfirm({
      message: window.__app.t(kind === 'cover' ? 'publication.removeCoverConfirm' : 'publication.removeAuthorImageConfirm'),
      confirmLabel: window.__app.t('publication.remove'),
      danger: true,
    })) return;
    this[m.busy] = true; this[m.error] = '';
    try {
      const r = await fetch(`/publication/${bookId}/${m.path}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(window.__app.tError(d)); }
      if (!this._isFormBook(bookId)) return;
      this.bookPublication[m.flag] = false;
      this.pubPreviewVersion++;
    } catch (e) {
      this[m.error] = e.message;
    } finally {
      this[m.busy] = false;
    }
  },

  uploadPublicationCover(file)       { return this._uploadPubImage('cover', file); },
  removePublicationCover()           { return this._removePubImage('cover'); },
  uploadPublicationAuthorImage(file) { return this._uploadPubImage('author', file); },
  removePublicationAuthorImage()     { return this._removePubImage('author'); },

  publicationCoverUrl() {
    const bookId = this._formBookId;
    if (!this.bookPublication?.has_cover || !bookId) return '';
    return `/publication/${bookId}/cover?v=${this.pubPreviewVersion}`;
  },

  publicationAuthorImageUrl() {
    const bookId = this._formBookId;
    if (!this.bookPublication?.has_author_image || !bookId) return '';
    return `/publication/${bookId}/author-image?v=${this.pubPreviewVersion}`;
  },
};
