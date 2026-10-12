'use strict';
// Nachrichtenverlauf (Walker-Block `messages`, aus div.msg-thread) → Word-
// Absätze. Ausgelagert aus lib/export-builders/docx.js, die auf ihrer
// LOC-Obergrenze steht. Pendant zu lib/pdf-render/block-messages.js:
//
//   plain   — eingehend linksbündig mit Einzug rechts, ausgehend rechtsbündig mit
//             Einzug links; Absender klein und fett auf der Seite seiner Nachricht, Zeitangaben zentriert und
//             kursiv. Absender und Zeit halten mit der Folgezeile zusammen
//             (`keepNext`).
//   bubbles — jede Nachricht eine einzelne Tabellenzelle mit leichter grauer
//             Hinterlegung, so breit wie ihr Text (höchstens 78 %), ausgehend
//             rechts. Warum keine Absatzschattierung: Word fasst aufeinander-
//             folgende Absätze mit gleicher Schattierung zu EINEM Kasten
//             zusammen, und der Kasten füllt den ganzen eingezogenen Bereich —
//             das sah aus wie ein Tabellenstreifen, nicht wie Blasen. Runde
//             Ecken kann Word nicht.
//
// Profil: `config.messages.style` (lib/docx-export-defaults.js, Validator geteilt
// mit dem PDF-Profil).

const {
  Paragraph, TextRun, AlignmentType, ShadingType, BorderStyle, LineRuleType,
  Table, TableRow, TableCell, WidthType, TableLayoutType,
} = require('docx');
const { contentWidthTwip } = require('../docx-export-defaults');

// Anteil der Satzbreite, den eine Nachricht höchstens einnimmt — derselbe Wert
// wie im PDF (lib/pdf-render/block-messages.js#MSG_MAX_WIDTH), hier als Einzug
// der Gegenseite ausgedrückt.
const MSG_SIDE_INDENT_PCT = 0.22;
const LABEL_SIZE_SCALE = 0.82;
// Absender kleiner als der Hinweis, eng an seiner Nachricht — wie im PDF
// (lib/pdf-render/block-messages.js#NAME_SIZE_SCALE) und am Bildschirm.
const NAME_SIZE_SCALE = 0.75;
const LABEL_COLOR = '555555';
const META_COLOR = '777777';
const BUBBLE_FILL = { in: 'EFEFEF', out: 'E0E0E0' };
// Abstände in Twips (1/20 pt).
const GAP_AFTER = 80;
const GAP_BEFORE_NAME = 60;
const GAP_AFTER_NAME = 0;
const GAP_AROUND_BLOCK = 200;

// Sprechblase: Innenabstand der Zelle (Twips) und geschätzte mittlere
// Zeichenbreite als Anteil des Schriftgrads. Word misst nicht für uns — die
// Zellbreite wird aus der längsten Zeile geschätzt; zu knapp geschätzt bricht
// Word die Zeile einfach um, darum lieber etwas grosszügig.
const BUBBLE_PAD_X = 140;
const BUBBLE_PAD_Y = 60;
const CHAR_WIDTH_EM = 0.52;
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' };
const NO_BORDERS = {
  top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
  insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
};

function _bubbleWidthTwip(runs, sizePt, maxTwip) {
  const text = (runs || []).map((r) => r.text).join('');
  const longest = Math.max(1, ...text.split('\n').map((l) => l.length));
  const est = Math.round(longest * sizePt * CHAR_WIDTH_EM * 20) + 2 * BUBBLE_PAD_X;
  return Math.min(maxTwip, est);
}

// Eine Nachricht als 1×1-Tabelle. Danach ein Abstandsabsatz: zwei unmittelbar
// aufeinanderfolgende Tabellen verschmilzt Word zu einer.
function _bubble(line, cfg, runsToChildren, maxTwip, gapAfter) {
  const out = line.kind === 'out';
  const width = _bubbleWidthTwip(line.runs, cfg.font.sizePt, maxTwip);
  const table = new Table({
    width: { size: width, type: WidthType.DXA },
    columnWidths: [width],
    layout: TableLayoutType.FIXED,
    alignment: out ? AlignmentType.RIGHT : AlignmentType.LEFT,
    borders: NO_BORDERS,
    rows: [new TableRow({
      cantSplit: true,
      children: [new TableCell({
        width: { size: width, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: BUBBLE_FILL[out ? 'out' : 'in'] },
        margins: { top: BUBBLE_PAD_Y, bottom: BUBBLE_PAD_Y, left: BUBBLE_PAD_X, right: BUBBLE_PAD_X },
        children: [new Paragraph({
          indent: { firstLine: 0 },
          spacing: { before: 0, after: 0, line: 240 },
          children: runsToChildren(line.runs),
        })],
      })],
    })],
  });
  const spacer = new Paragraph({
    spacing: { before: 0, after: 0, line: gapAfter, lineRule: LineRuleType.EXACT },
    children: [],
  });
  return [table, spacer];
}

/**
 * @param {{ lines: { kind: string, runs: object[] }[] }} block
 * @param {object} cfg  validiertes DOCX-Profil
 * @param {{ runsToChildren: Function }} helpers  Run-Mapper aus docx.js (Links,
 *   Fussnotenmarker, Auszeichnung) für die Nachrichten selbst
 */
function messagesToDocx(block, cfg, { runsToChildren }) {
  const bubbles = cfg.messages?.style === 'bubbles';
  const sizeHalfPt = Math.round(cfg.font.sizePt * 2);
  const labelSize = Math.round(sizeHalfPt * LABEL_SIZE_SCALE);
  const nameSize = Math.round(sizeHalfPt * NAME_SIZE_SCALE);
  const side = Math.round(contentWidthTwip(cfg) * MSG_SIDE_INDENT_PCT);
  const lines = block.lines || [];
  const maxBubble = Math.round(contentWidthTwip(cfg) * (1 - MSG_SIDE_INDENT_PCT));
  return lines.flatMap((line, i) => {
    const first = i === 0;
    const last = i === lines.length - 1;
    const spacing = {
      before: first ? GAP_AROUND_BLOCK : (line.kind === 'name' ? GAP_BEFORE_NAME : 0),
      after: last ? GAP_AROUND_BLOCK : (line.kind === 'name' ? GAP_AFTER_NAME : GAP_AFTER),
      line: 240,
    };
    if (line.kind === 'name' || line.kind === 'meta') {
      const meta = line.kind === 'meta';
      return new Paragraph({
        alignment: meta ? AlignmentType.CENTER : (line.side === 'out' ? AlignmentType.RIGHT : AlignmentType.LEFT),
        spacing,
        keepNext: true,
        children: _labelRuns(line.runs, { size: meta ? labelSize : nameSize, meta }),
      });
    }
    if (bubbles) return _bubble(line, cfg, runsToChildren, maxBubble, last ? GAP_AROUND_BLOCK : GAP_AFTER);
    const out = line.kind === 'out';
    return new Paragraph({
      alignment: out ? AlignmentType.RIGHT : AlignmentType.LEFT,
      indent: out ? { left: side, firstLine: 0 } : { right: side, firstLine: 0 },
      spacing,
      children: runsToChildren(line.runs),
    });
  });
}

// Absender/Zeitangabe: kleiner, grau, fett bzw. kursiv. Eigene TextRuns statt
// des allgemeinen Run-Mappers, weil der weder Grösse noch Farbe kennt; Links
// und Notenmarker in einer Absenderzeile werden zu Text.
function _labelRuns(runs, { size, meta }) {
  const color = meta ? META_COLOR : LABEL_COLOR;
  return (runs || []).map((r) => (r.text === '\n'
    ? new TextRun({ break: 1 })
    : new TextRun({ text: r.text, size, color, bold: !meta || !!r.bold || undefined, italics: meta || !!r.italic || undefined })));
}

module.exports = { messagesToDocx, MSG_SIDE_INDENT_PCT };
