// Push-Sperre + Bild-Vergleich des HubSpot-Syncs:
//   lib/hubspot-html.js#hubspotLossyParts — was der Rundweg verliert
//   lib/sync/image-mirror.js#remoteImageKey — dieselbe HubSpot-Datei unter
//   CDN-, Blog- und Skalier-Adresse ist ein Bild
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { hubspotLossyParts, hubspotToAppHtml } = (await import('../../lib/hubspot-html.js')).default;
const { remoteImageKey } = (await import('../../lib/sync/image-mirror.js')).default;

test('hubspotLossyParts: schlichter Post mit Bild, Tabelle, Liste sperrt nicht', () => {
  const body = '<h2>T</h2><p>Text <strong>fett</strong> <span style="color:#f00">rot</span></p>'
    + '<p><img src="https://x.hubspotusercontent-eu1.net/hubfs/1/a.png" alt="a"></p>'
    + '<ul><li>a</li></ul><table><tr><td>1</td></tr></table>';
  assert.deepEqual(hubspotLossyParts(body), []);
});

test('hubspotLossyParts: CTA (Wrapper und HubL), Formular, Modul, Embed, Medien', () => {
  assert.deepEqual(hubspotLossyParts('<span class="hs-cta-wrapper"><a href="https://x">Go</a></span>'), ['hs-cta']);
  assert.deepEqual(hubspotLossyParts('<p>{{ cta(\'abc-123\') }}</p>'), ['hs-cta']);
  assert.deepEqual(hubspotLossyParts('<p>{% form "kontakt" form_to_use="x" %}</p>'), ['hs-form']);
  assert.deepEqual(hubspotLossyParts('<div class="hs-form"></div>'), ['hs-form']);
  assert.deepEqual(hubspotLossyParts('<p>{% module "m" path="@hubspot/rich_text" %}</p>'), ['hs-module']);
  assert.deepEqual(hubspotLossyParts('<div class="hs-embed-wrapper"><iframe src="https://y"></iframe></div>').sort(), ['hs-embed', 'iframe']);
  assert.deepEqual(hubspotLossyParts('<video src="https://v"></video>'), ['video']);
  assert.deepEqual(hubspotLossyParts('<p><img src="http://alt.example/a.png"></p>'), ['image-unsupported']);
});

test('hubspotLossyParts: wörtliche Klammer als Entity (so schreibt der Push sie) ist kein Modul', () => {
  assert.deepEqual(hubspotLossyParts('<p>&#123;{ keine Vorlage }}</p>'), []);
});

test('hubspotToAppHtml: Bilder nur mit images: true', () => {
  const raw = '<p>a</p><p><img src="https://h/x.png" alt="b"></p>';
  assert.doesNotMatch(hubspotToAppHtml(raw), /<img/);
  assert.match(hubspotToAppHtml(raw, { images: true }), /<img src="https:\/\/h\/x\.png" alt="b">/);
});

test('remoteImageKey: CDN, Blog-Domain und Skalier-Adresse sind dieselbe Datei', () => {
  const a = remoteImageKey('https://123.fs1.hubspotusercontent-eu1.net/hubfs/4242/Bilder/Team%20A.png');
  const b = remoteImageKey('https://blog.dotag.example/hubfs/Bilder/Team A.png');
  const c = remoteImageKey('https://blog.dotag.example/hs-fs/hubfs/Bilder/team%20a.png?width=600&name=team.png');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.notEqual(a, remoteImageKey('https://blog.dotag.example/hubfs/Bilder/anderes.png'));
  assert.equal(remoteImageKey('https://fremd.example/a/b.jpg'), 'fremd.example/a/b.jpg');
  assert.equal(remoteImageKey('kein url'), '');
});
