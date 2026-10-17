'use strict';
// stripActiveContent: Script-URLs, die erst zur Laufzeit wirken (SVG-Animation
// setzt `href` nachtraeglich) oder hinter Zeichenreferenzen stecken
// (`javascript&#58;` — der Browser dekodiert sie im Attribut, der Vorab-Test
// darf darum nicht den Fast-Path nehmen). Dazu die Rekursionsfestigkeit des
// Gesamt-Sanitizers auf tief verschachteltem Inline-Markup.

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripActiveContent, cleanPageHtml, stripBlockEdgeNbsp } = require('../../lib/html-clean');

test('SVG <animate attributeName=href to=javascript:> faellt ganz', () => {
  const out = stripActiveContent('<svg><a><animate attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>');
  assert.ok(!/animate/i.test(out), out);
  assert.ok(!/javascript/i.test(out), out);
  assert.ok(out.includes('<text>x</text>'));
});

test('SVG <set attributeName=xlink:href> und values-Liste fallen', () => {
  for (const h of [
    '<svg><set attributeName="xlink:href" to="javascript:alert(1)"/></svg>',
    '<svg><a><animate attributeName="href" values="#a;javascript:alert(1)"/></a></svg>',
    '<svg><a><animate attributeName="href" from="javascript:alert(1)" to="#b"/></a></svg>',
    '<svg><a><animate attributeName="href" by="javascript:alert(1)"/></a></svg>',
  ]) {
    const out = stripActiveContent(h);
    assert.ok(!/javascript/i.test(out), `${h} -> ${out}`);
  }
});

test('Wert-Attribute mit Script-URL fallen auch ohne URL-Ziel', () => {
  const out = stripActiveContent('<svg><animate attributeName="x" values="1;javascript:alert(1)"/></svg>');
  assert.ok(!/javascript/i.test(out), out);
});

test('harmlose SVG-Animation bleibt', () => {
  const h = '<svg><animate attributeName="opacity" from="0" to="1"/></svg>';
  assert.ok(/<animate attributeName="opacity" from="0" to="1"/.test(stripActiveContent(h)));
});

test('Zeichenreferenzen umgehen den Fast-Path nicht', () => {
  for (const h of [
    '<p><a href="javascript&#58;alert(1)">x</a></p>',
    '<p><a href="javascript&#x3A;alert(1)">x</a></p>',
    '<p><a href="&#106;avascript:alert(1)">x</a></p>',
    '<p><a href="javascript&colon;alert(1)">x</a></p>',
    '<p><a href="java&Tab;script&colon;alert(1)">x</a></p>',
  ]) {
    assert.equal(stripActiveContent(h), '<p><a>x</a></p>', h);
  }
});

test('NBSP-Entity allein loest kein Strippen aus', () => {
  assert.equal(stripActiveContent('<p>a&#160;b</p>'), '<p>a&#160;b</p>');
});

test('tief verschachteltes Inline-Markup: kein Stack-Overflow, onerror faellt', () => {
  const n = 20000;
  const html = '<p><img src=x onerror=alert(1)></p>' + '<b>'.repeat(n) + '&nbsp;x&nbsp;' + '</b>'.repeat(n);
  const out = cleanPageHtml(html);
  assert.ok(!out.includes('onerror'));
  assert.ok(out.includes('x</b>'));
  assert.ok(!/&nbsp;x|x&nbsp;| x|x /.test(out), 'Rand-NBSP weiterhin getrimmt');
});

test('stripBlockEdgeNbsp: erster/letzter Textknoten ueber Verschachtelung', () => {
  assert.equal(
    stripBlockEdgeNbsp('<p><i></i><b><i> a</i></b> mitte <b>z </b><i></i></p>'),
    '<p><i></i><b><i>a</i></b> mitte <b>z</b><i></i></p>'
  );
});
