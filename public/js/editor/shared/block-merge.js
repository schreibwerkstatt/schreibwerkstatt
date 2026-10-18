// Block-Level-3-Way-Merge für den Stale-Write-Konflikt (Notebook + Focus-Editor).
// Statt Last-Write-Wins werden beide Versionen blockweise (anhand `data-bid`,
// vergeben in lib/html-clean.js#ensureBlockIds) verglichen: nicht-kollidierende
// Block-Edits mergen still, nur echter Block-Overlap (beide Geräte ändern denselben
// Block) landet als Konflikt in der Auflösungs-UI.
//
// `mergeBlockLists` ist die reine, DOM-freie Merge-Logik (Node-testbar). `parseBlocks`
// liefert Block-Arrays via DOMParser (Browser) bzw. Regex-Fallback (Node) — analog
// public/js/page-revision-diff.js.

const PAIRED_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'pre', 'figure', 'table', 'div'];
const _BLOCK_RE = new RegExp(`<(hr)\\b[^>]*\\/?>|<(${PAIRED_TAGS.join('|')})\\b[^>]*>([\\s\\S]*?)<\\/\\2>`, 'gi');
const _BID_RE = /\sdata-bid="([^"]+)"/;

// Vergleichs-Normalform: data-bid raus (ID darf Gleichheit nicht beeinflussen),
// Whitespace zwischen Tags kollabieren, trimmen. Display/Output nutzt das rohe HTML.
function _norm(html) {
  return String(html || '')
    .replace(/\sdata-bid="[^"]*"/gi, '')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
}

function _parseBlocksDOM(html, Parser) {
  if (!Parser) return null;
  const doc = new Parser().parseFromString(`<div id="r">${String(html || '')}</div>`, 'text/html');
  const root = doc.getElementById('r');
  if (!root) return [];
  const out = [];
  let surrogate = 0;
  for (const el of root.children) {
    const tag = el.tagName.toLowerCase();
    const bid = el.getAttribute('data-bid') || `__nobid_${surrogate++}`;
    out.push({ bid, tag, html: el.outerHTML });
  }
  return out;
}

function _parseBlocksRegex(html) {
  const src = String(html || '');
  const out = [];
  let surrogate = 0;
  for (const m of src.matchAll(_BLOCK_RE)) {
    const raw = m[0];
    const tag = (m[1] || m[2]).toLowerCase();
    const bidMatch = raw.match(_BID_RE);
    const bid = bidMatch ? bidMatch[1] : `__nobid_${surrogate++}`;
    out.push({ bid, tag, html: raw });
  }
  return out;
}

// Top-Level-Blöcke als [{ bid, tag, html }]. Blöcke ohne data-bid (frisch
// getippt, von extern gepastet) bekommen einen Surrogat-Key → zählen als „neu".
// `opts.DOMParser` reicht einen Parser ohne Browser-Global herein (Server:
// linkedom, lib/page-merge.js) — der Regex-Fallback trennt verschachtelte
// Blöcke gleichen Tags (`<div><div>…</div></div>`, Listen in Listen) falsch.
export function parseBlocks(html, opts = {}) {
  const Parser = opts.DOMParser || (typeof DOMParser === 'undefined' ? null : DOMParser);
  return _parseBlocksDOM(html, Parser) ?? _parseBlocksRegex(html);
}

// LCS zweier Bid-Sequenzen (gemeinsame Anker für stabile Merge-Reihenfolge).
function _lcs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const res = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { res.push(a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return res;
}

// Merge-Reihenfolge: local als Spine, remote-only-Blöcke an ihrer Position relativ
// zu gemeinsamen Ankern (LCS) zwischengeschoben. Deterministisch.
function _mergeOrder(localOrder, remoteOrder) {
  const anchors = _lcs(localOrder, remoteOrder);
  const out = [];
  let li = 0, ri = 0;
  for (const anchor of [...anchors, null]) {
    while (li < localOrder.length && localOrder[li] !== anchor) out.push(localOrder[li++]);
    while (ri < remoteOrder.length && remoteOrder[ri] !== anchor) out.push(remoteOrder[ri++]);
    if (anchor !== null) { out.push(anchor); li++; ri++; }
  }
  return [...new Set(out)];
}

// Reine 3-Way-Merge-Logik. base/local/remote sind Block-Arrays aus parseBlocks.
// Liefert { merged, conflicts }:
//   merged   — geordnete Entries [{ bid, tag, html, conflict? }]; html ist die
//              provisorische Auswahl (lokal bevorzugt) — die UI ersetzt sie pro
//              Konflikt-Block via decisions.
//   conflicts — [{ bid, tag, local_html, remote_html, base_html }] (null = gelöscht).
export function mergeBlockLists(baseBlocks, localBlocks, remoteBlocks) {
  const toMap = (arr) => new Map(arr.map(b => [b.bid, b]));
  const base = toMap(baseBlocks);
  const local = toMap(localBlocks);
  const remote = toMap(remoteBlocks);

  const order = _mergeOrder(localBlocks.map(b => b.bid), remoteBlocks.map(b => b.bid));
  const merged = [];
  const conflicts = [];

  for (const bid of order) {
    const b = base.get(bid);
    const l = local.get(bid);
    const r = remote.get(bid);
    const bn = b ? _norm(b.html) : null;
    const ln = l ? _norm(l.html) : null;
    const rn = r ? _norm(r.html) : null;

    // Beide gleich (inkl. beide gelöscht) → keine Kollision.
    if (ln === rn) { if (l) merged.push({ bid, tag: l.tag, html: l.html }); continue; }
    // Lokal unverändert ggü. base → remote gewinnt (auch Löschung).
    if (ln === bn) { if (r) merged.push({ bid, tag: r.tag, html: r.html }); continue; }
    // Remote unverändert ggü. base → lokal gewinnt (auch Löschung).
    if (rn === bn) { if (l) merged.push({ bid, tag: l.tag, html: l.html }); continue; }
    // Beide unterschiedlich geändert → echter Block-Konflikt.
    const tag = (l || r).tag;
    const entry = {
      bid, tag,
      html: l ? l.html : r.html, // provisorisch: lokale Version (least surprise)
      conflict: { local_html: l ? l.html : null, remote_html: r ? r.html : null, base_html: b ? b.html : null },
    };
    merged.push(entry);
    conflicts.push({ bid, tag, ...entry.conflict });
  }

  return { merged, conflicts };
}

// Provisorisches HTML (lokale Auswahl bei Konflikten) — für den Auto-Merge-Pfad.
export function mergedToHtml(merged) {
  return merged.map(e => e.html).filter(Boolean).join('');
}

// Finales HTML nach User-Auflösung. decisions: { [bid]: 'local'|'remote'|'both' }.
// Unbekannte/fehlende Entscheidung → 'local' (Default).
export function buildResolvedHtml(merged, decisions = {}) {
  const parts = [];
  for (const e of merged) {
    if (!e.conflict) { if (e.html) parts.push(e.html); continue; }
    const d = decisions[e.bid] || 'local';
    const { local_html, remote_html } = e.conflict;
    if (d === 'remote') { if (remote_html) parts.push(remote_html); }
    else if (d === 'both') { parts.push([local_html, remote_html].filter(Boolean).join('')); }
    else { if (local_html) parts.push(local_html); }
  }
  return parts.join('');
}

// Komfort-Wrapper: HTML-Strings rein, Merge-Resultat raus. `opts` wie parseBlocks.
export function mergeBlocks(baseHtml, localHtml, remoteHtml, opts = {}) {
  return mergeBlockLists(parseBlocks(baseHtml, opts), parseBlocks(localHtml, opts), parseBlocks(remoteHtml, opts));
}
