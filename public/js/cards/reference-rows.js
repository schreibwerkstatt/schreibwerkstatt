// Zeilen-Grammatik des Referenz-Slots (Begleitpanel neben dem Notebook-Editor):
// jede Zeile jedes Reiters folgt derselben Abfolge
//
//   Kopf (Titel + Chips) → Meta (eine Textzeile) → Beschreibung
//     → Verweise (Kapitel, Figuren, Orte, Motive …) → «in Abschnitten»
//
// Kopf, Meta und Beschreibung stehen im Template des Reiters; die beiden
// letzten Zeilen rendert für alle Reiter das Fragment `reference-row-tail.html`
// aus den Funktionen hier. Rein (keine Alpine-, DOM- oder Store-Zugriffe),
// damit die Zuordnung je Objektart ohne App testbar ist.

/** Höchstens so viele Chips je Zeile; der Rest steht als «+N». Der Slot ist
 *  eine schmale Leiste — eine Figur mit dreissig Kapitelauftritten soll nicht
 *  die halbe Liste füllen. */
export const REF_ROW_CAP = 6;

/** Liste kappen: `{ shown, more }` (more = Anzahl der nicht gezeigten). */
export function capRefs(list, cap = REF_ROW_CAP) {
  const all = Array.isArray(list) ? list : [];
  return { shown: all.slice(0, cap), more: Math.max(0, all.length - cap) };
}

const kapitelRefs = (list) => (Array.isArray(list) ? list : [])
  .filter(k => k && (k.chapter_id != null || k.name))
  .map(k => ({ type: 'kapitel', id: k.chapter_id ?? undefined, name: k.name }));

const idRefs = (type, ids) => (Array.isArray(ids) ? ids : [])
  .filter(id => id != null && id !== '')
  .map(id => ({ type, id }));

/** Verweise einer Zeile je Objektart (ohne Abschnitte — die stehen in der
 *  eigenen «in Abschnitten»-Zeile). Plan-Beats, Recherche und Weltfakten
 *  bringen ihre Verweise aus dem eigenen Slice mit (Katalog-/Kontext-Stand),
 *  darum hier nicht. */
export function rowRefs(kind, row) {
  if (!row) return [];
  switch (kind) {
    case 'figur':
      return kapitelRefs(row.kapitel);
    case 'ort':
      return [...kapitelRefs(row.kapitel), ...idRefs('figur', row.figuren)];
    case 'szene':
      return [
        ...(row.chapter_id != null || row.kapitel
          ? [{ type: 'kapitel', id: row.chapter_id ?? undefined, name: row.kapitel || undefined }] : []),
        ...idRefs('figur', row.fig_ids),
        ...idRefs('ort', row.ort_ids),
      ];
    case 'ereignis': {
      const names = Array.isArray(row.kapitel) ? row.kapitel : [];
      const ids = Array.isArray(row.chapter_ids) ? row.chapter_ids : [];
      const kap = names.map((name, i) => ({ type: 'kapitel', id: ids[i] ?? undefined, name }))
        .filter(r => r.id != null || r.name);
      const figs = (Array.isArray(row.figuren) ? row.figuren : [])
        .filter(f => f && (f.id != null || f.name))
        .map(f => ({ type: 'figur', id: f.id, name: f.name }));
      return [...kap, ...figs];
    }
    default:
      return [];
  }
}

/** Abschnitte, an denen das Objekt selbst hängt (IDs). */
function anchoredPageIds(kind, row) {
  switch (kind) {
    case 'szene':    return row.page_id != null ? [row.page_id] : [];
    case 'ereignis': return Array.isArray(row.page_ids) ? row.page_ids : [];
    case 'beat':     return (row.occ_top || []).map(o => o?.page_id);
    case 'recherche':
      return (Array.isArray(row.links) ? row.links : [])
        .filter(l => l?.target_kind === 'page').map(l => l.target_id);
    default:         return [];
  }
}

/** «in Abschnitten»: im Buch-Scope jeder Abschnitt, an dem das Objekt hängt;
 *  im Kontext-Scope nur die ANDEREN — eine Zeile, die zu diesem Abschnitt
 *  gehört (`refCtx === 'page'`), zeigt keine (die Angabe wäre Rauschen).
 *  Vorberechnete `refPageIds` des Kontext-Filters haben Vorrang. */
export function rowPageIds(kind, row, { contextActive = false, pageId = null } = {}) {
  if (!row) return [];
  let ids = Array.isArray(row.refPageIds) ? row.refPageIds : anchoredPageIds(kind, row);
  if (contextActive) {
    if (row.refCtx === 'page') return [];
    ids = ids.filter(id => pageId == null || Number(id) !== Number(pageId));
  }
  const seen = new Set();
  return ids.filter(id => {
    if (id == null || id === '' || seen.has(String(id))) return false;
    seen.add(String(id));
    return true;
  });
}

/** Kontext-Kopie einer Zeile (`refCtx` = 'page' | 'chapter') mit stabiler
 *  Identität: dieselbe Quell-Zeile im selben Quell-Array liefert bei jeder
 *  Neuberechnung dasselbe Objekt. Der Kontext-Filter rechnet beim Tippen nach
 *  jeder Eingabepause neu — mit frischen Kopien wertete Alpine jede Zeile
 *  komplett neu aus, auch wenn sich nichts geändert hat. Der Cache hängt am
 *  Quell-Array: lädt der Katalog neu (neues Array), gibt es neue Kopien, eine
 *  Kopie überlebt also nie den Stand, aus dem sie stammt. */
const _ctxCopies = new WeakMap();
export function ctxRow(source, row, refCtx) {
  if (!source || typeof source !== 'object' || !row || typeof row !== 'object') return { ...row, refCtx };
  let bySource = _ctxCopies.get(source);
  if (!bySource) { bySource = new WeakMap(); _ctxCopies.set(source, bySource); }
  let copies = bySource.get(row);
  if (!copies) { copies = {}; bySource.set(row, copies); }
  return (copies[refCtx] ||= { ...row, refCtx });
}
