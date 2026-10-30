'use strict';
// Facade der Alters-Analyse (Job `figur-alter`). Reine Module unter
// lib/figure-age/ — Mustererkennung (patterns), Kandidatensuche (scan),
// Verdichtung (consolidate). Kein DB-, kein Netzzugriff in dieser Schicht.
//
// AGE_ANALYSIS_VERSION geht in die Inhaltssignatur des Laufs (`content_sig`):
// aendert sich hier die Logik oder der Prompt, matcht der Delta-Skip nicht mehr
// und der naechste Lauf rechnet neu.
// v3: Nachrichtenverlaeufe zeilenweise, mit Absender (scan.js#scanMsgUtterances).
// v4: Zahlwort-Kopula, Englisch, Fenster um die Angabe, Absatzgrenzen, Geburtsjahr
//     der Zeile in der Rechnung, Todesjahr deckelt das Ankerjahr.
// v5: Datum in Ziffern teilt keinen Satz, "am" nur als "I am", Rechnungspruefung
//     am Bezugsjahr des Belegs, Bezugsjahr nur aus der Stelle, Rueckblende ohne
//     Konfidenz-Abzug.
const AGE_ANALYSIS_VERSION = 5;

const patterns = require('./figure-age/patterns');
const scan = require('./figure-age/scan');
const consolidate = require('./figure-age/consolidate');

module.exports = { AGE_ANALYSIS_VERSION, ...patterns, ...scan, ...consolidate };
