'use strict';
// Erzeugt die Screenshots der öffentlichen Landing-Page.
//
// Der Weg: die ECHTE App wird auf einer Wegwerf-DB gebootet (LOCAL_DEV_MODE,
// Dev-Admin-Session), das Beispielbuch wird geseedet und mit den Daten
// angereichert, die die Oberfläche zeigen soll (Figuren, Beat-Board,
// Recherche-Board, geteilte Abschnitte mit Leserkommentaren). Die KI-Antworten
// kommen aus einem Stub (scripts/landing-shots/mock-ai.js) — ohne API-Key gibt
// es sonst keine Befunde, keine Bewertung und keinen Chat.
//
// Danach fährt Playwright die neun Kachel-Flächen an und legt je ein WebP ab (920 × 614, 3:2).
// Das Skript ist der Reproduzierbarkeits-Beleg: `npm run shots:landing`
// erzeugt die Bilder, die auf der Landing-Page liegen.
//
// Aufruf:  node scripts/landing-shots.js [--out public/img/landing] [--keep-db]

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

// ── Argumente ────────────────────────────────────────────────────────────────
function _arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT_DIR = path.resolve(ROOT, _arg('out', 'public/img/landing'));
const KEEP_DB = process.argv.includes('--keep-db');
const PORT = Number(_arg('port', 8791));
const BASE = `http://127.0.0.1:${PORT}`;

// ── Umgebung (VOR dem Server-Boot) ───────────────────────────────────────────
const DB_PATH = path.join(ROOT, 'tests', '.tmp', 'landing-shots.db');
process.env.DB_PATH = DB_PATH;
process.env.PORT = String(PORT);
process.env.LOCAL_DEV_MODE = 'true';
process.env.LOCAL_DEV_SEED = 'false';   // Devmode-Testbuch ist nicht das Beispielbuch
process.env.LOCAL_DEV_SEED_SHOWCASE = 'false';
process.env.SESSION_SECRET = 'landing-shots-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + suffix); } catch { /* noch nicht da */ }
}

// KI-Stub VOR dem Server-Boot installieren: ab da sieht jeder Server-Code den
// Stub statt des echten Providers.
require('./landing-shots/mock-ai').install();

const logger = require(path.join(ROOT, 'logger'));

async function _waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`, { redirect: 'manual' });
      if (res.status < 500) return true;
    } catch { /* noch nicht up */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Server nicht erreichbar');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  logger.info(`Landing-Screenshots: Server auf ${BASE}, DB ${DB_PATH}`);
  require(path.join(ROOT, 'server.js'));
  await _waitForServer();

  const seed = await require('./landing-shots/seed').seedAll();
  logger.info(`Seed fertig: Buch ${seed.bookId}, ${seed.figures} Figuren, ${seed.beats} Beats, ${seed.research} Fundstücke, ${seed.shares} Shares, ${seed.comments} Kommentare`);

  const { captureAll } = require('./landing-shots/shots');
  const shots = await captureAll({ base: BASE, seed, outDir: OUT_DIR });
  for (const s of shots) logger.info(`Shot: ${s.name} -> ${s.file}`);
  logger.info(`${shots.length} Screenshots geschrieben.`);

  if (!KEEP_DB) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_PATH + suffix); } catch { /* schon weg */ }
    }
  }
  process.exit(0);
}

main().catch((e) => {
  logger.error(`landing-shots fehlgeschlagen: ${e.stack || e.message}`);
  console.error(e);
  process.exit(1);
});
