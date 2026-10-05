'use strict';
// Welt-Fakten (`world_facts` + Bruecke `world_fact_chapters`): Schreibpfad der
// Komplettanalyse-Phase, Lesepfad-SSoT aller Konsumenten, Scan-Marker
// (`world_facts_scan`) und Urteils-Cache des Faktenchecks (`world_fact_verdicts`).

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { toRefString: _toRefString } = require('./write-helpers');

// Whitelist für Welt-Fakten-Kategorien (harte Gruppierung analog EVENT_SUBTYP_WL).
// KI liefert die Kategorie im Komplettanalyse-Output; unbekannte/leere Werte
// fallen auf 'sonstiges' zurück. Frontend rendert Label + Icon je Key
// (public/js/cards/world-facts-card.js, i18n weltfakten.kategorie.*).
const FAKT_KATEGORIE_WL = new Set([
  'figur', 'ort', 'objekt', 'organisation', 'technik', 'regel',
  'kultur', 'historie', 'zeit', 'soziolekt', 'ereignis', 'sonstiges',
]);

// Normalisiert einen Kategorie-String auf einen Whitelist-Key (lowercase,
// getrimmt). Unbekannt/leer → 'sonstiges'. Gilt für jeden Schreibweg (Analyse,
// Bundle-Import), damit kein Kategorien-Filter eine Zeile übersieht.
function normFaktKategorie(raw) {
  const k = (raw == null ? '' : String(raw)).trim().toLowerCase();
  return FAKT_KATEGORIE_WL.has(k) ? k : 'sonstiges';
}

// Aussage-Schlüssel (SSoT lib/world-fact-key.js): Identität einer Aussage über Full-Replaces hinweg.
const { factKey, factKeyOf } = require('../lib/world-fact-key');

function _emailCond(userEmail) {
  return userEmail
    ? { cond: 'user_email = ?', vals: [userEmail] }
    : { cond: 'user_email IS NULL', vals: [] };
}

// Deklaratives Buch-Wissen aus der Komplettanalyse (Phase 1). Anders als Orte haben
// Fakten keine stabile KI-ID → Full-Replace pro (book, user) statt Upsert.
//
// - **Eine Zeile je Aussage:** dieselbe Aussage (gleicher factKey) aus mehreren
//   Kapiteln wird EINE Zeile mit mehreren Brücken-Einträgen — sonst belegt sie in
//   Karte, Buch-Chat-Block und Faktencheck mehrere Plätze.
// - **Kapitel-Link:** primär über den Kapitelnamen (chNameToId). Liefert das (z.B. im
//   Single-Pass mit kapitel='Gesamtbuch') kein Kapitel, greift der Fallback über den
//   Abschnittsnamen des Fakts (f.seite → pages.page_name → chapter_id) — nur bei
//   EINDEUTIGER Auflösung innerhalb der analysierten Kapitel, sonst bleibt der Fakt
//   book-level ohne Brücke (kein Sentinel).
// - **Teil-Ersatz (`keepChapterIds`):** Kapitel, deren Extraktion in diesem Lauf
//   ausfiel, behalten ihre bisherigen Fakten. Ein abgeschnittener Chunk hiesse sonst:
//   die Fakten dieses Kapitels sind weg, bis ein späterer Lauf sie wieder findet.
// - setzt den Scan-Marker (`world_facts_scan`).
//
// chapterFakten: [{ kapitel, fakten: [{ kategorie, subjekt, fakt, seite }] }]
function saveFaktenToDb(bookId, chapterFakten, userEmail, chNameToId = null, { keepChapterIds = null } = {}) {
  if (chNameToId == null) {
    const rows = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookId);
    chNameToId = Object.fromEntries(rows.map(r => [r.chapter_name, r.chapter_id]));
  }
  // Analysierte Kapitel: nur deren Abschnitte taugen als Seiten-Fallback — ein
  // gleichnamiger Abschnitt eines ausgeschlossenen Kapitels machte den Namen sonst ambig.
  const analysed = new Set(Object.values(chNameToId || {}).filter(v => v != null));
  const pageNameToChapter = new Map();
  const ambigPageName = new Set();
  for (const r of db.prepare('SELECT page_name, chapter_id FROM pages WHERE book_id = ?').all(bookId)) {
    if (r.chapter_id == null || !r.page_name) continue;
    if (analysed.size && !analysed.has(r.chapter_id)) continue;
    const name = r.page_name.trim();
    if (pageNameToChapter.has(name)) {
      if (pageNameToChapter.get(name) !== r.chapter_id) ambigPageName.add(name);
    } else {
      pageNameToChapter.set(name, r.chapter_id);
    }
  }
  const { cond: emailCond, vals: emailVal } = _emailCond(userEmail);
  const keep = keepChapterIds && keepChapterIds.size ? keepChapterIds : null;

  // Aussagen sammeln und über factKey zusammenführen (erste Fundstelle bestimmt Text,
  // Kategorie, Abschnitt und Reihenfolge; weitere Fundstellen liefern nur Kapitel).
  const byKey = new Map();
  const add = (f, chapId) => {
    const fakt = _toRefString(f?.fakt);
    if (!fakt) return;
    const subjekt = _toRefString(f?.subjekt) || null;
    const key = factKey(subjekt, fakt);
    const seite = (_toRefString(f?.seite) || '').trim() || null;
    let factChap = chapId;
    if (factChap == null && seite && !ambigPageName.has(seite)) factChap = pageNameToChapter.get(seite) ?? null;
    let e = byKey.get(key);
    if (!e) {
      e = { kategorie: normFaktKategorie(f?.kategorie), subjekt, fakt, seite, chapters: new Set() };
      byKey.set(key, e);
    }
    if (factChap != null) e.chapters.add(factChap);
  };

  db.transaction(() => {
    // Behaltene Kapitel: deren bisherige Fakten vor dem Löschen einsammeln.
    if (keep) {
      const old = db.prepare(`
        SELECT wf.id, wf.kategorie, wf.subjekt, wf.fakt, wf.seite_label, wfc.chapter_id
          FROM world_facts wf JOIN world_fact_chapters wfc ON wfc.fact_id = wf.id
         WHERE wf.book_id = ? AND wf.${emailCond}
         ORDER BY wf.sort_order, wf.id`).all(bookId, ...emailVal);
      for (const r of old) {
        if (!keep.has(r.chapter_id)) continue;
        add({ kategorie: r.kategorie, subjekt: r.subjekt, fakt: r.fakt, seite: r.seite_label }, r.chapter_id);
      }
    }
    for (const cf of (chapterFakten || [])) {
      const chName = _toRefString(cf?.kapitel);
      const chapId = chName ? (chNameToId?.[chName] ?? null) : null;
      if (keep && chapId != null && keep.has(chapId)) continue;
      for (const f of (cf?.fakten || [])) add(f, chapId);
    }

    // Full-Replace: alte Fakten weg (CASCADE räumt world_fact_chapters).
    db.prepare(`DELETE FROM world_facts WHERE book_id = ? AND ${emailCond}`).run(bookId, ...emailVal);
    const ins = db.prepare(`
      INSERT INTO world_facts (book_id, kategorie, subjekt, fakt, seite_label, sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`);
    const insWfc = db.prepare('INSERT OR IGNORE INTO world_fact_chapters (fact_id, chapter_id) VALUES (?, ?)');
    let order = 0;
    for (const e of byKey.values()) {
      const { lastInsertRowid } = ins.run(bookId, e.kategorie, e.subjekt, e.fakt, e.seite, order++, userEmail || null);
      for (const c of e.chapters) insWfc.run(lastInsertRowid, c);
    }
    markWorldFactsScanned(bookId, userEmail);
  })();
  return { count: byKey.size };
}

function markWorldFactsScanned(bookId, userEmail) {
  const email = userEmail || null;
  const upd = db.prepare(`UPDATE world_facts_scan SET scanned_at = ${NOW_ISO_SQL} WHERE book_id = ? AND user_email IS ?`)
    .run(bookId, email);
  if (!upd.changes) {
    db.prepare(`INSERT INTO world_facts_scan (book_id, user_email, scanned_at) VALUES (?, ?, ${NOW_ISO_SQL})`)
      .run(bookId, email);
  }
}

// ── Lesepfad ────────────────────────────────────────────────────────────────

/** Welt-Fakten eines Buchs mit ihren Kapitelnamen (JOIN zur Lesezeit, kein
 *  Snapshot). Optionen:
 *  - `kategorien` filtert auf eine Whitelist-Teilmenge (Weltgesetze: ['regel','technik']).
 *  - `subjekt` filtert auf Teilstring im Subjekt, gross-/kleinschreibungsunabhängig
 *    auch für Umlaute (in JS, nicht SQLite-LIKE, das nur ASCII faltet).
 *  - `withRefuted` setzt je Fakt `widerlegt: true|false` (Faktencheck, refutedFactKeys).
 *
 *  Gemeinsamer Lesepfad fuer alle Konsumenten: der Namens-JOIN gehoert nach `db/`
 *  (Content-Store-Facade-Regel), nicht in einen Route- oder Job-Handler.
 *
 *  @returns {Array<{id,kategorie,subjekt,fakt,seite,kapitel:string[],updated_at,widerlegt?}>}
 */
function listWorldFacts(bookId, userEmail, { kategorien = null, subjekt = null, withRefuted = false } = {}) {
  const bookIdInt = parseInt(bookId);
  if (!bookIdInt) return [];
  const email = userEmail || null;
  const kats = Array.isArray(kategorien)
    ? kategorien.map(k => String(k || '').toLowerCase()).filter(k => FAKT_KATEGORIE_WL.has(k))
    : null;
  // Eine leere (aber uebergebene) Kategorienliste heisst „nichts davon" — nicht „alles".
  if (kats && !kats.length) return [];
  const katCond = kats ? ` AND wf.kategorie IN (${kats.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`
    SELECT wf.id, wf.kategorie, wf.subjekt, wf.fakt, wf.seite_label, wf.updated_at,
           c.chapter_name
      FROM world_facts wf
      LEFT JOIN world_fact_chapters wfc ON wfc.fact_id = wf.id
      LEFT JOIN chapters c ON c.chapter_id = wfc.chapter_id
     WHERE wf.book_id = ? AND wf.user_email IS ?${katCond}
     ORDER BY wf.sort_order, wf.id, c.position
  `).all(bookIdInt, email, ...(kats || []));

  const subjQ = String(subjekt || '').trim().toLocaleLowerCase('de');
  const refuted = withRefuted ? refutedFactKeys(bookIdInt, email) : null;
  // Bridge-Zeilen (eine je Kapitel) zu einem Fakt zusammenfassen.
  const byId = new Map();
  for (const r of rows) {
    let e = byId.get(r.id);
    if (!e) {
      if (subjQ && !String(r.subjekt || '').toLocaleLowerCase('de').includes(subjQ)) continue;
      e = {
        id: r.id,
        kategorie: r.kategorie,
        subjekt: r.subjekt || null,
        fakt: r.fakt,
        seite: r.seite_label || null,
        kapitel: [],
        updated_at: r.updated_at || null,
      };
      if (refuted) e.widerlegt = refuted.has(factKey(r.subjekt, r.fakt));
      byId.set(r.id, e);
    }
    if (r.chapter_name && !e.kapitel.includes(r.chapter_name)) e.kapitel.push(r.chapter_name);
  }
  return [...byId.values()];
}

/** Ist der Fakten-Index dieses Buchs je erhoben worden?
 *
 *  **Leer heisst „nie analysiert", nicht „keine Weltfakten"** — dasselbe Muster wie
 *  `scanned: false` bei `motif_occurrences` und `anchorMap === null` im Plot-Check.
 *  Ohne diese Unterscheidung behauptet ein nie gelaufener Lauf, das Buch habe keine
 *  Welt: die Bewertung liest 0 Fakten als weltarm, die Consistency-Pruefung meldet
 *  „verletzt keine Weltregel", und die Karte fordert eine Analyse, die schon lief.
 *
 *  Signale: vorhandene Fakten (deckt importierte Buecher ab) ODER der Scan-Marker
 *  `world_facts_scan`, den jeder Schreibvorgang setzt. Ein Lauf, dessen Fakten-Pass
 *  ausfiel, schreibt nicht und setzt den Marker darum auch nicht.
 *
 *  @returns {{scanned: boolean, count: number}}
 */
function worldFactsScanState(bookId, userEmail) {
  const bookIdInt = parseInt(bookId);
  if (!bookIdInt) return { scanned: false, count: 0 };
  const email = userEmail || null;
  const { n } = db.prepare(
    'SELECT COUNT(*) AS n FROM world_facts WHERE book_id = ? AND user_email IS ?'
  ).get(bookIdInt, email);
  if (n > 0) return { scanned: true, count: n };
  const mark = db.prepare('SELECT 1 FROM world_facts_scan WHERE book_id = ? AND user_email IS ? LIMIT 1')
    .get(bookIdInt, email);
  return { scanned: !!mark, count: 0 };
}

// ── Faktencheck: Urteils-Cache + „real widerlegt" ───────────────────────────

/** Gespeicherte Faktencheck-Urteile eines Buchs: Map factKey → Urteilszeile. */
function getFactVerdicts(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT fact_key, urteil, schwere, beschreibung, empfehlung, quelle, checked_at
      FROM world_fact_verdicts WHERE book_id = ? AND user_email IS ?`).all(parseInt(bookId), userEmail || null);
  return new Map(rows.map(r => [r.fact_key, r]));
}

/** Urteile speichern (Upsert je factKey). verdicts: [{ key, urteil, schwere?, beschreibung?, empfehlung?, quelle? }] */
function saveFactVerdicts(bookId, userEmail, verdicts) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const del = db.prepare('DELETE FROM world_fact_verdicts WHERE book_id = ? AND user_email IS ? AND fact_key = ?');
  const ins = db.prepare(`
    INSERT INTO world_fact_verdicts (book_id, user_email, fact_key, urteil, schwere, beschreibung, empfehlung, quelle, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`);
  db.transaction(() => {
    for (const v of verdicts || []) {
      if (!v?.key || !['korrekt', 'falsch', 'unklar'].includes(v.urteil)) continue;
      del.run(bookIdInt, email, v.key);
      ins.run(bookIdInt, email, v.key, v.urteil, v.schwere || null, v.beschreibung || null, v.empfehlung || null, v.quelle || null);
    }
  })();
}

/** Aussage-Schlüssel der als real FALSCH belegten Fakten: Urteil «falsch» mit
 *  http(s)-Quelle, abzüglich derer, die der Autor im neuesten Kontinuitäts-Check als
 *  „kein Fehler" verworfen hat. SSoT für Karte, Buch-Chat, Werkzeug und Finetune-Filter
 *  — unabhängig davon, ob der zugehörige Befund im neuesten Check noch steht. */
function refutedFactKeys(bookId, userEmail) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const falsch = db.prepare(`
    SELECT fact_key, quelle FROM world_fact_verdicts
     WHERE book_id = ? AND user_email IS ? AND urteil = 'falsch'`).all(bookIdInt, email)
    .filter(r => /^https?:\/\//i.test(String(r.quelle || '').trim()))
    .map(r => r.fact_key);
  if (!falsch.length) return new Set();
  // Massgeblich ist je Aussage ihre jüngste Befund-Zeile: ein später aufgehobenes
  // „kein Fehler" gilt nicht mehr, und ein Check ohne Faktenfehler-Zeilen (neue
  // Komplettanalyse) löscht die Entscheidung des Autors nicht.
  const lastDismissed = new Map();
  for (const r of db.prepare(`
    SELECT ci.stelle_a, ci.dismissed FROM continuity_issues ci
      JOIN continuity_checks cc ON cc.id = ci.check_id
     WHERE cc.book_id = ? AND cc.user_email IS ? AND ci.typ = 'faktenfehler'
     ORDER BY cc.id, ci.id`).all(bookIdInt, email)) {
    lastDismissed.set(factKeyOf(r.stelle_a), !!r.dismissed);
  }
  return new Set(falsch.filter(k => !lastDismissed.get(k)));
}

/** Faktenfehler-Befunde (Kontinuitäts-Form, typ='faktenfehler') aus dem Urteils-Cache:
 *  jede als falsch belegte Aussage, die im aktuellen Index noch steht. Vom Autor
 *  verworfene sind dabei — der Triage-Übertrag des Speicherpfads (carryOverStatus)
 *  setzt ihr „kein Fehler" wieder. Quelle für den Faktencheck-Job und für das
 *  Nachziehen in jeden neuen Kontinuitäts-Check (remap.js#saveKontinuitaetResult). */
function faktenfehlerIssues(bookId, userEmail) {
  const verdicts = getFactVerdicts(bookId, userEmail);
  if (!verdicts.size) return [];
  const out = [];
  const seen = new Set();
  for (const f of listWorldFacts(bookId, userEmail)) {
    const key = factKey(f.subjekt, f.fakt);
    const v = verdicts.get(key);
    if (seen.has(key) || v?.urteil !== 'falsch' || !/^https?:\/\//i.test(String(v.quelle || '').trim())) continue;
    seen.add(key);
    const aussage = `${f.subjekt ? f.subjekt + ': ' : ''}${f.fakt}`;
    out.push({
      schwere: v.schwere || 'mittel',
      typ: 'faktenfehler',
      beschreibung: v.beschreibung || aussage,
      // stelle_a = die geprüfte Aussage (KEIN «»-Zitat → Zitat-Belegprüfung unberührt); stelle_b leer.
      stelle_a: aussage,
      stelle_b: '',
      empfehlung: v.empfehlung || '',
      quelle: v.quelle,
      figuren: [],
      kapitel: f.kapitel || [],
    });
  }
  return out;
}

// Anzeigetitel eines Welt-Fakts per world_facts.id fuer Treffer des Embedding-Index
// (Kind `fact`): «Subjekt (Kategorie)», ohne Subjekt der Fakt-Anfang. Scope wie
// getLocationName: mit `opts.userEmail`-Schluessel nur Fakten dieses Users.
// undefined = Fakt fehlt bzw. gehoert einem anderen User.
const _stmtFact = db.prepare('SELECT kategorie, subjekt, fakt FROM world_facts WHERE id = ?');
const _stmtFactForUser = db.prepare('SELECT kategorie, subjekt, fakt FROM world_facts WHERE id = ? AND user_email IS ?');
function getWorldFactTitle(factId, opts = {}) {
  const row = Object.prototype.hasOwnProperty.call(opts, 'userEmail')
    ? _stmtFactForUser.get(factId, opts.userEmail ?? null)
    : _stmtFact.get(factId);
  if (!row) return undefined;
  const subjekt = String(row.subjekt || '').trim();
  if (subjekt) return row.kategorie ? `${subjekt} (${row.kategorie})` : subjekt;
  const fakt = String(row.fakt || '').trim();
  return fakt.length > 80 ? `${fakt.slice(0, 79)}…` : fakt;
}

module.exports = {
  getWorldFactTitle,
  saveFaktenToDb,
  markWorldFactsScanned,
  listWorldFacts,
  worldFactsScanState,
  getFactVerdicts,
  saveFactVerdicts,
  refutedFactKeys,
  faktenfehlerIssues,
  factKey,
  factKeyOf,
  normFaktKategorie,
  FAKT_KATEGORIE_WL,
};
