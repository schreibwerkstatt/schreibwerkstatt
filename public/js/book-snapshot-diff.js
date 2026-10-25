// Buch-Level-Diff zwischen zwei Manuskript-Fassungen (book_snapshots).
// Pure-Function: keine DOM-/Alpine-Abhaengigkeit → testbar via node:test.
// Die eigentliche Seiten-Diff-Darstellung (Word-Level, Side-by-Side) macht
// weiterhin page-revision-diff.js#renderSideBySide — hier wird nur strukturell
// ausgerichtet (welche Seite kam dazu / fiel weg / wurde umbenannt / verschoben /
// inhaltlich geaendert) und die HTML-Bodies der gemeinsamen Seiten durchgereicht.
//
//   flattenSnapshot(content) -> [{ srcId, name, html, chapterPath, parentId, order }]
//   flattenChapters(content) -> [{ srcId, name, parentId, path, excluded }]
//   diffSnapshots(from, to)  -> { summary, entries, chapters }
//   diffChapters(from, to)   -> [{ srcId, status, name, renamed, moved, reordered, excludedChanged, … }]
//   diffPublication(a, b)    -> [{ key, kind, from, to }]
//
// Ausrichtung erfolgt ueber srcId (= Quell-page_id, von treeToNodes inline
// gesetzt). Seiten ohne srcId (Legacy/Defekt) werden positionsfrei behandelt
// und landen als added/removed — Snapshots aus diesem Code tragen immer srcId.

import { htmlToPlainText } from './html-text.js';

// content = { book, tree:[node…] }  (buildBookJson-Format) ODER direkt das
// Node-Array. Liefert die Seiten in Lesereihenfolge mit ihrem Kapitelpfad
// (Namen fuer die Anzeige) und dem Eltern-Kapitel (srcId fuer den Abgleich:
// `parentId` = null auf Buch-Ebene, undefined bei Kapiteln ohne srcId).
export function flattenSnapshot(content) {
  const nodes = _nodes(content);
  const out = [];
  let order = 0;
  (function walk(list, chapterPath, parentId) {
    for (const node of (list || [])) {
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'page') {
        out.push({
          srcId: Number.isFinite(node.srcId) ? node.srcId : null,
          name: typeof node.name === 'string' ? node.name : '',
          html: typeof node.html === 'string' ? node.html : '',
          chapterPath: chapterPath.slice(),
          parentId,
          order: order++,
        });
      } else if (node.type === 'chapter') {
        walk(node.children, chapterPath.concat([typeof node.name === 'string' ? node.name : '']),
          Number.isFinite(node.srcId) ? node.srcId : undefined);
      }
    }
  })(nodes, [], null);
  return out;
}

// Kapitel in Lesereihenfolge (nur solche mit srcId lassen sich ueber Fassungen
// hinweg zuordnen; Legacy-Kapitel ohne srcId bleiben aussen vor).
export function flattenChapters(content) {
  const out = [];
  (function walk(list, path, parentId) {
    for (const node of (list || [])) {
      if (!node || typeof node !== 'object' || node.type !== 'chapter') continue;
      const name = typeof node.name === 'string' ? node.name : '';
      const srcId = Number.isFinite(node.srcId) ? node.srcId : null;
      if (srcId != null) out.push({ srcId, name, parentId, path: path.slice(), excluded: node.excluded === true });
      walk(node.children, path.concat([name]), srcId ?? undefined);
    }
  })(_nodes(content), [], null);
  return out;
}

function _nodes(content) {
  return Array.isArray(content) ? content : (content && Array.isArray(content.tree) ? content.tree : []);
}

function _pathEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Liegt der Knoten unter einem anderen Eltern-Kapitel? Ueber die srcId, wenn
// beide Seiten sie kennen — ein umbenanntes Kapitel verschiebt nichts. Nur bei
// Legacy-Kapiteln ohne srcId ersatzweise ueber den Namenspfad.
function _moved(a, b) {
  if (a.parentId !== undefined && b.parentId !== undefined) return a.parentId !== b.parentId;
  return !_pathEq(a.chapterPath || a.path, b.chapterPath || b.path);
}

// Ids, deren relative Reihenfolge in `b` gegenueber `a` erhalten blieb. Beide
// Listen enthalten dieselben Ids, also ist das die laengste aufsteigende
// Teilfolge der a-Positionen in b-Reihenfolge (O(n log n)). Alle anderen gelten
// als umsortiert — so markiert ein einzelner verschobener Knoten nur sich
// selbst, nicht alle, die nachruecken.
function _keptOrder(a, b) {
  const posInA = new Map(a.map((id, i) => [id, i]));
  const seq = b.map(id => posInA.get(id));
  const tails = []; // tails[k] = Index in seq des kleinsten Endes einer Folge der Laenge k+1
  const prev = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0; let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < seq[i]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const kept = new Set();
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) kept.add(b[k]);
  return kept;
}

// Umsortierte Knoten je Eltern-Kapitel: nur Knoten, die in beiden Staenden
// unter demselben Eltern-Kapitel stehen (ein verschobener zaehlt als `moved`).
function _reordered(fromList, toList, toById) {
  const groups = new Map(); // parentKey -> { from:[], set, to:[] }
  const key = (x) => String(x.parentId);
  for (const f of fromList) {
    const t = toById.get(f.srcId);
    if (!t || _moved(f, t) || f.parentId === undefined) continue;
    if (!groups.has(key(f))) groups.set(key(f), { from: [], set: new Set(), to: [] });
    const g = groups.get(key(f));
    g.from.push(f.srcId); g.set.add(f.srcId);
  }
  for (const t of toList) {
    const g = groups.get(key(t));
    if (g && g.set.has(t.srcId)) g.to.push(t.srcId);
  }
  const out = new Set();
  for (const { from, to } of groups.values()) {
    const kept = _keptOrder(from, to);
    for (const id of from) if (!kept.has(id)) out.add(id);
  }
  return out;
}

function _sumChars(pages) {
  let n = 0;
  for (const p of pages) n += htmlToPlainText(p.html).length;
  return n;
}

// Kapitel-Diff: hinzugefuegt/entfernt/geaendert (umbenannt, verschoben,
// umsortiert, Export-Ausschluss umgeschaltet). Unveraenderte fallen weg.
export function diffChapters(from, to) {
  const fromCh = flattenChapters(from);
  const toCh = flattenChapters(to);
  const fromById = new Map(fromCh.map(c => [c.srcId, c]));
  const toById = new Map(toCh.map(c => [c.srcId, c]));
  const reordered = _reordered(fromCh, toCh, toById);
  const out = [];
  for (const t of toCh) {
    const f = fromById.get(t.srcId);
    if (!f) { out.push({ srcId: t.srcId, status: 'added', name: t.name, path: t.path }); continue; }
    const entry = {
      srcId: t.srcId, status: 'changed', name: t.name, path: t.path,
      renamed: f.name !== t.name, oldName: f.name !== t.name ? f.name : null,
      moved: _moved(f, t), oldPath: _moved(f, t) ? f.path : null,
      reordered: reordered.has(t.srcId),
      excludedChanged: f.excluded !== t.excluded, excluded: t.excluded,
    };
    if (entry.renamed || entry.moved || entry.reordered || entry.excludedChanged) out.push(entry);
  }
  for (const f of fromCh) {
    if (!toById.has(f.srcId)) out.push({ srcId: f.srcId, status: 'removed', name: f.name, path: f.path });
  }
  return out;
}

// Vergleicht Fassung `from` (aelter) gegen `to` (juenger).
// entries: Reihenfolge = `to`-Lesereihenfolge; entfernte Seiten am Ende in
// `from`-Reihenfolge. Jeder Eintrag traegt fromHtml/toHtml fuer die spaetere
// Word-Level-Darstellung. `chapters` = Kapitel-Diff (diffChapters).
export function diffSnapshots(from, to) {
  const fromPages = flattenSnapshot(from);
  const toPages = flattenSnapshot(to);

  const fromById = new Map();
  for (const p of fromPages) if (p.srcId != null) fromById.set(p.srcId, p);
  const toById = new Map();
  for (const p of toPages) if (p.srcId != null) toById.set(p.srcId, p);
  const reordered = _reordered(fromPages.filter(p => p.srcId != null), toPages, toById);
  const chapters = diffChapters(from, to);

  const entries = [];
  const summary = {
    added: 0, removed: 0, changed: 0, unchanged: 0,
    renamed: 0, moved: 0, reordered: 0,
    chaptersAdded: chapters.filter(c => c.status === 'added').length,
    chaptersRemoved: chapters.filter(c => c.status === 'removed').length,
    chaptersChanged: chapters.filter(c => c.status === 'changed').length,
    totalFrom: fromPages.length, totalTo: toPages.length,
    charsFrom: _sumChars(fromPages), charsTo: _sumChars(toPages),
  };

  // `to`-Reihenfolge durchgehen.
  for (const tp of toPages) {
    const fp = tp.srcId != null ? fromById.get(tp.srcId) : null;
    if (!fp) {
      entries.push({
        srcId: tp.srcId, status: 'added', renamed: false, moved: false, reordered: false,
        name: tp.name, oldName: null,
        chapterPath: tp.chapterPath, oldChapterPath: null,
        fromHtml: '', toHtml: tp.html,
      });
      summary.added += 1;
      continue;
    }
    const renamed = fp.name !== tp.name;
    const moved = _moved(fp, tp);
    const isReordered = reordered.has(tp.srcId);
    const textChanged = htmlToPlainText(fp.html) !== htmlToPlainText(tp.html);
    const status = textChanged ? 'changed' : 'unchanged';
    entries.push({
      srcId: tp.srcId, status, renamed, moved, reordered: isReordered,
      name: tp.name, oldName: renamed ? fp.name : null,
      chapterPath: tp.chapterPath, oldChapterPath: moved ? fp.chapterPath : null,
      fromHtml: fp.html, toHtml: tp.html,
    });
    if (status === 'changed') summary.changed += 1; else summary.unchanged += 1;
    if (renamed) summary.renamed += 1;
    if (moved) summary.moved += 1;
    if (isReordered) summary.reordered += 1;
  }

  // Entfernte Seiten (in `from`, nicht in `to`).
  for (const fp of fromPages) {
    const stillThere = fp.srcId != null && toById.has(fp.srcId);
    if (stillThere) continue;
    entries.push({
      srcId: fp.srcId, status: 'removed', renamed: false, moved: false, reordered: false,
      name: fp.name, oldName: null,
      chapterPath: fp.chapterPath, oldChapterPath: null,
      fromHtml: fp.html, toHtml: '',
    });
    summary.removed += 1;
  }

  return { summary, entries, chapters };
}

// Publikations-kritische Metadaten-Felder (book_publication), die zwischen zwei
// Auflagen bewusst geaendert werden — genau die Felder, die der Inhalts-Diff
// nicht sieht. Reihenfolge = Anzeige-Reihenfolge. Geteilt mit dem Drift-Check
// des Servers (routes/snapshots.js via lib/esm-bridge.js#snapshotDiff).
// Bilder: `kind:'bool'` bei Zugabe/Wegnahme, `kind:'replaced'` bei gleichem
// Vorhandensein, aber anderem Inhalts-Hash (lib/snapshot-export.js#imageHash).
export const PUB_TEXT_FIELDS = [
  'author_name', 'isbn', 'subtitle', 'year', 'publisher', 'series', 'series_index',
  'dedication', 'imprint', 'copyright', 'frontmatter', 'author_bio',
];
export const PUB_IMAGE_FIELDS = [
  { key: 'has_cover', hash: 'cover_hash' },
  { key: 'has_author_image', hash: 'author_image_hash' },
];

function _pubText(v) { return v == null ? '' : String(v).trim(); }

// Vergleicht die eingefrorenen Publikations-Metadaten zweier Fassungen (Form von
// db/book-publication#getMeta). Liefert nur geaenderte Felder als
// [{ key, kind:'text'|'bool'|'replaced', from, to }]. Fehlt eine Seite (Fassung
// ohne eingefrorene Publikation), wird gegen leer verglichen. Ein fehlender Hash
// (Live-Stand ohne Hash, aeltere Aufrufer) gilt nicht als Austausch.
export function diffPublication(fromMeta, toMeta) {
  const a = fromMeta || {};
  const b = toMeta || {};
  const out = [];
  for (const key of PUB_TEXT_FIELDS) {
    const from = _pubText(a[key]);
    const to = _pubText(b[key]);
    if (from !== to) out.push({ key, kind: 'text', from, to });
  }
  for (const { key, hash } of PUB_IMAGE_FIELDS) {
    const from = !!a[key];
    const to = !!b[key];
    if (from !== to) out.push({ key, kind: 'bool', from, to });
    else if (from && a[hash] && b[hash] && a[hash] !== b[hash]) out.push({ key, kind: 'replaced', from, to });
  }
  return out;
}
