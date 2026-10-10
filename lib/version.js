'use strict';
// App-Version — Single Source of Truth ist die Datei VERSION im Projektroot.
// Wird vor jedem Commit von Hand gepflegt. package.json#version wird NICHT mehr
// gelesen (npm-Metadatum, fuer die self-hosted App ohne Belang).
// Einmalig beim Modul-Load eingelesen; Aenderung wird beim naechsten Start aktiv.

const fs = require('fs');
const path = require('path');

let _version = '0.0.0';
try {
  _version = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim() || '0.0.0';
} catch (_) { /* Datei fehlt → Fallback */ }

function getVersion() {
  return _version;
}

// Content-Hash der aktuellen Shell-Generation (aus public/sw-manifest.js, einmal
// beim Modul-Load). Das Frontend vergleicht ihn beim Boot gegen window.__SHELL_BUILD
// (= Build, mit dem die geladene Shell ausgeliefert wurde) und löst bei Abweichung
// das Update/Reload aus — Self-Heal gegen eine stale SPA-Shell nach Deploy.
let _shellBuild = 'dev';
try {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw-manifest.js'), 'utf8');
  const m = src.match(/self\.__SHELL_BUILD\s*=\s*"([^"]+)"/);
  if (m) _shellBuild = m[1];
} catch (_) { /* Datei fehlt (z.B. vor erstem sw:manifest) → Fallback */ }

function getShellBuild() {
  return _shellBuild;
}

// Protokoll-Stand der Web-Shell (public/js/shell-protocol.js, dieselbe Datei,
// die die Shell mitträgt). Liegt eine offene Shell darunter, erzwingt sie das
// Update (public/js/app/boot/update-policy.js). null = Datei fehlt → kein Zwang.
let _shellProtocol = null;
try {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shell-protocol.js'), 'utf8');
  const m = src.match(/export\s+const\s+SHELL_PROTOCOL\s*=\s*(\d+)/);
  if (m) _shellProtocol = Number(m[1]);
} catch (_) { /* Datei fehlt → kein Pflicht-Update */ }

function getShellProtocol() {
  return _shellProtocol;
}

module.exports = { getVersion, getShellBuild, getShellProtocol };
