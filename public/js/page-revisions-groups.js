// Pure Helfer der Revisionsliste (pageRevisionsCard): Autosave-Serien zu
// Sitzungen buendeln und das Summary einer Revision deuten. Keine DOM-/Alpine-
// Abhaengigkeit, damit testbar via node:test.

// Quellen, deren Revisionen aus dem laufenden Schreiben stammen (Autosave im
// Notebook-/Focus-/Bucheditor, Mac-App). Alles andere ist eine Aktion (Chat-/
// Lektorat-Uebernahme, Import, Konflikt, Teilen, Wiederherstellen) und bleibt
// eine eigene Zeile.
const SESSION_SOURCES = new Set(['focus', 'main', 'book', 'macapp']);

// Groesste Luecke zwischen zwei Saves derselben Sitzung.
export const SESSION_GAP_MS = 10 * 60 * 1000;

function _ts(rev) {
  const t = Date.parse(rev?.created_at || '');
  return Number.isFinite(t) ? t : null;
}

function _joinable(newer, older, gapMs) {
  if (!SESSION_SOURCES.has(newer.source) || !SESSION_SOURCES.has(older.source)) return false;
  if (newer.pinned || older.pinned || newer.summary || older.summary) return false;
  if ((newer.user_email || '') !== (older.user_email || '')) return false;
  if ((newer.client || '') !== (older.client || '')) return false;
  const a = _ts(newer);
  const b = _ts(older);
  return a != null && b != null && a - b >= 0 && a - b <= gapMs;
}

/** Liste DESC (juengste zuerst) → Gruppen `{ key, items }`, ebenfalls DESC.
 *  Eine Gruppe ist eine Sitzung: aufeinanderfolgende Autosaves desselben Users
 *  im selben Client, keine Luecke ueber `gapMs`. `items[0]` ist der juengste
 *  Stand der Sitzung (Kopfzeile), `key` seine id. Angeheftete Revisionen und
 *  solche mit Summary (Ausgangsstand, Wiederherstellung, Teilen) stehen allein. */
export function groupRevisions(revs, { gapMs = SESSION_GAP_MS } = {}) {
  const out = [];
  for (const rev of Array.isArray(revs) ? revs : []) {
    const cur = out[out.length - 1];
    const last = cur?.items[cur.items.length - 1];
    if (last && _joinable(last, rev, gapMs)) cur.items.push(rev);
    else out.push({ key: rev.id, items: [rev] });
  }
  return out;
}

/** Gruppen (DESC, aus groupRevisions) → Tage `{ key, groups }`, ebenfalls DESC.
 *  `dayOf(iso)` liefert den Kalendertag (YYYY-MM-DD, App-Zeitzone) — injiziert,
 *  damit der Helfer ohne Zeitzonen-Setting testbar bleibt. Eine Sitzung ueber
 *  Mitternacht zaehlt zum Tag ihres juengsten Saves (Kopfzeile). */
export function groupByDay(groups, dayOf) {
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const key = dayOf(g.items[0]?.created_at) || '';
    const cur = out[out.length - 1];
    if (cur && cur.key === key) cur.groups.push(g);
    else out.push({ key, groups: [g] });
  }
  return out;
}

/** Summary einer Revision → `{ kind, revId }` oder null.
 *  Formate schreibt der Server (lib/content-store#savePage/#splitPage,
 *  routes/content/pages.js Restore). `split → #…`/`split from #…` deutet die
 *  Karte separat (splitLink), weil es dort eine Entitaets-Referenz gibt. */
export function summaryInfo(summary) {
  const s = String(summary || '');
  if (s === 'baseline') return { kind: 'baseline', revId: null };
  if (s === 'before split') return { kind: 'beforeSplit', revId: null };
  const m = /^restored from #(\d+)$/.exec(s);
  if (m) return { kind: 'restore', revId: Number(m[1]) };
  return null;
}
