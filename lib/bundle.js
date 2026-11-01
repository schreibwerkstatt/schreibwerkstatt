'use strict';
// Prod-Bündel der SPA-Shell: liefert, wenn vorhanden, die von
// scripts/build-bundle.js erzeugte Fassung aus (eine index.html, ein paar
// JS-Chunks, eine CSS-Datei) statt der ~1000 Einzeldateien unter public/.
//
// Der Bündel-Modus hängt allein daran, ob ein GÜLTIGES Bündel da ist — kein
// Schalter. Gültig heisst: build.json liegt vor und der Inhalts-Hash seiner
// Quelldateien stimmt mit dem jetzigen Stand auf der Platte überein. Ein
// veraltetes Bündel (Quelle danach geändert, z. B. lokal nach einem Probe-Build)
// wird ignoriert, sonst lieferte der Server still alten Code aus.
//
// Unberührt bleiben: public/js als Quelle (der Server importiert daraus, und
// das OTA-Editor-Bundle der nativen Clients, lib/editor-bundle.js, packt die
// Einzeldateien), die klassischen Scripts aus index.html und vendor/.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const BUNDLE_URL_PREFIX = '/bundle/';
const BUILD_FILE = 'build.json';
const SW_MANIFEST_FILE = 'sw-manifest.js';

/** Hash über Pfad + Inhalt der Quelldateien, gleiche Rechnung in Build und Boot. */
function sourceHash(root, inputs) {
  const h = crypto.createHash('sha256');
  for (const rel of [...inputs].sort()) {
    h.update(rel + '\0');
    h.update(fs.readFileSync(path.join(root, rel)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/** Gültiges Bündel laden oder `null` (dann gilt public/ wie ohne Build). */
function loadBundle({ root, dir: rawDir, logger }) {
  const dir = path.resolve(root, rawDir);
  const buildPath = path.join(dir, BUILD_FILE);
  if (!fs.existsSync(buildPath)) return null;
  let build;
  try {
    build = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
    const actual = sourceHash(root, build.inputs);
    if (actual !== build.sourceHash) {
      logger.warn(`Bündel in ${dir} ist veraltet (Quelle ${actual}, Bündel ${build.sourceHash}) — liefere Einzeldateien aus.`);
      return null;
    }
  } catch (e) {
    logger.warn(`Bündel in ${dir} nicht lesbar (${e.message}) — liefere Einzeldateien aus.`);
    return null;
  }
  logger.info(`Bündel-Modus: ${build.files.length} Dateien aus ${dir} (Quelle ${build.sourceHash}).`);
  return { dir, build, indexPath: path.join(dir, 'index.html') };
}

// Gehashte Dateinamen ändern sich mit jedem Inhalt → unbegrenzt cachebar.
function bundleAssets(bundle) {
  return express.static(bundle.dir, {
    index: false,
    etag: true,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  });
}

// Die Shell selbst bleibt `no-cache` + `X-App-Shell` wie die index.html aus
// public/ (server.js#staticServe, Begründung dort).
function bundleShell(bundle) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path !== '/' && req.path !== '/index.html') return next();
    res.setHeader('X-App-Shell', '1');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(bundle.indexPath);
  };
}

// Das SW-Manifest dieses Bündels (geschrieben von scripts/build-bundle.js)
// ersetzt public/sw-manifest.js: es listet die Bündel-Dateien statt der ~1000
// Einzeldateien, und sein Build-Hash gehört zu genau dieser Shell. Header wie
// das Original (staticServe: no-cache), ohne Session abrufbar (sw.js lädt es
// per importScripts).
function bundleSwManifest(bundle) {
  const file = path.join(bundle.dir, SW_MANIFEST_FILE);
  return (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path !== '/sw-manifest.js') return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript');
    res.sendFile(file);
  };
}

module.exports = {
  BUNDLE_URL_PREFIX, BUILD_FILE, SW_MANIFEST_FILE,
  sourceHash, loadBundle, bundleAssets, bundleShell, bundleSwManifest,
};
