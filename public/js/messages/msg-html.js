// Nachrichtenverlauf (SMS, WhatsApp, Gruppenchat) im Seiten-HTML — SSoT fuer
// Markup, Selektoren und Zeilenarten. Erzeugt und gesucht wird der Block im
// Notebook-Editor (Slash-Menue, Zeilenleiste, Tastatur), gelesen von den
// Leseansichten, dem Share-Reader und allen Exportwegen.
//
// Persistiertes Markup:
//
//   <div class="msg-thread">
//     <p class="msg-name">Lena</p>
//     <p class="msg-in">bist du schon da?</p>
//     <p class="msg-out">gleich, 5 min</p>
//     <p class="msg-meta">Dienstag, 14:32</p>
//   </div>
//
// JEDE ZEILE IST EIN EIGENER <p>. Der Absender steht als eigene Zeile UEBER
// seiner Nachricht (wie im Gruppenchat am Handy), nicht als Inline-Span davor:
// an einer Span-Kante weiss der Caret nicht, ob er im Namen oder schon im Text
// schreibt. Er steht auf der Seite seiner Nachricht — benennen lassen sich so
// beide Seiten, eine oder keine (msgNameSides). Ein Gespraech zu zweit braucht
// gar keine Namen, dort reicht die Richtung.
//
// NUR KLASSEN, KEINE data-*-ATTRIBUTE. Die EPUB-Bibliothek verwirft jedes
// `data-*` (lib/export-builders/epub/content.js#_applyDataClasses), WordPress
// filtert Attribute — Klassen kommen durch alle Ausgabewege.
//
// EIN <p> OHNE ZEILENKLASSE IM VERLAUF IST EINGEHEND. So bleibt ein Verlauf
// lesbar, dessen Zeilenklassen ein fremder Pfad (Import, Paste aus einer
// anderen App) verloren hat.
//
// Serverseitige Kopien der Klassennamen (html-clean, html-walker, txt-Export,
// EPUB-/HTML-Export-CSS) sind bewusst — CJS kann dieses Modul nicht synchron
// laden. Gegated durch tests/unit/msg-thread-drift.test.mjs.

export const MSG_THREAD_CLASS = 'msg-thread';
export const MSG_THREAD_SEL = `div.${MSG_THREAD_CLASS}`;
export const MSG_LINE_SEL = `${MSG_THREAD_SEL} > p`;

// Zeilenarten in der Reihenfolge der Zeilenleiste.
export const MSG_KINDS = ['in', 'out', 'name', 'meta'];
export const MSG_KIND_CLASS = {
  in: 'msg-in',
  out: 'msg-out',
  name: 'msg-name',
  meta: 'msg-meta',
};
const KIND_BY_CLASS = Object.fromEntries(Object.entries(MSG_KIND_CLASS).map(([k, c]) => [c, k]));

export function isMsgThreadEl(el) {
  return !!(el && el.nodeType === 1 && el.matches?.(MSG_THREAD_SEL));
}

// Zeile (<p> direkt im Verlauf) ab `node` aufwaerts, begrenzt auf echte
// Nachfahren von `root`. Textknoten erlaubt.
export function closestMsgLine(node, root = null) {
  const el = node && node.nodeType === 3 ? node.parentNode : node;
  const hit = el?.closest?.(MSG_LINE_SEL);
  if (!hit) return null;
  if (root && (hit === root || !root.contains(hit))) return null;
  return hit;
}

// Zeilenart einer Zeile. Ohne Zeilenklasse: eingehend (siehe Kopf).
export function msgKind(line) {
  for (const c of line?.classList || []) {
    if (KIND_BY_CLASS[c]) return KIND_BY_CLASS[c];
  }
  return 'in';
}

// Zeilenart setzen. Fremde Klassen an der Zeile bleiben stehen (z.B. die
// Fokus-Markierungen, die beim Speichern ohnehin fallen).
export function setMsgKind(line, kind) {
  if (!line || !MSG_KIND_CLASS[kind]) return;
  for (const c of Object.values(MSG_KIND_CLASS)) line.classList.remove(c);
  line.classList.add(MSG_KIND_CLASS[kind]);
}

// Zeilenart nach Tab: wechselt nur die Seite (Eingang <-> Ausgang). Absender
// und Hinweis setzt allein die Zeilenleiste — ein Zyklus ueber alle vier Arten
// machte aus einer Nachricht nach zwei Tabs eine Namenszeile, die wie eine
// Ueberschrift aussieht. Aus Absender/Hinweis fuehrt Tab zurueck zur Nachricht.
export function toggleMsgSide(kind) {
  return kind === 'in' ? 'out' : 'in';
}

// Seite jeder Absenderzeile aus der Folge der Zeilenarten: die Seite der
// ersten Nachricht danach, Hinweise dazwischen uebersprungen; folgt zuerst ein
// weiterer Absender oder nichts mehr, eingehend. Liefert pro Zeile 'in'|'out'
// fuer Absender, null fuer alle anderen. Der Absender traegt seine Seite nicht
// als Klasse: sie ergibt sich aus der Nachricht darunter, und wechselt die per
// Tab die Seite, wandert der Name mit.
//
// Serverseitige Kopie: lib/msg-lines.js#msgNameSides (CJS) — gegated durch
// tests/unit/msg-thread-drift.test.mjs.
export function msgNameSides(kinds) {
  return kinds.map((kind, i) => {
    if (kind !== 'name') return null;
    for (let j = i + 1; j < kinds.length; j++) {
      if (kinds[j] === 'in' || kinds[j] === 'out') return kinds[j];
      if (kinds[j] === 'name') break;
    }
    return 'in';
  });
}

// Seite einer Absenderzeile im DOM (siehe msgNameSides).
export function msgNameSide(line) {
  const kinds = [];
  for (let n = line; n; n = n.nextElementSibling) kinds.push(msgKind(n));
  return msgNameSides(kinds)[0] || 'in';
}

// Zeilenart der Zeile, die Enter hinter `line` anlegt. Nach einer Nachricht
// schreibt dieselbe Seite weiter; nach einem Absender folgt seine Nachricht auf
// seiner Seite; nach einem Hinweis die Richtung der Nachricht davor (oder
// eingehend).
export function nextLineKind(line) {
  const kind = msgKind(line);
  if (kind === 'in' || kind === 'out') return kind;
  if (kind === 'name') return msgNameSide(line);
  let prev = line.previousElementSibling;
  while (prev) {
    const k = msgKind(prev);
    if (k === 'in' || k === 'out') return k;
    prev = prev.previousElementSibling;
  }
  return 'in';
}

// Leere Zeile der Art `kind`, mit <br> als Caret-Slot.
export function createMsgLine(kind = 'in', doc = document) {
  const p = doc.createElement('p');
  setMsgKind(p, kind);
  p.appendChild(doc.createElement('br'));
  return p;
}

// Neuer Verlauf mit einer leeren eingehenden Zeile.
export function createMsgThread(doc = document) {
  const thread = doc.createElement('div');
  thread.className = MSG_THREAD_CLASS;
  const line = createMsgLine('in', doc);
  thread.appendChild(line);
  return { thread, line };
}
