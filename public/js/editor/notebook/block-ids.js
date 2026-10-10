// Block-IDs (`data-bid`) im Live-Editor des Notebook-Editors pflegen.
//
// Der Block-Merge (shared/block-merge.js) führt Blöcke über ihre ID zusammen
// und hält pro ID genau einen Block. Zwei Wege bringen den Live-Editor davon ab:
//  - Chromium klont beim Enter das Absatz-Element samt Attributen — mitten im
//    Absatz wie am Absatzende. Danach tragen zwei Absätze dieselbe ID, und der
//    Merge behielte nur einen davon (der andere Text wäre still weg).
//  - Neue Blöcke haben keine ID; der Server vergibt sie beim Save
//    (lib/html-clean.js#ensureBlockIds). Kennt der Client sie nicht, gilt der
//    eigene neue Absatz beim nächsten Merge als „remote neu, lokal anders"
//    → falscher Konflikt.
//
// Darum vergibt der Client vor jedem Merge/Save selbst, was fehlt — nach
// derselben Regel wie der Server (gleiche Tags, gleiches Format, Duplikat ab
// dem zweiten Vorkommen neu). Der Server lässt bestehende, eindeutige IDs
// stehen, also sind Editor und gespeicherte Fassung danach deckungsgleich.
//
// Reine DOM-Funktionen ohne Karten-State; gesetzt werden nur Attribute — kein
// Inhalt, kein Caret, kein Undo-Schritt, kein input-Event.

// Spiegel von lib/html-clean.js#_BID_BLOCK_SEL (+ `div.poem`). Weicht er ab,
// vergibt der Server für die Differenz eigene IDs, und die Fassungen laufen
// wieder auseinander.
const BID_SEL = 'p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,pre,hr,figure,table,div.poem';

// Gleiches Format wie lib/html-clean.js#_newBid: 8 Zufallsbytes als Hex.
export function newBid() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const isBidBlock = (el) => el.matches?.(BID_SEL);
const bidNodes = (root) => [...root.querySelectorAll(BID_SEL)];
const textKey = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
const tagOf = (el) => el.tagName.toLowerCase();

function parseReference(html) {
  const byBid = new Map();
  const top = [];
  if (!html) return { byBid, top };
  const t = document.createElement('template');
  t.innerHTML = html;
  for (const el of t.content.children) {
    const bid = el.getAttribute('data-bid');
    if (!bid || !isBidBlock(el)) continue;
    const entry = { bid, tag: tagOf(el), text: textKey(el), el };
    top.push(entry);
    if (!byBid.has(bid)) byBid.set(bid, entry);
  }
  return { byBid, top };
}

// Bringt die IDs im Editor-Container `el` in Ordnung. `referenceHtml` ist die
// zuletzt bekannte Server-Fassung (originalHtml bzw. die Antwort des Saves):
//  1. Top-Level-Duplikat → die ID behält der Block, dessen Text zur Referenz
//     passt (Enter am Absatzanfang/-ende: der leere Klon gibt sie ab), sonst
//     das erste Vorkommen.
//  2. Top-Level ohne ID → freie Referenz-ID mit gleichem Tag + Text übernehmen
//     (Undo auf einen Stand vor dem letzten Save, Antwort des Saves).
//  3. Verschachtelte Blöcke (Absatz im Zitat, Liste in der Liste) übernehmen
//     die IDs der Referenz, wenn ihr Top-Level-Block strukturell gleich ist.
//  4. Was dann noch fehlt oder doppelt ist, bekommt eine neue ID.
// Trägt die Referenz gar keine IDs (Seite seit Einführung der IDs nie
// gespeichert, leere Seite), gibt es nichts abzugleichen: der Merge rechnet
// dort ohnehin ohne IDs, und neu vergebene machten den unveränderten Editor
// für den Dirty-Vergleich (`isNoChange`) „geändert". Die IDs kommen mit dem
// ersten Save vom Server.
// Rückgabe: Anzahl gesetzter/entfernter IDs (0 = nichts geändert).
export function syncLiveBlockIds(el, referenceHtml) {
  if (!el || !/\sdata-bid=/.test(referenceHtml || '')) return 0;
  const ref = parseReference(referenceHtml);
  let changed = 0;
  const top = [...el.children].filter(isBidBlock);

  const groups = new Map();
  for (const b of top) {
    const bid = b.getAttribute('data-bid');
    if (!bid) continue;
    if (!groups.has(bid)) groups.set(bid, []);
    groups.get(bid).push(b);
  }
  for (const [bid, list] of groups) {
    if (list.length < 2) continue;
    const r = ref.byBid.get(bid);
    const keeper = (r && list.find((b) => tagOf(b) === r.tag && textKey(b) === r.text)) || list[0];
    for (const b of list) {
      if (b !== keeper) { b.removeAttribute('data-bid'); changed++; }
    }
  }

  const used = new Set(bidNodes(el).map((n) => n.getAttribute('data-bid')).filter(Boolean));
  for (const b of top) {
    if (b.getAttribute('data-bid')) continue;
    const tag = tagOf(b);
    const text = textKey(b);
    const hit = ref.top.find((r) => !used.has(r.bid) && r.tag === tag && r.text === text);
    if (!hit) continue;
    b.setAttribute('data-bid', hit.bid);
    used.add(hit.bid);
    changed++;
  }

  for (const b of top) {
    const r = ref.byBid.get(b.getAttribute('data-bid'));
    if (!r) continue;
    const ln = bidNodes(b);
    const rn = bidNodes(r.el);
    if (ln.length !== rn.length || ln.some((n, i) => tagOf(n) !== tagOf(rn[i]))) continue;
    ln.forEach((n, i) => {
      const rb = rn[i].getAttribute('data-bid');
      if (n.getAttribute('data-bid') || !rb || used.has(rb)) return;
      n.setAttribute('data-bid', rb);
      used.add(rb);
      changed++;
    });
  }

  const seen = new Set();
  for (const n of bidNodes(el)) {
    let bid = n.getAttribute('data-bid');
    if (!bid || seen.has(bid)) {
      bid = newBid();
      n.setAttribute('data-bid', bid);
      changed++;
    }
    seen.add(bid);
  }
  return changed;
}
