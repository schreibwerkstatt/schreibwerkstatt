'use strict';
// Prod-Bündel der Shell (lib/bundle.js): der Server nimmt ein Bündel nur, wenn
// sein Quell-Hash zum jetzigen Stand passt — ein veraltetes oder kaputtes fällt
// still auf die Einzeldateien zurück, statt alten Code auszuliefern.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { loadBundle, sourceHash, bundleShell, bundleAssets, bundleSwManifest, BUILD_FILE, SW_MANIFEST_FILE } = require('../../lib/bundle');
const { renderManifest } = require('../../scripts/sw-manifest');

const silent = { info() {}, warn() {} };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src/b.css'), 'body{}\n');
  const dir = path.join(root, 'dist');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>bündel</html>');
  fs.writeFileSync(path.join(dir, 'app-X.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, SW_MANIFEST_FILE), 'self.__SHELL_BUILD = "b";');
  const inputs = ['src/a.js', 'src/b.css'];
  fs.writeFileSync(path.join(dir, BUILD_FILE), JSON.stringify({
    sourceHash: sourceHash(root, inputs), files: ['/bundle/app-X.js'], inputs,
  }));
  return { root, dir };
}

test('gültiges Bündel wird geladen, relativer Pfad gegen root aufgelöst', () => {
  const { root } = fixture();
  const b = loadBundle({ root, dir: 'dist', logger: silent });
  assert.ok(b);
  assert.equal(b.indexPath, path.join(root, 'dist', 'index.html'));
});

test('ohne build.json kein Bündel-Modus', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
  assert.equal(loadBundle({ root, dir: 'dist', logger: silent }), null);
});

test('Quelle nach dem Build geändert → Bündel veraltet, Einzeldateien', () => {
  const { root, dir } = fixture();
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = 2;\n');
  const warns = [];
  assert.equal(loadBundle({ root, dir, logger: { info() {}, warn: (m) => warns.push(m) } }), null);
  assert.match(warns[0], /veraltet/);
});

test('Quelldatei verschwunden oder build.json kaputt → Einzeldateien', () => {
  const a = fixture();
  fs.rmSync(path.join(a.root, 'src/b.css'));
  assert.equal(loadBundle({ root: a.root, dir: a.dir, logger: silent }), null);
  const b = fixture();
  fs.writeFileSync(path.join(b.dir, BUILD_FILE), '{');
  assert.equal(loadBundle({ root: b.root, dir: b.dir, logger: silent }), null);
});

test('Shell no-cache + X-App-Shell, gehashte Dateien immutable', async () => {
  const { root, dir } = fixture();
  const bundle = loadBundle({ root, dir, logger: silent });
  const app = express();
  app.use(bundleSwManifest(bundle));
  app.use('/bundle/', bundleAssets(bundle));
  app.use(bundleShell(bundle));
  const server = app.listen(0);
  const port = server.address().port;
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ res, body }));
    }).on('error', reject);
  });
  try {
    const shell = await get('/');
    assert.equal(shell.res.headers['x-app-shell'], '1');
    assert.equal(shell.res.headers['cache-control'], 'no-cache');
    assert.match(shell.body, /bündel/);
    assert.equal((await get('/index.html')).res.headers['x-app-shell'], '1');
    const asset = await get('/bundle/app-X.js');
    assert.equal(asset.res.statusCode, 200);
    assert.match(asset.res.headers['cache-control'], /immutable/);
    assert.equal((await get('/bundle/build.json')).res.statusCode, 200);
    const sw = await get('/sw-manifest.js');
    assert.equal(sw.res.headers['cache-control'], 'no-cache');
    assert.match(sw.body, /__SHELL_BUILD = "b"/);
  } finally {
    server.close();
  }
});

// SW-Manifest im Bündel-Modus (scripts/sw-manifest.js#bundleFiles): eingebaute
// Module/Stylesheets raus, Bündel-Dateien rein (ohne Sourcemaps), der Rest des
// Shell-Satzes bleibt — und der Build-Hash folgt der Bündel-index.html.
test('SW-Manifest des Bündels: eingebaute Einzeldateien raus, Bündel rein', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-sw-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>a</html>');
  fs.writeFileSync(path.join(dir, 'app-X.js'), 'x');
  fs.writeFileSync(path.join(dir, 'app-X.css'), 'y');
  const bundle = {
    dir,
    indexPath: path.join(dir, 'index.html'),
    build: {
      inputs: ['public/index.html', 'public/js/app.js', 'public/js/utils.js', 'public/css/tokens.css'],
      files: ['/bundle/app-X.js', '/bundle/app-X.js.map', '/bundle/app-X.css'],
    },
  };
  const m = renderManifest({ bundle });
  assert.ok(m.urls.includes('/bundle/app-X.js'));
  assert.ok(m.urls.includes('/bundle/app-X.css'));
  assert.ok(!m.urls.includes('/bundle/app-X.js.map'));
  for (const gone of ['/js/app.js', '/js/utils.js', '/css/tokens.css']) assert.ok(!m.urls.includes(gone), gone);
  for (const kept of ['/js/client-error.js', '/js/failsafe-reveal.js', '/icons.svg']) assert.ok(m.urls.includes(kept), kept);
  assert.ok(m.urls.some((u) => u.startsWith('/partials/')));
  assert.deepEqual(m.urls, [...m.urls].sort());

  const plain = renderManifest();
  assert.ok(plain.urls.includes('/js/app.js'));
  fs.writeFileSync(bundle.indexPath, '<html>b</html>');
  assert.notEqual(renderManifest({ bundle }).build, m.build, 'Build-Hash folgt der Bündel-index.html');
});
