// Save-Ausfall eines Abschnitts, gemeldet an /telemetry/js-error (kind 'save').
//
// Ein Ausfall, der nie beim Server ankommt (hängende Verbindung, WLAN-Wechsel,
// Proxy), hinterlässt dort keine Spur: kein Log, keine Revision, kein 409. Was
// geschah, weiss nur der Client. Melden kann er es aber erst, wenn die
// Verbindung zurück ist — eine Meldung mitten im Ausfall hinge in derselben
// Leitung. Darum sammelt jeder gescheiterte Save in einen Ausfall-Datensatz pro
// Abschnitt, und der erste gelungene Save meldet ihn als EINE Zeile: wie lange,
// wie viele Fehlversuche welcher Art, ob dazwischen neu geladen wurde.
//
// sessionStorage, weil genau der Reload mitten im Ausfall der Fall ist, den die
// Meldung erklären soll; pro Tab, weil der Ausfall einer Edit-Session gehört.
const KEY_PREFIX = 'notebook_save_outage:';
// Ein Datensatz, dessen letzter Fehlversuch so lange her ist, gehört nicht mehr
// zum jetzt gelungenen Save — er wird verworfen statt gemeldet.
const STALE_MS = 6 * 60 * 60 * 1000;

function read(pageId) {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + pageId);
    const rec = raw ? JSON.parse(raw) : null;
    return rec && typeof rec.since === 'number' ? rec : null;
  } catch { return null; }
}

function write(pageId, rec) {
  try { sessionStorage.setItem(KEY_PREFIX + pageId, JSON.stringify(rec)); } catch { /* gesperrt/voll: keine Meldung, Save unberührt */ }
}

function clear(pageId) {
  try { sessionStorage.removeItem(KEY_PREFIX + pageId); } catch { /* ignore */ }
}

function online() {
  return typeof navigator === 'undefined' ? null : navigator.onLine !== false;
}

// Gescheiterter Save (Netz/Server/Konflikt …). `kind` aus save-errors.js bzw.
// 'conflict'; `status` der HTTP-Status, falls es eine Antwort gab.
export function noteSaveOutage(pageId, { kind, status = null, reason = null } = {}, now = Date.now()) {
  if (pageId == null || !kind) return;
  const rec = read(pageId) || { since: now, count: 0, kinds: {}, reloads: 0, onlineAtStart: online() };
  rec.count++;
  rec.kinds[kind] = (rec.kinds[kind] || 0) + 1;
  rec.last = now;
  rec.lastKind = kind;
  rec.lastStatus = typeof status === 'number' ? status : null;
  if (reason) rec.lastReason = String(reason).slice(0, 32);
  rec.onlineAtLast = online();
  write(pageId, rec);
}

// Edit-Session startet (auch nach einem Reload): ein offener Ausfall dieses
// Tabs bekommt einen Reload vermerkt.
export function noteEditStartDuringOutage(pageId) {
  const rec = read(pageId);
  if (!rec) return;
  rec.reloads++;
  write(pageId, rec);
}

// Reiner Formatierer, getrennt testbar. Eine Zeile, deutsch wie die übrigen
// Admin-Diagnosezeilen.
export function formatOutage(pageId, rec, now = Date.now()) {
  const secs = Math.round((now - rec.since) / 1000);
  const kinds = Object.entries(rec.kinds).map(([k, n]) => `${k}×${n}`).join(', ');
  const parts = [
    `Save-Ausfall Abschnitt ${pageId}: ${rec.count} Fehlversuch(e) über ${secs}s (${kinds})`,
    `letzter ${rec.lastKind}${rec.lastStatus != null ? ' ' + rec.lastStatus : ''}${rec.lastReason ? ' via ' + rec.lastReason : ''}`,
    `online=${rec.onlineAtStart}/${rec.onlineAtLast}`,
  ];
  if (rec.reloads) parts.push(`Reloads=${rec.reloads}`);
  return parts.join(' · ');
}

// Save gelungen: offenen Ausfall melden und schliessen.
export function noteSaveRecovered(pageId, now = Date.now()) {
  const rec = read(pageId);
  if (!rec) return;
  clear(pageId);
  if (now - (rec.last || rec.since) > STALE_MS) return;
  const report = typeof window !== 'undefined' ? window.__reportClientError : null;
  if (typeof report !== 'function') return;
  report({
    kind: 'save',
    message: formatOutage(pageId, rec, now),
    stack: null,
    source: 'notebook-save',
    line: null,
    col: null,
    pageUrl: typeof location !== 'undefined' ? location.href : null,
  });
}

// Nur für Tests: der Datensatz, wie er liegt.
export function _readOutage(pageId) { return read(pageId); }
