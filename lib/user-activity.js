'use strict';
// Aktive Zeit pro (User, Tag) → `user_activity`.
//
// Gezählt wird die Lücke zwischen zwei Aktivitäts-Signalen DESSELBEN USERS,
// solange sie unter ACTIVITY_GAP_MS liegt. Zwei Invarianten:
//
// A) Pro User, nicht pro Session. Jedes Gerät und jeder Tab hat eine eigene
//    Session; pro Session gezählt, summieren drei offene Geräte dieselbe
//    Wall-Clock dreifach (Tage mit 45 h). Der Zeitstempel liegt darum in einer
//    prozesslokalen Map über die E-Mail.
// B) Nur bewusste Nutzung zählt. Ein offener Tab pollt Jobs, Presence und
//    Event-Stream auch ohne Menschen davor. Als Signal gilt:
//      - Browser: Header `X-User-Active: 1`, den der fetch-Wrapper nur setzt,
//        wenn der Tab sichtbar ist und kürzlich eine Eingabe kam
//        (public/js/app/boot/user-active.js);
//      - native Clients (Device-Token, senden den Header nicht): schreibende
//        Requests — gespeichert wird nur, was jemand tippt.

const ACTIVITY_GAP_MS = 5 * 60 * 1000;
const ACTIVE_HEADER = 'x-user-active';

function requestSignalsActivity(req) {
  if (req.get?.(ACTIVE_HEADER) === '1') return true;
  const viaToken = req.session?.user?.via === 'device_token';
  return viaToken && req.method !== 'GET' && req.method !== 'HEAD';
}

/**
 * Liefert `record(email, nowMs)`: bucht die Lücke seit dem letzten Signal des
 * Users über `add(email, seconds, nowIso)`, falls sie unter dem Gap liegt.
 */
function makeActivityCounter({ add, gapMs = ACTIVITY_GAP_MS }) {
  const lastByUser = new Map();
  return function record(email, now) {
    const last = lastByUser.get(email);
    lastByUser.set(email, now);
    if (last == null) return;
    const delta = now - last;
    if (delta > 0 && delta < gapMs) add(email, delta / 1000, new Date(now).toISOString());
  };
}

module.exports = { requestSignalsActivity, makeActivityCounter, ACTIVITY_GAP_MS };
