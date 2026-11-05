'use strict';
// Nutzungs-Events (docs/usage-events.md): Katalog + einziger Schreibweg.
//
// Der Katalog ist die Allowlist. Ein Event, das hier fehlt, wird verworfen; ein
// Meta-Feld, das in seiner Spec fehlt oder deren Form verletzt, faellt still weg.
// Erlaubt sind nur kategoriale Werte (Enum, Slug, Ganzzahl) — Freitext hat
// keinen Typ, damit kein Manuskript-, Chat- oder Suchtext in die Tabelle geraten
// kann. `origin` sagt, wer das Event ausloest: 'client' kommt ueber
// POST /usage/event, 'server' nur aus dem Code. Der Client darf kein Server-Event
// faelschen (sonst liessen sich Logins oder Jobs erfinden).
//
// Gegated durch tests/unit/usage-events.test.mjs: jeder Aufrufer im Code nennt
// ein Event aus diesem Katalog mit passender Herkunft.

const logger = require('../logger');
const { getVersion } = require('./version');

const SLUG = { type: 'slug' };
const INT = { type: 'int' };
const enumOf = (...values) => ({ type: 'enum', values });

const CHAT_KINDS = enumOf('page', 'book', 'research', 'plot', 'ideen');
const EDITORS = enumOf('notebook', 'focus', 'book');

const USAGE_EVENTS = {
  // ── Sitzung + Konto ───────────────────────────────────────────────────────
  'session.start':   { origin: 'client', meta: { surface: enumOf('browser', 'pwa'), viewport: enumOf('mobile', 'tablet', 'desktop'), locale: enumOf('de', 'en') } },
  'auth.login':      { origin: 'server', meta: { method: SLUG } },
  'account.created': { origin: 'server', meta: { method: enumOf('local', 'oidc'), via: enumOf('invite', 'open-signup') } },
  'book.created':    { origin: 'server', meta: { via: enumOf('manual', 'book-import', 'manuscript-import', 'folder-import') } },

  // ── Features ──────────────────────────────────────────────────────────────
  // Karten-Oeffnung; geschrieben von POST /usage/track, nicht vom Client direkt.
  'card.open':       { origin: 'server', meta: { feature: SLUG } },

  // ── Schreiben ─────────────────────────────────────────────────────────────
  'editor.open':     { origin: 'client', meta: { editor: EDITORS } },
  'editor.close':    { origin: 'client', meta: { editor: EDITORS, durationSec: INT } },
  'dictation.start': { origin: 'client', meta: {} },
  'tts.start':       { origin: 'client', meta: {} },
  // Synonym eingesetzt; `source` = aus welchem Abschnitt des Pickers.
  'synonym.applied': { origin: 'client', meta: { source: enumOf('thesaurus', 'ai') } },

  // «Buch offline halten» (Sidebar-Knopf): Anheften/Loesen beim Klick, und
  // wie der dadurch ausgeloeste Erst-Sync ausging. `status` = HTTP-Status beim
  // Abbruch (0 = Netz), `persisted` = Browser hat dauerhaften Speicher gewaehrt.
  // Syncs der Automatik und spaetere Nach-Syncs melden nichts.
  'offline.pin':     { origin: 'client', meta: { action: enumOf('pin', 'unpin') } },
  'offline.pin.result': { origin: 'client', meta: { result: enumOf('done', 'partial', 'failed'), total: INT, failed: INT, status: INT, durationSec: INT, persisted: enumOf('yes', 'no') } },

  // ── Erzeugen & Teilen ───────────────────────────────────────────────────────
  // Etwas Neues im Buch: Quelle, Idee, Beat, Abschnitt, Kapitel, Figur. Der
  // Server schreibt das beim Anlegen — unabhaengig vom Client, also auch fuer
  // die nativen Clients gemessen.
  'content.created':    { origin: 'server', meta: { kind: enumOf('source', 'idea', 'beat', 'page', 'chapter', 'figure') } },
  // Share-Link erstellt: Buch, Kapitel oder Abschnitt an Leser:innen.
  'share.link.created': { origin: 'server', meta: { kind: enumOf('page', 'chapter', 'book') } },
  // Owner-Aktion auf einem Leser-Kommentar: antworten, aufloesen, loeschen.
  // Kommentare der Leser:innen sind anonym — sie haben kein Konto und stehen
  // deshalb nicht hier (ihre Verweildauer steht in den Share-Link-Tabellen).
  'comment.action':     { origin: 'server', meta: { action: enumOf('reply', 'resolve', 'delete') } },
  // Querverweis im Editor eingefuegt; `kind` = Zieltyp (chapter/figure/table/page).
  'xref.applied':       { origin: 'client', meta: { kind: SLUG } },

  // ── KI-Ergebnisse ─────────────────────────────────────────────────────────
  'job.queued':      { origin: 'server', meta: { type: SLUG } },
  'job.finished':    { origin: 'server', meta: { type: SLUG, status: enumOf('done', 'error', 'cancelled'), durationSec: INT } },
  // Ein Vorschlag aus einem der fuenf Chats; `kind` ist der Vorschlagstyp
  // (korrektur/stil, idee_create, beat_update, note …), `count` > 1 bei «alle».
  'chat.proposal':   { origin: 'client', meta: { chat: CHAT_KINDS, action: enumOf('applied', 'discarded', 'reopened', 'undone'), kind: SLUG, count: INT } },
  // Abschnitts-Lektorat «Korrekturen uebernehmen»: angezeigt / angehakt /
  // tatsaechlich angewendet / beim Anwenden uebersprungen.
  'lektorat.applied': { origin: 'client', meta: { shown: INT, selected: INT, applied: INT, skipped: INT } },
};

const SOURCES = new Set(['palette', 'tile', 'sidebar', 'shortcut']);
const SLUG_RE = /^[a-z0-9][a-z0-9_.:-]{0,47}$/i;
const MAX_INT = 10_000_000;

function _cleanValue(spec, v) {
  switch (spec.type) {
    case 'enum': return spec.values.includes(v) ? v : undefined;
    case 'slug': return (typeof v === 'string' && SLUG_RE.test(v)) ? v : undefined;
    case 'int': {
      const n = typeof v === 'number' ? v : NaN;
      return (Number.isInteger(n) && n >= 0 && n <= MAX_INT) ? n : undefined;
    }
    default: return undefined;
  }
}

// Meta auf die Spec des Events zuschneiden. Liefert null, wenn nichts bleibt.
function sanitizeMeta(event, meta) {
  const spec = USAGE_EVENTS[event]?.meta;
  if (!spec || !meta || typeof meta !== 'object') return null;
  const out = {};
  for (const [k, fieldSpec] of Object.entries(spec)) {
    const v = _cleanValue(fieldSpec, meta[k]);
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function isEvent(event, origin) {
  const def = USAGE_EVENTS[event];
  return !!def && (!origin || def.origin === origin);
}

// Best-Effort: wirft nie. Ein Tracking-Fehler darf keinen Login, Job oder Save
// abbrechen. `db/usage-events` lazy, damit dieses Modul in Minimal-Test-Schemata
// ohne die Tabelle importierbar bleibt.
function recordUsageEvent({ userEmail, event, bookId = null, source = null, meta = null }) {
  try {
    if (!userEmail || !USAGE_EVENTS[event]) return false;
    const book = Number.isInteger(Number(bookId)) && Number(bookId) > 0 ? Number(bookId) : null;
    require('../db/usage-events').insertUsageEvent({
      userEmail,
      bookId: book,
      event,
      source: SOURCES.has(source) ? source : null,
      meta: sanitizeMeta(event, meta),
      appVersion: getVersion(),
    });
    return true;
  } catch (e) {
    logger.warn(`[usage-events] ${event} nicht gespeichert: ${e.message}`);
    return false;
  }
}

module.exports = { USAGE_EVENTS, SOURCES, sanitizeMeta, isEvent, recordUsageEvent };
