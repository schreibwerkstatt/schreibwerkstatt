// Liegt eine Position im HTML-String innerhalb eines <div> mit Klasse `cls`?
// Parserfrei (laeuft auf demselben String wie html-find.js) und nur fuer die
// Container-Bloecke, die selbst kein inneres <div> tragen — `div.poem` und
// `div.msg-thread` enthalten ausschliesslich <p>-Zeilen, das erste </div>
// hinter dem Open schliesst sie. Konsumenten: html-find.js (Vers-Umbruch im
// Gedicht), editor/lektorat.js (Befund im Nachrichtenverlauf).
const _openRe = new Map();

function _divOpenRe(cls) {
  let re = _openRe.get(cls);
  if (!re) {
    const c = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`<div\\b[^>]*\\bclass\\s*=\\s*(?:"(?:[^"]*\\s)?${c}(?:\\s[^"]*)?"|'(?:[^']*\\s)?${c}(?:\\s[^']*)?')[^>]*>`, 'gi');
    _openRe.set(cls, re);
  }
  return re;
}

export function insideClassDiv(html, pos, cls) {
  const before = String(html || '').slice(0, pos);
  let open = -1;
  for (const m of before.matchAll(_divOpenRe(cls))) open = m.index + m[0].length;
  return open !== -1 && before.indexOf('</div', open) === -1;
}
