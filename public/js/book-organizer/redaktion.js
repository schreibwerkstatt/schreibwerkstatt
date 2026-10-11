// Bearbeitungsstand-Slice des Buchorganizers: Stufe pro Abschnitt lesen, setzen,
// anzeigen (docs/bearbeitungsstand.md).
//
// Warum im Organizer: die Frage „wo steht welcher Abschnitt" ist eine Frage an
// die Liste aller Abschnitte — und die ist der Organizer.
//
// Der Stand selbst liegt NICHT in der Karte, sondern in `Alpine.store('badges')`
// (`editStatus`, `editStatusChain`): Seitenbaum, Buchübersicht und Statistik
// lesen dieselbe Map, und eine Stufe, die hier gesetzt wird, muss dort sofort
// stehen. Die Karte haelt nur, ob die Spalte gezeigt wird, und den Speicher-
// Zustand je Zeile.

import { sendJson } from '../utils/net.js';
import { statusLabelKey } from '../redaktion/status.js';

const _t = (k, p) => window.__app?.t?.(k, p) ?? k;

export const redaktionMethods = {
  /**
   * Stand des Buchs (neu) holen. Fehler sind nicht fatal: der Organizer ist ohne
   * die Spalte vollstaendig benutzbar.
   */
  async loadRedaktion() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.redaktionEnabled = false; return; }
    await window.__app?.refreshPageStatus?.(bookId);
    if (Alpine.store('nav').selectedBookId !== bookId) return;
    this.redaktionEnabled = (Alpine.store('badges').editStatusChain || []).length > 0;
  },

  /** Eintrag einer Seite oder null. */
  redaktionOf(pageId) {
    return Alpine.store('badges').editStatus[String(pageId)] || null;
  },

  /**
   * Optionen der Stufen-Auswahl. Erste Option leert die Stufe wieder — ohne sie
   * waere ein versehentlich gesetzter Status nicht mehr zurueckzunehmen.
   */
  redaktionOptions() {
    return [
      { value: '', label: _t('redaktion.status.none') },
      ...(Alpine.store('badges').editStatusChain || []).map(s => ({ value: s, label: _t(statusLabelKey(s)) })),
    ];
  },

  /** Anzeige-Label einer Stufe (leer, wenn keine gesetzt ist). */
  redaktionLabel(status) {
    return status ? _t(statusLabelKey(status)) : '';
  },

  /**
   * Tooltip der Plakette: Stufe, wer sie gesetzt hat, und die Warnung, falls der
   * Text danach noch bearbeitet wurde. Der Stale-Hinweis ist der eigentliche
   * Wert der Spalte — „fertig" auf einem seither geaenderten Text ist die
   * gefaehrlichste Anzeige, die das Feature haben kann.
   */
  redaktionTip(pageId) {
    const e = this.redaktionOf(pageId);
    if (!e) return '';
    const parts = [this.redaktionLabel(e.status)];
    if (e.updated_by) parts.push(e.updated_by);
    if (e.stale) parts.push(_t('redaktion.staleHint'));
    return parts.join(' · ');
  },

  /**
   * Stufe setzen (leerer Wert entfernt sie). Optimistisch ist hier bewusst
   * nichts: die Antwort traegt den frisch berechneten `stale`-Wert und den
   * Zeitanker, und beides koennte der Client nicht selbst bilden.
   */
  async setRedaktion(pageId, status) {
    if (!this.redaktionEnabled) return;
    const key = String(pageId);
    this.redaktionSaving = { ...this.redaktionSaving, [key]: true };
    try {
      const r = await sendJson(`/redaktion/page/${pageId}`, 'PUT', { status: status || null });
      const badges = Alpine.store('badges');
      const next = { ...badges.editStatus };
      if (r.entry) next[key] = r.entry; else delete next[key];
      badges.editStatus = next;
    } catch (_) {
      // Die Map bleibt auf dem letzten bestaetigten Stand — sie wurde vor der
      // Antwort nicht angefasst.
      this.organizerStatus = _t('redaktion.saveFailed');
    } finally {
      const busy = { ...this.redaktionSaving };
      delete busy[key];
      this.redaktionSaving = busy;
    }
  },
};
