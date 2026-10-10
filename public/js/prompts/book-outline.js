// Gliederungs-Block des klassischen Buch-Chats: Kapitel jeder Tiefe und ihre
// Abschnitte in Lesereihenfolge, eingerückt nach Ebene. Steht im buch-stabilen
// System-Block 1 (gecacht) — die Textauszüge in Block 2 wechseln pro Frage und
// sagen allein nicht, wo im Buch sie stehen.
// `outline` = Knoten aus lib/content-store/outline.js#buildOutline
// ({ type:'chapter'|'page', name, depth, chapter_id? }).

const HEAD = '=== GLIEDERUNG DES BUCHS (Lesereihenfolge; ▸ Kapitel, eingerückt = Unterkapitel, · Abschnitt) ===';

function _lines(outline, withPages) {
  const out = [];
  const pageCount = new Map();
  if (!withPages) {
    for (const n of outline) if (n.type === 'page' && n.chapter_id != null) pageCount.set(n.chapter_id, (pageCount.get(n.chapter_id) || 0) + 1);
  }
  for (const n of outline) {
    if (n.type === 'chapter') {
      const cnt = withPages ? '' : ` (${pageCount.get(n.id) || 0} Abschnitte)`;
      out.push(`${'  '.repeat(n.depth - 1)}▸ ${n.name}${cnt}`);
    } else if (withPages || n.chapter_id == null) {
      out.push(`${'  '.repeat(n.depth)}· ${n.name}`);
    }
  }
  return out;
}

/**
 * Text des Gliederungs-Blocks oder null (leeres Buch). Passt die volle Gliederung
 * nicht in `maxChars`, fallen zuerst die Abschnittsnamen innerhalb der Kapitel weg
 * (Kapitel tragen dann ihre Abschnittszahl); reicht auch das nicht, wird hinten
 * gekürzt und das ausgewiesen.
 */
export function buildGliederungBlock(outline, { maxChars = 8000 } = {}) {
  const nodes = Array.isArray(outline) ? outline : [];
  if (!nodes.length) return null;
  let body = _lines(nodes, true);
  let note = null;
  if ([HEAD, ...body].join('\n').length > maxChars) {
    body = _lines(nodes, false);
    note = '(Abschnittsnamen innerhalb der Kapitel ausgelassen — Buch zu gross.)';
  }
  let text = [HEAD, ...(note ? [note] : []), ...body].join('\n');
  if (text.length > maxChars) {
    const cut = text.lastIndexOf('\n', maxChars - 60);
    text = text.slice(0, cut > 0 ? cut : maxChars - 60) + '\n… (Gliederung gekürzt)';
  }
  return text;
}
