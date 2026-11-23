'use strict';
// Beschreibt fürs Log, was eine neue Buch-Reihenfolge (book_order-Baum, Format
// db/book-order.js) gegenüber der alten ändert: welche Knoten in ein anderes
// Elternkapitel gewandert sind und in welchen Ebenen sich die Geschwister-
// Reihenfolge geändert hat. Reine Funktion, kein DB-Zugriff.

const LIST_MAX = 10;

// Knoten-Schlüssel → { parent, label }, je Eltern-Schlüssel die Kind-Folge.
function _index(tree) {
  const nodes = new Map();
  const orders = new Map();
  const walk = (list, parent) => {
    const seq = [];
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || (e.type !== 'chapter' && e.type !== 'page')) continue;
      const key = `${e.type}:${e.id}`;
      nodes.set(key, { parent });
      seq.push(key);
      if (e.type === 'chapter') walk(e.children, key);
    }
    orders.set(parent, seq);
  };
  walk(tree, 'root');
  return { nodes, orders };
}

function _label(key) {
  if (key === 'root') return 'oberste Ebene';
  const [type, id] = key.split(':');
  return `${type === 'chapter' ? 'Kapitel' : 'Abschnitt'} ${id}`;
}

function _parentLabel(key) {
  return key === 'root' ? 'oben' : `Kapitel ${key.split(':')[1]}`;
}

function _capped(items) {
  if (items.length <= LIST_MAX) return items.join(', ');
  return `${items.slice(0, LIST_MAX).join(', ')} …+${items.length - LIST_MAX}`;
}

// Liefert eine einzeilige Beschreibung, z.B.
// `12 Kapitel, 340 Abschnitte; umgehängt: Abschnitt 4711 (Kapitel 42→Kapitel 50); umsortiert in: Kapitel 42`
// oder `…; unverändert`. `before` darf null sein (noch kein gespeicherter Baum).
function describeOrderChange(before, after) {
  const a = _index(after);
  let chapters = 0, pages = 0;
  for (const key of a.nodes.keys()) key.startsWith('chapter:') ? chapters++ : pages++;
  const head = `${chapters} Kapitel, ${pages} Abschnitte`;
  if (!before) return `${head}; erster gespeicherter Baum`;

  const b = _index(before);
  const moved = [];
  for (const [key, { parent }] of a.nodes) {
    const prev = b.nodes.get(key);
    if (!prev) moved.push(`${_label(key)} (neu → ${_parentLabel(parent)})`);
    else if (prev.parent !== parent) moved.push(`${_label(key)} (${_parentLabel(prev.parent)}→${_parentLabel(parent)})`);
  }
  for (const key of b.nodes.keys()) {
    if (!a.nodes.has(key)) moved.push(`${_label(key)} (fehlt jetzt)`);
  }
  // Umsortiert: relative Folge der Kinder, die vorher wie nachher in dieser
  // Ebene lagen — ein Zu-/Abgang allein zählt nicht als Umsortieren.
  const reordered = [];
  for (const [parent, seq] of a.orders) {
    const prevSeq = b.orders.get(parent);
    if (!prevSeq) continue;
    const prevSet = new Set(prevSeq);
    const nowSet = new Set(seq);
    const nowStay = seq.filter(k => prevSet.has(k));
    const prevStay = prevSeq.filter(k => nowSet.has(k));
    if (nowStay.some((k, i) => k !== prevStay[i])) reordered.push(_label(parent));
  }
  const parts = [head];
  if (moved.length) parts.push(`umgehängt: ${_capped(moved)}`);
  if (reordered.length) parts.push(`umsortiert in: ${_capped(reordered)}`);
  if (!moved.length && !reordered.length) parts.push('unverändert');
  return parts.join('; ');
}

module.exports = { describeOrderChange };
