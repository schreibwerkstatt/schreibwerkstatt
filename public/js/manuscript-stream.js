// Kanonisches Manuskript-Stream-Modell: eine Sequenz aus Kapitel-Headern und
// Seiten-Blöcken in Lesereihenfolge. Geteilte Quelle für die drei Konsumenten,
// die ein Buch als durchgehenden Stream darstellen:
//   - Bucheditor      (fromPages, wrappt Page-Entries mit Editor-State)
//   - Fassungen-Reader (fromSnapshotTree)
//   - Share/Teilen-SSR (fromGroups, serverseitig via dynamic import())
//
// PURE + ISOMORPH: kein DOM-/Alpine-/Browser-Zugriff, damit der Express-Server
// das Modul wie public/js/prompts.js per dynamic import() laden kann. HTML wird
// VERBATIM durchgereicht (bereits via lib/html-clean.js sanitisiert) — hier
// nicht escapen, nicht strippen (stripFocusArtefacts gehört in den Editor-
// Wrapper, der browser-only ist).
//
// StreamEntry =
//   | { kind:'chapter', name, depth, key, chapterId? }
//   | { kind:'page',    name, depth, key, id, html, chapterId?, headBefore?, headAfter?, article? }
// `id` = einheitliche Seiten-Identität (pageId | srcId | pd.id), am Adapter-Rand
// normalisiert. `key` = positionsbasiert, deterministisch ('c'+i / 'p'+i).
//
// `headBefore`/`headAfter` sind FERTIGES Markup, das der Renderer über bzw.
// unter die Seitenüberschrift stellt (Dachzeile und Lead der Titel-Werkstatt).
// Dieses Modul baut es NICHT selbst: die Markup-SSoT ist lib/headline-render.js,
// und die ist CommonJS — hier stünde sonst eine zweite Kopie der Klassennamen.
// Der Adapter bekommt sie deshalb als Callback herein (siehe `opts.pageHead`).

function _str(v) {
  return typeof v === 'string' ? v : '';
}

function _pushChapter(out, name, depth, chapterId) {
  out.push({ kind: 'chapter', name: name || '', depth, key: 'c' + out.length, chapterId: chapterId ?? null });
}

function _pushPage(out, { name, html, id, depth, chapterId, headBefore, headAfter, article }) {
  out.push({
    kind: 'page', name: name || '', html: html || '', id: id ?? null,
    depth, key: 'p' + out.length, chapterId: chapterId ?? null,
    headBefore: headBefore || '', headAfter: headAfter || '', article: !!article,
  });
}

// Kapitelpfad (Wurzel → Kapitel) aus einer id → { id, name, parentId }-Map.
// Unbekannter Vorfahr beendet die Kette; Zyklen brechen ab.
function _chapterPath(chapterId, name, byId) {
  if (chapterId == null || chapterId === 0) return [];
  const path = [];
  const seen = new Set();
  let cur = byId.get(chapterId) || { id: chapterId, name, parentId: null };
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId != null ? byId.get(cur.parentId) : null;
  }
  return path;
}

// Kapitel-Header fuer jeden Vorfahren, der ab hier beginnt: gemeinsamer Praefix
// mit dem zuletzt offenen Pfad bleibt, der Rest bekommt je einen Header in
// seiner echten Tiefe (0 = Top-Kapitel, wie fromSnapshotTree). So erscheint
// auch ein Kapitel ohne eigenen Abschnitt («Teil I» nur mit Unterkapiteln)
// genau einmal vor seinem ersten Unterkapitel.
function _openPath(out, open, path) {
  let k = 0;
  while (k < open.length && k < path.length && open[k].id === path[k].id) k++;
  for (let i = k; i < path.length; i++) _pushChapter(out, path[i].name, i, path[i].id);
  return path;
}

// Bucheditor-Quelle: server-vorsortierte Page-Liste aus /book-editor/:id/contents.
// `opts.chapters` = [{ id, name, parentId }] (Top-Level-Feld der Antwort) liefert
// die Elternkette; fehlt es, ist jedes Kapitel Top-Level (Pfad nur aus
// chapterId/chapterName). Solo-Pages (chapterId null/0) erzeugen keinen Header.
// Page-depth = Zahl der umschliessenden Kapitel.
export function fromPages(pages, opts = {}) {
  const byId = new Map();
  for (const c of (opts.chapters || [])) {
    if (c && c.id != null) byId.set(c.id, { id: c.id, name: c.name || '', parentId: c.parentId ?? null });
  }
  const out = [];
  let open = [];
  for (const p of pages || []) {
    open = _openPath(out, open, _chapterPath(p.chapterId, p.chapterName, byId));
    _pushPage(out, { name: p.pageName, html: p.html, id: p.pageId, depth: open.length, chapterId: p.chapterId });
  }
  return out;
}

// Fassungs-Quelle: selbsttragender Snapshot-Tree (buildBookJson-Format,
// node.type 'chapter'|'page', verschachtelte children). Echtes Nesting → depth.
// srcId (alte page_id) → id.
export function fromSnapshotTree(tree) {
  const nodes = Array.isArray(tree) ? tree : [];
  const out = [];
  (function walk(list, depth) {
    for (const node of (list || [])) {
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'chapter') {
        // chapterId = srcId (alte chapter_id) — Adresse fuer den Kapitel-Restore im Reader.
        _pushChapter(out, _str(node.name), depth, Number.isFinite(node.srcId) ? node.srcId : null);
        walk(node.children, depth + 1);
      } else if (node.type === 'page') {
        _pushPage(out, {
          name: _str(node.name),
          html: _str(node.html),
          id: Number.isFinite(node.srcId) ? node.srcId : null,
          depth,
        });
      }
    }
  })(nodes, 0);
  return out;
}

// Share-/Export-Quelle: loadContents().groups = [{ chapterId, chapter, pages:[{ p, pd }] }].
// Die Elternkette steckt in `chapter.parent_chapter_id`; Vorfahren ohne eigene
// Abschnitte liefert loadContents als Gruppe mit `pages: []`. Kapitel-Header
// wie bei fromPages je Vorfahr, der ab hier beginnt, mit echter Tiefe
// (0 = oberstes Kapitel der Gruppen). pd.id → id.
//
// `opts.pageHead(p, pd)` darf je Seite `{ name, before, after }` liefern und
// damit den Titel-Kopf beisteuern (Aufrufer: lib/share-helpers.js mit
// lib/headline-render.js). Ein Kopf macht die Seite zum Beitrag (`article`),
// ausser er sagt `article: false` (nur Zusatz-Markup, z. B. Bearbeitungsstand). Fehlt der Callback, bleibt alles wie gehabt — dieses
// Modul kennt die Titel-Werkstatt nicht.
export function fromGroups(groups, opts = {}) {
  const head = typeof opts.pageHead === 'function' ? opts.pageHead : null;
  const byId = new Map();
  for (const g of (groups || [])) {
    const c = g && g.chapter;
    const id = c ? (g.chapterId ?? c.id ?? null) : null;
    if (id != null && !byId.has(id)) {
      byId.set(id, { id, name: c.name || c.chapter_name || '', parentId: c.parent_chapter_id ?? null });
    }
  }
  const out = [];
  let open = [];
  for (const g of (groups || [])) {
    if (g && g.chapter) {
      const id = g.chapterId ?? g.chapter.id ?? null;
      const path = _chapterPath(id, g.chapter.name || g.chapter.chapter_name, byId);
      // Eine neue Gruppe desselben Kapitels oeffnet es erneut (Header wie bisher).
      if (open.length && open[open.length - 1].id === id) open = open.slice(0, -1);
      open = _openPath(out, open, path);
    } else {
      open = [];
    }
    for (const { p, pd } of (g && g.pages ? g.pages : [])) {
      if (!pd) continue;
      const h = head ? (head(p || pd, pd) || null) : null;
      _pushPage(out, {
        name: (h && h.name) || pd.name,
        html: pd.html, id: pd.id, depth: open.length, chapterId: g.chapterId ?? null,
        headBefore: h && h.before, headAfter: h && h.after,
        article: h ? (h.article ?? true) : false,
      });
    }
  }
  return out;
}
