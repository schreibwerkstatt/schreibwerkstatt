#!/usr/bin/env node
'use strict';

// One-shot HubSpot-Blog-Import in ein bestehendes Buch.
// - Holt PUBLISHED-Posts via /cms/v3/blogs/posts, gruppiert nach Publish-Jahr
//   in Kapitel "YYYY", legt pro Post eine Page mit Name "YYYY-MM-DD: Titel" an.
// - Konvertiert post.postBody ueber dieselbe Allowlist wie der Import-Job
//   (lib/hubspot-html.js#hubspotToAppHtml).
// - Idempotent: existierende Page-Names werden uebersprungen.
// - Autor-Auswahl interaktiv, wenn --author-id fehlt.
// - User-Attribution via --user-email Pflicht (page_revisions.source='import').
//
// Usage:
//   HUBSPOT_TOKEN=pat-eu1-... node scripts/import-hubspot.js \
//     --book-id=102 --user-email=david.berger@dotag.ch \
//     [--author-id=12345] [--list-authors] [--dry-run] [--limit=N]

require('dotenv').config();

const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const contentStore = require('../lib/content-store');
const pageRevisions = require('../db/page-revisions');
const appUsers = require('../db/app-users');
const { hubspotToAppHtml } = require('../lib/hubspot-html');
const { createHubspotClient } = require('../lib/hubspot-client');
const { postTitle, postDate } = require('../lib/sync/providers/hubspot');
const { importedPageName } = require('../lib/blog-title');
const { resolveYearChapter, yearOf } = require('../lib/blog-pull');
const logger = require('../logger');

// API-Zugriff, Titel-/Datumsregel und Jahres-Kapitel teilt das Skript mit dem
// Import-Job (lib/hubspot-client.js, lib/sync/providers/hubspot.js,
// lib/blog-pull.js). Eigen ist nur der Ablauf: Abgleich ueber den Seitennamen
// statt ueber Links, `--update`, Probelauf.

function parseArgs(argv) {
  const out = { dryRun: false, limit: Infinity, listAuthors: false, update: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--list-authors') out.listAuthors = true;
    else if (a === '--update') out.update = true;
    else if (a.startsWith('--book-id=')) out.bookId = parseInt(a.slice('--book-id='.length), 10);
    else if (a.startsWith('--author-id=')) out.authorId = a.slice('--author-id='.length);
    else if (a.startsWith('--user-email=')) out.userEmail = a.slice('--user-email='.length);
    else if (a.startsWith('--limit=')) out.limit = parseInt(a.slice('--limit='.length), 10);
    else { console.error(`Unbekanntes Argument: ${a}`); process.exit(2); }
  }
  if (!out.listAuthors) {
    if (!Number.isFinite(out.bookId)) { console.error('--book-id=<int> Pflicht'); process.exit(2); }
    if (!out.userEmail) { console.error('--user-email=<addr> Pflicht'); process.exit(2); }
  }
  return out;
}

function listAuthors(token) {
  return createHubspotClient({ token }).listAuthors();
}

async function pickAuthorInteractive(token) {
  console.log('[hubspot-import] lade Autorenliste …');
  const authors = await listAuthors(token);
  if (!authors.length) { console.error('Keine Autoren in HubSpot gefunden.'); process.exit(2); }
  console.log(`\n${authors.length} Autoren gefunden:\n`);
  authors.forEach((a, i) => {
    const name = (a.fullName || a.displayName || a.name || '(ohne Name)').trim();
    const email = a.email ? ` <${a.email}>` : '';
    console.log(`  [${String(i + 1).padStart(3, ' ')}]  id=${a.id}  ${name}${email}`);
  });
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question('\nNummer waehlen (oder "q" zum Abbrechen): ')).trim();
  rl.close();
  if (answer.toLowerCase() === 'q') { console.log('Abgebrochen.'); process.exit(0); }
  const idx = parseInt(answer, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > authors.length) {
    console.error(`Ungueltige Auswahl: "${answer}"`); process.exit(2);
  }
  const chosen = authors[idx - 1];
  console.log(`[hubspot-import] gewaehlt: id=${chosen.id} (${chosen.fullName || chosen.name || '?'})\n`);
  return String(chosen.id);
}

async function* iterateAuthorPosts(token, authorId, hardLimit) {
  let yielded = 0;
  for await (const p of createHubspotClient({ token }).iteratePosts({ authorId, state: 'PUBLISHED' })) {
    if (yielded >= hardLimit) return;
    yield p;
    yielded += 1;
  }
}

async function loadExistingPagesByName(bookId) {
  const pages = await contentStore.listPages(bookId);
  const map = new Map();
  for (const p of pages) map.set(p.name || '', p.id);
  return map;
}

async function main() {
  const args = parseArgs(process.argv);
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) { console.error('HUBSPOT_TOKEN env-var Pflicht (in .env oder Shell).'); process.exit(2); }

  if (args.listAuthors) {
    const authors = await listAuthors(token);
    console.log(`${authors.length} Autoren:\n`);
    for (const a of authors) {
      const name = (a.fullName || a.displayName || a.name || '(ohne Name)').trim();
      console.log(`  id=${a.id}  ${name}${a.email ? ` <${a.email}>` : ''}`);
    }
    process.exit(0);
  }

  const user = appUsers.getUser(args.userEmail);
  if (!user) { console.error(`User "${args.userEmail}" nicht in app_users gefunden.`); process.exit(2); }
  if (user.status && user.status !== 'active') {
    console.error(`User "${args.userEmail}" hat Status "${user.status}" (nicht active).`); process.exit(2);
  }
  const ctx = { session: { user: { email: user.email } } };

  const book = await contentStore.loadBook(args.bookId, ctx).catch(() => null);
  if (!book) { console.error(`Buch ${args.bookId} nicht gefunden.`); process.exit(2); }

  const authorId = args.authorId || await pickAuthorInteractive(token);

  console.log(`[hubspot-import] book=${args.bookId} (${book.name}) author=${authorId} user=${user.email} dryRun=${args.dryRun} update=${args.update}`);

  const existingByName = await loadExistingPagesByName(args.bookId);
  const yearCache = new Map();
  let imported = 0, updated = 0, skipped = 0, dropped = 0, total = 0;

  for await (const post of iterateAuthorPosts(token, authorId, args.limit)) {
    total += 1;
    const title = postTitle(post);
    const ymd = postDate(post).slice(0, 10);
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) { dropped += 1; logger.warn(`[hubspot-import] post ohne Titel/Datum (id=${post.id})`); continue; }
    const pageName = importedPageName(title, ymd, '');
    const existingId = existingByName.get(pageName);

    const text = hubspotToAppHtml(post.postBody || '');
    if (!text.trim()) { dropped += 1; logger.warn(`[hubspot-import] post ${post.id} leer nach text-extract`); continue; }

    if (existingId && !args.update) {
      skipped += 1; console.log(`  skip  ${pageName}`); continue;
    }

    if (existingId && args.update) {
      if (args.dryRun) {
        console.log(`  ~     ${pageName} (page=${existingId}, ${text.length} chars)`);
      } else {
        await contentStore.savePage(
          existingId,
          { html: text, source: 'import', summary: `HubSpot-Import (update): post ${post.id}` },
          ctx,
        );
        console.log(`  ~     ${pageName} (page=${existingId})`);
      }
      updated += 1;
      continue;
    }

    // Neu anlegen
    const year = yearOf(ymd);
    if (args.dryRun) {
      console.log(`  +     ${pageName} → chapter ${year} (${text.length} chars)`);
    } else {
      const chapterId = await resolveYearChapter(args.bookId, year, yearCache);
      const created = await contentStore.createPage(
        { book_id: args.bookId, chapter_id: chapterId, name: pageName, html: text },
        ctx,
      );
      try {
        pageRevisions.insert({
          pageId: created.id,
          bookId: args.bookId,
          bodyHtml: created.html || text,
          bodyMarkdown: null,
          source: 'import',
          userEmail: user.email,
          summary: `HubSpot-Import: post ${post.id}`,
        });
      } catch (e) {
        logger.warn(`[hubspot-import] page_revisions insert failed page=${created.id}: ${e.message}`);
      }
      existingByName.set(pageName, created.id);
      console.log(`  +     ${pageName} → chapter ${year}`);
    }
    imported += 1;
  }

  console.log(`\n[hubspot-import] done. total=${total} imported=${imported} updated=${updated} skipped=${skipped} dropped=${dropped}`);
}

main().catch(err => {
  console.error('[hubspot-import] FATAL', err);
  process.exit(1);
});
