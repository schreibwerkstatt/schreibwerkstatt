// Revisions-Quelle «review»: ein übernommener Änderungsvorschlag eines
// Reviewers (Share-Link, Review-Modus) erscheint in der Revisionsliste als
// «Review», nicht als «Lektorat» (docs/share-link.md → „Änderungsvorschläge").
// Vier Schichten müssen zusammenpassen, sonst scheitert der Save oder die
// Liste zeigt den rohen Schlüssel:
//   1. Client-Whitelist  public/js/editor/shared/save-pipeline.js (buildSavePayload)
//   2. Server-Whitelist  db/page-revisions.js (VALID_SOURCES) und der CHECK der
//      Tabelle page_revisions (Migration 373) — echter Schreibzugriff unten
//   3. Beschriftung      editor.revisions.source.review in de + en
//   4. Aufrufer          comment-rail-core.js speichert mit source 'review'
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { useTmpDb } from './_helpers/tmp-db.js';

useTmpDb('review-revision-source');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-1234567890abcdef';

const ROOT = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

const { buildSavePayload } = await import('../../public/js/editor/shared/save-pipeline.js');

test('Client: buildSavePayload akzeptiert source=review', () => {
  const p = buildSavePayload({ html: '<p>x</p>', pageName: 'P', source: 'review' });
  assert.equal(p.source, 'review');
});

test('Server: page_revisions nimmt source=review an', () => {
  // Nur die Konstante lesen — kein DB-Zugriff noetig.
  const src = read('db/page-revisions.js');
  const m = /const VALID_SOURCES = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(m, 'VALID_SOURCES gefunden');
  assert.match(m[1], /'review'/);
});

test('Datenbank: eine Revision mit source=review wird geschrieben (CHECK)', async () => {
  const schema = (await import('../../db/schema.js')).default;
  const contentStore = (await import('../../lib/content-store/index.js')).default;
  const pageRevisions = (await import('../../db/page-revisions.js')).default;
  schema.upsertBookByName(9471, 'Review-Quelle');
  const page = await contentStore.createPage({ book_id: 9471, name: 'A', html: '<p>alt</p>' }, null);
  const id = pageRevisions.insert({ pageId: page.id, bookId: 9471, bodyHtml: '<p>neu aus dem Review</p>', source: 'review' });
  assert.ok(id, 'Revision angelegt');
  const row = pageRevisions.get(Number(id));
  assert.equal(row.source, 'review');
});

test('Beschriftung: editor.revisions.source.review in beiden Locales', () => {
  const de = JSON.parse(read('public/js/i18n/de.json'));
  const en = JSON.parse(read('public/js/i18n/en.json'));
  assert.equal(de['editor.revisions.source.review'], 'Review');
  assert.equal(en['editor.revisions.source.review'], 'Review');
});

test('Leiste: übernommener Vorschlag speichert mit source review', () => {
  const core = read('public/js/editor/comment-rail-core.js');
  const body = core.slice(core.indexOf('async _railDecideSuggestion'), core.indexOf('async _railDelete'));
  assert.match(body, /source:\s*'review'/);
  assert.doesNotMatch(body, /source:\s*'lektorat-apply'/);
});
