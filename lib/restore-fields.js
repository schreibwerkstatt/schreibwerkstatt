'use strict';
// Wiederherstellen eines geloeschten Eintrags (Undo im Ideen-Board und im
// Recherche-Board): der Client legt ihn per POST neu an und schickt im Feld
// `restore` den Stand aus seinem Snapshot mit, damit die Zeile nicht als «heute
// angelegt» zurueckkommt. Hier steht nur die Pruefung der gemeinsamen Felder;
// was ein Eintrag sonst noch traegt (Rang, Anheften), prueft seine Route.
//
// Der Client darf damit Zeitstempel setzen — begrenzt auf das, was ein echter
// Snapshot tragen kann: gueltiges ISO-Datum, nicht in der Zukunft, und der
// Status-Zeitpunkt nicht vor dem Anlegen.

// Uhrenabweichung zwischen Client-Snapshot und Server, die noch als «jetzt» gilt.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** ISO-Zeitstempel normalisieren (Format von NOW_ISO_SQL) oder null. */
function _stamp(v, nowMs) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || ms > nowMs + FUTURE_SKEW_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * `restore` aus dem Request-Body pruefen.
 * @param {unknown} raw  Body-Feld `restore` (fehlt → kein Restore)
 * @param {{ isStatus: (s: unknown) => boolean }} opts
 * @returns {{ error_code: string } | { value: null | { createdAt: string, status: string|null, statusAt: string|null } }}
 */
function parseRestoreFields(raw, { isStatus }) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error_code: 'INVALID_RESTORE' };
  const nowMs = Date.now();
  const createdAt = _stamp(raw.created_at, nowMs);
  if (!createdAt) return { error_code: 'INVALID_RESTORE' };
  let status = null;
  if (raw.status !== undefined && raw.status !== null) {
    if (!isStatus(raw.status)) return { error_code: 'INVALID_STATUS' };
    status = raw.status;
  }
  let statusAt = null;
  if (raw.status_at !== undefined && raw.status_at !== null) {
    statusAt = _stamp(raw.status_at, nowMs);
    if (!statusAt || statusAt < createdAt) return { error_code: 'INVALID_RESTORE' };
  }
  return { value: { createdAt, status, statusAt } };
}

module.exports = { parseRestoreFields, FUTURE_SKEW_MS };
