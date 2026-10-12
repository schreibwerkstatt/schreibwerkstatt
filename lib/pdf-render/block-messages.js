'use strict';
// Nachrichtenverlauf (Walker-Block `messages`, aus div.msg-thread): SMS,
// WhatsApp, Gruppenchat im Manuskript. Zwei Satzarten aus dem Profil
// (`config.messages.style`, lib/pdf-export-defaults/messages.js):
//
//   plain   — Buchkonvention, ohne Flächen: eingehend linksbündig, ausgehend
//             rechtsbündig mit Abstand zum linken Rand, Absender klein und fett
//             über seiner Nachricht, Zeitangaben zentriert und kursiv. Der
//             Text bricht wie Fliesstext, auch über Seitengrenzen.
//   bubbles — dieselbe Anordnung, jede Nachricht auf einer leichten grauen
//             Fläche mit runden Ecken. Eine Blase wird nie geteilt: passt sie
//             nicht mehr auf die Seite, beginnt sie auf der nächsten. Eine Blase,
//             die höher wäre als der Satzspiegel, fällt auf `plain` zurück.
//
// Alle Zeilen laufen durch den einen Layouter (justify.js) — die Verschiebung
// nach rechts geschieht über `indentFor`, nicht über die Seitenränder.

const { layoutRuns, drawLayout } = require('./justify');
const { ensureRoom } = require('./keep');

// Schriftgrad relativ zum Fliesstext: Nachrichten einen Hauch kleiner (wie
// Tabellen), Absender und Zeitangaben deutlich kleiner.
const MSG_SIZE_SCALE = 0.94;
const LABEL_SIZE_SCALE = 0.82;
// Eine Nachricht nimmt höchstens diesen Anteil der Satzbreite ein — so steht
// der Wechsel der Seite (links/rechts) auch bei langen Nachrichten im Bild.
const MSG_MAX_WIDTH = 0.78;
const LABEL_COLOR = '#555555';
const META_COLOR = '#777777';
// Abstände in Zeilen (doc.moveDown).
const GAP_BETWEEN_LINES = 0.25;
const GAP_BEFORE_NAME = 0.35;
const GAP_AROUND_BLOCK = 1; // nach dem Block: × Fliesstextgrad in pt
// Sprechblasen: Innenabstand, Eckenradius, Flächen. Graustufen, weil der Druck
// meist schwarzweiss ist; ausgehend einen Ton dunkler.
const BUBBLE_PAD_X = 6;
const BUBBLE_PAD_Y = 3.5;
const BUBBLE_RADIUS = 5;
const BUBBLE_FILL = { in: '#efefef', out: '#e0e0e0' };

function _textWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function _atTop(doc) { return doc.y <= doc.page.margins.top + 0.5; }

function _opts(ctx, sizePt, extra) {
  const body = ctx.font.body;
  return {
    sizePt,
    lineHeight: body.lineHeight,
    textColor: body.color || '#000000',
    fontKeyBase: 'body',
    columns: 1,
    // Keine Silbentrennung: eine getrennte Chatnachricht sieht nicht mehr aus
    // wie eine Nachricht (EPUB/Bildschirm trennen dort ebenfalls nicht).
    hyphenate: null,
    footnotes: ctx.footnotes || null,
    ...extra,
  };
}

// Absender / Zeitangabe: kleine Zeile, die mit der folgenden Nachricht
// zusammenbleibt (keine Absenderzeile allein am Seitenfuss).
function _renderLabel(doc, line, ctx, W) {
  const size = ctx.font.body.sizePt * LABEL_SIZE_SCALE;
  const meta = line.kind === 'meta';
  const runs = line.runs.map((r) => (meta ? { ...r, italic: true } : { ...r, bold: true }));
  const opts = _opts(ctx, size, {
    width: W,
    align: meta ? 'center' : 'left',
    textColor: meta ? META_COLOR : LABEL_COLOR,
  });
  const layout = layoutRuns(doc, runs, opts);
  const msgSize = ctx.font.body.sizePt * MSG_SIZE_SCALE;
  ensureRoom(doc, layout.lines.length * layout.advance + msgSize * 2.5);
  drawLayout(doc, layout, opts);
}

// Nachricht ohne Fläche. Ausgehend: rechtsbündig in den rechten 78 % der Breite.
function _renderPlain(doc, line, ctx, W) {
  const out = line.kind === 'out';
  const shift = out ? W * (1 - MSG_MAX_WIDTH) : 0;
  const opts = _opts(ctx, ctx.font.body.sizePt * MSG_SIZE_SCALE, {
    width: out ? W : W * MSG_MAX_WIDTH,
    align: out ? 'right' : 'left',
    indentFor: () => shift,
    widowOrphan: ctx.widowOrphanControl !== false,
  });
  drawLayout(doc, layoutRuns(doc, line.runs, opts), opts);
}

// Nachricht in einer Blase. Erst umbrechen (Breite = Höchstbreite minus
// Innenabstand), dann die Blase so breit wie die längste Zeile machen.
function _renderBubble(doc, line, ctx, W) {
  const out = line.kind === 'out';
  const innerMax = W * MSG_MAX_WIDTH - 2 * BUBBLE_PAD_X;
  const sizePt = ctx.font.body.sizePt * MSG_SIZE_SCALE;
  const probe = _opts(ctx, sizePt, { width: innerMax, align: 'left' });
  const measured = layoutRuns(doc, line.runs, probe);
  if (!measured.lines.length) return;
  const textW = Math.max(...measured.lines.map((l) => l.width));
  const textH = (measured.lines.length - 1) * measured.advance + measured.fitHeight;
  const bubbleW = Math.min(W * MSG_MAX_WIDTH, textW + 2 * BUBBLE_PAD_X);
  const bubbleH = textH + 2 * BUBBLE_PAD_Y;
  const pageH = doc.page.maxY() - doc.page.margins.top;
  if (bubbleH > pageH) { _renderPlain(doc, line, ctx, W); return; }
  ensureRoom(doc, bubbleH);

  const offset = out ? W - bubbleW : 0;
  const x = doc.page.margins.left + offset;
  const y = doc.y;
  doc.save();
  doc.roundedRect(x, y, bubbleW, bubbleH, BUBBLE_RADIUS).fill(BUBBLE_FILL[out ? 'out' : 'in']);
  doc.restore();

  // Text in die Blase: dieselben Umbruchstellen wie gemessen (gleiche Breite),
  // nach rechts verschoben um Blasen-Versatz + Innenabstand. Ohne Witwen-/
  // Waisenlogik — der Platz der ganzen Blase ist oben schon gesichert.
  const shift = offset + BUBBLE_PAD_X;
  const opts = _opts(ctx, sizePt, {
    width: shift + innerMax,
    align: 'left',
    indentFor: () => shift,
  });
  doc.y = y + BUBBLE_PAD_Y;
  drawLayout(doc, layoutRuns(doc, line.runs, opts), opts);
  doc.y = y + bubbleH;
  doc.x = doc.page.margins.left;
}

async function renderMessages(doc, block, ctx) {
  const lines = block.lines || [];
  if (!lines.length) return;
  const bubbles = ctx.messages?.style === 'bubbles';
  const W = _textWidth(doc);
  if (!_atTop(doc)) doc.moveDown(GAP_AROUND_BLOCK);
  lines.forEach((line, i) => {
    if (i > 0) doc.moveDown(line.kind === 'name' ? GAP_BEFORE_NAME : GAP_BETWEEN_LINES);
    if (line.kind === 'name' || line.kind === 'meta') _renderLabel(doc, line, ctx, W);
    else if (bubbles) _renderBubble(doc, line, ctx, W);
    else _renderPlain(doc, line, ctx, W);
  });
  // In Punkt des Fliesstexts, nicht per moveDown: das rechnete mit der zuletzt
  // gesetzten (kleineren) Schrift, und der Abstand danach fiele knapper aus als
  // der davor.
  if (!_atTop(doc)) doc.y += ctx.font.body.sizePt * GAP_AROUND_BLOCK;
  // Nach einem Verlauf beginnt der Folgeabsatz ohne Erstzeilen-Einzug, wie
  // nach einem Blockzitat.
  if (ctx.firstParaHint) ctx.firstParaHint.pending = true;
}

module.exports = { renderMessages, MSG_MAX_WIDTH };
