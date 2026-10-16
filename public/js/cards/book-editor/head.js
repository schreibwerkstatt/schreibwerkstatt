// Teil von bookEditorCard (Facade cards/book-editor-card.js): Titel-Kopf
// (Dachzeile · Titel · Lead) über jedem Beitrag im Stream — nur in
// publizistischen Büchern. Methoden in den Card-Scope gespreadet.
//
// Der Kopf ist Metadata der Seite (`page_headline`), nicht ihr Text. Darum steht
// er AUSSERHALB von `.book-editor-page-body`: er gelangt weder in `block.html`
// noch in den Dirty-Vergleich, den Undo-Verlauf oder Find/Replace (die alle nur
// `[data-book-editor-page]` lesen), und er bewegt `pages.updated_at` nicht — die
// Save-Queue und der Konflikt-Schutz sehen ihn gar nicht. Gespeichert wird über
// `PUT /headline/page/:id`, dieselbe Route wie Titel-Werkstatt und Notebook-Kopf,
// beim Verlassen des Feldes.
//
// Leere Felder stehen nur am aktiven Beitrag (dort schreibt man gerade); an
// allen anderen nimmt ein leerer Kopf keinen Platz weg. Der Teaser fehlt mit
// Absicht — er gehört in Übersichten (channels.js#HEADLINE_HEAD_FIELDS).

import { fetchJson } from '../../utils.js';
import { sendJson } from '../../utils/net.js';
import { HEADLINE_HEAD_FIELDS, HEADLINE_LONG_FIELDS } from '../../headline/channels.js';
import { isJournalisticBuchtyp } from '../feature-registry.js';
import { EVT } from '../../events.js';

const _pick = (h) => Object.fromEntries(HEADLINE_HEAD_FIELDS.map(f => [f, (h && h[f]) || '']));

export const bookEditorHeadMethods = {
  headAvailable() {
    return isJournalisticBuchtyp(window.__app?.currentBuchtyp?.());
  },

  /** Alle Köpfe des Buchs in einem Call. Nicht fatal: ohne sie fehlt nur die
   *  Anzeige, der Stream bleibt bearbeitbar. `token` = Lade-Token der Karte. */
  async _loadHeads(bookId, token) {
    this.heads = {};
    if (!bookId || !this.headAvailable()) return;
    try {
      const data = await fetchJson('/headline/' + bookId);
      if (token !== this._loadToken || !data.enabled) return;
      const next = {};
      for (const [pid, h] of Object.entries(data.pages || {})) next[pid] = _pick(h);
      this.heads = next;
    } catch { /* Kopf ist Zutat, kein Inhalt */ }
  },

  headFieldList() { return HEADLINE_HEAD_FIELDS; },

  headValue(pageId, feld) { return this.heads[String(pageId)]?.[feld] || ''; },

  /** Ein Feld steht, wenn es gefüllt ist — leer nur am aktiven Beitrag und nur
   *  für wer schreiben darf. */
  headFieldShown(block, feld) {
    if (!this.headAvailable()) return false;
    if (this.headValue(block.pageId, feld)) return true;
    return this.activePageId === block.pageId && !!window.__app?.canEdit?.();
  },

  headShown(block) {
    return HEADLINE_HEAD_FIELDS.some(f => this.headFieldShown(block, f));
  },

  /** Höhe nach Inhalt, wo `field-sizing: content` fehlt (Firefox, ältere
   *  WebKit) — sonst schnitte die einzeilige Textarea einen mehrzeiligen Lead ab. */
  headAutosize(el) {
    if (!el || globalThis.CSS?.supports?.('field-sizing', 'content')) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  },

  /** Enter beendet Dachzeile und Titel (einzeilig); im Lead bleibt er Umbruch. */
  headKeydown(feld, ev) {
    if (ev.key === 'Enter' && !HEADLINE_LONG_FIELDS.includes(feld)) {
      ev.preventDefault();
      ev.target.blur();
    }
  },

  async headSave(block, feld, el) {
    const pid = String(block.pageId);
    const val = String(el?.value ?? '');
    if (!window.__app?.canEdit?.() || val === this.headValue(pid, feld)) return;
    try {
      const r = await sendJson(`/headline/page/${pid}`, 'PUT', { [feld]: val });
      // Der Server normalisiert (trimmt, faltet Umbrüche) — der bestätigte
      // Stand ist seine Antwort, nicht die Eingabe.
      this.heads = { ...this.heads, [pid]: _pick(r.headline) };
      if (el) { el.value = this.headValue(pid, feld); this.headAutosize(el); }
      window.dispatchEvent(new CustomEvent(EVT.CARD_REFRESH, { detail: { name: 'titelwerkstatt' } }));
    } catch {
      if (el) el.value = this.headValue(pid, feld);
      const app = window.__app;
      app?.setStatus?.(app.t('headline.saveError'), false, 5000);
    }
  },
};
