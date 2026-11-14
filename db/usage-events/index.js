'use strict';
// Nutzungs-Events (docs/usage-events.md): Schreibweg + Admin-Auswertung.
// Facade des Ordners: Helfer in _shared.js, Verweildauer und Reibung in dwell.js.
//
// Geschrieben wird ausschliesslich ueber lib/usage-events#recordUsageEvent (Katalog-
// Pruefung, Meta-Zuschnitt). Die Auswertung «Verhalten» liest zusaetzlich
// user_activity (aktive Sekunden je User und Tag, seit Version 52 gefuehrt): aktive
// User und Kohorten haben damit Historie vor dem ersten Event.
//
// Privacy-Boundary wie db/admin-usage.js: keine Joins auf Buchnamen oder Inhalte.

const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');
const { localHour, isoAddDays } = require('../../lib/local-date');
const { _excluded, _events, _bump, _median, _weekStart } = require('./_shared');
const { cardDwell, panels, pageViews, friction } = require('./dwell');

const _stmtInsert = db.prepare(`
  INSERT INTO usage_events (user_email, book_id, event, source, meta_json, app_version, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);

function insertUsageEvent({ userEmail, bookId, event, source, meta, appVersion }) {
  _stmtInsert.run(userEmail, bookId ?? null, event, source ?? null, meta ? JSON.stringify(meta) : null, appVersion ?? null);
}

// ── Auswertung ──────────────────────────────────────────────────────────────

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

// Öffnungen je Karte (`card.open`) plus Verweildauer aus `card.close`
// (dwell.js#cardDwell).
function _features(evts, dwell = new Map()) {
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
  return [...acc.values()].map(f => ({
    ...f, users: f.users.size,
    medianSec: dwell.get(f.feature)?.medianSec ?? null,
    totalSec: dwell.get(f.feature)?.totalSec ?? 0,
  }));
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

// Abschnitts-Revisionen: je Kennzahl eine Zeile mit Anzahl und Personen. Alle
// Zeilen stehen auch bei 0 — «niemand stellt je wieder her» ist eine Antwort.
// `view.steps` zaehlt Blaetterschritte (Summe), Personen = wer geblaettert hat.
const REVISION_KEYS = [
  'view', 'view.diff', 'view.current', 'view.steps',
  'restore.hour', 'restore.day', 'restore.week', 'restore.older',
  'pin', 'pin.named', 'rename', 'unpin',
];

function _revisions(evts) {
  const acc = new Map(REVISION_KEYS.map(key => [key, { key, count: 0, users: new Set() }]));
  const hit = (key, user, n = 1) => {
    const r = acc.get(key);
    if (!r || n <= 0) return;
    r.count += n;
    r.users.add(user);
  };
  for (const e of evts) {
    const m = e.meta;
    if (e.event === 'revision.view') {
      hit('view', e.user_email);
      if (m.diff === 'yes') hit('view.diff', e.user_email);
      if (m.current === 'yes') hit('view.current', e.user_email);
      if (Number.isInteger(m.steps)) hit('view.steps', e.user_email, m.steps);
    } else if (e.event === 'revision.restore') {
      if (m.ageBucket) hit(`restore.${m.ageBucket}`, e.user_email);
    } else if (e.event === 'revision.pin') {
      if (m.action === 'pin') {
        hit('pin', e.user_email);
        if (m.named === 'yes') hit('pin.named', e.user_email);
      } else if (m.action) {
        hit(m.action, e.user_email);
      }
    }
  }
  return [...acc.values()].map(r => ({ ...r, users: r.users.size }));
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
    features: _features(keep(_events(['card.open'], fromIso, toIso)), cardDwell(keep(_events(['card.close'], fromIso, toIso)))),
    jobs: _jobs(jobEvents),
    proposals,
    // Chat-Runden mit und ohne Vorschlag: eine Runde ohne Vorschlag ist eine
    // Frage, die nur eine Antwort brachte.
    chatTurns: _chatTurns(jobEvents),
    creation: _creation(keep(_events(['content.created'], fromIso, toIso))),
    sharing: _sharing(keep(_events(['share.link.created', 'comment.action'], fromIso, toIso))),
    lektorat: _lektorat(keep(_events(['lektorat.applied'], fromIso, toIso))),
    revisions: _revisions(keep(_events(['revision.view', 'revision.restore', 'revision.pin'], fromIso, toIso))),
    editors,
    hours,
    tools: _tools(keep(_events(['dictation.start', 'tts.start', 'synonym.applied', 'xref.applied'], fromIso, toIso))),
    reading: _reading(excluded),
    // Verweildauer und Reibung (dwell.js): Werkzeuge am Abschnitt,
    // Abschnitts-Besuche je Person, Konflikte/Save-Fehler/Outbox/Verwerfen.
    panels: panels(keep(_events(['panel.open', 'panel.close'], fromIso, toIso))),
    pageViews: pageViews(keep(_events(['page.view'], fromIso, toIso))),
    friction: friction(keep(_events(['save.conflict', 'save.failed', 'outbox.flush', 'discard.prompt'], fromIso, toIso))),
    cohorts: _cohorts(excluded),
  };
}

module.exports = { insertUsageEvent, behaviorReport };
