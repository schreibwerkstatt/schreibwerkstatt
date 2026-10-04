'use strict';

// Pure Builder/Parser/Validator fuer das `.swbook`-Migrationsformat (Buch
// zwischen App-Instanzen zuegeln). Kein Express, keine DB — nur Datenformung,
// damit Round-Trip + Validierung ohne Harness testbar bleiben.
//
// Bundle (ZIP):
//   manifest.json  { format, version, exportedAt, sourceBookId, appVersion, includes }
//   book.json      { book:{ name, description, settings }, tree:[ node… ] }
//   analysis.json  (optional) Komplettanalyse-Entities (Figuren/Orte/Szenen/…)
//   lektorat.json  (optional) gespeicherte Seiten-Checks (page_checks)
//   chats.json     (optional) Chat-Sessions + Nachrichten
// node = { type:'chapter', name, srcId, excluded?, children:[node…] }
//      | { type:'page', name, html, srcId, images?:[{oldId,mime,width,height,b64}] }
// `srcId` = Quell-Page-/Chapter-ID; der Import baut daraus die ID-Remap-Maps,
// damit die optionalen Extra-Dateien ihre page_id/chapter_id-Referenzen
// umschreiben koennen. `images` traegt die im Seiten-HTML referenzierten
// Manuskript-Bild-BLOBs (base64) mit, damit sie bei Restore/Migration mitwandern
// (die /content/page-image/:id-Refs werden beim Anlegen auf neue IDs umgeschrieben).
// Reihenfolge = Array-Order. Hierarchie = Nesting (max Tiefe 3, wie chapters).

const FORMAT = 'schreibwerkstatt-book';
const VERSION = 2; // v2: srcId auf Nodes + manifest.includes + optionale Extra-Dateien
const MAX_DEPTH = 3; // chapters sind selbst auf 3 Ebenen begrenzt
const EXTRA_KEYS = ['analysis', 'lektorat', 'chats', 'research'];

function _err(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}

// ── Export ────────────────────────────────────────────────────────────────────

function buildManifest({ sourceBookId, exportedAt, appVersion = null, includes = null }) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: exportedAt || null,
    sourceBookId: sourceBookId ?? null,
    appVersion,
    includes: normalizeIncludes(includes),
  };
}

// Welche optionalen Extra-Dateien das Bundle enthaelt. Tolerant: fehlend/falsch
// → alles false. Aus beliebigem Input (z.B. manifest.includes) lesbar.
function normalizeIncludes(src) {
  const out = {};
  for (const k of EXTRA_KEYS) out[k] = !!(src && src[k]);
  return out;
}

// bookTree-Output (lib/content-store) + html-Map (pageId -> html) -> node-Tree.
// chapters[] = Top-Level; jedes Kapitel hat pages[] (Meta) + subchapters[].
// topPages[] = kapitellose Top-Level-Seiten.
// `orderTree` (book_order-Format, db/book-order.js) legt die Reihenfolge fest —
// bookTree liefert Seiten und (Sub-)Kapitel getrennt, nur der Order-Tree kennt
// das Interleaving (Seite zwischen zwei Kapiteln). Deckt er den bookTree nicht
// vollstaendig ab, greift die Listen-Reihenfolge (Seiten vor Kapiteln).
function treeToNodes(bookTree, htmlById, imagesByPage, orderTree = null) {
  const ordered = _orderedNodes(bookTree, htmlById, imagesByPage, orderTree);
  if (ordered) return ordered;
  const nodes = [];
  for (const p of (bookTree.topPages || [])) {
    nodes.push(_pageNode(p, htmlById, imagesByPage));
  }
  for (const c of (bookTree.chapters || [])) {
    nodes.push(_chapterNode(c, htmlById, imagesByPage));
  }
  return nodes;
}

function _orderedNodes(bookTree, htmlById, imagesByPage, orderTree) {
  if (!Array.isArray(orderTree) || !orderTree.length) return null;
  const chapters = new Map();
  const pages = new Map();
  (function index(list) {
    for (const c of (list || [])) {
      chapters.set(c.id, c);
      for (const p of (c.pages || [])) pages.set(p.id, p);
      index(c.subchapters);
    }
  })(bookTree.chapters);
  for (const p of (bookTree.topPages || [])) pages.set(p.id, p);

  let seenChapters = 0;
  let seenPages = 0;
  function walk(entries) {
    const out = [];
    for (const e of (entries || [])) {
      if (e?.type === 'chapter' && chapters.has(e.id)) {
        seenChapters += 1;
        out.push(_chapterShell(chapters.get(e.id), walk(e.children)));
      } else if (e?.type === 'page' && pages.has(e.id)) {
        seenPages += 1;
        out.push(_pageNode(pages.get(e.id), htmlById, imagesByPage));
      }
    }
    return out;
  }
  const nodes = walk(orderTree);
  return seenChapters === chapters.size && seenPages === pages.size ? nodes : null;
}

function _chapterShell(ch, children) {
  return {
    type: 'chapter',
    name: ch.name || '',
    srcId: ch.id ?? null,
    excluded: !!ch.excluded,
    children,
  };
}

function _chapterNode(ch, htmlById, imagesByPage) {
  const children = [];
  for (const p of (ch.pages || [])) children.push(_pageNode(p, htmlById, imagesByPage));
  for (const sub of (ch.subchapters || [])) children.push(_chapterNode(sub, htmlById, imagesByPage));
  return _chapterShell(ch, children);
}

function _pageNode(p, htmlById, imagesByPage) {
  const node = {
    type: 'page',
    name: p.name || '',
    html: (htmlById && htmlById.get(p.id)) || '',
    srcId: p.id ?? null,
  };
  const images = imagesByPage && imagesByPage.get(p.id);
  if (Array.isArray(images) && images.length) node.images = images;
  return node;
}

function buildBookJson({ book, settings, nodes }) {
  return {
    book: {
      name: book?.name || '',
      description: book?.description || '',
      settings: settings ? _cleanSettings(settings) : null,
    },
    tree: Array.isArray(nodes) ? nodes : [],
  };
}

// Nur authored Konfig. Instanz-/ACL-Felder (allow_lektor_book_chat) gehoeren
// nicht dazu — Import und Fassungs-Restore setzen sie nie aus dem Bundle
// (lib/bundle-apply.js#applyBundleSettings). Fehlt ein Key im Bundle (aeltere
// Fassung/.swbook), bleibt der Wert am Ziel unangetastet.
const SETTINGS_KEYS = [
  'language', 'region', 'buchtyp', 'buch_kontext', 'erzaehlperspektive',
  'erzaehlzeit', 'is_finished', 'daily_goal_chars', 'orte_real',
  'schauplatz_land', 'entities_enabled',
  'stilprofil', 'goal_target_chars', 'goal_deadline', 'zeitlinie_real',
  'weltfakten_real_pruefen', 'exclude_from_stats',
  'citation_style', 'bibliography_enabled', 'bibliography_title', 'bibliography_scope',
  'bibliography_in_blog', 'citation_notes', 'figure_numbering', 'table_numbering',
  'textsorte', 'research_profile', 'research_domains', 'ideen_stages',
];
function _cleanSettings(s) {
  const out = {};
  for (const k of SETTINGS_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

// ── Import ──────────────────────────────────────────────────────────────────

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw _err('BAD_MANIFEST', 'manifest missing');
  if (manifest.format !== FORMAT) throw _err('BAD_MANIFEST', `unexpected format ${manifest.format}`);
  if (!Number.isInteger(manifest.version) || manifest.version < 1) throw _err('BAD_MANIFEST', 'bad version');
  if (manifest.version > VERSION) throw _err('UNSUPPORTED_VERSION', `bundle version ${manifest.version} > ${VERSION}`);
  return true;
}

function validateBookJson(bookJson) {
  if (!bookJson || typeof bookJson !== 'object') throw _err('SWBOOK_EMPTY', 'book.json missing');
  if (!bookJson.book || typeof bookJson.book.name !== 'string' || !bookJson.book.name.trim()) {
    throw _err('SWBOOK_EMPTY', 'book.name missing');
  }
  if (!Array.isArray(bookJson.tree) || !bookJson.tree.length) throw _err('SWBOOK_EMPTY', 'tree empty');
  return true;
}

// Flacht den node-Tree in eine geordnete Op-Liste fuer den Import-Worker aus.
// Pure — keine DB. Kapitel bekommen fortlaufende tempIds; Pages referenzieren
// ihr Parent-Kapitel via parentTempId (null = Top-Level).
//   ops: [{ op:'chapter', tempId, parentTempId, name, srcId },
//         { op:'page', parentTempId, name, html, srcId }]
// `srcId` reicht die Quell-ID durch, damit der Import-Worker beim Anlegen die
// Remap-Maps (srcPageId/srcChapterId → neue ID) fuer die Extra-Dateien fuellen
// kann (null, wenn das Bundle keine srcIds traegt, z.B. v1-Altbestand).
// Tiefe > MAX_DEPTH wird gekappt: tiefere Kapitel werden nicht angelegt, ihre
// Pages haengen am letzten erlaubten Vorfahr. `cappedChapters` zaehlt das.
function planFromNodes(nodes) {
  const ops = [];
  let tempSeq = 0;
  let cappedChapters = 0;

  function walk(list, parentTempId, depth) {
    for (const n of (list || [])) {
      if (!n || typeof n !== 'object') continue;
      if (n.type === 'page') {
        ops.push({
          op: 'page',
          parentTempId,
          name: typeof n.name === 'string' ? n.name : '',
          html: typeof n.html === 'string' ? n.html : '',
          srcId: Number.isFinite(n.srcId) ? n.srcId : null,
          images: Array.isArray(n.images) ? n.images : [],
        });
      } else if (n.type === 'chapter') {
        if (depth > MAX_DEPTH) {
          // Kapitel kappen: Inhalt am aktuellen Parent weiterfuehren.
          cappedChapters += 1;
          walk(n.children, parentTempId, depth); // Pages landen am Parent
          continue;
        }
        const tempId = tempSeq++;
        ops.push({
          op: 'chapter',
          tempId,
          parentTempId,
          name: typeof n.name === 'string' ? n.name : '',
          srcId: Number.isFinite(n.srcId) ? n.srcId : null,
          // undefined = Bundle kennt das Flag nicht (Altbestand) → Ziel unangetastet.
          excluded: typeof n.excluded === 'boolean' ? n.excluded : undefined,
        });
        walk(n.children, tempId, depth + 1);
      }
    }
  }
  walk(nodes, null, 1);
  return { ops, cappedChapters };
}

// Order-Tree (book_order-Format) aus der Op-Liste + den beim Anlegen/Zuordnen
// vergebenen echten IDs. Die Op-Reihenfolge ist die Lesereihenfolge inklusive
// Interleaving; ein nicht angelegtes Kapitel reicht seine Kinder an den Eltern
// weiter, eine nicht angelegte Seite faellt weg.
//   chapterIdByTemp: tempId -> chapter_id   pageIdByOp: Op-Index -> page_id
function orderTreeFromOps(ops, chapterIdByTemp, pageIdByOp) {
  const root = [];
  const childrenOf = new Map();
  ops.forEach((o, i) => {
    const parent = o.parentTempId == null ? root : (childrenOf.get(o.parentTempId) || root);
    if (o.op === 'chapter') {
      const id = chapterIdByTemp.get(o.tempId);
      if (id == null) { childrenOf.set(o.tempId, parent); return; }
      const entry = { type: 'chapter', id, children: [] };
      childrenOf.set(o.tempId, entry.children);
      parent.push(entry);
    } else if (o.op === 'page') {
      const id = pageIdByOp.get(i);
      if (id != null) parent.push({ type: 'page', id });
    }
  });
  return root;
}

module.exports = {
  FORMAT, VERSION, MAX_DEPTH, EXTRA_KEYS,
  SETTINGS_KEYS,
  buildManifest, normalizeIncludes, treeToNodes, buildBookJson,
  validateManifest, validateBookJson, planFromNodes, orderTreeFromOps,
};
