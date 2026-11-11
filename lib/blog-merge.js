'use strict';
// Pure Last-Write-Wins-Klassifikation fuer den Blog-Pull. Vergleicht den WP-
// Modified-Stamp gegen den zuletzt gesehenen Stand und den lokalen Edit gegen
// den letzten Sync-Punkt. Ausgelagert als reine Funktion, damit die Faelle ohne
// Job-/DB-Kontext testbar sind (tests/unit/blog-merge.test.mjs).

// ISO-Stamp → ms. Zonenlose Stamps (WordPress `modified_gmt`:
// `2026-05-19T20:29:35`) sind UTC — `Date.parse` laese sie sonst als Ortszeit.
function stampMs(s) {
  const str = String(s || '');
  const ms = Date.parse(/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(str) ? `${str}Z` : str);
  return Number.isFinite(ms) ? ms : NaN;
}

// Zeitvergleich zweier ISO-8601-Stamps. Per `Date.parse`, nicht als String:
// Remote-APIs lassen Millisekunden weg, wenn sie 0 sind (Javas `Instant`) —
// `…10:00:00Z` waere lexikografisch juenger als `…10:00:00.500Z` ('Z' > '.').
// Nicht parsebare Stamps fallen auf den String-Vergleich zurueck. Leeres/
// fehlendes a nie neuer; fehlendes b immer aelter als ein vorhandenes a.
function newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const ta = stampMs(a);
  const tb = stampMs(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta > tb;
  return String(a) > String(b);
}

/** Juengster der uebergebenen Stamps ('' wenn keiner gesetzt). */
function latest(...stamps) {
  let out = '';
  for (const s of stamps) if (newer(s, out)) out = String(s);
  return out;
}

/** Sync-Punkt eines Links: der juengere von letztem Pull und letztem Push.
 *  Ein Push macht den App-Stand ebenso zum gemeinsamen Stand wie ein Pull —
 *  wer nur `last_pulled_at` vergleicht, haelt jede gepushte Aenderung fuer
 *  einen offenen lokalen Edit (und jede Seite, die per Push entstand, hat gar
 *  keinen Pull-Stamp). */
function syncPoint(link) {
  return latest(link?.last_pulled_at, link?.last_pushed_at);
}

// Liefert die Pull-Aktion fuer einen WP-Post:
//  - 'create'   : kein Link -> neue Page anlegen
//  - 'update'   : WP neuer als der Link-Stand, App lokal unveraendert -> WP → App
//  - 'conflict' : beide Seiten seit dem letzten Sync veraendert -> User loest via Diff
//  - 'skip'     : App neuer (gehoert in den Push) oder beide unveraendert
//
// Lokaler Edit = Seite ODER Titel-Werkstatt (`headlineUpdatedAt`) juenger als
// der Sync-Punkt (juengerer von `lastPulledAt`/`lastPushedAt`).
function classifyPull({
  hasLink, wpModifiedAt, linkModifiedAt,
  pageUpdatedAt, headlineUpdatedAt = null, lastPulledAt, lastPushedAt = null,
}) {
  if (!hasLink) return 'create';
  const wpHasNew = newer(wpModifiedAt, linkModifiedAt);
  const appHasLocalEdit = newer(latest(pageUpdatedAt, headlineUpdatedAt), latest(lastPulledAt, lastPushedAt));
  if (wpHasNew && appHasLocalEdit) return 'conflict';
  if (wpHasNew && !appHasLocalEdit) return 'update';
  return 'skip';
}

module.exports = { newer, latest, syncPoint, classifyPull };
