// public/sw-drafts.js ist ein klassisches Worker-Skript und kann
// public/js/editor/draft-idb.js nicht importieren. Datenbank, Store, Version,
// Kanal, Sync-Tag, Lock-Präfix und Konto-Schlüssel stehen dort als Kopie —
// weicht eine ab, liest der Background Sync eine leere Datenbank, meldet seine
// Löschungen ins Leere oder sendet parallel zur Outbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sw = readFileSync(join(ROOT, 'public', 'sw-drafts.js'), 'utf8');
const swMain = readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8');
const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
const storage = readFileSync(join(ROOT, 'public', 'js', 'editor', 'draft-storage.js'), 'utf8');
const idb = await import('../../public/js/editor/draft-idb.js');

const swConst = (name) => {
  const m = new RegExp(`const ${name} = (['"]?)([^'";]+)\\1;`).exec(sw);
  assert.ok(m, `${name} fehlt in sw-drafts.js`);
  return m[1] ? m[2] : Number(m[2]);
};

test('sw-drafts.js: Konstanten = draft-idb.js', () => {
  for (const name of ['DRAFT_DB', 'DRAFT_STORE', 'DRAFT_DB_VERSION', 'DRAFT_CHANNEL', 'DRAFT_SYNC_TAG', 'DRAFT_LOCK_PREFIX', 'DRAFT_SENT_PREFIX']) {
    assert.equal(swConst(name), idb[name], name);
  }
});

test('sw-drafts.js: Konto-Schlüssel wie draft-storage.js', () => {
  assert.match(storage, /const DRAFT_PREFIX = 'editor_draft_';/);
  assert.match(storage, /OWNER_PREFIX = \(owner\) => `\$\{DRAFT_PREFIX\}u:\$\{owner\}:`/);
  assert.equal(swConst('OWNER_PREFIX'), 'editor_draft_u:');
});

test('sw.js lädt sw-drafts.js, und der Server liefert es vor dem Login aus', () => {
  assert.match(swMain, /importScripts\([^)]*'\/sw-drafts\.js'/);
  assert.match(server, /'\/sw-drafts\.js',/);
});

test('sw-drafts.js: Deckel der eigenen Save-Kennungen = Server und save-ids.js', () => {
  const routes = readFileSync(join(ROOT, 'routes', 'content', 'pages.js'), 'utf8');
  const saveIds = readFileSync(join(ROOT, 'public', 'js', 'repo', 'save-ids.js'), 'utf8');
  const serverMax = Number(/const OWN_SAVE_IDS_MAX = (\d+);/.exec(routes)?.[1]);
  const clientMax = Number(/const MAX_IDS = (\d+);/.exec(saveIds)?.[1]);
  assert.ok(serverMax > 0 && clientMax === serverMax);
  assert.equal(swConst('OWN_SAVE_IDS_MAX'), serverMax);
});
