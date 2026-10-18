// Entwurfs-Ablage mit IndexedDB (editor/draft-storage.js über editor/draft-idb.js).
// localStorage ist der synchrone Vorlauf: geschrieben wird dort zuerst, nach
// der Bestätigung durch IndexedDB fällt die Kopie — sonst liesse eine
// liegengebliebene localStorage-Kopie einen Entwurf wieder auferstehen, den der
// Service Worker nach dem Background Sync geräumt hat. Gelesen wird synchron aus
// dem Spiegel, den der Start füllt und die anderen Tabs per Broadcast nachführen.
// Das echte IndexedDB prüft tests/e2e-app/book-editor-offline.spec.js.
import test from 'node:test';
import assert from 'node:assert/strict';

const ls = new Map();
let lsFull = false;
globalThis.localStorage = {
  get length() { return ls.size; },
  key(i) { return [...ls.keys()][i] ?? null; },
  getItem(k) { return ls.has(k) ? ls.get(k) : null; },
  setItem(k, v) { if (lsFull) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); ls.set(k, String(v)); },
  removeItem(k) { ls.delete(k); },
  clear() { ls.clear(); },
};

const events = [];
globalThis.window = { dispatchEvent: (e) => { events.push(e); return true; } };

const { initDraftStore, whenDraftsReady, readDraft, writeDraft, clearDraft, clearDraftIfSame, listDraftPageIds, setDraftOwner,
  listDraftBackups, moveDraftToBackup, removeDraftBackup } = await import('../../public/js/editor/draft-storage.js');

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeIdb(initial = []) {
  const db = new Map(initial);
  const sent = [];
  let listener = null;
  let failPut = false;
  let failDel = false;
  let ok = true;
  let gate = null;
  return {
    db, sent,
    usable: () => ok,
    present: () => true,
    put: async (k, v) => { await tick(); if (failPut) throw new Error('idb'); db.set(k, v); },
    del: async (k) => { await tick(); if (failDel) throw new Error('idb del'); db.delete(k); },
    getAll: async () => { if (gate) await gate; return [...db.entries()]; },
    broadcast: (m) => sent.push(m),
    onMessage: (fn) => { listener = fn; },
    receive: (m) => listener(m),
    failPuts() { failPut = true; },
    failDels() { failDel = true; },
    setUsable(v) { ok = v; },
    hold() { let release; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
  };
}

const K = (id) => `editor_draft_${id}`;
const rec = (html, savedAt = 1) => ({ html, originalHtml: '<p>b</p>', originalUpdatedAt: 'T0', savedAt });

test.beforeEach(() => { ls.clear(); lsFull = false; events.length = 0; setDraftOwner(null); });

test('Start: Entwürfe aus IndexedDB sind nach whenDraftsReady synchron lesbar', async () => {
  const idb = fakeIdb([[K(1), rec('<p>aus idb</p>')]]);
  initDraftStore(idb);
  await whenDraftsReady();
  assert.equal(readDraft(1).html, '<p>aus idb</p>');
  assert.deepEqual(listDraftPageIds(), [1]);
});

test('writeDraft: localStorage sofort, nach der Bestätigung nur noch IndexedDB', async () => {
  const idb = fakeIdb();
  initDraftStore(idb);
  await whenDraftsReady();
  assert.equal(writeDraft(2, '<p>neu</p>', '<p>b</p>', 'T0'), true);
  assert.ok(ls.has(K(2)), 'synchroner Vorlauf übersteht ein sofortiges Schliessen');
  assert.equal(readDraft(2).html, '<p>neu</p>');
  await tick(); await tick();
  assert.equal(ls.has(K(2)), false, 'Kopie fällt nach der Bestätigung');
  assert.equal(idb.db.get(K(2)).html, '<p>neu</p>');
  assert.equal(readDraft(2).html, '<p>neu</p>');
  assert.deepEqual(idb.sent.map((m) => [m.type, m.key]), [['put', K(2)]]);
});

test('Alt-Entwurf nur in localStorage (vor IndexedDB) wird beim Start übernommen', async () => {
  ls.set(K(3), JSON.stringify(rec('<p>alt</p>', 5)));
  const idb = fakeIdb();
  initDraftStore(idb);
  await whenDraftsReady();
  assert.equal(idb.db.get(K(3)).html, '<p>alt</p>');
  assert.equal(ls.has(K(3)), false);
  assert.equal(readDraft(3).html, '<p>alt</p>');
});

test('Start: jüngerer Stand gewinnt zwischen localStorage und IndexedDB', async () => {
  ls.set(K(4), JSON.stringify(rec('<p>ls älter</p>', 1)));
  const idb = fakeIdb([[K(4), rec('<p>idb jünger</p>', 9)]]);
  initDraftStore(idb);
  await whenDraftsReady();
  assert.equal(readDraft(4).html, '<p>idb jünger</p>');
  assert.equal(ls.has(K(4)), false);
});

test('clearDraft räumt IndexedDB und meldet es den anderen Tabs', async () => {
  const idb = fakeIdb([[K(5), rec('<p>x</p>')]]);
  initDraftStore(idb);
  await whenDraftsReady();
  clearDraft(5);
  assert.equal(readDraft(5), null);
  await tick();
  assert.equal(idb.db.has(K(5)), false);
  assert.deepEqual(idb.sent.at(-1), { type: 'del', key: K(5), savedAt: 1 });
});

test('Broadcast eines anderen Tabs (oder des Service Workers) führt den Spiegel nach', async () => {
  const idb = fakeIdb();
  initDraftStore(idb);
  await whenDraftsReady();
  idb.receive({ type: 'put', key: K(6), rec: rec('<p>anderer tab</p>') });
  assert.equal(readDraft(6).html, '<p>anderer tab</p>');
  idb.receive({ type: 'del', key: K(6) });
  assert.equal(readDraft(6), null);
});

test('während des Start-Ladens geräumt → kommt nicht zurück', async () => {
  const idb = fakeIdb([[K(7), rec('<p>alt</p>')]]);
  const release = idb.hold();
  initDraftStore(idb);
  clearDraft(7);
  release();
  await whenDraftsReady();
  assert.equal(readDraft(7), null);
});

test('localStorage voll: IndexedDB sichert trotzdem', async () => {
  const idb = fakeIdb();
  initDraftStore(idb);
  await whenDraftsReady();
  lsFull = true;
  assert.equal(writeDraft(8, '<p>gross</p>', '<p>b</p>', 'T0'), true);
  await tick(); await tick();
  assert.equal(idb.db.get(K(8)).html, '<p>gross</p>');
});

test('IndexedDB-Write scheitert, localStorage hielt den Stand → bleibt lesbar', async () => {
  const idb = fakeIdb();
  initDraftStore(idb);
  await whenDraftsReady();
  idb.failPuts();
  writeDraft(9, '<p>nur ls</p>', '<p>b</p>', 'T0');
  await tick(); await tick();
  assert.equal(readDraft(9).html, '<p>nur ls</p>');
  assert.ok(ls.has(K(9)));
});

test('Konto-Schlüssel: fremde Entwürfe in IndexedDB zählen nicht', async () => {
  const idb = fakeIdb([['editor_draft_u:b@x:10', { ...rec('<p>b</p>'), owner: 'b@x' }]]);
  initDraftStore(idb);
  await whenDraftsReady();
  setDraftOwner('a@x');
  assert.deepEqual(listDraftPageIds(), []);
  assert.equal(readDraft(10), null);
  setDraftOwner('b@x');
  assert.deepEqual(listDraftPageIds(), [10]);
});

test('Löschen in IndexedDB scheitert → Grabstein, nach dem Neustart kommt der Entwurf nicht zurück', async () => {
  const idb = fakeIdb([[K(20), rec('<p>alt</p>', 5)]]);
  initDraftStore(idb);
  await whenDraftsReady();
  idb.failDels();
  clearDraft(20);
  await tick(); await tick();
  assert.equal(idb.db.has(K(20)), true, 'Datensatz liegt noch');
  const idb2 = fakeIdb([...idb.db.entries()]);
  initDraftStore(idb2);
  await whenDraftsReady();
  assert.equal(readDraft(20), null);
  await tick(); await tick();
  assert.equal(idb2.db.has(K(20)), false, 'beim Start nachgeräumt');
});

test('IndexedDB vorübergehend nicht nutzbar beim Räumen → Grabstein wirkt beim Start', async () => {
  const idb = fakeIdb([[K(21), rec('<p>alt</p>', 5)]]);
  initDraftStore(idb);
  await whenDraftsReady();
  idb.setUsable(false);
  clearDraft(21);
  idb.setUsable(true);
  initDraftStore(fakeIdb([...idb.db.entries()]));
  await whenDraftsReady();
  assert.equal(readDraft(21), null);
});

test('Ein gescheiterter Write sperrt das Löschen nicht (kein Sitzungs-Bann)', async () => {
  const idb = fakeIdb([[K(22), rec('<p>alt</p>', 5)]]);
  initDraftStore(idb);
  await whenDraftsReady();
  idb.failPuts();
  writeDraft(23, '<p>x</p>', '<p>b</p>', 'T0');
  await tick(); await tick();
  clearDraft(22);
  await tick(); await tick();
  assert.equal(idb.db.has(K(22)), false);
});

test('localStorage voll UND IndexedDB scheitert → Entwurf bleibt im Spiegel, Editor wird informiert', async () => {
  const idb = fakeIdb();
  initDraftStore(idb);
  await whenDraftsReady();
  lsFull = true;
  idb.failPuts();
  assert.equal(writeDraft(24, '<p>wichtig</p>', '<p>b</p>', 'T0'), true);
  await tick(); await tick();
  assert.equal(readDraft(24)?.html, '<p>wichtig</p>', 'nicht still verworfen');
  const ev = events.find((e) => e.type === 'draft:persist-failed');
  assert.ok(ev, 'Ereignis für „nicht gesichert"');
  assert.equal(ev.detail.pageId, 24);
});

test('Lösch-Broadcast mit älterem Stand räumt einen jüngeren Entwurf im Spiegel nicht', async () => {
  const idb = fakeIdb();
  initDraftStore(idb);
  await whenDraftsReady();
  idb.receive({ type: 'put', key: K(25), rec: rec('<p>neu</p>', 50) });
  idb.receive({ type: 'del', key: K(25), savedAt: 40 });
  assert.equal(readDraft(25).html, '<p>neu</p>');
  idb.receive({ type: 'del', key: K(25), savedAt: 50 });
  assert.equal(readDraft(25), null);
});

test('Vom Service Worker nachgesendet: localStorage-Restkopie wird nicht wieder Entwurf', async () => {
  ls.set(K(26), JSON.stringify(rec('<p>gesendet</p>', 30)));
  const idb = fakeIdb([['sent:' + K(26), { savedAt: 30, at: Date.now() }]]);
  initDraftStore(idb);
  await whenDraftsReady();
  assert.equal(readDraft(26), null);
  assert.equal(ls.has(K(26)), false);
  assert.equal(idb.db.has(K(26)), false);
});

test('IndexedDB lädt zu spät: schon neu geschrieben → alter Entwurf wird Sicherung, nicht überschrieben', async () => {
  const idb = fakeIdb([[K(27), rec('<p>offline geschrieben</p>', 10)]]);
  const release = idb.hold();
  initDraftStore(idb);
  writeDraft(27, '<p>neu getippt</p>', '<p>b</p>', 'T1');
  release();
  await whenDraftsReady();
  await tick(); await tick();
  assert.equal(readDraft(27).html, '<p>neu getippt</p>');
  const backups = listDraftBackups();
  assert.equal(backups.length, 1);
  assert.equal(backups[0].kind, 'recovered');
  assert.equal(backups[0].pageId, 27);
  assert.equal(backups[0].html, '<p>offline geschrieben</p>');
  assert.ok(events.some((e) => e.type === 'draft:backup'));
  assert.deepEqual(listDraftPageIds(), [27], 'Sicherung zählt nicht als wartend');
  removeDraftBackup(backups[0].key);
  assert.equal(listDraftBackups().length, 0);
});

test('clearDraftIfSame räumt nur den gesendeten Stand', async () => {
  initDraftStore(fakeIdb());
  await whenDraftsReady();
  writeDraft(28, '<p>a</p>', '<p>b</p>', 'T0');
  const sentAt = readDraft(28).savedAt;
  await new Promise((r) => setTimeout(r, 2));
  writeDraft(28, '<p>weiter</p>', '<p>b</p>', 'T0');
  assert.equal(clearDraftIfSame(28, sentAt), false);
  assert.equal(readDraft(28).html, '<p>weiter</p>');
  assert.equal(clearDraftIfSame(28, readDraft(28).savedAt), true);
  assert.equal(readDraft(28), null);
});

test('Entwurf eines gelöschten Abschnitts → Sicherung statt ewig wartend', async () => {
  initDraftStore(fakeIdb());
  await whenDraftsReady();
  writeDraft(29, '<p>Text</p>', '<p>b</p>', 'T0');
  assert.equal(moveDraftToBackup(29), true);
  assert.deepEqual(listDraftPageIds(), []);
  assert.equal(listDraftBackups()[0].kind, 'orphan');
});

test('Kontoloser Alt-Entwurf geht nicht an ein Konto, wenn das Gerät mehrere kannte', async () => {
  initDraftStore(fakeIdb());
  await whenDraftsReady();
  setDraftOwner('a@x');
  setDraftOwner('b@x');
  ls.set(K(30), JSON.stringify(rec('<p>wessen?</p>', 5)));
  setDraftOwner('b@x');
  assert.equal(readDraft(30), null);
  assert.deepEqual(listDraftPageIds(), []);
  assert.ok(ls.has(K(30)), 'bleibt liegen, nichts gelöscht');
});

test('Zwei Tabs am selben Abschnitt: der fremde Stand wird Sicherung, nicht still überschrieben', async () => {
  initDraftStore(fakeIdb([[K(31), { ...rec('<p>Tab A</p>', 5), tab: 'anderer-tab' }]]));
  await whenDraftsReady();
  ls.set('notebook_live_edit:31', JSON.stringify({ tab: 'anderer-tab', at: Date.now() }));
  writeDraft(31, '<p>Tab B</p>', '<p>b</p>', 'T0');
  assert.equal(readDraft(31).html, '<p>Tab B</p>');
  const [b] = listDraftBackups();
  assert.equal(b?.html, '<p>Tab A</p>');
  assert.equal(b.kind, 'recovered');
  ls.delete('notebook_live_edit:31');
  writeDraft(32, '<p>x</p>', '<p>b</p>', 'T0');
  assert.equal(listDraftBackups().length, 1, 'ohne fremden Halter keine Sicherung');
});

test('Spätes IndexedDB: während des Ladens geschrieben und geräumt → alter Entwurf wird Sicherung', async () => {
  const idb = fakeIdb([[K(33), rec('<p>aus früherer Sitzung</p>', 10)]]);
  const release = idb.hold();
  initDraftStore(idb);
  writeDraft(33, '<p>neu</p>', '<p>b</p>', 'T1');
  clearDraft(33);
  release();
  await whenDraftsReady();
  assert.equal(readDraft(33), null);
  assert.ok(listDraftBackups().some((b) => b.pageId === 33 && b.html === '<p>aus früherer Sitzung</p>'));
});

test('Während des Ladens nur geräumt (nicht geschrieben) → kein Sicherungs-Rauschen', async () => {
  const idb = fakeIdb([[K(34), rec('<p>alt</p>', 10)]]);
  const release = idb.hold();
  initDraftStore(idb);
  clearDraft(34);
  release();
  await whenDraftsReady();
  assert.equal(listDraftBackups().length, 0);
});
