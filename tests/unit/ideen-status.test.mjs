// Ideen-Stufen: der Vertrag zwischen Server-SSoT, Frontend-Spiegel, DB-CHECK
// und den i18n-Labels.
//
// Warum gegated: ein Status-Key ist eine Persistenz-Konstante — er steht als
// Spaltenwert in `ideen.status`, im CHECK der Tabelle, als Spalte im Board und
// als i18n-Key `ideen.status.<key>`. Faellt eine der vier Stellen aus dem Tritt,
// zeigt die Oberflaeche entweder einen rohen Key oder der Schreibpfad laeuft in
// einen CHECK-Fehler — beides erst zur Laufzeit und beides erst beim Benutzer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

const server = require(path.join(ROOT, 'lib', 'ideen-status.js'));
const shared = await import(path.join(ROOT, 'public', 'js', 'book', 'ideen-shared.js'));

const locales = Object.fromEntries(['de', 'en'].map(l =>
  [l, JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'js', 'i18n', `${l}.json`), 'utf8'))]));

test('Stufen: Server-SSoT und Frontend-Spiegel sind gleich — gleiche Keys, gleiche Reihenfolge', () => {
  assert.deepEqual(shared.IDEE_STATUSES, server.IDEE_STATUSES);
  assert.deepEqual(shared.IDEE_OPEN_STATUSES, server.IDEE_OPEN_STATUSES);
  assert.deepEqual(shared.IDEA_LINK_KINDS, server.IDEA_LINK_KINDS);
});

test('Stufen: „offen" schliesst verworfen aus', () => {
  // Die zentrale Aussage der Achse. Waere `verworfen` offen, setzte eine
  // fallengelassene Idee eine Sidebar-Plakette und ginge als Absicht des Autors
  // in den Seiten-Chat-Prompt.
  assert.ok(server.isOpenIdeeStatus('offen'));
  assert.ok(server.isOpenIdeeStatus('in_arbeit'));
  assert.equal(server.isOpenIdeeStatus('erledigt'), false);
  assert.equal(server.isOpenIdeeStatus('verworfen'), false);
  assert.equal(shared.isOpenIdee({ status: 'verworfen' }), false);
});

test('Stufen: unbekannter Wert faellt auf die erste Stufe, nicht aus dem Board', () => {
  assert.equal(server.normalizeIdeeStatus('quatsch'), 'offen');
  assert.equal(server.normalizeIdeeStatus(null), 'offen');
  assert.equal(shared.ideeStatus({ status: undefined }), 'offen');
  assert.equal(shared.ideeStatus({}), 'offen');
  // …und gilt damit als offen: eine Zeile mit kaputtem Status ist eine
  // ungeklaerte Pendenz, keine erledigte.
  assert.ok(server.isOpenIdeeStatus('quatsch'));
});

test('Stufen: jede Stufe hat ein Label in beiden Locales', () => {
  for (const s of server.IDEE_STATUSES) {
    for (const [loc, dict] of Object.entries(locales)) {
      assert.ok(dict[`ideen.status.${s}`], `${loc}: ideen.status.${s} fehlt`);
    }
  }
});

test('Verknuepfungs-Arten: jede hat ein Label in beiden Locales', () => {
  for (const k of server.IDEA_LINK_KINDS) {
    for (const [loc, dict] of Object.entries(locales)) {
      assert.ok(dict[`ideen.link.kind.${k}`], `${loc}: ideen.link.kind.${k} fehlt`);
    }
  }
});

test('Stufen: DB-CHECK der ideen-Tabelle nennt genau diese Stufen', () => {
  const { SQUASHED_SCHEMA } = require(path.join(ROOT, 'db', 'squashed-schema.js'));
  const table = SQUASHED_SCHEMA.split(/;\n/).find(p => /CREATE TABLE "?ideen"? \(/.test(p));
  assert.ok(table, 'ideen-Tabelle nicht im Squashed-Schema gefunden');
  const m = table.match(/status\s+TEXT[\s\S]*?CHECK\(status IN \(([^)]*)\)\)/);
  assert.ok(m, 'CHECK auf ideen.status nicht gefunden');
  const inCheck = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(inCheck.sort(), [...server.IDEE_STATUSES].sort());
});

test('Verknuepfungs-Arten: DB-CHECK von idea_links nennt genau diese Arten', () => {
  const { SQUASHED_SCHEMA } = require(path.join(ROOT, 'db', 'squashed-schema.js'));
  const table = SQUASHED_SCHEMA.split(/;\n/).find(p => /CREATE TABLE "?idea_links"? \(/.test(p));
  assert.ok(table, 'idea_links-Tabelle nicht im Squashed-Schema gefunden');
  const m = table.match(/target_kind\s+TEXT\s+NOT NULL CHECK\(target_kind IN \(([^)]*)\)\)/);
  assert.ok(m, 'CHECK auf idea_links.target_kind nicht gefunden');
  const inCheck = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(inCheck.sort(), [...server.IDEA_LINK_KINDS].sort());
});

test('Stufen: kein `erledigt`-Flag mehr — eine Spalte, eine Wahrheit', () => {
  // Der Rueckfall auf ein zweites Ja/Nein neben `status` waere die Drift, gegen
  // die die Migration steht: `erledigt = 1` neben `status = 'verworfen'` loest
  // kein Lesepfad sinnvoll auf.
  const { SQUASHED_SCHEMA } = require(path.join(ROOT, 'db', 'squashed-schema.js'));
  const table = SQUASHED_SCHEMA.split(/;\n/).find(p => /CREATE TABLE "?ideen"? \(/.test(p));
  // Auf die SPALTE pruefen, nicht auf das Wort: 'erledigt' ist zugleich ein
  // gueltiger Stufen-Wert und steht darum legitim im CHECK.
  assert.equal(/^\s*erledigt(_at)?\s+\w+/m.test(table), false,
    'ideen traegt wieder eine erledigt-Spalte');
});

test('SQL-Fragment: openStatusSql setzt das Alias vor die Spalte', () => {
  assert.equal(server.openStatusSql('i'), "i.status IN ('offen','in_arbeit')");
  assert.equal(server.openStatusSql(), "status IN ('offen','in_arbeit')");
});
