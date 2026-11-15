'use strict';
// Was zum stabilisierten Lektorat gehoert — EINE Definition fuer die
// Sonderpruefung (scripts/test-lektorat.js). Regel: docs/lektorat.md
// «Stabilisiert».
//
// Kriterium: der Pfad entscheidet ueber Prompt, Merge, Filter, Anker oder
// Uebernahme eines Lektorat-Befunds. Doku, Eval-Werkzeug und Bilder zaehlen
// nicht (sie aendern kein Verhalten); Tests zaehlen mit — ein gelockerter
// Assert ist dieselbe Verhaltensaenderung wie ein geaenderter Filter.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Dateinamen mit «lektorat» unter diesen Wurzeln.
const NAME_ROOTS = /^(routes|lib|db|public\/js|public\/css|public\/partials|tests)\//;
const NAME_RE = /lektorat/i;
// Ohne «lektorat» im Namen, aber Teil derselben Kette.
const EXPLICIT = new Set([
  'public/partials/editor-findings.html',   // Befundliste im Notebook-Editor
  'public/js/prompts/blocks.js',            // Regelbloecke des Lektorat-Prompts
  'public/js/prompts/blocks-fach.js',
  'public/js/prompts/blocks-welt.js',
  'public/js/prompts/state.js',             // JSON_ONLY
]);

function toRel(p) {
  const abs = path.resolve(ROOT, p);
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function isLektoratPath(p) {
  if (!p) return false;
  const rel = toRel(p);
  if (rel.startsWith('..')) return false;
  if (EXPLICIT.has(rel)) return true;
  return NAME_ROOTS.test(rel) && NAME_RE.test(path.posix.basename(rel));
}

function listLektoratFiles() {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean).filter(isLektoratPath).sort();
}

// Fingerabdruck des aktuellen Lektorat-Stands im Working Tree. Die
// Sonderpruefung schreibt ihn nach gruenem Lauf; das Stop-Gate vergleicht.
function lektoratFingerprint() {
  const h = crypto.createHash('sha256');
  for (const rel of listLektoratFiles()) {
    h.update(rel + '\0');
    try { h.update(fs.readFileSync(path.join(ROOT, rel))); } catch { h.update('<missing>'); }
    h.update('\0');
  }
  return h.digest('hex');
}

const STAMP_FILE = path.join(ROOT, 'tests', '.tmp', 'lektorat-check.json');

function readStamp() {
  try { return JSON.parse(fs.readFileSync(STAMP_FILE, 'utf8')); } catch { return null; }
}

function writeStamp(fingerprint) {
  fs.mkdirSync(path.dirname(STAMP_FILE), { recursive: true });
  fs.writeFileSync(STAMP_FILE, JSON.stringify({ fingerprint, at: new Date().toISOString() }) + '\n');
}

module.exports = { ROOT, isLektoratPath, listLektoratFiles, lektoratFingerprint, readStamp, writeStamp, STAMP_FILE };
