'use strict';
// Score-Floor der Motiv-Fundstellen (App-Setting `motif.scan.min_score`, 0 = alle).
// EINE Lesestelle für alle Konsumenten des Ist-Index — Konstellation/Band
// (routes/motifs.js), KI-Konsistenz-Job, Buch-Chat-Werkzeug, Figuren-Werkstatt
// (Badge + Prompt-Block): alle müssen über dieselben Zahlen reden, sonst nennt eine
// Oberfläche eine Lücke, die auf der anderen keine ist.
const appSettings = require('./app-settings');

function motifScoreFloor() {
  return Number(appSettings.get('motif.scan.min_score')) || 0;
}

module.exports = { motifScoreFloor };
