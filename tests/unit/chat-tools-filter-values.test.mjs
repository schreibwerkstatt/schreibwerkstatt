// Filterwerte und Analyse-Stand der Chat-Werkzeuge (routes/jobs/chat-tools/shared.js):
//  - Text-Filter auf ein Vokabular (typ, schwere): ein Wert, der in den Daten nie
//    vorkommt, liefert die vorhandenen Werte statt einer stillen leeren Liste —
//    sonst liest das Modell «keine Treffer» als Befund.
//  - Enum-Filter (status, kind, kategorie): ein ungültiger Wert ist ein
//    invalidParam-Fehler statt eines still verworfenen Filters (= ganze Liste).
//  - Katalog-Ergebnisse tragen den Stand der letzten Komplettanalyse und melden
//    seither bearbeitete Abschnitte.
//  - Katalog: Beispielwerte in Parameter-Beschreibungen sind gültige Werte, feste
//    Enums stimmen mit den Komplett-Schemas überein.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('chat-tools-filter-values');

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const plot = require('../../db/plot');
const { db } = require('../../db/connection');
const { executeTool } = require('../../routes/jobs/chat-tools');
const { filterMiss, invalidEnum } = require('../../routes/jobs/chat-tools/shared');
const { FAKT_KATEGORIE_WL } = require('../../db/world-facts');

const P = await import('../../public/js/prompts.js');
const { TIMELINE_TYPEN, CONTINUITY_SCHWEREN } = await import('../../public/js/prompts/chat-tools/catalog-world.js');
const { SCHEMA_ZEITSTRAHL, SCHEMA_KONTINUITAET_PROBLEME } = await import('../../public/js/prompts/komplett/schemas.js');
const { KONTINUITAET_TYPEN } = await import('../../public/js/prompts/komplett/schema-strings.js');
const { ALLE_LEKTORAT_TYPEN } = await import('../../public/js/prompts/lektorat-typen.js');

const USER = 'filter@x.test';
const BOOK = 771401;
const NOW = '2026-01-01T00:00:00.000Z';
const RUN_END = '2026-02-01T00:00:00.000Z';
const LATER = '2026-03-01T00:00:00.000Z';

appUsers.createUser({ email: USER, displayName: 'Filter' });
schema.upsertBookByName(BOOK, 'Filter-Testbuch');

const chId = db.prepare('INSERT INTO chapters (book_id, chapter_name, parent_chapter_id, position) VALUES (?, ?, NULL, 1)')
  .run(BOOK, 'Eins').lastInsertRowid;
const insPage = db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, body_html, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
const P_OLD = 7714011, P_NEW = 7714012;
insPage.run(P_OLD, BOOK, chId, 'Alt', '<p>Es war einmal.</p>', NOW);
insPage.run(P_NEW, BOOK, chId, 'Neu', '<p>Danach.</p>', LATER);

const checkId = db.prepare('INSERT INTO continuity_checks (book_id, user_email, checked_at) VALUES (?, ?, ?)')
  .run(BOOK, USER, NOW).lastInsertRowid;
const insIssue = db.prepare(`INSERT INTO continuity_issues
  (check_id, book_id, typ, schwere, beschreibung, resolved, dismissed, sort_order) VALUES (?, ?, ?, ?, ?, 0, 0, ?)`);
insIssue.run(checkId, BOOK, 'zeitlinie', 'kritisch', 'Datum widerspricht sich', 0);
insIssue.run(checkId, BOOK, 'figur', 'mittel', 'Augenfarbe wechselt', 1);
insIssue.run(checkId, BOOK, 'ort', 'mittel', 'Haus steht woanders', 2);

const insEvent = db.prepare('INSERT INTO zeitstrahl_events (book_id, user_email, datum, ereignis, typ, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
insEvent.run(BOOK, USER, '1989', 'Mauerfall', 'extern', 0);
insEvent.run(BOOK, USER, '1990', 'Umzug', 'persoenlich', 1);

db.prepare(`INSERT INTO page_checks (page_id, book_id, checked_at, error_count, errors_json, user_email)
            VALUES (?, ?, ?, ?, ?, ?)`)
  .run(P_OLD, BOOK, NOW, 2, JSON.stringify([
    { typ: 'stil', original: 'a', korrektur: 'b', erklaerung: 'c' },
    { typ: 'grammatik', original: 'd', korrektur: 'e', erklaerung: 'f' },
  ]), USER);

const ctx = () => ({ bookId: BOOK, userEmail: USER, logger: { info() {}, warn() {} } });
const run = (name, input) => executeTool(name, input, ctx());

// ── Helfer ───────────────────────────────────────────────────────────────────

test('filterMiss: vorhandener Wert (Gross/Klein, Leerraum egal) → null, fehlender → Werte mit Anzahl', () => {
  const vals = ['kritisch', 'Mittel', 'mittel', null, ''];
  assert.equal(filterMiss('schwere', ' KRITISCH ', vals), null);
  assert.equal(filterMiss('schwere', undefined, vals), null);
  assert.equal(filterMiss('schwere', '', vals), null);
  const miss = filterMiss('schwere', 'hoch', vals);
  assert.deepEqual(miss.available_values, { kritisch: 1, mittel: 2 });
  assert.match(miss.hint, /«hoch» kommt nicht vor — vorhanden: mittel \(2\), kritisch \(1\)/);
});

test('invalidEnum: gültig/leer → null, sonst invalidParam mit den gültigen Werten', () => {
  assert.equal(invalidEnum('status', 'offen', ['offen', 'erledigt']), null);
  assert.equal(invalidEnum('status', undefined, ['offen']), null);
  const err = invalidEnum('status', 'done', ['offen', 'erledigt']);
  assert.equal(err.errorKey, 'chat.toolError.invalidParam');
  assert.deepEqual(err.errorParams, { param: 'status' });
  assert.match(err.error, /offen, erledigt/);
});

// ── Text-Filter gegen die Daten ──────────────────────────────────────────────

test('list_continuity_issues: «hoch» nennt die vorhandenen Schweregrade statt still leer', async () => {
  const r = await run('list_continuity_issues', { schwere: 'hoch' });
  assert.equal(r.total, 0);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.available_values, { kritisch: 1, mittel: 2 });
  const ok = await run('list_continuity_issues', { schwere: 'Kritisch' });
  assert.equal(ok.total, 1);
  const typMiss = await run('list_continuity_issues', { typ: 'zeit' });
  assert.ok(typMiss.available_values.zeitlinie, 'typ «zeit» nennt zeitlinie');
});

test('get_timeline: «historisch» nennt persoenlich/extern', async () => {
  const r = await run('get_timeline', { typ: 'historisch' });
  assert.equal(r.total, 0);
  assert.deepEqual(r.available_values, { extern: 1, persoenlich: 1 });
  const ok = await run('get_timeline', { typ: 'extern' });
  assert.equal(ok.total, 1);
});

test('get_lektorat findings: unbekannter typ nennt die Typen der gespeicherten Befunde', async () => {
  const r = await run('get_lektorat', { view: 'findings', typ: 'wortwahl' });
  assert.equal(r.total_findings, 0);
  assert.deepEqual(r.available_values, { stil: 1, grammatik: 1 });
  const ok = await run('get_lektorat', { view: 'findings', typ: 'STIL' });
  assert.equal(ok.total_findings, 1);
});

// ── Enum-Filter: ungültig = Fehler, nicht ungefiltert ────────────────────────

test('ungültiger Status/Kind/Kategorie → invalidParam statt ganzer Liste', async () => {
  plot.createAct(BOOK, USER, { name: 'Akt 1' });
  for (const [tool, input, param] of [
    ['get_edit_status', { status: 'entwurf' }, 'status'],
    ['list_ideen', { status: 'done' }, 'status'],
    ['get_plot_board', { status: 'fertig' }, 'status'],
    ['list_research_items', { kind: 'artikel' }, 'kind'],
    ['list_research_items', { status: 'erledigt' }, 'status'],
    ['list_world_facts', { kategorie: 'magie' }, 'kategorie'],
  ]) {
    const r = await run(tool, input);
    assert.equal(r.errorKey, 'chat.toolError.invalidParam', `${tool} ${JSON.stringify(input)}`);
    assert.equal(r.errorParams.param, param, tool);
  }
  // Gültige Werte laufen weiter durch.
  assert.equal((await run('get_edit_status', { status: 'ohne' })).errorKey, undefined);
  assert.equal((await run('list_ideen', { status: 'offen' })).errorKey, undefined);
});

// ── Analyse-Stand ────────────────────────────────────────────────────────────

test('Katalog-Ergebnis: ohne Komplettlauf kein Stand, danach Stand + seither bearbeitete Abschnitte', async () => {
  const before = await run('get_timeline', {});
  assert.equal(before.analyse_stand, undefined);
  db.prepare(`INSERT INTO job_runs (job_id, type, book_id, user_email, status, queued_at, ended_at)
              VALUES ('jr-filter-1', 'komplett-analyse', ?, ?, 'done', ?, ?)`).run(BOOK, USER, NOW, RUN_END);
  const r = await run('get_timeline', {});
  assert.equal(r.analyse_stand, RUN_END);
  assert.match(r.analyse_hinweis, /^1 Abschnitt\(e\) seit der Analyse bearbeitet/);
  assert.deepEqual(Object.keys(r).slice(0, 2), ['analyse_stand', 'analyse_hinweis'], 'Stand vor den Listen');
});

// ── Katalog ──────────────────────────────────────────────────────────────────

const toolParam = (tool, param) => P.CHAT_TOOLS.find(t => t.name === tool).input_schema.properties[param];

test('Katalog-Enums stimmen mit den Komplett-Schemas überein', () => {
  const evItems = Object.values(SCHEMA_ZEITSTRAHL.properties).find(p => p.type === 'array').items;
  assert.deepEqual(TIMELINE_TYPEN, evItems.properties.typ.enum);
  assert.deepEqual(CONTINUITY_SCHWEREN, SCHEMA_KONTINUITAET_PROBLEME.properties.probleme.items.properties.schwere.enum);
  assert.deepEqual(toolParam('get_timeline', 'typ').enum, TIMELINE_TYPEN);
  assert.deepEqual(toolParam('list_continuity_issues', 'schwere').enum, CONTINUITY_SCHWEREN);
});

// Text-Filter ohne Enum: jedes "zitierte" Beispiel in der Beschreibung muss ein
// gültiger Wert sein — ein falsches Beispiel ist genau der Wert, den das Modell schickt.
const PARAM_VOCAB = {
  'get_lektorat.typ': ALLE_LEKTORAT_TYPEN,
  'list_continuity_issues.typ': [...KONTINUITAET_TYPEN, 'faktenfehler'],
  'list_world_facts.kategorie': [...FAKT_KATEGORIE_WL],
};

test('Beispielwerte in Filter-Beschreibungen sind gültige Werte', () => {
  for (const [key, vocab] of Object.entries(PARAM_VOCAB)) {
    const [tool, param] = key.split('.');
    const desc = toolParam(tool, param).description;
    const quoted = [...desc.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    const listed = /Gültige Werte:/.test(desc) ? desc.split('Gültige Werte:')[1].replace(/\.$/, '').split(',').map(s => s.trim()) : [];
    const examples = [...quoted, ...listed];
    assert.ok(examples.length, `${key}: keine Beispielwerte gefunden`);
    for (const v of examples) assert.ok(vocab.includes(v), `${key}: Beispiel «${v}» ist kein gültiger Wert`);
  }
});
