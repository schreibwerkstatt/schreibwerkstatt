'use strict';
// Auswertung «Verhalten»: Verweildauern und Reibung (docs/usage-events.md#verweildauer,
// #reibung). Alle Dauern sind sichtbare Sekunden, vom Client gedeckelt.
//
// Privacy-Boundary wie index.js: keine Joins auf Buch- oder Abschnittsnamen.
// `pageId` bleibt eine Zahl; die Auswertung zählt nur verschiedene Abschnitte.

const { db } = require('../connection');
const { localIsoDate } = require('../../lib/local-date');
const { _bump, _median } = require('./_shared');

function _dur(e) {
  return Number.isInteger(e.meta.durationSec) ? e.meta.durationSec : null;
}

// Karten: je Feature-Key Median und Summe der Sitzungen (`card.close`).
// Wird in index.js#_features an die Öffnungen gehängt.
function cardDwell(evts) {
  const acc = new Map();
  for (const e of evts) {
    const key = e.meta.feature;
    const d = _dur(e);
    if (!key || d == null) continue;
    const c = _bump(acc, key, () => ({ durations: [], totalSec: 0 }));
    c.durations.push(d);
    c.totalSec += d;
  }
  return new Map([...acc].map(([key, c]) => [key, { medianSec: _median(c.durations), totalSec: c.totalSec }]));
}

// Werkzeuge am Abschnitt: je Werkzeug und Editor Öffnungen, Personen, Median
// und Summe der Dauer.
function panels(evts) {
  const acc = new Map();
  for (const e of evts) {
    const { panel, editor } = e.meta;
    if (!panel) continue;
    const p = _bump(acc, `${panel}:${editor || ''}`, () => ({ panel, editor: editor || null, opens: 0, users: new Set(), durations: [], totalSec: 0 }));
    p.users.add(e.user_email);
    if (e.event === 'panel.open') p.opens += 1;
    else {
      const d = _dur(e);
      if (d != null) { p.durations.push(d); p.totalSec += d; }
    }
  }
  return [...acc.values()].map(({ durations, users, ...p }) => ({ ...p, users: users.size, medianSec: _median(durations) }));
}

// Abschnitts-Besuche je Person: Besuche, verschiedene Abschnitte, Lese- und
// Schreibzeit, Besuche mit Änderung und der Anteil der Abschnitte, zu denen
// die Person an einem anderen Tag zurückkehrte.
function pageViews(evts) {
  const acc = new Map();
  for (const e of evts) {
    const { pageId, editSec } = e.meta;
    const d = _dur(e);
    if (!Number.isInteger(pageId) || d == null) continue;
    const u = _bump(acc, e.user_email, () => ({ views: 0, readSec: 0, editSec: 0, changed: 0, days: new Map() }));
    const edit = Math.min(d, Number.isInteger(editSec) ? editSec : 0);
    u.views += 1;
    u.editSec += edit;
    u.readSec += d - edit;
    if (e.meta.changed === 'yes') u.changed += 1;
    _bump(u.days, pageId, () => new Set()).add(localIsoDate(new Date(e.created_at)));
  }
  if (!acc.size) return { total: { views: 0, pages: 0, readSec: 0, editSec: 0 }, perUser: [] };
  const names = new Map(db.prepare(`SELECT email, display_name FROM app_users`).all().map(r => [r.email, r.display_name]));
  const total = { views: 0, pages: 0, readSec: 0, editSec: 0 };
  const perUser = [...acc].map(([email, u]) => {
    const pages = u.days.size;
    const returned = [...u.days.values()].filter(s => s.size > 1).length;
    total.views += u.views;
    total.pages += pages;
    total.readSec += u.readSec;
    total.editSec += u.editSec;
    return {
      email, displayName: names.get(email) || null,
      views: u.views, pages, readSec: u.readSec, editSec: u.editSec,
      changedShare: u.views ? u.changed / u.views : null,
      returnShare: pages ? returned / pages : null,
    };
  });
  return { total, perUser };
}

// Reibung: feste Kennzahlen, auch bei 0 — «nie ein Konflikt» ist eine Antwort.
// Outbox-Felder sind Summen (Anzahl Entwürfe/Operationen), sonst Ereignisse.
const SAVE_FAIL_REASONS = ['network', 'server', 'auth', 'locked', 'forbidden', 'notFound', 'rejected'];
const FRICTION_KEYS = [
  'conflict.merged', 'conflict.rejected', 'conflict.self',
  ...SAVE_FAIL_REASONS.map(r => `saveFailed.${r}`),
  'outbox.synced', 'outbox.conflicts', 'outbox.dropped', 'outbox.stuck',
  'discard.keep', 'discard.discard',
];

function friction(evts) {
  const acc = new Map(FRICTION_KEYS.map(key => [key, { key, count: 0, users: new Set() }]));
  const hit = (key, user, n = 1) => {
    const r = acc.get(key);
    if (!r || !(n > 0)) return;
    r.count += n;
    r.users.add(user);
  };
  for (const e of evts) {
    const m = e.meta;
    if (e.event === 'save.conflict') {
      if (m.outcome) hit(`conflict.${m.outcome}`, e.user_email);
      if (m.self === 'yes') hit('conflict.self', e.user_email);
    } else if (e.event === 'save.failed') {
      if (m.reason) hit(`saveFailed.${m.reason}`, e.user_email);
    } else if (e.event === 'outbox.flush') {
      for (const k of ['synced', 'conflicts', 'dropped', 'stuck']) {
        if (Number.isInteger(m[k])) hit(`outbox.${k}`, e.user_email, m[k]);
      }
    } else if (e.event === 'discard.prompt') {
      if (m.answer) hit(`discard.${m.answer}`, e.user_email);
    }
  }
  return [...acc.values()].map(r => ({ ...r, users: r.users.size }));
}

module.exports = { cardDwell, panels, pageViews, friction, FRICTION_KEYS };
