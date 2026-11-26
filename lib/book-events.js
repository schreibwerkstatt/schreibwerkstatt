'use strict';
const { EventEmitter } = require('events');

// Prozess-interner Bus für Änderungen an einem Buch. Einzige Quelle für den
// Buch-Kanal des Event-Streams (routes/events/book-channel.js).
//
// Die Events sind ANSTÖSSE, keine Daten: der Client holt nach einem Anstoss
// selbst `/changes` bzw. `/presence`. So bleiben Self-Filter, Geräte-Label-Scope
// und ACL an genau der Stelle, an der sie heute schon gelten, und ein Event
// braucht keine empfängerabhängige Form.
//
// 'change' (bookId, origin): Seiteninhalt oder -bestand geändert. Gefeuert
//   ausschliesslich aus den Schreibpfaden der Content-Store-Facade
//   (savePage/createPage/deletePage/movePage).
// 'presence' (bookId, origin): ein Gerät ist am Buch/an einer Seite neu
//   aufgetaucht oder hat sich abgemeldet. Gefeuert aus db/book-presence.js und
//   db/page-presence.js — nur bei Zustandswechsel, nicht bei jedem Heartbeat.
// 'meta' (bookId, kind, origin): buchbezogene Daten ausserhalb des Manuskripts
//   geändert — Ideen, Bearbeitungsstand, Recherche, Plot, Share-Links,
//   Kommentare, Katalog-Einträge … (`kind` = Bereich, Liste in
//   lib/live-writes.js). Gefeuert von der Middleware lib/live-writes.js für
//   jeden erfolgreichen Schreib-Request mit Buch-Kontext, plus explizit für
//   Share-Link-Kommentare (routes/share/*). origin = { tabId }: der auslösende
//   Browser-Tab (Header X-Tab-Id) bekommt sein eigenes Echo nicht; ohne Tab
//   (Leser im Share-Reader, native Clients, Jobs) erreicht die Meldung alle.
//
// origin = { email, deviceId } des Auslösers; der Kanal filtert damit das Echo
// des eigenen Geräts aus (gleiche Regel wie der Self-Filter von /changes).
const { getContext } = require('./log-context');

const bus = new EventEmitter();
bus.setMaxListeners(0); // ein Listener-Paar pro offenem Stream

function _origin(email, deviceId) {
  return { email: email || null, deviceId: deviceId || null };
}

function emitBookChange(bookId, email, deviceId) {
  if (bookId) bus.emit('change', Number(bookId), _origin(email, deviceId));
}

function emitBookPresence(bookId, email, deviceId) {
  if (bookId) bus.emit('presence', Number(bookId), _origin(email, deviceId));
}

// Tab-ID des auslösenden Requests liegt im ALS-Kontext (lib/live-writes.js).
function emitBookMeta(bookId, kind) {
  if (bookId && kind) bus.emit('meta', Number(bookId), String(kind), { tabId: getContext().tabId || null });
}

module.exports = { bus, emitBookChange, emitBookPresence, emitBookMeta };
