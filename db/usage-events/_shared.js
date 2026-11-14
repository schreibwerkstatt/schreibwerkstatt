'use strict';
// Gemeinsame Helfer der Auswertung «Verhalten» (index.js, dwell.js): Events
// eines Zeitraums lesen, Admins ausklammern, zählen, Median, Wochenbeginn.

const { db } = require('../connection');
const { isoAddDays } = require('../../lib/local-date');

const _stmtAdminEmails = db.prepare(`SELECT email FROM app_users WHERE global_role = 'admin'`);

function _excluded(includeAdmins) {
  return includeAdmins ? new Set() : new Set(_stmtAdminEmails.all().map(r => r.email));
}

function _events(names, fromIso, toIso) {
  const ph = names.map(() => '?').join(',');
  return db.prepare(`
    SELECT user_email, book_id, event, source, meta_json, created_at
      FROM usage_events
     WHERE event IN (${ph}) AND created_at >= ? AND created_at < ?
  `).all(...names, fromIso, toIso).map(r => ({ ...r, meta: r.meta_json ? JSON.parse(r.meta_json) : {} }));
}

function _bump(map, key, init) {
  if (!map.has(key)) map.set(key, init());
  return map.get(key);
}

function _median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// ISO-Montag der Woche eines YYYY-MM-DD-Datums.
function _weekStart(date) {
  const d = new Date(date + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  return isoAddDays(date, -dow);
}

module.exports = { _excluded, _events, _bump, _median, _weekStart };
