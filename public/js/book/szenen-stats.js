// Reine Ableitungen der Szenen-Karte: Sortierung, Verteilungen, Filter-Optionen.
//
// Framework-frei (kein Alpine, kein window), damit die Unit-Tests sie direkt
// importieren. Die Buchreihenfolge kommt als `order`-Objekt herein:
//   order.chapterIdx(s) / order.pageIdx(s) → Position im Buch (unbekannt = gross)
// So bleibt die Kapitel-/Seitenachse an der Sidebar-SSoT (tree/build.js), ohne
// dass dieses Modul den Root kennt.
//
// Kapitel und Seiten werden über ihre ID geführt, nicht über den Namen:
// gleichnamige Kapitel („Kapitel 1" in Teil I und Teil II) sind zwei Kapitel.
// Der Name ist nur der Fallback für Szenen, deren Kapitel nicht mehr existiert.
//
// Stale-Szenen („nicht mehr im Text") zählen in keiner Verteilung und keinem
// Zähler — sie stehen nur noch in der Liste, damit man sie löschen kann.

export const WERTUNGEN = ['stark', 'mittel', 'schwach'];
const WERTUNG_RANK = { stark: 0, mittel: 1, schwach: 2 };

// Fehlende/unbekannte Wertung gilt als «mittel» — dieselbe Regel für Anzeige,
// Zähler und Filter, sonst zählt ein Tab Szenen, die sein Filter nicht findet.
export function wertungOf(s) {
  return WERTUNGEN.includes(s?.wertung) ? s.wertung : 'mittel';
}
export function wertungRank(s) { return WERTUNG_RANK[wertungOf(s)]; }

export function activeSzenen(szenen) {
  return (szenen || []).filter(s => !s.stale);
}

const sameId = (a, b) => a != null && b != null && a !== '' && b !== '' && String(a) === String(b);

// Kapitel-Schlüssel: ID, sonst Name (Szene ohne auflösbares Kapitel).
function kapitelKey(s) {
  return s.chapter_id != null ? 'c' + s.chapter_id : (s.kapitel ? 'n' + s.kapitel : null);
}
function seiteKey(s) {
  return s.page_id != null ? 'p' + s.page_id : (s.seite ? 'n' + s.seite : null);
}

export function applySzenenFilters(szenen, filters) {
  const f = filters || {};
  const q = f.suche ? f.suche.toLowerCase() : '';
  return (szenen || []).filter(s =>
    (!q || (s.titel || '').toLowerCase().includes(q) || (s.kommentar || '').toLowerCase().includes(q)) &&
    (!f.wertung || wertungOf(s) === f.wertung) &&
    (!f.figurId || (s.fig_ids || []).includes(f.figurId)) &&
    (!f.kapitelId || sameId(s.chapter_id, f.kapitelId)) &&
    // Seite gilt nur unter einem Kapitelfilter (wie in Figuren/Ereignisse).
    (!f.kapitelId || !f.seiteId || sameId(s.page_id, f.seiteId)) &&
    (!f.ortId || (s.ort_ids || []).includes(f.ortId))
  );
}

// Buchreihenfolge: Kapitel → Seite → Reihenfolge im Text. Letztere ist die
// Position in `szenen` (der Server liefert nach `sort_order`, also in der
// Abfolge der Extraktion) — nicht der Titel.
export function sortSzenen(list, order, szenen = list) {
  const pos = new Map((szenen || []).map((s, i) => [s.id, i]));
  return [...(list || [])].sort((a, b) =>
    (order.chapterIdx(a) - order.chapterIdx(b)) ||
    (order.pageIdx(a) - order.pageIdx(b)) ||
    ((pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0)));
}

// Sortierwerte für die Grid-Tabelle: Kapitel/Seite als Buchposition, Wertung als
// Rang. `s` trägt die Original-Szene fürs Rendern.
export function szenenGridRows(list, order) {
  return (list || []).map(s => ({
    id: s.id,
    s,
    titel: s.titel || '',
    wertung: wertungRank(s),
    kapitel: order.chapterIdx(s),
    seite: order.chapterIdx(s) * 100000 + order.pageIdx(s),
  }));
}

// Pro Kapitel: Wertungs-Verteilung + Anteil am grössten Kapitel (Balkenlänge).
export function szenenNachKapitel(szenen, order, labelOf) {
  const map = new Map();
  for (const s of activeSzenen(szenen)) {
    const key = kapitelKey(s);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        key, chapterId: s.chapter_id ?? null,
        name: labelOf(s.chapter_id, s.kapitel),
        idx: order.chapterIdx(s),
        total: 0, stark: 0, mittel: 0, schwach: 0,
      });
    }
    const e = map.get(key);
    e.total++;
    e[wertungOf(s)]++;
  }
  const rows = [...map.values()].sort((a, b) => a.idx - b.idx);
  const max = rows.reduce((m, r) => Math.max(m, r.total), 0) || 1;
  for (const r of rows) r.share = Math.round((r.total / max) * 100);
  return rows;
}

export function szenenNachSeite(szenen, order, labelOf) {
  const map = new Map();
  for (const s of activeSzenen(szenen)) {
    const key = seiteKey(s);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        key, pageId: s.page_id ?? null, chapterId: s.chapter_id ?? null,
        name: s.seite, kapitel: labelOf(s.chapter_id, s.kapitel),
        ci: order.chapterIdx(s), pi: order.pageIdx(s), total: 0,
      });
    }
    map.get(key).total++;
  }
  return [...map.values()].sort((a, b) => (a.ci - b.ci) || (a.pi - b.pi));
}

// Pro Figur (nur Figuren mit ≥1 Szene), in Figuren-Reihenfolge. `wenig` markiert
// unterrepräsentierte Figuren (< WENIG_SZENEN).
export const WENIG_SZENEN = 3;
export function szenenNachFigur(szenen, figuren) {
  const counts = new Map();
  for (const s of activeSzenen(szenen)) {
    for (const id of (s.fig_ids || [])) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const out = [];
  for (const f of (figuren || [])) {
    const total = counts.get(f.id) || 0;
    if (total === 0) continue;
    out.push({ id: f.id, name: f.kurzname || f.name, total, wenig: total < WENIG_SZENEN });
  }
  return out;
}

export function szenenWertungCounts(szenen) {
  const c = { stark: 0, mittel: 0, schwach: 0 };
  for (const s of activeSzenen(szenen)) c[wertungOf(s)]++;
  return c;
}

// Kapitel-Optionen für den Filter: jedes Kapitel, in dem eine Szene liegt, in
// Buchreihenfolge. Nur Szenen mit Kapitel-ID — der Filter arbeitet auf der ID.
export function szenenKapitelOptionen(szenen, order, labelOf) {
  const seen = new Map();
  for (const s of (szenen || [])) {
    if (s.chapter_id == null || seen.has(s.chapter_id)) continue;
    seen.set(s.chapter_id, { value: s.chapter_id, label: labelOf(s.chapter_id, s.kapitel), idx: order.chapterIdx(s) });
  }
  return [...seen.values()].sort((a, b) => a.idx - b.idx).map(({ value, label }) => ({ value, label }));
}

export function szenenSeitenOptionen(szenen, kapitelId, order) {
  if (!kapitelId) return [];
  const seen = new Map();
  for (const s of (szenen || [])) {
    if (!sameId(s.chapter_id, kapitelId) || s.page_id == null || seen.has(s.page_id)) continue;
    seen.set(s.page_id, { value: s.page_id, label: s.seite || '', idx: order.pageIdx(s) });
  }
  return [...seen.values()].sort((a, b) => a.idx - b.idx).map(({ value, label }) => ({ value, label }));
}

// Anzeigename je Kapitel-ID: der Kapitelname, bei gleichnamigen Kapiteln mit dem
// Elternkapitel davor („Teil II › Kapitel 1"). Ohne Eltern bleibt der Name
// gleich — dann trennt die Buchreihenfolge die Einträge.
export function buildKapitelLabels(tree) {
  const chapters = (tree || []).filter(i => i.type === 'chapter' && !i.solo);
  const byId = new Map(chapters.map(c => [c.id, c]));
  const nameCount = new Map();
  for (const c of chapters) nameCount.set(c.name, (nameCount.get(c.name) || 0) + 1);
  const labels = new Map();
  for (const c of chapters) {
    const parent = c.parent_id != null ? byId.get(c.parent_id) : null;
    labels.set(c.id, nameCount.get(c.name) > 1 && parent ? `${parent.name} › ${c.name}` : c.name);
  }
  return labels;
}
