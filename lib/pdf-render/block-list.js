'use strict';
// Listen: Aufzählungszeichen bzw. Nummer stehen im hängenden Einzug, der Text
// läuft auf allen Zeilen bündig dahinter. Der Marker wird vom Layouter selbst
// gesetzt (justify.js, `marker`) — auf der Seite und Zeile, auf der der erste
// Text des Punkts nach allen Umbruchentscheidungen tatsächlich landet. Ein
// vorab mit pdfkit gesetzter Marker läge sonst unter einer neu gesetzten Zeile.
//
// Verschachtelte Listen rücken pro Ebene um denselben Einzug weiter ein
// (Einzugs-Stapel der Seitengeometrie — gilt auch über einen Seitenwechsel).

const { _renderRuns } = require('./runs');
const { measureText } = require('./measure');
const { flowGeometry } = require('./page-geometry');

const LIST_INDENT_PT = 18;
const LIST_MARKER_GAP_PT = 5;
const LIST_GAP_AFTER_LINES = 0.3;
// Ebenen-Wechsel der Aufzählungszeichen. Nur Zeichen, die jede gängige
// Textschrift trägt (PDF/A: eine fehlende Glyphe fiele sonst still weg).
const BULLETS = ['•', '–', '•'];

async function renderList(doc, block, ctx, renderBlock) {
  const { font, textRole = 'body', footnotes = null, columns = 1, columnGap = 0, hyphenate = null, widowOrphanControl = true } = ctx;
  const roleCfg = (textRole !== 'body' && font[textRole]) ? font[textRole] : font.body;
  const fontKeyBase = (textRole !== 'body' && font[textRole]) ? textRole : 'body';
  const depth = ctx.listDepth || 0;
  const items = block.items || [];
  const first = block.start ?? 1;
  const markerOf = (i) => (block.ordered ? `${first + i}.` : BULLETS[depth % BULLETS.length]);

  // Einzug so breit, dass auch die längste Nummer („12.") samt Abstand passt.
  const widest = block.ordered ? markerOf(items.length - 1) : markerOf(0);
  const indent = Math.max(LIST_INDENT_PT, measureText(doc, widest, fontKeyBase, roleCfg.sizePt) + LIST_MARKER_GAP_PT + 2);
  const geo = flowGeometry(doc, ctx);
  geo.pushIndent(indent);
  try {
    for (let i = 0; i < items.length; i++) {
      const itemBlocks = items[i] || [];
      const marker = {
        text: markerOf(i), fontKey: fontKeyBase, sizePt: roleCfg.sizePt,
        color: roleCfg.color || '#000000', gap: LIST_MARKER_GAP_PT,
      };
      const subCtx = { ...ctx, listDepth: depth + 1, bodyFirstLineIndentPt: 0, hangingIndentPt: 0 };
      const [first, ...rest] = itemBlocks;
      if (first && first.kind === 'paragraph') {
        _renderRuns(doc, first.runs, {
          sizePt: roleCfg.sizePt,
          lineHeight: roleCfg.lineHeight || font.body.lineHeight,
          align: 'left',
          textColor: roleCfg.color || '#000000',
          fontKeyBase,
          hyphenate, columns, columnGap,
          footnotes,
          marker,
          widowOrphan: widowOrphanControl && columns === 1,
        });
      } else {
        // Punkt beginnt mit einem Block (verschachtelte Liste, Zitat, Bild):
        // Marker auf die Höhe, an der dieser Block beginnt.
        const mw = measureText(doc, marker.text, fontKeyBase, roleCfg.sizePt);
        doc.font(fontKeyBase).fontSize(roleCfg.sizePt).fillColor(marker.color);
        doc.text(marker.text, doc.page.margins.left - marker.gap - mw, doc.y, { lineBreak: false });
        doc.x = doc.page.margins.left;
        if (first) await renderBlock(doc, first, subCtx, rest[0]);
      }
      for (let k = 0; k < rest.length; k++) await renderBlock(doc, rest[k], subCtx, rest[k + 1]);
    }
  } finally {
    geo.popIndent();
  }
  if (depth === 0) doc.moveDown(LIST_GAP_AFTER_LINES);
}

module.exports = { renderList, LIST_INDENT_PT, LIST_MARKER_GAP_PT };
