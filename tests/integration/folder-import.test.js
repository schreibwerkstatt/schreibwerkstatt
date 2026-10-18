'use strict';
// Integration test: Folder-Import-Job. Baut ein In-Memory-ZIP mit Tagebuch-
// Struktur (YYYY/Monat/Tagesdatei.docx + .odt), startet den Worker direkt und
// prueft das Ergebnis ueber den Content-Store.

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
let folderImport;
let contentStore;

test.before(() => {
  ctx = bootstrap();
  folderImport = require('../../routes/jobs/folder-import');
  contentStore = require('../../lib/content-store');
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => { ctx.mockAi.reset(); });

async function makeDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder('_rels').file('.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.folder('word').file('document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeOdt(text) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
  zip.file('content.xml',
    `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>${text}</text:p></office:text></office:body></office:document-content>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildArchive(entries) {
  const zip = new JSZip();
  for (const [path, buf] of entries) zip.file(path, buf);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('folder-import (merge): docx + odt aus YYYY/Monat → Kapitel pro Jahr, Seiten pro Tag', async () => {
  const userEmail = 'tester@test.dev';

  // Buch + Owner-ACL anlegen
  const book = await contentStore.createBook(
    { name: 'Tagebuch', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  // ZIP-Archiv mit 3 Jahres-Buckets
  const buffer = await buildArchive([
    ['2023/12/2023-12-30.docx', await makeDocx('Silvester-Vorabend.')],
    ['2023/12/2023-12-31.docx', await makeDocx('Silvester.')],
    ['2024/01/2024-01-01.odt',  await makeOdt('Neujahr.')],
    ['2024/03/05.docx',         await makeDocx('Maerz-Eintrag.')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'Tagebuch' },
    'merge:' + book.id,
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done', `Job-Status: ${job.status}, err: ${job.error || '-'}`);
  assert.equal(job.result.pagesCreated, 4);
  // 2 Year-Chapters (2023, 2024) + 3 Month-Sub-Chapters (12/2023, 01/2024, 03/2024)
  assert.equal(job.result.yearChaptersCreated, 2);
  assert.equal(job.result.monthSubChaptersCreated, 3);
  assert.equal(job.result.chaptersCreated, 5);
  assert.equal(job.result.bookId, book.id);

  const chapters = await contentStore.listChapters(book.id, { session: { user: { email: userEmail } } });
  const yearChapters = chapters.filter(c => !c.parent_chapter_id).map(c => c.name).sort();
  assert.deepEqual(yearChapters, ['2023', '2024']);

  // Sub-Chapter pro Monat. Name-Format: "YYYY Monatsname"
  const subChapters = chapters.filter(c => c.parent_chapter_id).map(c => c.name).sort();
  assert.deepEqual(subChapters, ['2023 Dezember', '2024 Januar', '2024 März']);

  // Jeder Sub-Chapter referenziert sein Year-Chapter via parent_chapter_id
  const yearByName = new Map(chapters.filter(c => !c.parent_chapter_id).map(c => [c.name, c.id]));
  for (const sub of chapters.filter(c => c.parent_chapter_id)) {
    const yearPrefix = sub.name.slice(0, 4);
    assert.equal(sub.parent_chapter_id, yearByName.get(yearPrefix));
  }

  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  const pageNames = pages.map(p => p.name).sort();
  assert.deepEqual(pageNames, ['2023-12-30', '2023-12-31', '2024-01-01', '2024-03-05']);

  // Pages haengen am Sub-Chapter (Month), nicht am Year-Chapter
  const subIds = new Set(chapters.filter(c => c.parent_chapter_id).map(c => c.id));
  for (const p of pages) assert.ok(subIds.has(p.chapter_id), `Page ${p.name} sollte an Month-Sub-Chapter haengen`);
});

test('folder-import: Buch ohne Buchtyp wird Tagebuch, gesetzter Typ bleibt', async () => {
  const userEmail = 'tester@test.dev';
  const { db } = require('../../db/connection');
  const { getBookSettings } = require('../../db/schema');
  const run = async (book, tag) => {
    db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', '2026-01-01T00:00:00.000Z')`).run(book.id, userEmail);
    const buffer = await buildArchive([['2024/01/2024-01-02.docx', await makeDocx('Eintrag.')]]);
    const jobId = ctx.shared.createJob('folder-import', book.id, userEmail, 'job.label.folderImport', { name: tag }, `merge:${book.id}:${tag}`);
    folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });
    await folderImport.runFolderImportJob(jobId, { userEmail, mode: 'merge', bookName: '', bookId: book.id });
    assert.equal(ctx.shared.jobs.get(jobId).status, 'done');
  };
  const session = { session: { user: { email: userEmail } } };
  const untyped = await contentStore.createBook({ name: 'Ohne Typ', owner_email: userEmail }, session);
  await run(untyped, 'untyped');
  assert.equal(getBookSettings(untyped.id, userEmail).buchtyp, 'tagebuch');

  const memoir = await contentStore.createBook({ name: 'Memoiren', owner_email: userEmail }, session);
  db.prepare(`INSERT INTO book_settings (book_id, language, region, updated_at, buchtyp) VALUES (?, 'de', 'CH', '2026-01-01T00:00:00.000Z', 'autobiografie')`).run(memoir.id);
  await run(memoir, 'memoir');
  assert.equal(getBookSettings(memoir.id, userEmail).buchtyp, 'autobiografie');
});

test('folder-import: leeres Archiv → failJob mit emptyArchive', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'Empty', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  const buffer = await buildArchive([
    ['random.txt', Buffer.from('hi')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'Empty' },
    'merge:' + book.id + ':empty',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'error');
  assert.match(String(job.error || ''), /emptyArchive/i);
});

test('folder-import: Datum aus erster Zeile, Filename ohne Datum', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'FirstLine', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  // Filenames "tag-a.docx" und "tag-b.docx" tragen kein Datum. Erste Zeile
  // des Dokuments enthaelt das ISO-Datum.
  const buffer = await buildArchive([
    ['2024/01/tag-a.docx', await makeDocx('2024-01-15')],
    ['2024/02/tag-b.docx', await makeDocx('05.02.2024')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'FirstLine' },
    'merge:' + book.id + ':firstline',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done', `Job-Status: ${job.status}, err: ${job.error || '-'}`);
  assert.equal(job.result.pagesCreated, 2);
  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  const names = pages.map(p => p.name).sort();
  assert.deepEqual(names, ['2024-01-15', '2024-02-05']);
});

test('folder-import: AbiWord-Datei (.abw) wird verarbeitet', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'AbwBook', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  const abwContent = `<?xml version="1.0"?><abiword><section><p>Hallo aus AbiWord.</p></section></abiword>`;
  const buffer = await buildArchive([
    ['2024/03/2024-03-10.abw', Buffer.from(abwContent, 'utf8')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'AbwBook' },
    'merge:' + book.id + ':abw',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.pagesCreated, 1);

  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  assert.equal(pages[0].name, '2024-03-10');
  const page = await contentStore.loadPage(pages[0].id, { session: { user: { email: userEmail } } });
  assert.match(page.html, /Hallo aus AbiWord/);
});

test('folder-import: month-only Fallback fuer Datei ohne Datum im Namen/Inhalt', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'MonthOnly', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  const buffer = await buildArchive([
    // Filename ohne Tageszahl, Inhalt ohne Datum → nur Year+Month aus Pfad
    ['2006/november 2006/warum ich notizen mag.docx', await makeDocx('Reine Notiz ohne Datum.')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'MonthOnly' },
    'merge:' + book.id + ':monthonly',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done', `Job-Status: ${job.status}, err: ${job.error || '-'}`);
  assert.equal(job.result.pagesCreated, 1);

  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  // Page-Name: "2006-11 warum ich notizen mag" (Thema aus Filename)
  assert.match(pages[0].name, /^2006-11 warum ich notizen mag/);

  // Year-Chapter "2006" + Month-Sub-Chapter "11 November"
  const chapters = await contentStore.listChapters(book.id, { session: { user: { email: userEmail } } });
  const yearCh = chapters.find(c => c.name === '2006' && !c.parent_chapter_id);
  const subCh = chapters.find(c => c.name === '2006 November');
  assert.ok(yearCh);
  assert.ok(subCh);
  assert.equal(subCh.parent_chapter_id, yearCh.id);
  assert.equal(pages[0].chapter_id, subCh.id);
});

test('folder-import: persoenliches_NN.abw + Monat-Ordner → korrektes Datum', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'AbwNumbered', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  const abw = `<?xml version="1.0"?><abiword><section><p>Eintrag.</p></section></abiword>`;
  const buffer = await buildArchive([
    ['2007/mai 2007/persoenliches_23.abw', Buffer.from(abw, 'utf8')],
    ['2010/Februar 2010/persoenliches_03.odt.docx', await makeDocx('docx Eintrag.')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'AbwNumbered' },
    'merge:' + book.id + ':abwnumbered',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.pagesCreated, 2);

  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  const names = pages.map(p => p.name).sort();
  assert.deepEqual(names, ['2007-05-23', '2010-02-03']);
});

test('folder-import: mtime-Fallback wenn kein Datum aus Filename/Heading', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'MtimeBook', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  // ZIP-Entry mit explizitem date-Feld setzen — JSZip nimmt die Date am Entry an.
  const archive = new JSZip();
  archive.file('2020/november 2020/notiz.docx', await makeDocx('Body ohne Datum.'), {
    date: new Date(Date.UTC(2020, 10, 7, 12, 0, 0)), // 2020-11-07
  });
  const buffer = await archive.generateAsync({ type: 'nodebuffer' });

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'MtimeBook' },
    'merge:' + book.id + ':mtime',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done', `Job-Status: ${job.status}, err: ${job.error || '-'}`);
  assert.equal(job.result.pagesCreated, 1);

  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  // Pfad-Monat (November) hat Vorrang vor mtime-Monat → 2020-11-07 (Tag aus mtime)
  assert.equal(pages[0].name, '2020-11-07');
});

test('folder-import: mtime liefert Monat wenn Pfad nur Jahr traegt', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'MtimeMonthRescue', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  // Pfad-Ordner "andere" ist kein Monat-Token -> Pfad liefert nur Jahr.
  // mtime-Jahr 2024 weicht von Pfad-Jahr 2020 ab; im relaxed-Modus (Pfad-Monat
  // fehlt) wird mtime trotzdem akzeptiert: Pfad-Jahr bleibt, mtime liefert
  // Monat+Tag.
  const archive = new JSZip();
  archive.file('2020/andere/notiz.docx', await makeDocx('Body ohne Datum.'), {
    date: new Date(Date.UTC(2024, 10, 7, 12, 0)), // 2024-11-07
  });
  const buffer = await archive.generateAsync({ type: 'nodebuffer' });

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'MtimeMonthRescue' },
    'merge:' + book.id + ':mtime-monthrescue',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done', `Job-Status: ${job.status}, err: ${job.error || '-'}`);
  assert.equal(job.result.pagesCreated, 1);

  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  // Pfad-Jahr 2020 + mtime-Monat 11 + mtime-Tag 07
  assert.equal(pages[0].name, '2020-11-07');

  // Year-Chapter "2020" + Month-Sub "2020 November"
  const chapters = await contentStore.listChapters(book.id, { session: { user: { email: userEmail } } });
  const yearCh = chapters.find(c => c.name === '2020' && !c.parent_chapter_id);
  const subCh = chapters.find(c => c.name === '2020 November');
  assert.ok(yearCh, 'Year-Chapter 2020 fehlt');
  assert.ok(subCh, 'Month-Sub "2020 November" fehlt');
  assert.equal(subCh.parent_chapter_id, yearCh.id);
  assert.equal(pages[0].chapter_id, subCh.id);
});

test('folder-import: mtime verworfen wenn Jahr nicht matcht', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'MtimeMismatch', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  // mtime in 2024, aber Pfad sagt 2020 → mtime wird verworfen, Fallback auf
  // month-only mit YYYY-MM-15.
  const archive = new JSZip();
  archive.file('2020/november 2020/notiz.docx', await makeDocx('Body.'), {
    date: new Date(Date.UTC(2024, 5, 15)),
  });
  const buffer = await archive.generateAsync({ type: 'nodebuffer' });

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'MtimeMismatch' },
    'merge:' + book.id + ':mtimemismatch',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done');
  // Page-Name ist month-only-Format
  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  assert.match(pages[0].name, /^2020-11 /);
});

test('folder-import: month-only Thema aus Heading (h1 schlaegt Filename)', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'MonthOnlyHeading', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  // ODT mit echtem H1 — Filename "persoenliches" ist generisch, Heading sollte
  // im Page-Name auftauchen.
  const odtXml = `<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:text>
    <text:h text:outline-level="1">Über das Reisen</text:h>
    <text:p>Body-Text.</text:p>
  </office:text></office:body>
</office:document-content>`;
  const JSZipLib = require('jszip');
  const z = new JSZipLib();
  z.file('mimetype', 'application/vnd.oasis.opendocument.text');
  z.file('content.xml', odtXml);
  const odtBuf = await z.generateAsync({ type: 'nodebuffer' });

  const buffer = await buildArchive([
    ['2006/november 2006/persoenliches.odt', odtBuf],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'MonthOnlyHeading' },
    'merge:' + book.id + ':heading',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done');
  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  assert.equal(pages[0].name, '2006-11 Über das Reisen');
});

test('folder-import: unbekannte Extension wird skipped', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'Mixed', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  const buffer = await buildArchive([
    ['2024/01/2024-01-01.docx', await makeDocx('Neujahr.')],
    ['2024/01/notes.txt', Buffer.from('plain text')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'Mixed' },
    'merge:' + book.id + ':mixed',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.pagesCreated, 1);
  assert.ok(job.result.skipped.some(s => s.path.endsWith('notes.txt') && s.reason === 'UNSUPPORTED_EXT'));
});

test('folder-import: zwei Files gleicher Tag mit Thema → getrennte Pages mit YYYY-MM-DD <Thema>', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'CollideThema', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  // Beide Dateien tragen ein extrahierbares Thema (h1 in mammoth via Heading-Style
  // ist nicht trivial — Filename-Body taugt aber als Thema-Quelle).
  const buffer = await buildArchive([
    ['2024/05/Persoenliches 03.docx', await makeDocx('Tagebucheintrag morgens.')],
    ['2024/05/Arbeit 03.docx', await makeDocx('Tagebucheintrag abends.')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'CollideThema' },
    'merge:' + book.id + ':collide-thema',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done', `Job-Status: ${job.status}, err: ${job.error || '-'}`);
  assert.equal(job.result.pagesCreated, 2);
  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  const names = pages.map(p => p.name).sort();
  assert.deepEqual(names, ['2024-05-03 Arbeit', '2024-05-03 Persoenliches']);
});

test('folder-import: zwei Files gleicher Tag ohne Thema → HTML gemerged in eine Page', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'CollideMerge', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  // Beide Filenames sind reine ISO-Datumsstrings (Filename-Body nach Strip = '')
  // und der Text-Body ist ein 1-Zeichen-Marker (firstLine length<2 → kein Thema).
  // extractTitle liefert '' fuer beide → Merge-Pfad greift.
  const buffer = await buildArchive([
    ['2024/05/2024-05-04.docx', await makeDocx('A')],
    ['2024/05/2024-05-04.odt', await makeOdt('B')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'CollideMerge' },
    'merge:' + book.id + ':collide-merge',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done', `Job-Status: ${job.status}, err: ${job.error || '-'}`);
  assert.equal(job.result.pagesCreated, 1);
  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].name, '2024-05-04');
  const page = await contentStore.loadPage(pages[0].id, { session: { user: { email: userEmail } } });
  assert.match(page.html, /\bA\b/);
  assert.match(page.html, /\bB\b/);
  assert.match(page.html, /day-merge/);
});

test('folder-import (grouping=year): nur Jahr-Kapitel, keine Monats-Subs', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'GroupYear', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  const buffer = await buildArchive([
    ['2023/12/2023-12-31.docx', await makeDocx('Silvester.')],
    ['2024/01/2024-01-01.odt',  await makeOdt('Neujahr.')],
    ['2024/03/2024-03-05.docx', await makeDocx('Maerz.')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'GroupYear' },
    'merge:' + book.id + ':group-year',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id, grouping: 'year',
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done', `Job-Status: ${job.status}, err: ${job.error || '-'}`);
  assert.equal(job.result.pagesCreated, 3);
  assert.equal(job.result.yearChaptersCreated, 2);
  assert.equal(job.result.monthSubChaptersCreated, 0);

  const chapters = await contentStore.listChapters(book.id, { session: { user: { email: userEmail } } });
  assert.equal(chapters.filter(c => c.parent_chapter_id).length, 0, 'keine Sub-Chapter erwartet');
  const yearByName = new Map(chapters.map(c => [c.name, c.id]));

  // Alle Seiten haengen direkt am jeweiligen Year-Chapter
  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  for (const p of pages) {
    assert.equal(p.chapter_id, yearByName.get(p.name.slice(0, 4)), `Page ${p.name} sollte am Year-Chapter haengen`);
  }
});

test('folder-import (grouping=flat): keine Kapitel, Seiten direkt am Buch', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'GroupFlat', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  const buffer = await buildArchive([
    ['2023/12/2023-12-31.docx', await makeDocx('Silvester.')],
    ['2024/01/2024-01-01.odt',  await makeOdt('Neujahr.')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'GroupFlat' },
    'merge:' + book.id + ':group-flat',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id, grouping: 'flat',
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done', `Job-Status: ${job.status}, err: ${job.error || '-'}`);
  assert.equal(job.result.pagesCreated, 2);
  assert.equal(job.result.chaptersCreated, 0);

  const chapters = await contentStore.listChapters(book.id, { session: { user: { email: userEmail } } });
  assert.equal(chapters.length, 0, 'keine Kapitel erwartet');

  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  assert.equal(pages.length, 2);
  for (const p of pages) assert.ok(!p.chapter_id, `Page ${p.name} sollte kapitellos sein`);
});

test('folder-import (merge, zweiter Lauf): Monate ueber den Namen erkannt, Jahre/Monate chronologisch', async () => {
  const userEmail = 'tester@test.dev';
  const session = { session: { user: { email: userEmail } } };
  const book = await contentStore.createBook({ name: 'Tagebuch 2', owner_email: userEmail }, session);
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', '2026-01-01T00:00:00.000Z')`).run(book.id, userEmail);
  const run = async (entries, tag) => {
    const buffer = await buildArchive(entries);
    const jobId = ctx.shared.createJob('folder-import', book.id, userEmail, 'job.label.folderImport', { name: tag }, `merge:${book.id}:${tag}`);
    folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });
    await folderImport.runFolderImportJob(jobId, { userEmail, mode: 'merge', bookName: '', bookId: book.id });
    const job = ctx.shared.jobs.get(jobId);
    assert.equal(job.status, 'done', job.error || '');
  };

  await run([
    ['2020/03/2020-03-10.docx', await makeDocx('Maerz.')],
    ['2020/11/2020-11-10.docx', await makeDocx('November.')],
  ], 'a');
  // Buch oeffnen: ensureTree materialisiert chapters.position buchweit neu
  // (0, 1, 2 …) — genau die Werte, die frueher als Monat 1–12 galten.
  await contentStore.bookTree(book.id, session);
  await run([
    ['2020/01/2020-01-05.docx', await makeDocx('Januar.')],
    ['2020/02/2020-02-05.docx', await makeDocx('Februar.')],
    ['2020/11/2020-11-20.docx', await makeDocx('November 2.')],
    ['2019/12/2019-12-24.docx', await makeDocx('Weihnachten.')],
  ], 'b');

  const outline = await contentStore.bookOutline(book.id, session);
  const chapters = outline.filter(n => n.type === 'chapter').map(n => n.name);
  assert.deepEqual(chapters, ['2019', '2019 Dezember', '2020', '2020 Januar', '2020 Februar', '2020 März', '2020 November']);
  const pageIn = {};
  for (const n of outline) if (n.type === 'page') pageIn[n.name] = n.path[n.path.length - 1];
  assert.equal(pageIn['2020-01-05'], '2020 Januar');
  assert.equal(pageIn['2020-02-05'], '2020 Februar');
  assert.equal(pageIn['2020-11-20'], '2020 November');
  assert.equal(pageIn['2020-03-10'], '2020 März');
});

test('folder-import (new-book): Abbruch → «cancelled», angelegtes Buch zurueckgenommen', async () => {
  const userEmail = 'tester@test.dev';
  const session = { session: { user: { email: userEmail } } };
  const before = (await contentStore.listBooks(session)).length;
  const buffer = await buildArchive([['2024/01/2024-01-02.docx', await makeDocx('Eintrag.')]]);
  const jobId = ctx.shared.createJob('folder-import', 0, userEmail, 'job.label.folderImport', { name: 'Abbruch' }, `new:abbruch:${Math.random()}`);
  ctx.shared.jobs.get(jobId).status = 'running';
  ctx.shared.cancelJob(jobId, userEmail);
  folderImport.importBuffers.set(jobId, { buffer, userEmail, mode: 'new-book', bookName: 'Abbruch', bookId: null });
  await folderImport.runFolderImportJob(jobId, { userEmail, mode: 'new-book', bookName: 'Abbruch', bookId: null });
  assert.equal(ctx.shared.jobs.get(jobId).status, 'cancelled');
  assert.equal((await contentStore.listBooks(session)).length, before);
});
