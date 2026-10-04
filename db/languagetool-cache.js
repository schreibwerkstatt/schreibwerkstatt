'use strict';
// Absatz-Cache fuer LanguageTool-Resultate.
//
// Key: (content_hash, lang, picky). content_hash = sha1 ueber den Text EINES
// Absatz-Segments (lib/languagetool-chunk.js#splitSegments). Gespeichert werden
// die UNGEFILTERTEN LT-Treffer mit Offsets relativ zum Segment — Woerterbuch,
// Buchnamen und abgeschaltete Regeln filtert der Proxy erst beim Ausliefern.
// Darum ist der Cache benutzer- und seitenunabhaengig: ein Absatz, der in zwei
// Seiten oder bei zwei Mitarbeitern gleich lautet, wird einmal geprueft.
//
// TTL: lib/cache-cleanup.js (created_at). Neue LT-Regeln greifen spaetestens
// nach Ablauf bzw. sobald der Absatz geaendert wird.

const crypto = require('crypto');
const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const _stmtGet = db.prepare(
  `SELECT matches_json FROM languagetool_para_cache
   WHERE content_hash = ? AND lang = ? AND picky = ?`
);
const _stmtUpsert = db.prepare(
  `INSERT INTO languagetool_para_cache (content_hash, lang, picky, matches_json, created_at)
   VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
   ON CONFLICT(content_hash, lang, picky) DO UPDATE SET
     matches_json = excluded.matches_json,
     created_at = excluded.created_at`
);

function hashText(text) {
  return crypto.createHash('sha1').update(typeof text === 'string' ? text : '').digest('hex');
}

/** @returns {Map<string, object[]>} hash -> Treffer; fehlende Hashes fehlen in der Map. */
function getMany({ hashes, lang, picky }) {
  const out = new Map();
  if (!lang || !Array.isArray(hashes)) return out;
  const p = picky ? 1 : 0;
  for (const h of new Set(hashes)) {
    const row = _stmtGet.get(h, lang, p);
    if (!row) continue;
    try {
      const arr = JSON.parse(row.matches_json);
      if (Array.isArray(arr)) out.set(h, arr);
    } catch { /* kaputte Zeile = Miss */ }
  }
  return out;
}

const _setManyTx = db.transaction((entries, lang, p) => {
  for (const e of entries) {
    _stmtUpsert.run(e.hash, lang, p, JSON.stringify(Array.isArray(e.matches) ? e.matches : []));
  }
});

/** @param {{entries: {hash: string, matches: object[]}[], lang: string, picky: boolean}} args */
function setMany({ entries, lang, picky }) {
  if (!lang || !Array.isArray(entries) || !entries.length) return;
  _setManyTx(entries, lang, picky ? 1 : 0);
}

module.exports = { hashText, getMany, setMany };
