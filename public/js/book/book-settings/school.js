// Teil von bookSettingsMethods (siehe Facade book-settings.js).
// Schulsystem des Buchs (Kontext-Tab, docs/figur-lebenslauf.md «Schullaufbahn»):
// Vorlage, Einschulungsalter, Stichtag, Schuljahresbeginn, Jahre je Stufe,
// Standardweg. Grundlage der Klassenstufen in Figuren-Karte und Buch-Chat.
//
// Eigener Schreibpfad `PUT /booksettings/:book_id/schulsystem` (Muster /research);
// der Header-Speichern-Knopf schreibt ihn mit (saveActiveTab in settings.js).
// Normalisiert wird mit derselben Funktion wie auf dem Server
// (book/school-path.js#normalizeSchulsystem) — die Antwort spiegelt den
// gespeicherten Stand zurück.

import {
  SCHUL_VORLAGE_KEYS, SCHUL_GRENZEN, schulsystemAusVorlage, normalizeSchulsystem, resolveSchulsystem, wegKeys,
  schulwegFuerBuchtyp,
  vorlageLabelKey, stufeLabelKey, wegLabelKey,
} from '../school-path.js';

export const schoolMethods = {
  /** Aus dem Settings-Response übernehmen (GET /booksettings/:id trägt `schulsystem`). */
  _applySchoolSettings(data) {
    const n = normalizeSchulsystem(data?.schulsystem);
    this.bookSchulsystem = n;
    this.schulVorlage = n?.vorlage || '';
    this.bookHandlungsjahr = Number.isInteger(data?.handlungsjahr) ? data.handlungsjahr : null;
    this.bookSchulsystemLoaded = true;
  },

  /** Abschnitt nur bei Buchtypen mit Schullaufbahn — folgt der Auswahl im Formular. */
  schulAbschnittSichtbar() {
    return schulwegFuerBuchtyp(this.bookSettingsBuchtyp);
  },

  schulVorlageOptionen() {
    return SCHUL_VORLAGE_KEYS.map(k => ({ value: k, label: window.__app.t(vorlageLabelKey(k)) }));
  },

  /** Vorlage gewählt: frisch aus der Vorlage (Stufen und Wege hängen an ihr), leer = keins.
   *  Wechsel zwischen zwei Vorlagen: Figuren mit eigenem Weg verlieren ihn (der
   *  Weg-Key gehört zur alten Vorlage, gerechnet wird dann mit dem Standardweg) —
   *  darum vorher fragen, mit der Zahl der betroffenen Figuren. */
  async onSchulVorlageChange(key) {
    const alt = this.bookSchulsystem?.vorlage || '';
    if (key && alt && key !== alt) {
      const n = await this._schulFigurenMitEigenemWeg(key);
      if (n > 0 && !await window.__app.appConfirm({
        message: window.__app.t('book.settings.schule.vorlageWechselConfirm', { n }),
        confirmLabel: window.__app.t('book.settings.schule.vorlageWechseln'),
      })) {
        this.schulVorlage = alt;
        return;
      }
    }
    this.schulVorlage = key || '';
    if (!key) { this.bookSchulsystem = null; return; }
    if (this.bookSchulsystem?.vorlage === key) return;
    this.bookSchulsystem = schulsystemAusVorlage(key);
  },

  /** Figuren mit eigenem Weg, den die neue Vorlage nicht kennt. 0 bei Fehler —
   *  die Rückfrage ist ein Hinweis, kein Schutz, und darf den Wechsel nicht sperren. */
  async _schulFigurenMitEigenemWeg(neueVorlage) {
    const bookId = Alpine.store('nav').selectedBookId;
    try {
      const r = await fetch(`/figures/${encodeURIComponent(bookId)}/schulwege`);
      if (!r.ok) return 0;
      const { wege = {} } = await r.json();
      const neu = new Set(wegKeys(schulsystemAusVorlage(neueVorlage)));
      return Object.values(wege).filter(w => w?.weg && !neu.has(w.weg)).length;
    } catch {
      return 0;
    }
  },

  schulGrenzen() {
    return SCHUL_GRENZEN;
  },

  /** Stufen des gewählten Systems für die Jahre-Felder ({ key, label }). */
  schulStufen() {
    const r = resolveSchulsystem(this.bookSchulsystem);
    return r ? Object.keys(r.stufen).map(k => ({ key: k, label: window.__app.t(stufeLabelKey(k)) })) : [];
  },

  schulWegOptionen() {
    const r = resolveSchulsystem(this.bookSchulsystem);
    return r ? r.wege.map(w => ({
      value: w.key,
      label: window.__app.t(wegLabelKey(w.key)),
    })) : [];
  },

  async saveSchulsystem() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.bookSchulsystemLoaded) return;
    this.schulSaving = true;
    this.schulError = '';
    try {
      const r = await fetch(`/booksettings/${bookId}/schulsystem`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schulsystem: this.bookSchulsystem ? normalizeSchulsystem(this.bookSchulsystem) : null,
          handlungsjahr: this.bookHandlungsjahr ?? null,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(d) || `HTTP ${r.status}`);
      this._applySchoolSettings(d);
      window.__app?.invalidateBookSettingsCache?.();
    } catch (e) {
      this.schulError = e.message;
    } finally {
      this.schulSaving = false;
    }
  },
};
