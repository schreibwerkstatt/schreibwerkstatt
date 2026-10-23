'use strict';
// Pre-Auth-Freigabe statischer Assets (server.js → lib/public-asset-path.js).
//
// Geprüft wird die Kette wie in server.js: Freigabe-Gate → Auth-Guard →
// express.static. Die Freigabe-Listen werden aus server.js gelesen, damit der
// Test die echte Konfiguration prüft und nicht eine Kopie davon.
//
//   - Ein Landing-Bild kommt ohne Anmeldung (200, image/webp).
//   - Ein anderes Bild unter /img/ kommt ohne Anmeldung NICHT (401).
//   - Pfad-Traversal über ein freigegebenes Präfix (`/img/landing/../…`,
//     `/css/%2e%2e/…`) fällt in den Auth-Guard, statt beliebige Dateien aus
//     public/ auszuliefern.
//
// Als Wurzel dient ein Wegwerf-Ordner mit derselben Struktur: in public/img/
// liegt heute nur landing/, ein Bild daneben muss der Test selbst anlegen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { bootstrap } = require('./_helpers/setup');

bootstrap();

const ROOT = path.join(__dirname, '..', '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function _listFromServer(re) {
  const m = re.exec(SERVER_SRC);
  assert.ok(m, `Freigabe-Liste in server.js nicht gefunden: ${re}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}
const PREFIXES = _listFromServer(/const PUBLIC_ASSET_PREFIXES = \[([^\]]*)\]/);
const EXACT = new Set(_listFromServer(/const PUBLIC_ASSETS = new Set\(\[([\s\S]*?)\]\);/));

let server;
let port;
let tmpRoot;

test.before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-public-assets-'));
  const webp = fs.readFileSync(path.join(ROOT, 'public', 'img', 'landing', 'chat.webp'));
  fs.mkdirSync(path.join(tmpRoot, 'img', 'landing'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'css'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'img', 'landing', 'chat.webp'), webp);
  fs.writeFileSync(path.join(tmpRoot, 'img', 'intern.webp'), webp);
  fs.writeFileSync(path.join(tmpRoot, 'css', 'tokens.css'), ':root{}');
  fs.writeFileSync(path.join(tmpRoot, 'index.html'), '<!doctype html><title>shell</title>');

  const { createEphemeralSession } = require('../../lib/token-session');
  const { makePublicAssetGate } = require('../../lib/public-asset-path');
  const serve = express.static(tmpRoot);
  const app = express();
  app.use((req, _res, next) => { req.session = createEphemeralSession(); next(); });
  app.use(makePublicAssetGate({ exact: EXACT, prefixes: PREFIXES, serve }));
  app.use(require('../../lib/auth-guard').makeAuthGuard({ localDevMode: false }));
  app.use(serve);
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    server.on('error', reject);
  });
});

test.after(() => {
  server?.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Roher Request: fetch() normalisiert `..` im Client weg, ein Angreifer nicht.
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers: { accept: '*/*' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Pre-Auth: /img/ ist nur für /img/landing/ freigegeben', () => {
  assert.ok(PREFIXES.includes('/img/landing/'), 'server.js gibt /img/landing/ nicht frei');
  assert.ok(!PREFIXES.includes('/img/'), 'server.js gibt ganz /img/ frei statt nur /img/landing/');
});

test('Pre-Auth: Landing-Bild kommt ohne Anmeldung als image/webp', async () => {
  const res = await rawGet('/img/landing/chat.webp');
  assert.equal(res.status, 200);
  assert.match(res.type, /^image\/webp/);
});

test('Pre-Auth: freigegebenes Stylesheet kommt ohne Anmeldung', async () => {
  const res = await rawGet('/css/tokens.css');
  assert.equal(res.status, 200);
  assert.match(res.type, /^text\/css/);
});

test('Pre-Auth: ein anderes Bild unter /img/ kommt ohne Anmeldung nicht', async () => {
  const res = await rawGet('/img/intern.webp');
  assert.equal(res.status, 401);
  assert.doesNotMatch(res.type, /^image\//);
});

test('Pre-Auth: Pfad-Traversal über ein freigegebenes Präfix landet im Auth-Guard', async () => {
  const cases = [
    '/img/landing/../intern.webp',
    '/img/landing/../../index.html',
    '/img/landing/..%2fintern.webp',
    '/img/landing/%2e%2e/intern.webp',
    '/css/../index.html',
    '/css/%2e%2e/index.html',
    '/css/%2E%2E/index.html',
    '/js/./../index.html',
    '/css//tokens.css',
    '/css/%E0%A4%A.css',
  ];
  for (const p of cases) {
    const res = await rawGet(p);
    assert.notEqual(res.status, 200, `${p} wurde ohne Anmeldung ausgeliefert`);
    assert.ok(!res.body.includes('<title>shell</title>'), `${p} lieferte index.html aus`);
    assert.doesNotMatch(res.type, /^image\//, `${p} lieferte ein Bild aus`);
  }
});

test('canonicalAssetPath: nur bereits kanonische Pfade', () => {
  const { canonicalAssetPath } = require('../../lib/public-asset-path');
  assert.equal(canonicalAssetPath('/img/landing/chat.webp'), '/img/landing/chat.webp');
  assert.equal(canonicalAssetPath('/js/share-reader/a%20b.js'), '/js/share-reader/a b.js');
  assert.equal(canonicalAssetPath('/img/landing/../x'), null);
  assert.equal(canonicalAssetPath('/css/%2e%2e/x'), null);
  assert.equal(canonicalAssetPath('/css/.%2e/x'), null);
  assert.equal(canonicalAssetPath('/css/%5c..%5cx'), null);
  assert.equal(canonicalAssetPath('/css/a%00.css'), null);
  assert.equal(canonicalAssetPath('/css/%E0%A4%A'), null);
  assert.equal(canonicalAssetPath('relative.css'), null);
});
