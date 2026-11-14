// Liegt eine Position im HTML-String innerhalb eines <div> mit Klasse `cls`?
// Parserfrei (laeuft auf demselben String wie html-find.js). Das Ende eines
// Containers zaehlt verschachtelte <div> mit: `div.poem` und `div.msg-thread`
// tragen nach dem Markup-Vertrag nur <p>-Zeilen, ein inneres <div> (Paste aus
// einer fremden App, aelterer gespeicherter Stand) beendet sie trotzdem nicht.
// Konsumenten: html-find.js (Vers-Umbruch im Gedicht), editor/lektorat.js
// (Befund im Nachrichtenverlauf).
const _openRe = new Map();
const _DIV_TAG_RE = /<div\b[^>]*>|<\/div\s*>/gi;

function _divOpenRe(cls) {
  let re = _openRe.get(cls);
  if (!re) {
    const c = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`^<div\\b[^>]*\\bclass\\s*=\\s*(?:"(?:[^"]*\\s)?${c}(?:\\s[^"]*)?"|'(?:[^']*\\s)?${c}(?:\\s[^']*)?'|${c}(?=[\\s/>]))`, 'i');
    _openRe.set(cls, re);
  }
  return re;
}

export function insideClassDiv(html, pos, cls) {
  const before = String(html || '').slice(0, pos);
  const openRe = _divOpenRe(cls);
  // Stapel der offenen <div> bis `pos`: true = Container mit `cls`.
  const stack = [];
  for (const m of before.matchAll(_DIV_TAG_RE)) {
    if (m[0][1] === '/') stack.pop();
    else if (!/\/\s*>$/.test(m[0])) stack.push(openRe.test(m[0]));
  }
  return stack.includes(true);
}
