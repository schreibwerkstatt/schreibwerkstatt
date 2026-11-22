'use strict';
// SEO-Sichtbarkeit der oeffentlichen Seiten.
//
// Testgegenstand ist eine Zusage, die man einer Seite nicht ansieht: geteilte
// Inhalte sind privat und duerfen NIE in einem Suchindex landen. Das ist keine
// Eigenschaft von share.html (dessen Meta-Tag deckt nur den HTML-Weg ab),
// sondern eine Eigenschaft JEDER Antwort unter /share — auch der Bild-Streams
// und JSON-Antworten, die kein <head> haben. Darum wird hier der Header am
// Router geprueft und nicht das Markup.
//
// Die Gegenprobe gehoert dazu: Landing und Datenschutz sollen indexierbar
// sein. Genau das war jahrelang nicht der Fall (geerbtes noindex aus der
// Share-Vorlage), und ein Test, der nur „share ist gesperrt" prueft, haette
// den stillen Totalausfall der Sichtbarkeit nicht bemerkt.
//
// Mini-Express + http wie in tests/unit/account-delete.test.js, kein Supertest.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('seo-robots');
delete process.env.ADMIN_EMAIL;
delete process.env.DEMO_EMAIL;
delete process.env.DEMO_PASSWORD;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appSettings = require('../../lib/app-settings');

const express = require('express');
const app = express();
app.use(require('../../routes/public'));
app.use(require('../../routes/public-pages'));
app.use('/share', require('../../routes/share'));

const server = app.listen(0);
const port = server.address().port;

test.after(() => {
  server.close();
});

function _get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    req.on('error', reject);
    req.end();
  });
}

function _setIndexable(value, publicUrl = 'https://app.example.test') {
  appSettings.set('seo.indexable', value, { updatedBy: 'test' });
  appSettings.set('app.public_url', publicUrl, { updatedBy: 'test' });
}

test('geteilte Inhalte tragen X-Robots-Tag: noindex — auf JEDER Antwort unter /share', async () => {
  _setIndexable(true);
  // Unbekannter Token → 404. Gerade dieser Weg ist wichtig: er liefert kein
  // share.html aus, das Meta-Tag greift hier also gar nicht.
  const res = await _get('/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.match(res.headers['x-robots-tag'] || '', /noindex/);
  assert.match(res.headers['x-robots-tag'] || '', /nofollow/);
});

test('/share bleibt auch bei indexierbarer Instanz gesperrt', async () => {
  _setIndexable(true);
  const res = await _get('/share/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.match(res.headers['x-robots-tag'] || '', /noindex/);
});

test('robots.txt sperrt /share NICHT — ein Disallow verdeckte den noindex-Header', async () => {
  // Kein Test der Formulierung, sondern der Wirkungskette: waere /share per
  // robots.txt verboten, koennte der Crawler den noindex-Header nie lesen und
  // ein von aussen verlinkter Token landete als reiner URL-Eintrag im Index.
  _setIndexable(true);
  const res = await _get('/robots.txt');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.body, /Disallow:\s*\/share/i);
});

test('robots.txt nennt die Sitemap unter der konfigurierten Basis-URL', async () => {
  _setIndexable(true, 'https://app.example.test');
  const res = await _get('/robots.txt');
  assert.match(res.body, /^Sitemap: https:\/\/app\.example\.test\/sitemap\.xml$/m);
});

test('Landing und Datenschutz sind indexierbar und nennen ihre kanonische URL', async () => {
  _setIndexable(true, 'https://app.example.test');
  for (const [urlPath, canonical] of [['/landing', '/'], ['/datenschutz', '/datenschutz']]) {
    const res = await _get(urlPath);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.body, /noindex/, `${urlPath} darf kein noindex tragen`);
    assert.match(res.body, new RegExp(`<link rel="canonical" href="https://app\\.example\\.test${canonical === '/' ? '/' : canonical}">`));
  }
});

test('/privacy zeigt kanonisch auf /datenschutz — sonst konkurrieren zwei URLs mit gleichem Inhalt', async () => {
  _setIndexable(true, 'https://app.example.test');
  const res = await _get('/privacy');
  assert.match(res.body, /<link rel="canonical" href="https:\/\/app\.example\.test\/datenschutz">/);
});

test('seo.indexable=false nimmt die ganze Instanz aus dem Index', async () => {
  _setIndexable(false);
  const robots = await _get('/robots.txt');
  assert.match(robots.body, /^Disallow: \/$/m);

  const sitemap = await _get('/sitemap.xml');
  assert.equal(sitemap.status, 404);

  for (const urlPath of ['/landing', '/datenschutz']) {
    const res = await _get(urlPath);
    assert.match(res.body, /<meta name="robots" content="noindex, nofollow">/, `${urlPath} braucht noindex`);
  }
});

test('ohne app.public_url bleibt die Instanz unindexiert — es gibt keine kanonische Adresse', async () => {
  _setIndexable(true, '');
  const robots = await _get('/robots.txt');
  assert.match(robots.body, /^Disallow: \/$/m);

  const landing = await _get('/landing');
  assert.match(landing.body, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(landing.body, /rel="canonical"/);
});

test('Themenseiten und Werkzeug sind indexierbar, kanonisch und stehen in der Sitemap', async () => {
  _setIndexable(true, 'https://app.example.test');
  for (const urlPath of ['/lektorat', '/testleser', '/wortwiederholungen']) {
    const res = await _get(urlPath);
    assert.equal(res.status, 200, urlPath);
    assert.doesNotMatch(res.body, /noindex/, `${urlPath} darf kein noindex tragen`);
    assert.match(res.body, new RegExp(`<link rel="canonical" href="https://app\\.example\\.test${urlPath}">`));
    assert.match(res.body, /<meta name="description" content="[^"]{60,}">/, `${urlPath} braucht eine Meta-Description`);
  }
  const sitemap = await _get('/sitemap.xml');
  for (const urlPath of ['/', '/lektorat', '/testleser', '/wortwiederholungen', '/datenschutz']) {
    assert.match(sitemap.body, new RegExp(`<loc>https://app\\.example\\.test${urlPath}</loc>`), urlPath);
  }
});

test('Themenseiten folgen seo.indexable=false', async () => {
  _setIndexable(false);
  for (const urlPath of ['/lektorat', '/testleser', '/wortwiederholungen']) {
    const res = await _get(urlPath);
    assert.match(res.body, /<meta name="robots" content="noindex, nofollow">/, `${urlPath} braucht noindex`);
  }
});

test('Landing trägt Meta-Description, OG-Bild und SoftwareApplication-Strukturdaten', async () => {
  _setIndexable(true, 'https://app.example.test');
  const res = await _get('/landing');
  assert.match(res.body, /<meta name="description" content="[^"]{60,}">/);
  assert.match(res.body, /<meta property="og:image" content="https:\/\/app\.example\.test\/img\/landing\/lektorat\.webp">/);
  const ld = /<script type="application\/ld\+json">([^<]+)<\/script>/.exec(res.body);
  assert.ok(ld, 'ld+json fehlt');
  const data = JSON.parse(ld[1])['@graph'].find(n => n['@type'] === 'SoftwareApplication');
  assert.ok(data, 'SoftwareApplication fehlt');
  assert.equal(data.offers.price, '0');
});

test('jede Sprachfassung hat eine eigene URL mit hreflang-Gruppe (Googlebot schickt kein Accept-Language)', async () => {
  _setIndexable(true, 'https://app.example.test');
  const en = await _get('/lektorat?lang=en');
  assert.match(en.body, /<html lang="en">/);
  assert.match(en.body, /<link rel="canonical" href="https:\/\/app\.example\.test\/lektorat\?lang=en">/);
  for (const [hl, href] of [['de', '/lektorat'], ['en', '/lektorat?lang=en'], ['x-default', '/lektorat']]) {
    const re = new RegExp(`<link rel="alternate" hreflang="${hl}" href="https://app\\.example\\.test${href.replace('?', '\\?')}">`);
    assert.match(en.body, re, hl);
  }
  const de = await _get('/datenschutz?lang=de');
  assert.match(de.body, /<html lang="de">/);
  assert.match(de.body, /<link rel="canonical" href="https:\/\/app\.example\.test\/datenschutz">/);
  assert.match(de.body, /<meta name="description" content="[^"]{60,}">/);
});

test('Sitemap listet beide Sprachfassungen mit vollständigen hreflang-Alternativen', async () => {
  _setIndexable(true, 'https://app.example.test');
  const res = await _get('/sitemap.xml');
  assert.match(res.body, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  const blocks = res.body.match(/<url>[\s\S]*?<\/url>/g);
  assert.equal(blocks.length, 10, '5 Seiten × 2 Sprachen');
  for (const b of blocks) {
    assert.equal((b.match(/<xhtml:link /g) || []).length, 3, b);
  }
  assert.match(res.body, /<loc>https:\/\/app\.example\.test\/wortwiederholungen\?lang=en<\/loc>/);
});

test('Strukturdaten: WebSite auf der Landing, Brotkrumen auf Themen- und Werkzeugseite', async () => {
  _setIndexable(true, 'https://app.example.test');
  const ldOf = (body) => JSON.parse(/<script type="application\/ld\+json">([^<]+)<\/script>/.exec(body)[1]);
  const landing = ldOf((await _get('/landing')).body);
  const site = landing['@graph'].find(n => n['@type'] === 'WebSite');
  assert.equal(site.url, 'https://app.example.test/');
  for (const urlPath of ['/lektorat', '/wortwiederholungen']) {
    const ld = ldOf((await _get(urlPath)).body);
    const nodes = ld['@graph'] || [ld];
    const crumbs = nodes.find(n => n['@type'] === 'BreadcrumbList');
    assert.ok(crumbs, urlPath);
    assert.equal(crumbs.itemListElement[1].item, `https://app.example.test${urlPath}`);
  }
});
