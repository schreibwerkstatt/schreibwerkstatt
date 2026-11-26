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

function _get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, headers }, (res) => {
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

test('Themenseiten sind indexierbar, kanonisch und stehen in der Sitemap', async () => {
  _setIndexable(true, 'https://app.example.test');
  for (const urlPath of ['/schreiben', '/lektorat', '/testleser', '/funktionen']) {
    const res = await _get(urlPath);
    assert.equal(res.status, 200, urlPath);
    assert.doesNotMatch(res.body, /noindex/, `${urlPath} darf kein noindex tragen`);
    assert.match(res.body, new RegExp(`<link rel="canonical" href="https://app\\.example\\.test${urlPath}">`));
    assert.match(res.body, /<meta name="description" content="[^"]{60,}">/, `${urlPath} braucht eine Meta-Description`);
  }
  const sitemap = await _get('/sitemap.xml');
  for (const urlPath of ['/', '/schreiben', '/lektorat', '/testleser', '/funktionen', '/datenschutz']) {
    assert.match(sitemap.body, new RegExp(`<loc>https://app\\.example\\.test${urlPath}</loc>`), urlPath);
  }
});

test('Themenseiten folgen seo.indexable=false', async () => {
  _setIndexable(false);
  for (const urlPath of ['/schreiben', '/lektorat', '/testleser', '/funktionen']) {
    const res = await _get(urlPath);
    assert.match(res.body, /<meta name="robots" content="noindex, nofollow">/, `${urlPath} braucht noindex`);
  }
});

test('Landing trägt Meta-Description, OG-Bild und SoftwareApplication-Strukturdaten', async () => {
  _setIndexable(true, 'https://app.example.test');
  const res = await _get('/landing');
  assert.match(res.body, /<meta name="description" content="[^"]{60,}">/);
  assert.match(res.body, /<meta property="og:image" content="https:\/\/app\.example\.test\/img\/landing\/og-landing-de\.jpg">/);
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
  assert.equal(blocks.length, 12, '6 Seiten × 2 Sprachen');
  for (const b of blocks) {
    assert.equal((b.match(/<xhtml:link /g) || []).length, 3, b);
  }
  assert.match(res.body, /<loc>https:\/\/app\.example\.test\/testleser\?lang=en<\/loc>/);
});

test('Strukturdaten: WebSite auf der Landing, Brotkrumen auf Themenseiten', async () => {
  _setIndexable(true, 'https://app.example.test');
  const ldOf = (body) => JSON.parse(/<script type="application\/ld\+json">([^<]+)<\/script>/.exec(body)[1]);
  const landing = ldOf((await _get('/landing')).body);
  const site = landing['@graph'].find(n => n['@type'] === 'WebSite');
  assert.equal(site.url, 'https://app.example.test/');
  for (const urlPath of ['/lektorat', '/funktionen']) {
    const ld = ldOf((await _get(urlPath)).body);
    const nodes = ld['@graph'] || [ld];
    const crumbs = nodes.find(n => n['@type'] === 'BreadcrumbList');
    assert.ok(crumbs, urlPath);
    assert.equal(crumbs.itemListElement[1].item, `https://app.example.test${urlPath}`);
  }
});

test('indexierbare Seiten: Sprache allein aus der URL, Browser-Englisch bekommt nur einen Hinweis-Link', async () => {
  // Sonst lieferte dieselbe URL je nach Accept-Language eine andere Sprache
  // samt anderem canonical, und ein Crawler mit `en` saehe die deutsche
  // Standard-URL als Duplikat der englischen.
  _setIndexable(true, 'https://app.example.test');
  for (const urlPath of ['/', '/schreiben', '/lektorat', '/testleser', '/funktionen', '/datenschutz']) {
    const res = await _get(urlPath === '/' ? '/landing' : urlPath, { 'accept-language': 'en-US,en;q=0.9' });
    assert.match(res.body, /<html lang="de">/, urlPath);
    assert.match(res.body, new RegExp(`<link rel="canonical" href="https://app\\.example\\.test${urlPath}">`), urlPath);
    const enUrl = `${urlPath}?lang=en`.replace('?', '\\?');
    assert.match(res.body, new RegExp(`class="public-lang-hint" lang="en"><a class="public-inline-link" href="${enUrl}" hreflang="en">This page`), urlPath);
    const plain = await _get(urlPath === '/' ? '/landing' : urlPath);
    assert.doesNotMatch(plain.body, /public-lang-hint/, `${urlPath}: ohne Browser-Englisch kein Hinweis`);
    assert.match(plain.body, new RegExp(`class="public-footer-link" href="${enUrl}" hreflang="en" lang="en">English</a>`), `${urlPath}: Umschalter`);
    assert.equal(res.headers['cache-control'], 'private, no-cache', urlPath);
  }
  const en = await _get('/lektorat?lang=en', { 'accept-language': 'de' });
  assert.match(en.body, /<html lang="en">/);
  assert.match(en.body, /class="public-footer-link" href="\/lektorat" hreflang="de" lang="de">Deutsch<\/a>/);
});

test('/privacy (nicht indexierter Alias) folgt weiter dem Browser', async () => {
  _setIndexable(true, 'https://app.example.test');
  const res = await _get('/privacy', { 'accept-language': 'en' });
  assert.match(res.body, /<html lang="en">/);
});

test('Vorschaubild: 1200×630-JPEG je Seite und Sprache, Datei vorhanden, Meta vollständig', async () => {
  _setIndexable(true, 'https://app.example.test');
  const { PAGES, LANGS } = require('../../scripts/landing-shots/og-image');
  const pathOf = { landing: '/landing', schreiben: '/schreiben', lektorat: '/lektorat', testleser: '/testleser', funktionen: '/funktionen' };
  assert.deepEqual(Object.keys(PAGES).sort(), Object.keys(pathOf).sort());
  for (const key of Object.keys(PAGES)) {
    for (const lang of LANGS) {
      const file = path.join(__dirname, '..', '..', 'public', 'img', 'landing', `og-${key}-${lang}.jpg`);
      assert.ok(fs.existsSync(file), `${file} fehlt — npm run shots:og`);
      const res = await _get(`${pathOf[key]}${lang === 'de' ? '' : '?lang=en'}`);
      assert.match(res.body, new RegExp(`<meta property="og:image" content="https://app\\.example\\.test/img/landing/og-${key}-${lang}\\.jpg">`), `${key} ${lang}`);
      assert.match(res.body, /<meta property="og:image:width" content="1200">/);
      assert.match(res.body, /<meta property="og:image:height" content="630">/);
      assert.match(res.body, new RegExp(`<meta property="og:locale" content="${lang === 'de' ? 'de_DE' : 'en_US'}">`));
      assert.match(res.body, /<meta property="og:site_name" content="[^"]+">/);
      assert.match(res.body, /<link rel="apple-touch-icon" href="\/icon-192\.png">/);
      assert.match(res.body, /<meta name="theme-color" content="#faf7f2" media="\(prefers-color-scheme: light\)">/);
    }
  }
});
