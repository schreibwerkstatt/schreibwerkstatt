'use strict';
// Versionen des Client-Vertrags der nativen Clients (macOS, Android).
// SSoT ist contract/version.json; Regeln und Ablauf: contract/README.md.
//
//   api        — Revision der REST-Fläche. Steigt bei JEDER Vertragsänderung
//                (auch additiv), damit ein Client per `api >= n` prüfen kann,
//                ob der Server ein Feld schon kennt. Brechen ist hier verboten:
//                was ein Client liest, bleibt, bis kein Gerät es mehr braucht.
//   editorApi  — MAJOR des OTA-Editor-Bundles. Steigt nur bei einem Bruch
//                (Export/Bridge-Feld/Klasse fällt weg, Bridge verlangt etwas
//                Neues). Ein Client meldet per `X-Editor-Api`, welche Majors er
//                kann; passt keiner, liefert der Server kein Bundle, und der
//                Client bleibt auf seinem gecachten.

const VERSION = require('../contract/version.json');

const API_VERSION = VERSION.api;
const EDITOR_API = VERSION.editorApi;

/** `X-Editor-Api: 1` bzw. `1,2` → [1, 2]; fehlt/unlesbar → null (Alt-Client). */
function parseEditorApiHeader(value) {
  if (value == null || String(value).trim() === '') return null;
  const majors = String(value).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return majors.length ? majors : null;
}

/**
 * Darf der Server diesem Client das aktuelle Bundle liefern? Ein Client ohne
 * Header ist ein Build von vor der Versionierung — er kann genau Major 1.
 */
function editorApiCompatible(headerValue) {
  const majors = parseEditorApiHeader(headerValue) || [1];
  return { ok: majors.includes(EDITOR_API), client: majors, server: EDITOR_API };
}

/** Block für `GET /config` und das Bundle-Manifest. */
function clientContract() {
  return { api: API_VERSION, editorApi: EDITOR_API };
}

module.exports = { API_VERSION, EDITOR_API, parseEditorApiHeader, editorApiCompatible, clientContract };
