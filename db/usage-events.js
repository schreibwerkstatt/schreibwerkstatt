'use strict';
// Nutzungs-Events (docs/usage-events.md): Schreibweg + Admin-Auswertung.
//
// Geschrieben wird ausschliesslich ueber lib/usage-events#recordUsageEvent (Katalog-
// Pruefung, Meta-Zuschnitt). Die Auswertung «Verhalten» liest zusaetzlich
// user_activity (aktive Sekunden je User und Tag, seit Version 52 gefuehrt): aktive
// User und Kohorten haben damit Historie vor dem ersten Event.
//
// Privacy-Boundary wie db/admin-usage.js: keine Joins auf Buchnamen oder Inhalte.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { localHour, isoAddDays } = require('../lib/local-date');

const _stmtInsert = db.prepare(`
  INSERT INTO usage_events (user_email, book_id, event, source, meta_json, app_version, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);

function insertUsageEvent({ userEmail, bookId, event, source, meta, appVersion }) {
  _stmtInsert.run(userEmail, bookId ?? null, event, source ?? null, meta ? JSON.stringify(meta) : null, appVersion ?? null);
}

// ── Auswertung ──────────────────────────────────────────────────────────────

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

function _activity(fromDate, toDate, excluded) {
  const rows = db.prepare(`
    SELECT user_email, date, seconds FROM user_activity WHERE date >= ? AND date < ?
  `).all(fromDate, toDate).filter(r => !excluded.has(r.user_email));
  const weeks = new Map();
  const users = new Set();
  for (const r of rows) {
    users.add(r.user_email);
    const w = _bump(weeks, _weekStart(r.date), () => ({ users: new Set(), seconds: 0, days: 0 }));
    w.users.add(r.user_email);
    w.seconds += r.seconds || 0;
    w.days += 1;
  }
  return {
    activeUsers: users.size,
    weekly: [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, w]) => ({
      week, activeUsers: w.users.size, activeSeconds: w.seconds, activeDays: w.days,
    })),
  };
}

function _features(evts) {
  const acc = new Map();
  for (const e of evts) {
    const key = e.meta.feature;
    if (!key) continue;
    const f = _bump(acc, key, () => ({ feature: key, opens: 0, users: new Set(), lastAt: null, sources: {} }));
    f.opens += 1;
    f.users.add(e.user_email);
    if (!f.lastAt || e.created_at > f.lastAt) f.lastAt = e.created_at;
    const src = e.source || 'other';
    f.sources[src] = (f.sources[src] || 0) + 1;
  }
  return [...acc.values()].map(f => ({ ...f, users: f.users.size }));
}

function _jobs(evts) {
  const acc = new Map();
  for (const e of evts) {
    const type = e.meta.type;
    if (!type) continue;
    const j = _bump(acc, type, () => ({ type, queued: 0, done: 0, error: 0, cancelled: 0, users: new Set(), durations: [] }));
    j.users.add(e.user_email);
    if (e.event === 'job.queued') j.queued += 1;
    else if (j[e.meta.status] !== undefined) {
      j[e.meta.status] += 1;
      if (e.meta.status === 'done' && Number.isInteger(e.meta.durationSec)) j.durations.push(e.meta.durationSec);
    }
  }
  return [...acc.values()].map(({ durations, users, ...j }) => ({ ...j, users: users.size, medianSec: _median(durations) }));
}

function _proposals(evts) {
  const acc = new Map();
  for (const e of evts) {
    const { chat, kind, action } = e.meta;
    if (!chat || !action) continue;
    const key = `${chat}:${kind || ''}`;
    const p = _bump(acc, key, () => ({ chat, kind: kind || null, applied: 0, discarded: 0, reopened: 0, undone: 0, users: new Set() }));
    p[action] += Number.isInteger(e.meta.count) && e.meta.count > 0 ? e.meta.count : 1;
    p.users.add(e.user_email);
  }
  return [...acc.values()].map(p => ({ ...p, users: p.users.size }));
}

function _lektorat(evts) {
  const out = { runs: 0, users: new Set(), shown: 0, selected: 0, applied: 0, skipped: 0 };
  for (const e of evts) {
    out.runs += 1;
    out.users.add(e.user_email);
    for (const k of ['shown', 'selected', 'applied', 'skipped']) out[k] += e.meta[k] || 0;
  }
  return { ...out, users: out.users.size };
}

function _editors(evts) {
  const acc = new Map();
  const hours = new Array(24).fill(0);
  for (const e of evts) {
    const editor = e.meta.editor;
    if (!editor) continue;
    const ed = _bump(acc, editor, () => ({ editor, opens: 0, users: new Set(), durations: [], totalSec: 0 }));
    ed.users.add(e.user_email);
    if (e.event === 'editor.open') {
      ed.opens += 1;
      hours[localHour(new Date(e.created_at))] += 1;
    } else if (Number.isInteger(e.meta.durationSec)) {
      ed.durations.push(e.meta.durationSec);
      ed.totalSec += e.meta.durationSec;
    }
  }
  return {
    editors: [...acc.values()].map(({ durations, users, ...ed }) => ({
      ...ed, users: users.size, sessions: durations.length, medianSec: _median(durations),
    })),
    hours,
  };
}

// Je Werkzeug eine Zeile; Synonyme getrennt nach Thesaurus und KI.
function _tools(evts) {
  const acc = new Map();
  for (const e of evts) {
    const key = e.meta.source ? `${e.event}.${e.meta.source}` : e.event;
    const t = _bump(acc, key, () => ({ event: key, count: 0, users: new Set() }));
    t.count += 1;
    t.users.add(e.user_email);
  }
  return [...acc.values()].map(t => ({ ...t, users: t.users.size }));
}

// Erzeugtes im Buch: Quelle, Idee, Beat, Abschnitt, Kapitel, Figur-Entwurf.
function _creation(evts) {
  const acc = new Map();
  for (const e of evts) {
    const kind = e.meta.kind;
    if (!kind) continue;
    const c = _bump(acc, kind, () => ({ kind, count: 0, users: new Set(), lastAt: null }));
    c.count += 1;
    c.users.add(e.user_email);
    if (!c.lastAt || e.created_at > c.lastAt) c.lastAt = e.created_at;
  }
  return [...acc.values()].map(c => ({ ...c, users: c.users.size }));
}

// Geteilt: Share-Link erstellt, an Leser-Kommentare geantwortet/geloest/geloescht.
function _sharing(evts) {
  const acc = new Map();
  for (const e of evts) {
    const key = e.event === 'share.link.created' ? `link.${e.meta.kind}` : e.meta.action;
    if (!key) continue;
    const s = _bump(acc, key, () => ({ key, count: 0, users: new Set() }));
    s.count += 1;
    s.users.add(e.user_email);
  }
  return [...acc.values()].map(s => ({ ...s, users: s.users.size }));
}

// Job-Typ → Chat-Art. Eine Chat-Runde ist ein Job; die Vorschlaege dazu kommen
// als `chat.proposal`. So ist sichtbar, wie viele Runden ohne Vorschlag blieben.
const CHAT_JOB_TYPES = { chat: 'page', 'book-chat': 'book', 'research-chat': 'research', 'plot-chat': 'plot', 'ideen-chat': 'ideen' };

// Runden zaehlt `job.queued`; mit/ohne Vorschlag zaehlen fertige Runden
// (`job.finished` done) nach ihrem `proposals`-Feld. Runden ohne das Feld
// (abgebrochen, fehlgeschlagen) zaehlen in keine der beiden Spalten.
function _chatTurns(evts) {
  const acc = new Map();
  // Alle fuenf Chats als Zeile — auch die ohne Runde: die Nullzeile beantwortet
  // «welcher Chat wird nie benutzt?» (Muster der Funktionstabelle).
  for (const chat of Object.values(CHAT_JOB_TYPES)) {
    acc.set(chat, { chat, turns: 0, withProposal: 0, withoutProposal: 0, users: new Set() });
  }
  for (const e of evts) {
    const chat = CHAT_JOB_TYPES[e.meta.type];
    if (!chat) continue;
    const c = acc.get(chat);
    if (e.event === 'job.queued') {
      c.turns += 1;
      c.users.add(e.user_email);
    } else if (e.meta.status === 'done' && Number.isInteger(e.meta.proposals)) {
      if (e.meta.proposals > 0) c.withProposal += 1;
      else c.withoutProposal += 1;
    }
  }
  return [...acc.values()].map(c => ({ ...c, users: c.users.size }));
}

// Leseaktivitaet je Person: verschiedene Abschnitte und Oeffnungen. Quelle ist
// `user_page_usage` (je Person und Abschnitt aggregiert) — nicht der Event-Strom,
// deshalb kennt sie keine Zeitachse: die Werte sind kumuliert, nicht periodisch.
function _reading(excluded) {
  const rows = db.prepare(`
    SELECT u.email AS user_email, u.display_name, COUNT(DISTINCT p.page_id) AS pages, SUM(p.use_count) AS opens, MAX(p.last_used) AS last_at
      FROM user_page_usage p JOIN app_users u ON u.email = p.user_email
     GROUP BY u.email
  `).all().filter(r => !excluded.has(r.user_email));
  let pages = 0, opens = 0;
  const perUser = rows.map(r => {
    pages += r.pages || 0;
    opens += r.opens || 0;
    return {
      email: r.user_email, displayName: r.display_name,
      pages: r.pages || 0, opens: r.opens || 0, lastAt: r.last_at || null,
    };
  });
  return { total: { pages, opens }, perUser };
}

// Kohorten ueber die ganze Historie (nicht den Zeitraum): Start = erste Anmeldung
// bzw. Anlage, Aktivitaet aus user_activity. «Tage aktiv in Woche 1» ist die
// Retention-Frage «bleibt jemand nach dem Einstieg?».
function _cohorts(excluded) {
  const users = db.prepare(`
    SELECT email, display_name, COALESCE(first_seen_at, created_at) AS start_at
      FROM app_users WHERE status != 'deleted'
  `).all().filter(u => !excluded.has(u.email));
  const days = db.prepare(`SELECT user_email, date FROM user_activity ORDER BY date`).all();
  const byUser = new Map();
  for (const d of days) _bump(byUser, d.user_email, () => []).push(d.date);
  return users.map(u => {
    const dates = byUser.get(u.email) || [];
    const start = (u.start_at || dates[0] || '').slice(0, 10);
    const in7 = start ? dates.filter(d => d >= start && d < isoAddDays(start, 7)).length : 0;
    const in30 = start ? dates.filter(d => d >= start && d < isoAddDays(start, 30)).length : 0;
    return {
      email: u.email,
      displayName: u.display_name,
      startDate: start || null,
      activeDays7: in7,
      activeDays30: in30,
      activeDaysTotal: dates.length,
      activeWeeks: new Set(dates.map(_weekStart)).size,
      lastActive: dates.length ? dates[dates.length - 1] : null,
    };
  });
}

function behaviorReport({ fromIso, toIso, includeAdmins = false }) {
  const excluded = _excluded(includeAdmins);
  const keep = rows => rows.filter(r => !excluded.has(r.user_email));
  const sessions = keep(_events(['session.start'], fromIso, toIso));
  const { editors, hours } = _editors(keep(_events(['editor.open', 'editor.close'], fromIso, toIso)));
  const jobEvents = keep(_events(['job.queued', 'job.finished'], fromIso, toIso));
  const proposals = _proposals(keep(_events(['chat.proposal'], fromIso, toIso)));
  return {
    activity: _activity(fromIso.slice(0, 10), toIso.slice(0, 10), excluded),
    sessions: sessions.length,
    logins: keep(_events(['auth.login'], fromIso, toIso)).length,
    booksCreated: keep(_events(['book.created'], fromIso, toIso)).length,
    features: _features(keep(_events(['card.open'], fromIso, toIso))),
    jobs: _jobs(jobEvents),
    proposals,
    // Chat-Runden mit und ohne Vorschlag: eine Runde ohne Vorschlag ist eine
    // Frage, die nur eine Antwort brachte.
    chatTurns: _chatTurns(jobEvents),
    creation: _creation(keep(_events(['content.created'], fromIso, toIso))),
    sharing: _sharing(keep(_events(['share.link.created', 'comment.action'], fromIso, toIso))),
    lektorat: _lektorat(keep(_events(['lektorat.applied'], fromIso, toIso))),
    editors,
    hours,
    tools: _tools(keep(_events(['dictation.start', 'tts.start', 'synonym.applied', 'xref.applied'], fromIso, toIso))),
    reading: _reading(excluded),
    cohorts: _cohorts(excluded),
  };
}

module.exports = { insertUsageEvent, behaviorReport };
