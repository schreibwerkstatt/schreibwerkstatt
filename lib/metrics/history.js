'use strict';
// Tagesreihen fuer /metrics/history.json: was die Live-Kennzahlen heute melden,
// rueckwirkend aus den Tages-Snapshots (book_stats_history, Lauf 23:00 lokal).
// Die Home-Assistant-Integration schreibt sie einmal in ihre Langzeitstatistik,
// damit Verlaufsgrafiken nicht erst mit der Einrichtung beginnen.
//
// Gleiche Namen und Labels wie /metrics.json — die Integration ordnet eine
// Reihe ueber Name + Labels ihrem Sensor zu. Regeln:
//  - Stand je Datum: je Buch der letzte Snapshot bis zu diesem Datum. Die
//    juengsten 365 Tage sind taeglich, aelter nur Monatsend-Staende
//    (lib/cache-cleanup.js). Geloeschte Buecher fehlen samt Verlauf (CASCADE).
//  - Netto je Tag (`*_today`) nur, wo auch der Vortag einen Snapshot hat, also
//    im taeglichen Fenster; je Buch Snapshot minus vorheriger Snapshot. Erster
//    Snapshot eines Buchs zaehlt nicht (Import), wie bei sw_words_today.
//  - Schreib-, Lektorats- und Diktatzeit: Tagessummen aus den Zeittabellen,
//    nur Tage mit Eintraegen.
//  - Heute fehlt: der Tag laeuft noch, die Live-Werte decken ihn ab.
//  - Pro User wie live: eigene Buecher (books.owner_email), nur aktive User,
//    nur mit `includeUsers`.

const q = require('../../db/metrics-queries');
const { localIsoDate, isoAddDays, currentTz } = require('../local-date');
const { getInstanceId } = require('../instance-id');
const { JSON_SCHEMA } = require('./format');

const TIME_SERIES = [
  ['writing_time', 'writing_seconds_today'],
  ['lektorat_time', 'lektorat_seconds_today'],
  ['stt_time', 'stt_seconds_today'],
];

function collectHistoryJson({ includeUsers = false, now = new Date() } = {}) {
  const today = localIsoDate(now);
  const users = includeUsers
    ? new Map(q.activeUsers().map(u => [u.email, u.display_name || u.email]))
    : new Map();

  const byDate = new Map();
  for (const r of q.historyRows(today)) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }

  const series = new Map();
  const point = (name, date, value, labels = {}) => {
    const key = `${name}|${labels.user || ''}`;
    if (!series.has(key)) series.set(key, { name, labels, points: [] });
    series.get(key).points.push([date, value]);
  };

  const last = new Map();  // book_id → { words, chars, email }
  let prevDate = null;
  for (const [date, rows] of byDate) {
    const daily = prevDate === isoAddDays(date, -1);
    const net = { words: 0, chars: 0 };
    const netByUser = new Map();
    for (const r of rows) {
      const before = last.get(r.book_id);
      if (before) {
        const dw = r.words - before.words, dc = r.chars - before.chars;
        net.words += dw; net.chars += dc;
        if (users.has(r.email)) {
          const u = netByUser.get(r.email) || { words: 0, chars: 0 };
          u.words += dw; u.chars += dc;
          netByUser.set(r.email, u);
        }
      }
      last.set(r.book_id, { words: r.words, chars: r.chars, email: r.email });
    }

    const total = { books: 0, written: 0, words: 0, chars: 0 };
    const perUser = new Map([...users.keys()].map(e => [e, { books: 0, words: 0, chars: 0 }]));
    for (const b of last.values()) {
      total.books++; total.words += b.words; total.chars += b.chars;
      if (b.chars > 0) total.written++;
      const u = perUser.get(b.email);
      if (u) { u.books++; u.words += b.words; u.chars += b.chars; }
    }

    point('sw_books', date, total.books);
    point('sw_books_written', date, total.written);
    point('sw_chars', date, total.chars);
    point('sw_words', date, total.words);
    point('sw_normseiten', date, Math.round(total.chars / 1800));
    if (daily) {
      point('sw_chars_today', date, net.chars);
      point('sw_words_today', date, net.words);
    }
    for (const [email, u] of perUser) {
      const labels = { user: email, user_name: users.get(email) };
      point('sw_user_books', date, u.books, labels);
      point('sw_user_chars', date, u.chars, labels);
      point('sw_user_words', date, u.words, labels);
      if (daily) {
        const n = netByUser.get(email) || { words: 0, chars: 0 };
        point('sw_user_chars_today', date, n.chars, labels);
        point('sw_user_words_today', date, n.words, labels);
      }
    }
    prevDate = date;
  }

  for (const [table, name] of TIME_SERIES) {
    const total = new Map();
    for (const r of q.secondsHistory(table, today)) {
      total.set(r.date, (total.get(r.date) || 0) + r.n);
      if (users.has(r.email)) point(`sw_user_${name}`, r.date, r.n, { user: r.email, user_name: users.get(r.email) });
    }
    for (const [date, n] of total) point(`sw_${name}`, date, n);
  }

  return {
    schema: JSON_SCHEMA,
    instance_id: getInstanceId(),
    generated_at: now.toISOString(),
    timezone: currentTz(),
    today,
    includes_users: !!includeUsers,
    series: [...series.values()],
  };
}

module.exports = { collectHistoryJson };
