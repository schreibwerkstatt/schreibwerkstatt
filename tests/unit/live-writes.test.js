// Live-Meldung erfolgreicher Schreib-Requests mit Buch-Kontext
// (lib/live-writes.js): Bereich aus dem Pfad, nur bei Erfolg, nur mit Buch,
// Tab-ID aus dem Header als Echo-Herkunft.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { liveWrites, kindForPath, validTabId } = require('../../lib/live-writes');
const { bus } = require('../../lib/book-events');
const { runWithContext, setContext } = require('../../lib/log-context');

test('kindForPath: Bereiche, Ausnahmen, Manuskript nicht', () => {
  assert.equal(kindForPath('/ideen/12'), 'ideen');
  assert.equal(kindForPath('/ideen?book_id=3'), 'ideen');
  assert.equal(kindForPath('/redaktion/page/5'), 'redaktion');
  assert.equal(kindForPath('/research/7/links'), 'recherche');
  assert.equal(kindForPath('/plot/beats/1'), 'plot');
  assert.equal(kindForPath('/share/api/links'), 'shareLinks');
  assert.equal(kindForPath('/share/api/links/abc/reviewers'), 'shareLinks');
  assert.equal(kindForPath('/share/api/links/abc/comments'), null, 'Kommentare explizit');
  assert.equal(kindForPath('/share/api/comments/4/resolve'), null);
  assert.equal(kindForPath('/draft-figures/1'), 'figuren');
  assert.equal(kindForPath('/content/pages/1'), null, 'Manuskript hat eigenen Anstoss');
  assert.equal(kindForPath('/jobs/lektorat'), null);
  assert.equal(kindForPath('/ideenx'), null);
});

test('validTabId: nur 12 Hex-Zeichen', () => {
  assert.equal(validTabId('0123456789ab'), '0123456789ab');
  assert.equal(validTabId('0123456789AB'), null);
  assert.equal(validTabId('x'), null);
  assert.equal(validTabId(undefined), null);
});

function fakeReq(method, url, headers = {}) {
  return { method, originalUrl: url, url, get: (h) => headers[h.toLowerCase()] };
}
function fakeRes(status) {
  return { statusCode: status, end() { return 'ended'; } };
}
// Request durch die Middleware schicken; `handler` läuft wie ein Route-Handler
// im selben ALS-Kontext und beendet die Antwort.
function run(req, res, handler) {
  const seen = [];
  const on = (bookId, kind, origin) => seen.push({ bookId, kind, origin });
  bus.on('meta', on);
  try {
    runWithContext({ job: 'http' }, () => liveWrites(req, res, () => handler(res)));
  } finally { bus.off('meta', on); }
  return seen;
}

test('Erfolg mit Buch-Kontext → eine Meldung mit Tab-Herkunft', () => {
  const seen = run(fakeReq('POST', '/ideen', { 'x-tab-id': 'abcdefabcdef' }), fakeRes(200), (res) => {
    setContext({ book: 42 });
    res.end();
    res.end();
  });
  assert.deepEqual(seen, [{ bookId: 42, kind: 'ideen', origin: { tabId: 'abcdefabcdef' } }]);
});

test('keine Meldung: Fehlerstatus, ohne Buch, GET, Manuskript', () => {
  assert.equal(run(fakeReq('PATCH', '/ideen/1'), fakeRes(404), (res) => { setContext({ book: 1 }); res.end(); }).length, 0);
  assert.equal(run(fakeReq('PATCH', '/ideen/1'), fakeRes(200), (res) => res.end()).length, 0);
  assert.equal(run(fakeReq('GET', '/ideen'), fakeRes(200), (res) => { setContext({ book: 1 }); res.end(); }).length, 0);
  assert.equal(run(fakeReq('PUT', '/content/pages/1'), fakeRes(200), (res) => { setContext({ book: 1 }); res.end(); }).length, 0);
});

test('ohne gültige Tab-ID: Herkunft leer (alle Tabs bekommen die Meldung)', () => {
  const seen = run(fakeReq('DELETE', '/plot/beats/3', { 'x-tab-id': 'nope' }), fakeRes(200), (res) => { setContext({ book: 7 }); res.end(); });
  assert.deepEqual(seen, [{ bookId: 7, kind: 'plot', origin: { tabId: null } }]);
});
