'use strict';
// Normalisierter Aussage-Schlüssel eines Welt-Fakts: `subjekt: fakt` (bzw. nur `fakt`),
// kleingeschrieben, Typografie-Varianten vereinheitlicht, Leerraum und
// Schluss-Satzzeichen weg. Identität einer Aussage über Läufe hinweg — die Zeilen-ID in
// `world_facts` ändert sich bei jedem Full-Replace. Derselbe Schlüssel entsteht aus
// `stelle_a` eines Faktenfehler-Befunds, der genau diese Form trägt (job-faktencheck.js).
//
// Eigenes, abhängigkeitsfreies Modul, damit auch die Migration 0320 ihn nutzen kann
// (db/world-facts.js lädt die Migrationen selbst).

function factKeyOf(text) {
  return String(text || '')
    .normalize('NFC')
    .toLocaleLowerCase('de')
    .replace(/[«»„“”"‚‘’']/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[\s.;,!]+$/u, '')
    .trim();
}

function factKey(subjekt, fakt) {
  const s = String(subjekt || '').trim();
  return factKeyOf(s ? `${s}: ${fakt || ''}` : fakt);
}

module.exports = { factKey, factKeyOf };
