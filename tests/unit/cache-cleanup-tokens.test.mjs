// Passwort-Einmal-Links (user_password_tokens) werden vom taeglichen Cleanup
// (lib/cache-cleanup.js) aufgeraeumt: verbrauchte sofort, abgelaufene nach 30
// Tagen, offene gueltige bleiben. Ohne das wuchs die Tabelle unbegrenzt.
//
// Lauf: `node --test tests/unit/cache-cleanup-tokens.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('cleanup-tokens-test');
delete process.env.ADMIN_EMAIL;
require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const creds = require('../../db/user-credentials');
const { runCacheCleanup } = require('../../lib/cache-cleanup');

test('verbrauchte und lange abgelaufene Tokens fallen, offene bleiben', () => {
  for (const e of ['a@x.test', 'b@x.test', 'c@x.test']) appUsers.createUser({ email: e });
  const open = creds.createToken('a@x.test');
  creds.createToken('b@x.test');
  db.prepare("UPDATE user_password_tokens SET used_at = expires_at WHERE user_email = 'b@x.test'").run();
  creds.createToken('c@x.test');
  db.prepare("UPDATE user_password_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_email = 'c@x.test'").run();

  const summary = runCacheCleanup();
  const entry = summary.tables.find(t => t.table === 'user_password_tokens');
  assert.equal(entry.removed, 2);
  const left = db.prepare('SELECT user_email FROM user_password_tokens').all().map(r => r.user_email);
  assert.deepEqual(left, ['a@x.test']);
  assert.ok(creds.findValidToken(open.token));
});
