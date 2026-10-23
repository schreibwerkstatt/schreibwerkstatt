// Pure Helfer der Revisionsliste (pageRevisionsCard): Autosave-Serien zu
// Sitzungen buendeln, Zeichen-Deltas rechnen und das Summary einer Revision
// deuten. Keine DOM-/Alpine-Abhaengigkeit, damit testbar via node:test.

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
  if (newer.source !== older.source) return false;
  const a = _ts(newer);
  const b = _ts(older);
  return a != null && b != null && a - b >= 0 && a - b <= gapMs;
}

/** Liste DESC (juengste zuerst) → Gruppen `{ key, items }`, ebenfalls DESC.
 *  Eine Gruppe ist eine Sitzung: aufeinanderfolgende Autosaves desselben Users
 *  im selben Client aus derselben Quelle, keine Luecke ueber `gapMs`. Quelle,
 *  Person und Geraet sind damit innerhalb einer Sitzung gleich — die Zeile
 *  blendet sie an den Unterzeilen aus, und `filterGroups` darf am Kopf
 *  entscheiden. `items[0]` ist der juengste
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

/** Gruppen behalten, deren Kopfzeile `keep` erfuellt. Gruppiert wird vorher
 *  auf der VOLLSTAENDIGEN Liste: eine Sitzung ist dann auch in der Vollliste
 *  zusammenhaengend, ihr Delta (juengster Stand gegen die Vorgaengerin des
 *  aeltesten) enthaelt nur ihre eigenen Saves. Auf der gefilterten Liste
 *  gruppiert, verschmoelzen zwei Sitzungen von A mit einer von B dazwischen,
 *  und deren Delta zaehlte B mit. Der Kopf reicht als Probe, weil Quelle und
 *  Person in einer Sitzung gleich sind (`_joinable`). */
export function filterGroups(groups, keep) {
  return (Array.isArray(groups) ? groups : []).filter(g => keep(g.items[0]));
}

/** Zeichen-Deltas gegen die vollstaendige Liste `revs` (DESC, geladenes
 *  Fenster). `older` = Vorgaengerin der aeltesten geladenen (Server, nur bei
 *  `hasMore`).
 *  - `base(rev)`: Zeichenstand vor `rev` — die naechstaeltere Revision, am
 *    Fensterrand `older`. Ist `rev` die allererste Revision (nichts mehr
 *    nachzuladen), ist das der leere Stand: 0. Fehlt `older` trotz `hasMore`
 *    oder steht `rev` nicht in der Liste (angeheftet ausserhalb des
 *    Fensters): null, kein geratenes Delta.
 *  - `span(newest, oldest)`: juengster Stand gegen den Stand vor dem
 *    aeltesten; `span(rev, rev)` ist das Delta eines einzelnen Saves.
 *  - `sum(groups)`: Summe der Sitzungs-Deltas, null sobald eines fehlt.
 *    Ohne Filter liegen die Sitzungen eines Tages in der Vollliste lueckenlos
 *    hintereinander, die Summe teleskopiert zu «juengster Stand des Tages
 *    gegen den Stand davor»; mit Filter zaehlt sie nur die angezeigten. */
export function revisionDeltas(revs, { older = null, hasMore = false } = {}) {
  const list = Array.isArray(revs) ? revs : [];
  const idx = new Map(list.map((r, i) => [r.id, i]));
  const chars = r => Number(r?.chars || 0);
  const base = (rev) => {
    const i = rev?.id != null ? idx.get(rev.id) : undefined;
    if (i == null) return null;
    if (i + 1 < list.length) return chars(list[i + 1]);
    if (hasMore) return older ? chars(older) : null;
    return 0;
  };
  const span = (newest, oldest) => {
    const b = base(oldest);
    return newest && b != null ? chars(newest) - b : null;
  };
  const sum = (groups) => {
    if (!Array.isArray(groups) || !groups.length) return null;
    let total = 0;
    for (const g of groups) {
      const d = span(g.items[0], g.items[g.items.length - 1]);
      if (d == null) return null;
      total += d;
    }
    return total;
  };
  return { base, span, sum };
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
