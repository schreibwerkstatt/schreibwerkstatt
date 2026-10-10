// Save-Payload-Aufbau. Reine Funktionen ohne DOM-Zugriff und ohne Side-Effects,
// damit beide Editoren (Normal + Focus) bit-identisch denselben PUT-Body
// erzeugen und das Verhalten isoliert testbar bleibt.
//
// Trennung von der Save-API-Schicht (shared/page-api.js) ist Absicht: hier
// wird beschrieben, *was* gesendet wird, dort *wie* es übertragen wird
// (Offline-Queue, Retry, Conflict-Handling).

import { normalizeForCompare } from './html-clean.js';

// Vergleicht zwei HTML-Strings nach Anwendung der Vergleichs-Normalform.
// Liefert true, wenn die normalisierten Fassungen byte-identisch sind —
// also keine semantische Änderung vorliegt. Bricht früh bei identischer
// roher Form (häufiger Pfad: User öffnet Edit, klickt Save sofort).
export function isNoChange(currentHtml, originalHtml) {
  if (currentHtml === originalHtml) return true;
  return currentHtml === normalizeForCompare(originalHtml || '');
}

// Liefert den PUT-Body für /content/pages/:id. Inputs sind reine Strings/
// Werte; kein `this`, kein DOM. `source` muss vom Aufrufer entschieden
// werden — die Lib wählt das nicht selbst, weil sie modus-agnostisch ist.
//
// Erlaubte Quellen (Spiegel von db/page-revisions.js#VALID_SOURCES, ohne
// die nur-Server-Quellen import/conflict):
//   'main'          — Notebook-Editor
//   'focus'         — Focus-Editor
//   'book'          — Buch-Editor (mehrere Pages am Stück)
//   'lektorat-apply'— Lektorat-Korrekturen übernehmen
//   'chat-apply'    — Chat-Vorschlag in Seite einsetzen
//
// Wirft, wenn html, pageName oder source fehlen/ungültig — Aufrufer dürfen
// sich auf die Pflichtfelder verlassen.
const VALID_SOURCES = new Set(['main', 'focus', 'book', 'lektorat-apply', 'chat-apply']);

// `reason` (optional): welcher Weg den Save ausgelöst hat (autosave, retry,
// outbox …) — nur Diagnose, der Server schreibt es in die PAGE_CONFLICT-Zeile.
export function buildSavePayload({ html, pageName, source, expectedUpdatedAt, reason }) {
  if (typeof html !== 'string') throw new Error('buildSavePayload: html required');
  if (!pageName) throw new Error('buildSavePayload: pageName required');
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`buildSavePayload: invalid source ${JSON.stringify(source)}`);
  }
  const payload = {
    html,
    name: pageName,
    source,
    expected_updated_at: expectedUpdatedAt || null,
  };
  if (reason) payload.save_reason = reason;
  return payload;
}
