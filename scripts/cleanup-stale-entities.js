#!/usr/bin/env node
'use strict';
// Einmaliges Cleanup verwaister stale-Dubletten (Orte + Szenen) nach dem Fuzzy-Reconcile-
// Fix (lib/entity-match.js). Vor dem Fix fiel jede Schreibvariante zwischen zwei
// Komplettanalyse-Läufen auf stale=1 und akkumulierte als Dublette; der Fix stoppt den
// Nachschub, räumt aber die bereits akkumulierten stale-Rows nicht rückwirkend weg.
//
// Ablauf auf Prod (LXC):
//   1. Fix deployen.
//   2. Komplettanalyse je betroffenem Buch einmal neu laufen lassen (Within-Run-Dedup +
//      Fuzzy-Cross-Run-Reconcile → alles, was aktuell im Text steht, ist wieder stale=0).
//   3. node scripts/cleanup-stale-entities.js            (Dry-Run, zeigt was gelöscht würde)
//      node scripts/cleanup-stale-entities.js --apply    (löscht die stale-Dubletten)
//
// Löschstrategie (konservativ, Default): nur stale-Rows, die einen LEBENDEN (stale=0)
// Namensverwandten im selben Buch haben (per demselben Matcher wie die Pipeline) —
// also beweisbar redundant. --all-stale löscht zusätzlich verwaiste stale-Rows OHNE
// lebendes Pendant (z.B. echt aus dem Text entfernte Orte). In BEIDEN Fällen werden
// stale-Rows mit research_item_links (user-kuratierte Recherche-Verknüpfung) IMMER
// übersprungen — deren CASCADE-Löschung würde Nutzerdaten reissen.
//
// FK-CASCADE (foreign_keys=ON in db/connection.js) räumt beim Löschen die Analyse-Bridges
// (location_figures/-chapters, scene_locations) automatisch mit.

const { db } = require('../db/schema');
const { locationSimilarity, sceneTitleTokens } = require('../lib/entity-match');

// Nicht-greedy: hat diese stale-Row IRGENDEIN lebendes Pendant? (Anders als der
// Reconcile-Matcher, der 1:1 greedy zuordnet — beim Cleanup sollen ALLE stale-Dubletten
// desselben lebenden Orts weg, nicht nur die erste.)
const _subset = (a, b) => a.length > 0 && a.every(t => b.includes(t));
function liveLocTwin(stale, live) {
  return live.find(l => locationSimilarity(l, stale) > 0) || null;
}
function liveSceneTwin(stale, live) {
  const ts = sceneTitleTokens(stale.titel);
  if (!ts.length) return null;
  return live.find(l => (l.chapter_id ?? 0) === (stale.chapter_id ?? 0)
    && (() => { const tl = sceneTitleTokens(l.titel); return tl.length && (_subset(ts, tl) || _subset(tl, ts)); })()) || null;
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL_STALE = args.includes('--all-stale');
const bookArg = args.find(a => a.startsWith('--book='));
const ONLY_BOOK = bookArg ? Number(bookArg.split('=')[1]) : null;

const hasResearchLoc = db.prepare('SELECT 1 FROM research_item_links WHERE location_id = ? LIMIT 1');
const hasResearchScene = db.prepare('SELECT 1 FROM research_item_links WHERE scene_id = ? LIMIT 1');
const delLoc = db.prepare('DELETE FROM locations WHERE id = ?');
const delScene = db.prepare('DELETE FROM figure_scenes WHERE id = ?');

// (book_id, user_email)-Gruppen — der Reconcile-Scope der Pipeline.
function groups(table) {
  let sql = `SELECT DISTINCT book_id, user_email FROM ${table}`;
  const params = [];
  if (ONLY_BOOK != null) { sql += ' WHERE book_id = ?'; params.push(ONLY_BOOK); }
  return db.prepare(sql).all(...params);
}

let plannedLoc = 0, plannedScene = 0, skippedLoc = 0, skippedScene = 0, orphanKeptLoc = 0, orphanKeptScene = 0;

function processLocations() {
  for (const g of groups('locations')) {
    const emailCond = g.user_email == null ? 'user_email IS NULL' : 'user_email = ?';
    const emailVal = g.user_email == null ? [] : [g.user_email];
    const rows = db.prepare(
      `SELECT id, name, typ, stale FROM locations WHERE book_id = ? AND ${emailCond}`
    ).all(g.book_id, ...emailVal);
    const live = rows.filter(r => !r.stale);
    const stale = rows.filter(r => r.stale);
    for (const s of stale) {
      const twin = liveLocTwin(s, live);
      if (!twin && !ALL_STALE) { orphanKeptLoc++; continue; }
      if (hasResearchLoc.get(s.id)) { skippedLoc++; continue; }
      plannedLoc++;
      console.log(`  [Ort] Buch ${g.book_id}${g.user_email ? ' · ' + g.user_email : ''}: `
        + `«${s.name}» (id ${s.id}) → ${twin ? `Dublette von «${twin.name}» (id ${twin.id})` : 'verwaist, kein Pendant'}`);
      if (APPLY) delLoc.run(s.id);
    }
  }
}

function processScenes() {
  for (const g of groups('figure_scenes')) {
    const emailCond = g.user_email == null ? 'user_email IS NULL' : 'user_email = ?';
    const emailVal = g.user_email == null ? [] : [g.user_email];
    const rows = db.prepare(
      `SELECT id, chapter_id, titel, stale FROM figure_scenes WHERE book_id = ? AND ${emailCond}`
    ).all(g.book_id, ...emailVal);
    const live = rows.filter(r => !r.stale);
    const stale = rows.filter(r => r.stale);
    for (const s of stale) {
      const twin = liveSceneTwin(s, live);
      if (!twin && !ALL_STALE) { orphanKeptScene++; continue; }
      if (hasResearchScene.get(s.id)) { skippedScene++; continue; }
      plannedScene++;
      console.log(`  [Szene] Buch ${g.book_id}${g.user_email ? ' · ' + g.user_email : ''}: `
        + `«${s.titel}» (id ${s.id}) → ${twin ? `Dublette von «${twin.titel}» (id ${twin.id})` : 'verwaist, kein Pendant'}`);
      if (APPLY) delScene.run(s.id);
    }
  }
}

console.log(`Cleanup stale-Dubletten — Modus: ${APPLY ? 'APPLY (löscht)' : 'DRY-RUN (nur Anzeige)'}`
  + `${ALL_STALE ? ', inkl. verwaister stale ohne Pendant' : ' (nur stale mit lebendem Pendant)'}`
  + `${ONLY_BOOK != null ? `, nur Buch ${ONLY_BOOK}` : ''}\n`);

const run = APPLY ? (fn) => db.transaction(fn)() : (fn) => fn();
run(() => { processLocations(); processScenes(); });

console.log(`\nOrte:   ${APPLY ? 'gelöscht' : 'würde löschen'} ${plannedLoc}`
  + `${skippedLoc ? `, übersprungen (Recherche-Link) ${skippedLoc}` : ''}`
  + `${!ALL_STALE && orphanKeptLoc ? `, verwaist behalten ${orphanKeptLoc}` : ''}`);
console.log(`Szenen: ${APPLY ? 'gelöscht' : 'würde löschen'} ${plannedScene}`
  + `${skippedScene ? `, übersprungen (Recherche-Link) ${skippedScene}` : ''}`
  + `${!ALL_STALE && orphanKeptScene ? `, verwaist behalten ${orphanKeptScene}` : ''}`);
if (!APPLY) console.log('\n→ Zum Löschen erneut mit --apply ausführen (vorher DB sichern).');
