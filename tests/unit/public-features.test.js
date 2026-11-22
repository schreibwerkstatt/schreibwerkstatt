'use strict';
// Funktionsuebersicht /funktionen (routes/public-features.js).
//
// Zusagen, die man der Route nicht ansieht: jeder Bereich und jede Funktion
// hat Text in beiden Sprachen (ein fehlender Key stuende sonst als
// «publicFeatures.x.y» auf einer oeffentlichen Seite), jedes referenzierte
// Bild liegt unter public/img/landing/ (sonst ein kaputtes Bild nach einem
// Screenshot-Lauf, der es nicht mehr erzeugt), und die Landing verlinkt die
// Seite.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('public-features');
delete process.env.ADMIN_EMAIL;
delete process.env.DEMO_EMAIL;
delete process.env.DEMO_PASSWORD;

require('../../db/migrations');
const { tServer } = require('../../lib/i18n-server');
const { FEATURE_GROUPS } = require('../../routes/public-features');
const { escHtml } = require('../../lib/public-render');

const express = require('express');
const app = express();
app.use(require('../../routes/public'));
app.use(require('../../routes/public-pages'));
const server = app.listen(0);
const port = server.address().port;
test.after(() => server.close());

function _get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    }).on('error', reject);
  });
}

const ROOT = path.join(__dirname, '..', '..');

test('jeder Bereich und jede Funktion hat Text in beiden Sprachen', () => {
  const de = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/js/i18n/de.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/js/i18n/en.json'), 'utf8'));
  const keys = ['publicFeatures.title', 'publicFeatures.metaDescription', 'publicFeatures.h1',
    'publicFeatures.intro', 'publicFeatures.tocLabel', 'landing.allFeaturesLink'];
  for (const g of FEATURE_GROUPS) {
    keys.push(`publicFeatures.${g.key}.title`, `publicFeatures.${g.key}.intro`);
    for (const i of g.items) keys.push(`publicFeatures.${g.key}.${i}.title`, `publicFeatures.${g.key}.${i}.desc`);
  }
  for (const k of keys) {
    assert.ok(typeof de[k] === 'string' && de[k].trim(), `de: ${k}`);
    assert.ok(typeof en[k] === 'string' && en[k].trim(), `en: ${k}`);
  }
});

test('jedes Bereichsbild liegt unter public/img/landing/', () => {
  for (const g of FEATURE_GROUPS) {
    if (!g.img) continue;
    assert.ok(fs.existsSync(path.join(ROOT, 'public/img/landing', `${g.img}.webp`)), `${g.key}: ${g.img}.webp fehlt`);
  }
});

test('/funktionen rendert alle Bereiche ohne rohen Key, in beiden Sprachen', async () => {
  for (const lang of ['de', 'en']) {
    const res = await _get(`/funktionen?lang=${lang}`);
    assert.equal(res.status, 200);
    assert.match(res.body, new RegExp(`<html lang="${lang}">`));
    assert.doesNotMatch(res.body, /publicFeatures\./, 'unaufgeloester Key im Markup');
    assert.doesNotMatch(res.body, /\{\{\w+\}\}/, 'unersetzte Template-Variable');
    for (const g of FEATURE_GROUPS) {
      assert.match(res.body, new RegExp(`id="f-${g.key}"`), g.key);
      assert.match(res.body, new RegExp(`href="#f-${g.key}"`), `Inhaltsverzeichnis: ${g.key}`);
      for (const i of g.items) {
        const title = escHtml(tServer(`publicFeatures.${g.key}.${i}.title`, lang))
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.match(res.body, new RegExp(`<h3>${title}</h3>`), `${lang} ${g.key}.${i}`);
      }
    }
  }
});

test('Landing verlinkt die Funktionsuebersicht', async () => {
  const res = await _get('/landing');
  assert.match(res.body, /href="\/funktionen"/);
});
