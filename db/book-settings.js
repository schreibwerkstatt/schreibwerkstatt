'use strict';
// Buch-Einstellungen (`book_settings`): Sprache/Region, Buchtyp + Freitext,
// Erzaehlform, Ziele, Quellen-/Querverweis-Einstellungen, Textsorte, Stilprofil.

const { db } = require('./connection');
const { parseDomains, serializeDomains, normalizeProfile } = require('../lib/research-profile');
const { normalizeIdeeStages, serializeIdeeStages } = require('../lib/ideen-status');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');


// Quellenverzeichnis-Defaults: einmal deklariert, von Row-Mapping und beiden
// Fallback-Pfaden in getBookSettings geteilt. Die Werte spiegeln die
// Spalten-Defaults aus Migration 252 — driften sie auseinander, sieht ein Buch
// ohne book_settings-Zeile andere Einstellungen als eines mit.
const CITATION_DEFAULTS = Object.freeze({
  citation_style: 'apa7',
  citation_notes: 'inline',
  bibliography_enabled: 0,
  bibliography_title: null,
  bibliography_scope: 'cited',
  bibliography_in_blog: 0,
});
const VALID_CITATION_STYLES = ['apa7', 'chicago-ad', 'numeric'];
// Deckungsgleich mit CITATION_NOTES_MODES in lib/endnotes.js — laufen die
// auseinander, faellt der Schreibpfad stumm auf 'inline' zurueck.
const VALID_CITATION_NOTES = ['inline', 'endnotes', 'footnotes'];
const VALID_BIBLIOGRAPHY_SCOPES = ['cited', 'all'];

// Querverweis-Defaults (Migration 255). Steht aus demselben Grund in
// book_settings wie der Zitierstil: ob ein Werk seine Abbildungen nummeriert,
// gilt fuer ALLE Ausgabewege gleichzeitig und darf nicht je Exportprofil
// abweichen. Default 0 — ein Roman mit Bildern will keine „Abb. 1:"-Praefixe.
const XREF_DEFAULTS = Object.freeze({
  figure_numbering: 0,
  table_numbering: 0,
});

// Recherche-Profil (Migration 289). `research_domains` verlaesst die DB immer
// als ARRAY, nie als Rohtext — gespeichert wird zeilenweise, gelesen wird
// geparst; sonst haette jeder Konsument seine eigene Trennlogik.
const RESEARCH_DEFAULTS = Object.freeze({
  research_profile: null,
  research_domains: [],
});

const _getBookSettings = db.prepare('SELECT language, region, buchtyp, buch_kontext, stilprofil, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat, daily_goal_chars, goal_target_chars, goal_deadline, entities_enabled, orte_real, schauplatz_land, zeitlinie_real, weltfakten_real_pruefen, exclude_from_stats, citation_style, bibliography_enabled, bibliography_title, bibliography_scope, bibliography_in_blog, citation_notes, figure_numbering, table_numbering, textsorte, research_profile, research_domains, ideen_stages FROM book_settings WHERE book_id = ?');

// Felder, die das Haupt-Formular (PUT /booksettings/:id) und der Bundle-Import
// ueber saveBookSettings schreiben. Alle anderen Spalten haben eigene Setter.
const MAIN_FIELDS = Object.freeze([
  'language', 'region', 'buchtyp', 'buch_kontext', 'stilprofil',
  'erzaehlperspektive', 'erzaehlzeit', 'is_finished', 'allow_lektor_book_chat',
  'daily_goal_chars', 'goal_target_chars', 'goal_deadline',
  'orte_real', 'schauplatz_land', 'zeitlinie_real', 'weltfakten_real_pruefen', 'exclude_from_stats',
]);

// Stand eines Buchs ohne book_settings-Zeile — ohne Sprache/Region/Buchtyp, die
// kommen aus den Defaults des Owners (ownerDefaults). Eine Konstante fuer beide
// Fallback-Pfade, damit sie nicht auseinanderlaufen.
const SETTINGS_DEFAULTS = Object.freeze({
  buch_kontext: null, stilprofil: null, erzaehlperspektive: null, erzaehlzeit: null,
  is_finished: 0, allow_lektor_book_chat: 0,
  daily_goal_chars: null, goal_target_chars: null, goal_deadline: null,
  entities_enabled: 0, orte_real: 0, schauplatz_land: null, zeitlinie_real: 0,
  weltfakten_real_pruefen: 0, exclude_from_stats: 0, textsorte: null,
  ...RESEARCH_DEFAULTS, ...CITATION_DEFAULTS, ...XREF_DEFAULTS,
});

const _upsertBookSettings = db.prepare(`
  INSERT INTO book_settings (book_id, language, region, buchtyp, buch_kontext, stilprofil, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat, daily_goal_chars, goal_target_chars, goal_deadline, orte_real, schauplatz_land, zeitlinie_real, weltfakten_real_pruefen, exclude_from_stats, updated_at)
  VALUES (@book_id, @language, @region, @buchtyp, @buch_kontext, @stilprofil, @erzaehlperspektive, @erzaehlzeit, @is_finished, @allow_lektor_book_chat, @daily_goal_chars, @goal_target_chars, @goal_deadline, @orte_real, @schauplatz_land, @zeitlinie_real, @weltfakten_real_pruefen, @exclude_from_stats, @updated_at)
  ON CONFLICT(book_id) DO UPDATE SET
    language=excluded.language, region=excluded.region,
    buchtyp=excluded.buchtyp, buch_kontext=excluded.buch_kontext,
    stilprofil=excluded.stilprofil,
    erzaehlperspektive=excluded.erzaehlperspektive, erzaehlzeit=excluded.erzaehlzeit,
    is_finished=excluded.is_finished,
    allow_lektor_book_chat=excluded.allow_lektor_book_chat,
    daily_goal_chars=excluded.daily_goal_chars,
    goal_target_chars=excluded.goal_target_chars,
    goal_deadline=excluded.goal_deadline,
    orte_real=excluded.orte_real,
    schauplatz_land=excluded.schauplatz_land,
    zeitlinie_real=excluded.zeitlinie_real,
    weltfakten_real_pruefen=excluded.weltfakten_real_pruefen,
    exclude_from_stats=excluded.exclude_from_stats,
    updated_at=excluded.updated_at
`);

// ── Zeile anlegen ────────────────────────────────────────────────────────────
// Entscheidung: die Zeile entsteht lazy ueber ensureBookSettingsRow, das JEDER
// Schreibpfad dieses Moduls vorher ruft — und zusaetzlich frueh bei der
// Buchanlage (lib/content-store#createBook, mit dem Anleger als Owner-Ersatz,
// weil books.owner_email dort noch nicht gesetzt ist). Keine Migration/kein
// Backfill: ein Altbuch ohne Zeile liest ueber getBookSettings dieselben
// Owner-Defaults, die ensureBookSettingsRow beim ersten Schreiben festschreibt —
// Lesen und Schreiben sehen also denselben Stand, ohne dass ein Backfill die
// heutigen Profil-Defaults in Altbuecher einfriert.
//
// Warum ueberhaupt: ein Teil-Upsert (`INSERT … (book_id, x)`) legte die Zeile mit
// den Spalten-Defaults an (de/CH, Buchtyp NULL) und ueberschrieb so den Fallback
// auf die Profil-Defaults — ein englisches Buch wurde durch einen Schalter im
// Notebook still deutsch.
const _insertBookSettingsRow = db.prepare(`
  INSERT INTO book_settings (book_id, language, region, buchtyp, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(book_id) DO NOTHING
`);

/** Sprache/Region/Buchtyp aus den Profil-Defaults des Buch-Owners.
 *  `fallbackEmail` greift nur, solange das Buch (noch) keinen Owner hat — bei
 *  der Anlage, bevor die Karte den Eigentuemer setzt. Bewusst NICHT der
 *  Anfragende: sonst saehe ein Lektor das Buch eines Autors in seiner eigenen
 *  Sprache. */
function ownerDefaults(bookId, fallbackEmail = null) {
  const { defaultRegionFor } = require('../lib/book-settings-values');
  const owner = require('./book-access').getOwnerEmail(bookId) || fallbackEmail || null;
  const u = owner ? require('./app-users').getUser(owner) : null;
  const language = u?.default_language || 'de';
  return {
    language,
    region: u?.default_region || defaultRegionFor(language),
    buchtyp: u?.default_buchtyp || null,
  };
}

/** Legt die book_settings-Zeile an, falls sie fehlt (Owner-Defaults fuer
 *  Sprache/Region/Buchtyp). Idempotent; eine vorhandene Zeile bleibt unberuehrt. */
function ensureBookSettingsRow(bookId, fallbackEmail = null) {
  const id = parseInt(bookId);
  if (_getBookSettings.get(id)) return;
  const d = ownerDefaults(id, fallbackEmail);
  _insertBookSettingsRow.run(id, d.language, d.region, d.buchtyp, new Date().toISOString());
}

const _updateBookSettingsEntitiesEnabled = db.prepare(`
  INSERT INTO book_settings (book_id, entities_enabled, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    entities_enabled=excluded.entities_enabled,
    updated_at=excluded.updated_at
`);
const _updateBookIsFinished = db.prepare(`
  INSERT INTO book_settings (book_id, is_finished, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    is_finished=excluded.is_finished,
    updated_at=excluded.updated_at
`);
const _updateBookStilprofil = db.prepare(`
  INSERT INTO book_settings (book_id, stilprofil, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    stilprofil=excluded.stilprofil,
    updated_at=excluded.updated_at
`);
// Vorbelegung aus dem Autorenprofil: schreibt NUR, solange das Buch noch kein
// eigenes Stilprofil hat. Der WHERE-Zusatz am DO UPDATE ist der ganze
// Unterschied zu `_updateBookStilprofil` — ohne ihn wuerde eine Vererbung die
// Handarbeit am Buch ueberschreiben, und genau das darf sie nie.
const _seedBookStilprofil = db.prepare(`
  INSERT INTO book_settings (book_id, stilprofil, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    stilprofil=excluded.stilprofil,
    updated_at=excluded.updated_at
  WHERE book_settings.stilprofil IS NULL OR TRIM(book_settings.stilprofil) = ''
`);
// Quellenverzeichnis-Einstellungen als eigener Schreibpfad (Muster
// entities_enabled/stilprofil) statt als weitere MAIN_FIELDS: der Quellen-Tab
// speichert unabhaengig vom Haupt-Formular.
const _updateBookCitationSettings = db.prepare(`
  INSERT INTO book_settings (book_id, citation_style, bibliography_enabled, bibliography_title, bibliography_scope, bibliography_in_blog, citation_notes, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    citation_style=excluded.citation_style,
    bibliography_enabled=excluded.bibliography_enabled,
    bibliography_title=excluded.bibliography_title,
    bibliography_scope=excluded.bibliography_scope,
    bibliography_in_blog=excluded.bibliography_in_blog,
    citation_notes=excluded.citation_notes,
    updated_at=excluded.updated_at
`);
// Querverweis-Einstellungen, eigener Schreibpfad aus demselben Grund.
const _updateBookXrefSettings = db.prepare(`
  INSERT INTO book_settings (book_id, figure_numbering, table_numbering, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    figure_numbering=excluded.figure_numbering,
    table_numbering=excluded.table_numbering,
    updated_at=excluded.updated_at
`);

/** Buchtyp eines Buchs OHNE book_settings-Zeile: der Default-Buchtyp des
 *  Owners (Aufrufer reicht dessen E-Mail). Eigene Funktion, weil die Buchliste
 *  (GET /content/books) den Typ ohne getBookSettings je Buch liest und sonst
 *  einen anderen Typ meldete als Prompts und Buchübersicht. */
function fallbackBuchtyp(ownerEmail) {
  if (!ownerEmail) return null;
  return require('./app-users').getUser(ownerEmail)?.default_buchtyp || null;
}

function _mapRow(row) {
  return {
    ...row,
    is_finished: row.is_finished ? 1 : 0,
    allow_lektor_book_chat: row.allow_lektor_book_chat ? 1 : 0,
    entities_enabled: row.entities_enabled ? 1 : 0,
    orte_real: row.orte_real ? 1 : 0,
    zeitlinie_real: row.zeitlinie_real ? 1 : 0,
    weltfakten_real_pruefen: row.weltfakten_real_pruefen ? 1 : 0,
    exclude_from_stats: row.exclude_from_stats ? 1 : 0,
    citation_style: row.citation_style || CITATION_DEFAULTS.citation_style,
    bibliography_enabled: row.bibliography_enabled ? 1 : 0,
    bibliography_title: row.bibliography_title || null,
    bibliography_scope: row.bibliography_scope || CITATION_DEFAULTS.bibliography_scope,
    bibliography_in_blog: row.bibliography_in_blog ? 1 : 0,
    citation_notes: row.citation_notes || CITATION_DEFAULTS.citation_notes,
    figure_numbering: row.figure_numbering ? 1 : 0,
    table_numbering: row.table_numbering ? 1 : 0,
    textsorte: row.textsorte || null,
    research_profile: row.research_profile || null,
    research_domains: parseDomains(row.research_domains),
    ideen_stages: normalizeIdeeStages(row.ideen_stages),
  };
}

/** Alle Buch-Einstellungen. Fehlt die book_settings-Zeile, gelten fuer
 *  Sprache/Region/Buchtyp die Profil-Defaults des Buch-Owners (ownerDefaults),
 *  alles andere aus SETTINGS_DEFAULTS. `fallbackEmail` wird nur gelesen, wenn das
 *  Buch keinen Owner hat (Anlage-Phase) — Aufrufer duerfen die Session-E-Mail
 *  weiter mitgeben, sie bestimmt das Ergebnis aber nicht mehr.
 *  `daily_goal_chars`: NULL = nicht gesetzt (Frontend mappt auf 1500), 0 = kein Tagesziel. */
function getBookSettings(bookId, fallbackEmail = null) {
  const row = _getBookSettings.get(parseInt(bookId));
  if (row) return _mapRow(row);
  return {
    ...ownerDefaults(bookId, fallbackEmail),
    ...SETTINGS_DEFAULTS,
    research_domains: [],
    ideen_stages: normalizeIdeeStages(null),
  };
}

/** Locale-Key für ein Buch: z.B. "de-CH", "en-US". */
function getBookLocale(bookId, fallbackEmail = null) {
  const { language, region } = getBookSettings(bookId, fallbackEmail);
  return `${language}-${region}`;
}

/** Speichert die Felder des Haupt-Formulars (MAIN_FIELDS) als Teil-Update:
 *  ein Key, der in `patch` fehlt (oder `undefined` ist), behaelt den
 *  gespeicherten Wert; `null`/'' loescht ihn (bzw. setzt den Schalter auf 0).
 *  Validierung ist Sache des Aufrufers — hier wird nur normalisiert.
 *  `entities_enabled` und die Tab-Einstellungen (Quellen, Querverweise, …)
 *  laufen ueber ihre eigenen Setter. Gibt den gespeicherten Stand zurueck. */
function saveBookSettings(bookId, patch = {}) {
  const id = parseInt(bookId);
  ensureBookSettingsRow(id);
  const cur = getBookSettings(id);
  const v = (k) => (patch[k] !== undefined ? patch[k] : cur[k]);
  const str = (x) => (x == null || x === '' ? null : String(x));
  const int = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Math.round(Number(x)));
  const bit = (x) => (x ? 1 : 0);
  const language = str(v('language')) || cur.language;
  _upsertBookSettings.run({
    book_id: id,
    language,
    region: str(v('region')) || cur.region,
    buchtyp: str(v('buchtyp')),
    buch_kontext: str(v('buch_kontext')),
    stilprofil: str(v('stilprofil')),
    erzaehlperspektive: str(v('erzaehlperspektive')),
    erzaehlzeit: str(v('erzaehlzeit')),
    is_finished: bit(v('is_finished')),
    allow_lektor_book_chat: bit(v('allow_lektor_book_chat')),
    daily_goal_chars: int(v('daily_goal_chars')),
    goal_target_chars: int(v('goal_target_chars')),
    goal_deadline: str(v('goal_deadline')),
    orte_real: bit(v('orte_real')),
    schauplatz_land: str(v('schauplatz_land')),
    zeitlinie_real: bit(v('zeitlinie_real')),
    weltfakten_real_pruefen: bit(v('weltfakten_real_pruefen')),
    exclude_from_stats: bit(v('exclude_from_stats')),
    updated_at: new Date().toISOString(),
  });
  return getBookSettings(id);
}

/** Toggle aus Notebook-Toolbar — Quick-Update nur fuer entities_enabled,
 *  ohne andere Settings anzufassen (Toolbar-Toggle laedt Form nicht). */
function setBookEntitiesEnabled(bookId, enabled) {
  ensureBookSettingsRow(bookId);
  _updateBookSettingsEntitiesEnabled.run(
    parseInt(bookId),
    enabled ? 1 : 0,
    new Date().toISOString()
  );
}

// Default-Textsorte des Buchs. Eigener Setter, gesetzt ueber PUT /:id/textsorte.
const _updateBookTextsorte = db.prepare(
  'UPDATE book_settings SET textsorte = ?, updated_at = ? WHERE book_id = ?',
);
// Buchtyp allein setzen (Ordner-Import legt ein Tagebuch an). Sprache/Region
// der neuen Zeile kommen aus denselben Owner-Defaults wie bei getBookSettings
// (`userEmail` = Anleger, solange das Buch noch keinen Owner hat), damit die
// Monatsnamen der Kapitel und die Buch-Locale übereinstimmen.
const _updateBookBuchtyp = db.prepare(
  'UPDATE book_settings SET buchtyp = ?, updated_at = ? WHERE book_id = ?',
);
function setBookBuchtyp(bookId, buchtyp, userEmail = null) {
  ensureBookSettingsRow(bookId, userEmail);
  _updateBookBuchtyp.run(buchtyp || null, new Date().toISOString(), parseInt(bookId));
}

function setBookTextsorte(bookId, textsorte) {
  const value = textsorte == null || textsorte === '' ? null : String(textsorte);
  // Zeile zuerst sicherstellen: ein reines UPDATE traefe ohne Zeile nichts, und
  // die Route meldete trotzdem ok. Die Route laesst nur publizistische Buecher
  // durch (Buchtyp aus Zeile oder Owner-Default), die neue Zeile traegt also
  // denselben Buchtyp, unter dem die Textsorte gilt.
  ensureBookSettingsRow(bookId);
  _updateBookTextsorte.run(value, new Date().toISOString(), parseInt(bookId));
  return value;
}

/** Quellenverzeichnis-Einstellungen pro Buch (Quellen-Tab der Bucheinstellungen).
 *  Eigener Schreibpfad — beruehrt keine anderen Settings. Enum-Werte werden hier
 *  hart auf die Whitelist gezwungen, damit ein Fremdwert nie in der DB landet
 *  (der Formatter kennt nur diese Stile und wuerde sonst still auf apa7 fallen). */
function setBookCitationSettings(bookId, {
  citation_style, bibliography_enabled, bibliography_title, bibliography_scope, bibliography_in_blog,
  citation_notes,
} = {}) {
  ensureBookSettingsRow(bookId);
  const style = VALID_CITATION_STYLES.includes(citation_style)
    ? citation_style : CITATION_DEFAULTS.citation_style;
  const scope = VALID_BIBLIOGRAPHY_SCOPES.includes(bibliography_scope)
    ? bibliography_scope : CITATION_DEFAULTS.bibliography_scope;
  const title = bibliography_title ? String(bibliography_title).trim().slice(0, 200) : null;
  _updateBookCitationSettings.run(
    parseInt(bookId), style,
    bibliography_enabled ? 1 : 0,
    title || null, scope,
    bibliography_in_blog ? 1 : 0,
    VALID_CITATION_NOTES.includes(citation_notes) ? citation_notes : CITATION_DEFAULTS.citation_notes,
    new Date().toISOString(),
  );
}

// Recherche-Profil, eigener Schreibpfad aus demselben Grund wie /citation und
// /xrefs: es steuert nur den Recherche-Chat.
const _updateBookResearchSettings = db.prepare(`
  INSERT INTO book_settings (book_id, research_profile, research_domains, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    research_profile=excluded.research_profile,
    research_domains=excluded.research_domains,
    updated_at=excluded.updated_at
`);

/** Recherche-Profil eines Buchs (Freitext + Domain-Eingrenzung). Normalisiert
 *  ueber lib/research-profile.js — ein Fremdwert landet nie in der Spalte, und
 *  `allowed_domains` bekommt nur, was auch ein Hostname ist.
 *  Gibt den gespeicherten Stand zurueck (Domains als Array). */
function setBookResearchSettings(bookId, { research_profile, research_domains } = {}) {
  ensureBookSettingsRow(bookId);
  const profile = normalizeProfile(research_profile);
  const domains = serializeDomains(research_domains);
  _updateBookResearchSettings.run(
    parseInt(bookId), profile, domains, new Date().toISOString(),
  );
  return { research_profile: profile, research_domains: parseDomains(domains) };
}

// Ideen-Stufen, eigener Schreibpfad aus demselben Grund wie /xrefs.
const _updateBookIdeenStages = db.prepare(`
  INSERT INTO book_settings (book_id, ideen_stages, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    ideen_stages=excluded.ideen_stages,
    updated_at=excluded.updated_at
`);

/** Aktive Ideen-Stufen eines Buchs (docs/ideen-board.md). Normalisiert ueber
 *  lib/ideen-status.js — `offen`/`erledigt` kommen immer dazu, Unbekanntes
 *  faellt weg. Gibt die gespeicherte Liste zurueck. */
function setBookIdeenStages(bookId, stages) {
  ensureBookSettingsRow(bookId);
  const value = serializeIdeeStages(Array.isArray(stages) ? stages : []);
  _updateBookIdeenStages.run(parseInt(bookId), value, new Date().toISOString());
  return normalizeIdeeStages(value);
}

/** Aktive Ideen-Stufen eines Buchs (NULL/keine Zeile = alle). */
const _getBookIdeenStages = db.prepare('SELECT ideen_stages FROM book_settings WHERE book_id = ?');
function getBookIdeenStages(bookId) {
  const row = _getBookIdeenStages.get(parseInt(bookId));
  return normalizeIdeeStages(row ? row.ideen_stages : null);
}

// Schulsystem des Buchs (Migration 345, docs/figur-lebenslauf.md «Schullaufbahn»).
// Eigener Schreibpfad wie /research. Gespeichert wird die bereits normalisierte
// Form (public/js/book/school-path.js#normalizeSchulsystem, im Route-Handler über
// die ESM-Bridge) — dieses Modul kennt die Vorlagen nicht und validiert nicht
// ein zweites Mal.
const _getBookSchulsystem = db.prepare('SELECT schulsystem_json FROM book_settings WHERE book_id = ?');
const _updateBookSchulsystem = db.prepare(`
  INSERT INTO book_settings (book_id, schulsystem_json, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    schulsystem_json=excluded.schulsystem_json,
    updated_at=excluded.updated_at
`);

/** Gespeichertes Schulsystem (Objekt) oder null. Rohform — Konsumenten rechnen
 *  über school-path.js#resolveSchulsystem, das ohnehin normalisiert. */
function getBookSchulsystem(bookId) {
  const row = _getBookSchulsystem.get(parseInt(bookId));
  if (!row?.schulsystem_json) return null;
  try { return JSON.parse(row.schulsystem_json); } catch { return null; }
}

/** Schulsystem setzen (normalisierte Form) oder mit null entfernen. */
function setBookSchulsystem(bookId, schulsystem) {
  ensureBookSettingsRow(bookId);
  _updateBookSchulsystem.run(
    parseInt(bookId), schulsystem ? JSON.stringify(schulsystem) : null, new Date().toISOString(),
  );
}

// Handlungsjahr (Migration 346): Jahr, in dem die Handlung (überwiegend) spielt.
// Angabe des Autors, NULL = keine. Geschrieben mit dem Schulsystem
// (PUT /booksettings/:id/schulsystem), gelesen von Steckbrief und Lebenslauf.
const _getBookHandlungsjahr = db.prepare('SELECT handlungsjahr FROM book_settings WHERE book_id = ?');
const _updateBookHandlungsjahr = db.prepare(`
  INSERT INTO book_settings (book_id, handlungsjahr, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    handlungsjahr=excluded.handlungsjahr,
    updated_at=excluded.updated_at
`);

function getBookHandlungsjahr(bookId) {
  const v = _getBookHandlungsjahr.get(parseInt(bookId))?.handlungsjahr;
  return Number.isInteger(v) ? v : null;
}

function setBookHandlungsjahr(bookId, jahr) {
  ensureBookSettingsRow(bookId);
  _updateBookHandlungsjahr.run(parseInt(bookId), Number.isInteger(jahr) ? jahr : null, new Date().toISOString());
}

/** Querverweis-Einstellungen pro Buch. Eigener Schreibpfad — beruehrt keine
 *  anderen Settings. */
function setBookXrefSettings(bookId, { figure_numbering, table_numbering } = {}) {
  ensureBookSettingsRow(bookId);
  _updateBookXrefSettings.run(
    parseInt(bookId),
    figure_numbering ? 1 : 0,
    table_numbering ? 1 : 0,
    new Date().toISOString(),
  );
}

/** Quick-Update nur fuer is_finished — Regal-Karte („Meine Buecher") schaltet
 *  den Fertig-Status ohne das ganze Settings-Formular. `is_finished` bleibt
 *  damit EIN Schalter: er gilt buchweit und geht in die Prompts, ein zweiter
 *  pro User wuerde diese Aussage zerteilen. */
function setBookIsFinished(bookId, isFinished) {
  ensureBookSettingsRow(bookId);
  _updateBookIsFinished.run(
    parseInt(bookId),
    isFinished ? 1 : 0,
    new Date().toISOString()
  );
}

/** Quick-Update nur fuer stilprofil — der Stilprofil-Extraktions-Job persistiert
 *  sein Ergebnis, ohne die uebrigen Settings (die er nicht geladen hat) zu beruehren. */
function setBookStilprofil(bookId, stilprofil) {
  ensureBookSettingsRow(bookId);
  _updateBookStilprofil.run(
    parseInt(bookId),
    stilprofil || null,
    new Date().toISOString()
  );
}

/**
 * Stilprofil eines Buchs aus dem Autorenprofil vorbelegen.
 *
 * Kopie, keine Verknuepfung — dieselbe Entscheidung wie beim geerbten KI-Profil
 * eines eingeladenen Kontos: ein spaeter geaendertes Autorenprofil zieht das Buch
 * NICHT mit, sonst wechselte die Stimme eines laufenden Manuskripts ohne Anlass.
 *
 * Schreibt nur in eine leere Stelle. Gibt `true` zurueck, wenn vorbelegt wurde.
 */
function seedBookStilprofil(bookId, stilprofil, authorEmail = null) {
  const text = (stilprofil || '').trim();
  if (!text) return false;
  // Anlage-Phase: books.owner_email ist noch leer → der Autor steht fuer den Owner.
  ensureBookSettingsRow(bookId, authorEmail);
  return _seedBookStilprofil.run(parseInt(bookId), text, new Date().toISOString()).changes > 0;
}

module.exports = {
  getBookSettings,
  ensureBookSettingsRow,
  MAIN_FIELDS,
  fallbackBuchtyp,
  seedBookStilprofil,
  getBookLocale,
  saveBookSettings,
  setBookEntitiesEnabled,
  setBookIsFinished,
  setBookStilprofil,
  setBookTextsorte,
  setBookBuchtyp,
  setBookCitationSettings,
  setBookResearchSettings,
  setBookXrefSettings,
  setBookIdeenStages,
  getBookIdeenStages,
  getBookSchulsystem,
  setBookSchulsystem,
  getBookHandlungsjahr,
  setBookHandlungsjahr,
  VALID_CITATION_STYLES,
  VALID_CITATION_NOTES,
  VALID_BIBLIOGRAPHY_SCOPES,
};
