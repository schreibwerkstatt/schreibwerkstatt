'use strict';
// Import-Log fuer Ordner- und Manuskript-Import: jeder fuer den User relevante
// Schritt als { level, key, params, ts }. Die Import-Karte rendert `t(key,
// params)` — so folgt das Log der Locale des Betrachters, nicht der des
// Servers (Regel „UI-Strings nur in i18n"). Dieselbe Zeile geht als Key +
// Params ins Winston-Log; rein technische Meldungen (Ausnahmetexte, Baseline)
// gehoeren nicht hierher, sondern direkt an den Job-Logger.

/**
 * @param {{ info: Function, warn: Function }} log  Job-Logger
 * @returns {{ entries: Array<object>, audit: (level: 'info'|'warn', key: string, params?: object) => void }}
 */
function makeImportAudit(log) {
  const entries = [];
  const audit = (level, key, params = null) => {
    entries.push({ level, key, params, ts: new Date().toISOString() });
    const line = params ? `${key} ${JSON.stringify(params)}` : key;
    if (level === 'warn') log.warn(line); else log.info(line);
  };
  return { entries, audit };
}

/** Import-Warnung eines Parsers/Splitters (`{ code, … }`) → Log-Key. Der Key
 *  liegt unter `folderImport.warning.*`, dieselben Texte zeigt die Karte in
 *  Vorschau und Ergebnis. */
function warningKey(code) {
  return `folderImport.warning.${code}`;
}

module.exports = { makeImportAudit, warningKey };
