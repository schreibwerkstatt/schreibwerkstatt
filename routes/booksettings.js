'use strict';
const express = require('express');
const {
  getBookSettings, saveBookSettings, setBookEntitiesEnabled,
  setBookCitationSettings, VALID_CITATION_STYLES, VALID_BIBLIOGRAPHY_SCOPES, VALID_CITATION_NOTES,
  setBookXrefSettings, setBookTextsorte, setBookIsFinished, setBookResearchSettings,
} = require('../db/schema');
const { isValidTextsorte } = require('../db/textsorte');
const { journalisticBookSettings } = require('../lib/page-guard');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const logger = require('../logger');
const { captureSnapshot } = require('./snapshots');
const { getBookSchulsystem, setBookSchulsystem, getBookHandlungsjahr, setBookHandlungsjahr } = require('../db/book-settings');
const { schoolPath } = require('../lib/esm-bridge');

const router = express.Router();
const jsonBody = express.json();

// Label der Fassung, die beim Fertig-Markieren automatisch entsteht (Publikations-
// Meilenstein). __i18n:-Marker → Betrachter sieht die Bezeichnung in seiner Locale.
const AUTO_FINISH_LABEL = '__i18n:snapshots.autoFinishLabel__';

const {
  VALID_LANGUAGES, VALID_REGIONS, VALID_POV, VALID_TEMPUS, validBuchtypen,
} = require('../lib/book-settings-values');
const BUCH_KONTEXT_MAX = 2000;
// Stilprofil: KI-destilliert ~1-2k Zeichen; 6000 als grosszuegige Obergrenze
// gegen versehentliches Einfuegen ganzer Kapitel.
const STILPROFIL_MAX = 6000;
// Tagesziel: 100 Zeichen ≈ kurzer Tweet (Untergrenze gegen Tippfehler),
// 50 000 ≈ 33 Normseiten als praktisches Maximum.
const DAILY_GOAL_MIN = 100;
const DAILY_GOAL_MAX = 50000;
// Schreibziel (gesamt): 1 000 Zeichen Untergrenze, 20 Mio (~13 000 Normseiten)
// als praktisches Maximum gegen Tippfehler.
const GOAL_TARGET_MIN = 1000;
const GOAL_TARGET_MAX = 20000000;
// Verzeichnis-Ueberschrift ("Literaturverzeichnis", "Quellen", …). Leer =
// Sprach-Default des Renderers.
const BIBLIOGRAPHY_TITLE_MAX = 200;

/** Gibt Sprache, Region, Buchtyp und Buchkontext für ein Buch zurück. */
router.get('/:book_id', aclParamGuard('viewer'), (req, res) => {
  const bookId = req.bookId;
  const settings = getBookSettings(bookId, sessionEmail(req));
  res.json({ ...settings, schulsystem: getBookSchulsystem(bookId), handlungsjahr: getBookHandlungsjahr(bookId) });
});

const has = (b, k) => b[k] !== undefined;
const isEmpty = (x) => x === null || x === '';

/** Echtes Kalenderdatum im strikten ISO-Format (2025-02-30 faellt durch). */
function isCalendarDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Ganzzahl im Bereich, `null`/'' = kein Wert. Liefert { value } oder { error }. */
function intInRange(raw, min, max) {
  if (isEmpty(raw)) return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return { error: true };
  return { value: n };
}

/** Speichert die Felder des Haupt-Formulars als Teil-PUT: ein fehlender Key
 *  (undefined) behaelt den gespeicherten Wert, `null`/'' loescht ihn (Text-,
 *  Enum- und Zielfelder) bzw. schaltet ihn aus. Sprache und Region lassen sich
 *  nicht loeschen; fehlen sie, bleibt der Stand (ohne Zeile: Owner-Defaults).
 *  `allow_lektor_book_chat` ist eine Rechte-Freigabe und wird nur vom Owner
 *  uebernommen — von einem Editor still ignoriert, weil das Formular das Feld
 *  immer mitschickt. */
router.put('/:book_id', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = {};
  const bad = (field, allowed) => res.status(400).json({ error_code: 'INVALID_VALUE', params: { field, allowed } });

  for (const k of ['language', 'region']) {
    if (!has(b, k)) continue;
    if (isEmpty(b[k])) return res.status(400).json({ error_code: 'LANGUAGE_REGION_REQUIRED' });
  }
  if (has(b, 'language')) {
    if (!VALID_LANGUAGES.includes(b.language)) {
      return res.status(400).json({ error_code: 'INVALID_LANGUAGE', params: { allowed: VALID_LANGUAGES.join(', ') } });
    }
    patch.language = b.language;
  }
  if (has(b, 'region')) {
    if (!VALID_REGIONS.includes(b.region)) {
      return res.status(400).json({ error_code: 'INVALID_REGION', params: { allowed: VALID_REGIONS.join(', ') } });
    }
    patch.region = b.region;
  }
  if (has(b, 'buchtyp')) {
    if (!isEmpty(b.buchtyp) && !validBuchtypen().includes(b.buchtyp)) {
      return res.status(400).json({ error_code: 'INVALID_BUCHTYP', params: { allowed: validBuchtypen().join(', ') } });
    }
    patch.buchtyp = b.buchtyp || null;
  }
  if (has(b, 'buch_kontext')) {
    if (b.buch_kontext && String(b.buch_kontext).length > BUCH_KONTEXT_MAX) {
      return res.status(400).json({ error_code: 'BUCH_KONTEXT_TOO_LONG', params: { max: BUCH_KONTEXT_MAX } });
    }
    patch.buch_kontext = b.buch_kontext || null;
  }
  if (has(b, 'stilprofil')) {
    if (b.stilprofil && String(b.stilprofil).length > STILPROFIL_MAX) {
      return res.status(400).json({ error_code: 'STILPROFIL_TOO_LONG', params: { max: STILPROFIL_MAX } });
    }
    patch.stilprofil = b.stilprofil || null;
  }
  if (has(b, 'erzaehlperspektive')) {
    if (!isEmpty(b.erzaehlperspektive) && !VALID_POV.includes(b.erzaehlperspektive)) {
      return res.status(400).json({ error_code: 'INVALID_POV', params: { allowed: VALID_POV.join(', ') } });
    }
    patch.erzaehlperspektive = b.erzaehlperspektive || null;
  }
  if (has(b, 'erzaehlzeit')) {
    if (!isEmpty(b.erzaehlzeit) && !VALID_TEMPUS.includes(b.erzaehlzeit)) {
      return res.status(400).json({ error_code: 'INVALID_TEMPUS', params: { allowed: VALID_TEMPUS.join(', ') } });
    }
    patch.erzaehlzeit = b.erzaehlzeit || null;
  }
  // Tagesziel: null/'' = nicht gesetzt (Frontend-Default 1500, so stehen Altbuecher
  // da); 0 = bewusst KEIN Tagesziel (wird als 0 gespeichert, nie als Divisor benutzt).
  if (has(b, 'daily_goal_chars')) {
    if (Number(b.daily_goal_chars) === 0 && !isEmpty(b.daily_goal_chars)) {
      patch.daily_goal_chars = 0;
    } else {
      const r = intInRange(b.daily_goal_chars, DAILY_GOAL_MIN, DAILY_GOAL_MAX);
      if (r.error) return bad('daily_goal_chars', `0, ${DAILY_GOAL_MIN}–${DAILY_GOAL_MAX}`);
      patch.daily_goal_chars = r.value;
    }
  }
  // Schreibziel: Zielzeichenzahl (gesamt). null/leer = kein Ziel.
  if (has(b, 'goal_target_chars')) {
    const r = intInRange(b.goal_target_chars, GOAL_TARGET_MIN, GOAL_TARGET_MAX);
    if (r.error) return bad('goal_target_chars', `${GOAL_TARGET_MIN}–${GOAL_TARGET_MAX}`);
    patch.goal_target_chars = r.value;
  }
  // Abgabedatum: striktes ISO YYYY-MM-DD und ein echter Kalendertag. null/leer = keine Deadline.
  if (has(b, 'goal_deadline')) {
    if (!isEmpty(b.goal_deadline) && !isCalendarDate(String(b.goal_deadline))) {
      return bad('goal_deadline', 'YYYY-MM-DD');
    }
    patch.goal_deadline = isEmpty(b.goal_deadline) ? null : String(b.goal_deadline);
  }
  if (has(b, 'schauplatz_land')) {
    if (!isEmpty(b.schauplatz_land) && !/^[A-Za-z]{2}$/.test(String(b.schauplatz_land))) {
      return bad('schauplatz_land', 'ISO-3166-1-alpha-2');
    }
    patch.schauplatz_land = isEmpty(b.schauplatz_land) ? null : String(b.schauplatz_land).toLowerCase();
  }
  for (const k of ['is_finished', 'orte_real', 'zeitlinie_real', 'weltfakten_real_pruefen', 'exclude_from_stats']) {
    if (has(b, k)) patch[k] = b[k] ? 1 : 0;
  }
  if (has(b, 'allow_lektor_book_chat') && req.bookRole === 'owner') {
    patch.allow_lektor_book_chat = b.allow_lektor_book_chat ? 1 : 0;
  }

  // Vorheriger Fertig-Status fuer die Auto-Fassung beim 0→1-Uebergang.
  const wasFinished = getBookSettings(bookId)?.is_finished ? 1 : 0;
  const saved = saveBookSettings(bookId, patch);

  // Publikations-Meilenstein: Buch frisch als fertig markiert (0→1) → automatisch
  // eine Fassung festhalten (dedup gegen die juengste, damit kein Duplikat
  // entsteht, falls der Stand bereits festgehalten wurde). Best-effort und
  // fire-and-forget — blockiert das Settings-Speichern nicht und darf nie werfen.
  if (saved.is_finished && !wasFinished) {
    captureSnapshot(bookId, req, {
      kind: 'auto_finish', label: AUTO_FINISH_LABEL, dedup: true, userEmail: sessionEmail(req),
    }).catch((e) => logger.warn(`Auto-Fassung beim Fertig-Markieren fehlgeschlagen (book=${bookId}): ${e.message}`));
  }

  // Antwort: der vollstaendige gespeicherte Stand (wie GET), nicht das Echo des
  // Bodys — bei einem Teil-PUT sieht die Oberflaeche so auch die unveraenderten Felder.
  res.json({ ok: true, ...saved, locale: `${saved.language}-${saved.region}` });
});

/** Quick-Toggle aus Notebook-Toolbar — patcht nur entities_enabled,
 *  ohne dass der ganze Settings-Body uebertragen werden muss. */
router.put('/:book_id/entities-enabled', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;
  const enabled = req.body?.enabled ? 1 : 0;
  setBookEntitiesEnabled(bookId, enabled);
  res.json({ ok: true, entities_enabled: enabled });
});

/** Quick-Toggle „fertig" aus der Regal-Karte („Meine Buecher") — patcht nur
 *  is_finished, ohne dass der ganze Settings-Body uebertragen werden muss
 *  (Muster entities-enabled). Der 0→1-Uebergang haelt dieselbe Auto-Fassung
 *  fest wie das Formular; die Logik darf hier nicht abweichen, sonst haengt
 *  der Publikations-Meilenstein davon ab, WO geklickt wurde. */
router.put('/:book_id/finished', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;
  const finished = req.body?.is_finished ? 1 : 0;
  const wasFinished = getBookSettings(bookId, sessionEmail(req))?.is_finished ? 1 : 0;
  setBookIsFinished(bookId, finished);
  if (finished && !wasFinished) {
    captureSnapshot(bookId, req, {
      kind: 'auto_finish', label: AUTO_FINISH_LABEL, dedup: true, userEmail: sessionEmail(req),
    }).catch((e) => logger.warn(`Auto-Fassung beim Fertig-Markieren fehlgeschlagen (book=${bookId}): ${e.message}`));
  }
  res.json({ ok: true, is_finished: finished });
});

/** Quellenverzeichnis-Einstellungen (Quellen-Tab). Eigener Endpunkt statt
 *  weiterer Felder im Haupt-Body: der Tab speichert unabhaengig, und der
 *  Zitierstil gilt buchweit fuer ALLE Ausgabewege (PDF, DOCX, WordPress,
 *  HubSpot) — er gehoert deshalb nicht in ein Exportprofil. */
router.put('/:book_id/citation', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;
  const b = req.body || {};

  if (b.citation_style !== undefined && !VALID_CITATION_STYLES.includes(b.citation_style)) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'citation_style', allowed: VALID_CITATION_STYLES.join(', ') } });
  }
  if (b.bibliography_scope !== undefined && !VALID_BIBLIOGRAPHY_SCOPES.includes(b.bibliography_scope)) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'bibliography_scope', allowed: VALID_BIBLIOGRAPHY_SCOPES.join(', ') } });
  }
  if (b.citation_notes !== undefined && !VALID_CITATION_NOTES.includes(b.citation_notes)) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'citation_notes', allowed: VALID_CITATION_NOTES.join(', ') } });
  }
  if (b.bibliography_title && String(b.bibliography_title).length > BIBLIOGRAPHY_TITLE_MAX) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'bibliography_title', allowed: `max ${BIBLIOGRAPHY_TITLE_MAX}` } });
  }

  // Vorwerte als Basis: der Tab darf einzelne Felder patchen, ohne die uebrigen
  // auf ihren Default zurueckzusetzen.
  const cur = getBookSettings(bookId, sessionEmail(req));
  setBookCitationSettings(bookId, {
    citation_style:       b.citation_style       !== undefined ? b.citation_style       : cur.citation_style,
    bibliography_enabled: b.bibliography_enabled !== undefined ? b.bibliography_enabled : cur.bibliography_enabled,
    bibliography_title:   b.bibliography_title   !== undefined ? b.bibliography_title   : cur.bibliography_title,
    bibliography_scope:   b.bibliography_scope   !== undefined ? b.bibliography_scope   : cur.bibliography_scope,
    bibliography_in_blog: b.bibliography_in_blog !== undefined ? b.bibliography_in_blog : cur.bibliography_in_blog,
    citation_notes:       b.citation_notes       !== undefined ? b.citation_notes       : cur.citation_notes,
  });

  const next = getBookSettings(bookId, sessionEmail(req));
  logger.info(`[quellen] settings book=${bookId} stil=${next.citation_style} verzeichnis=${next.bibliography_enabled} scope=${next.bibliography_scope} blog=${next.bibliography_in_blog} noten=${next.citation_notes}`);
  res.json({
    ok: true,
    citation_style: next.citation_style,
    bibliography_enabled: next.bibliography_enabled,
    bibliography_title: next.bibliography_title,
    bibliography_scope: next.bibliography_scope,
    bibliography_in_blog: next.bibliography_in_blog,
    citation_notes: next.citation_notes,
  });
});

/** Querverweis-Einstellungen. Eigener Endpunkt aus demselben Grund wie
 *  /citation: ob ein Werk seine Abbildungen und Tabellen nummeriert, gilt buchweit
 *  fuer alle Ausgabewege und gehoert deshalb nicht in ein Exportprofil. */
router.put('/:book_id/xrefs', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;
  const b = req.body || {};
  const cur = getBookSettings(bookId, sessionEmail(req));

  // Teil-PUT: nicht uebergebene Felder behalten ihren Stand. Abbildungen und
  // Tabellen haben getrennte Schalter — ein Werk kann Tabellen nummerieren und
  // Abbildungen nicht.
  setBookXrefSettings(bookId, {
    figure_numbering: b.figure_numbering !== undefined ? b.figure_numbering : cur.figure_numbering,
    table_numbering: b.table_numbering !== undefined ? b.table_numbering : cur.table_numbering,
  });

  const next = getBookSettings(bookId, sessionEmail(req));
  logger.info(`[querverweise] settings book=${bookId} abbNummerierung=${next.figure_numbering} tabNummerierung=${next.table_numbering}`);
  res.json({ ok: true, figure_numbering: next.figure_numbering, table_numbering: next.table_numbering });
});

/** Vorherrschende Textsorte des Buchs (journalistische Projekte). Default fuer
 *  jede Seite ohne eigenen Override — den setzt `PUT /textsorte/page/:page_id`.
 *  Eigener Endpunkt wie /citation und /xrefs. */
router.put('/:book_id/textsorte', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;
  // Gleiches Gate wie `PUT /textsorte/page/:page_id`: ausserhalb eines
  // publizistischen Buchs gibt es keine Textsorte, und ein hier gesetzter Default
  // laege still neben jedem Abschnitt.
  if (!journalisticBookSettings(req, bookId)) {
    return res.status(400).json({ error_code: 'NOT_JOURNALISTIC_BOOK' });
  }
  const raw = req.body?.textsorte;
  const value = raw == null || raw === '' ? null : String(raw);
  if (value !== null && !isValidTextsorte(value)) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'textsorte' } });
  }
  setBookTextsorte(bookId, value);
  logger.info(`[textsorte] book=${bookId} default=${value || '–'}`);
  res.json({ ok: true, textsorte: value });
});

/** Recherche-Profil des Buchs: Freitext-Steuerung + Domain-Eingrenzung fuer den
 *  Recherche-Chat. Eigener Endpunkt wie /citation, /xrefs und /textsorte.
 *
 *  Teil-PUT: ein nicht uebergebenes Feld behaelt seinen Stand — der Freitext und
 *  die Domainliste werden in der Oberflaeche zwar zusammen bearbeitet, sind aber
 *  zwei unabhaengige Aussagen.
 *
 *  Die Antwort traegt den NORMALISIERTEN Stand (Domains als Array): die
 *  Oberflaeche muss zeigen, was wirklich gespeichert wurde — eine eingetippte
 *  ganze URL wird zum Host, eine unbrauchbare Zeile faellt weg, und das darf der
 *  User nicht erst beim naechsten Laden merken. */
router.put('/:book_id/research', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;
  const b = req.body || {};
  const cur = getBookSettings(bookId, sessionEmail(req));

  const saved = setBookResearchSettings(bookId, {
    research_profile: b.research_profile !== undefined ? b.research_profile : cur.research_profile,
    research_domains: b.research_domains !== undefined ? b.research_domains : cur.research_domains,
  });

  logger.info(`[recherche-profil] book=${bookId} profilZeichen=${(saved.research_profile || '').length} domains=${saved.research_domains.length}`);
  res.json({ ok: true, ...saved });
});

const HANDLUNGSJAHR_MIN = 1000, HANDLUNGSJAHR_MAX = 2999;

/** Schulsystem des Buchs (Schullaufbahn der Figuren, docs/figur-lebenslauf.md).
 *  Eigener Endpunkt wie /research. `schulsystem: null` entfernt es, ein fehlender
 *  Key laesst es stehen. Normalisiert
 *  wird ausschliesslich über die Rechenschicht (school-path.js, ESM-Bridge) — die
 *  Antwort trägt den gespeicherten Stand, damit die Oberfläche geklemmte Werte
 *  sofort sieht. Eine unbekannte Vorlage ist ein 400, kein stilles null. */
router.put('/:book_id/schulsystem', aclParamGuard('editor'), jsonBody, async (req, res) => {
  const bookId = req.bookId;
  // Teil-PUT wie handlungsjahr: fehlt der Key, bleibt das Schulsystem stehen;
  // nur ein explizites `null` entfernt es.
  const hasSys = Object.prototype.hasOwnProperty.call(req.body || {}, 'schulsystem');
  const raw = hasSys ? (req.body.schulsystem ?? null) : null;
  const { normalizeSchulsystem, SCHUL_VORLAGE_KEYS } = await schoolPath();
  const value = raw == null ? null : normalizeSchulsystem(raw);
  if (raw != null && !value) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'schulsystem', allowed: SCHUL_VORLAGE_KEYS.join(', ') } });
  }
  // Handlungsjahr reist optional mit (gleicher Abschnitt, gleicher Speichern-Knopf);
  // fehlt der Key, bleibt es unberührt.
  const hasJahr = Object.prototype.hasOwnProperty.call(req.body || {}, 'handlungsjahr');
  let jahr = null;
  if (hasJahr && req.body.handlungsjahr != null && req.body.handlungsjahr !== '') {
    jahr = Number(req.body.handlungsjahr);
    if (!Number.isInteger(jahr) || jahr < HANDLUNGSJAHR_MIN || jahr > HANDLUNGSJAHR_MAX) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'handlungsjahr', allowed: `${HANDLUNGSJAHR_MIN}–${HANDLUNGSJAHR_MAX}` } });
    }
  }
  if (hasSys) setBookSchulsystem(bookId, value);
  if (hasJahr) setBookHandlungsjahr(bookId, jahr);
  const stored = getBookSchulsystem(bookId);
  logger.info(`[schulsystem] book=${bookId} vorlage=${stored?.vorlage || '–'} standardWeg=${stored?.standard_weg || '–'}${hasJahr ? ` handlungsjahr=${jahr ?? '–'}` : ''}`);
  res.json({ ok: true, schulsystem: stored, handlungsjahr: getBookHandlungsjahr(bookId) });
});

module.exports = router;
