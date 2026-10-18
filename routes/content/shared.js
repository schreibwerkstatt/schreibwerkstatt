'use strict';
// Geteilte HTTP-Helfer der Content-Routes (books/chapters/pages/assets):
// User-/Client-Labels, ACL-Guards (Page/Chapter → Buch), Fehler-Mapping,
// Body-Parser + Validierungs-Konstanten.

const express = require('express');
const logger = require('../../logger');
const { resolvePageBookId, resolveChapterBookId } = require('../../lib/content-ownership');
const { guardBook, sessionEmail } = require('../../lib/acl');
const deviceTokens = require('../../db/device-tokens');
const { BOOK_NAME_MAX } = require('../../lib/book-create');

const jsonBody = express.json({ limit: '10mb' });

// Die Lese-Endpunkte, deren Abweichung der Service Worker an die Tabs meldet
// (Buchliste, Baum, Abschnitt — public/sw.js#CONTENT_NOTIFY_REGEX), antworten
// konditional.
//
// WARUM: Der SW liefert sie als Stale-While-Revalidate aus und vergleicht die
// Revalidierung mit dem ausgelieferten Cache-Stand, um einen leisen Nachzug
// auszuloesen (public/sw.js#_samePayload). Mit ETag entscheidet dort ein
// Header-Vergleich statt eines Textvergleichs ueber den ganzen Body — und im
// Regelfall (unveraendert) beantwortet schon der HTTP-Cache des Browsers die
// Revalidierung mit 304, also ohne ein einziges Byte Nutzlast. Der ETag kommt
// von Express selbst (`etag: true`, schwach ueber den Body), ebenso der 304 —
// hier fehlt nur die Erlaubnis, die Antwort ueberhaupt zu speichern.
//
// `max-age=0, must-revalidate` und NICHT `no-cache`: beides zwingt zur
// Revalidierung, aber `no-cache` liest der SW als „diese Antwort darf nicht
// stale ausgeliefert werden" (_forbidsStale) und schaltet den Pfad auf
// Netz-zuerst um. Das waere das Gegenteil des Gewollten — Sidebar und Abschnitt
// sollen sofort stehen und offline ueberhaupt.
// `private`, weil die Antworten user-skopiert sind (Rolle, Regal-Zustand,
// eigenes Geraet als letzter Bearbeiter).
const REVALIDATE_CACHE_CONTROL = 'private, max-age=0, must-revalidate';
// Namensdeckel der Gliederung (Buch, Kapitel, Abschnitt): eine Quelle, lib/book-create.js.
const NAME_MAX = BOOK_NAME_MAX;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function _validDeviceId(s) { return typeof s === 'string' && UUID_RE.test(s); }
// Client-gelieferte Diagnose-Kennung (Tab-ID, Save-Weg) für eine Logzeile:
// nur [A-Za-z0-9_-], gedeckelt — sonst könnte der Body Zeilenumbrüche ins Log
// schreiben.
function _logToken(s) { return typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : '-'; }
// Zeitstempel aus dem Request-Body (ISO-8601) fuer Log-Zeilen — alles andere
// wird '-', damit ein Client keine Zeilenumbrueche ins Log schreiben kann.
function _logStamp(s) { return typeof s === 'string' && /^[0-9T:.Z+-]{10,32}$/.test(s) ? s : '-'; }


// Beschreibt den anfragenden Client fuer Logs. Bei Device-Token-Auth (nativer
// Mac-Client) loest es Geraetename + Plattform aus dem Token auf, sonst "session".
function _clientLabel(req) {
  const u = req.session?.user;
  if (u?.via !== 'device_token') return 'session';
  try {
    const dev = deviceTokens.getDeviceTokenById(u.tokenId);
    if (dev) return `device "${dev.device_name}"${dev.platform ? ` ${dev.platform}` : ''}`;
  } catch { /* Lookup-Fehler nie den Bundle-Download blockieren lassen */ }
  return 'device';
}

// Echter Geraetename aus dem Device-Token (nativer Client), fuer das
// app_users_devices.label → „Zuletzt bearbeitet auf <Geraet>"-Hint. Browser
// (Session-Auth) liefern null → upsertDevice faellt auf das UA-Label zurueck.
function _deviceTokenLabel(req) {
  const u = req.session?.user;
  if (u?.via !== 'device_token' || !u.tokenId) return null;
  try {
    const dev = deviceTokens.getDeviceTokenById(u.tokenId);
    return dev?.device_name?.trim() || null;
  } catch { return null; }
}

function _guardPage(req, res, pageId, minRole) {
  const bookId = resolvePageBookId(pageId);
  if (!bookId) { res.status(404).json({ error_code: 'PAGE_NOT_FOUND' }); return null; }
  return guardBook(req, res, bookId, minRole) ? bookId : null;
}

function _guardChapter(req, res, chapterId, minRole) {
  const bookId = resolveChapterBookId(chapterId);
  if (!bookId) { res.status(404).json({ error_code: 'CHAPTER_NOT_FOUND' }); return null; }
  return guardBook(req, res, bookId, minRole) ? bookId : null;
}

function _fail(res, e, opName) {
  const status = e?.status || 500;
  const bodySnippet = e?.bodyText ? ' | body: ' + String(e.bodyText).slice(0, 200) : '';
  logger.warn(`${opName} fehlgeschlagen: ${e.message}${bodySnippet}`);
  res.status(status === 401 ? 502 : status).json({
    error_code: 'CONTENT_FAILED',
    status,
    detail: e.message,
  });
}

// Fail-closed-Sanitizer des Content-Stores (lib/content-store/backends/localdb.js
// #_cleanHtmlSafe): eigener error_code statt CONTENT_FAILED, damit der Client
// `t('error.HTML_SANITIZE_FAILED')` zeigt. true = Antwort ist raus.
function _sendSanitizeFailed(res, e) {
  if (e?.code !== 'HTML_SANITIZE_FAILED') return false;
  res.status(422).json({ error_code: 'HTML_SANITIZE_FAILED' });
  return true;
}

module.exports = {
  jsonBody, NAME_MAX, UUID_RE, REVALIDATE_CACHE_CONTROL, _validDeviceId, _logToken, _logStamp,
  _clientLabel, _deviceTokenLabel,
  _guardPage, _guardChapter, _fail, _sendSanitizeFailed,
};
