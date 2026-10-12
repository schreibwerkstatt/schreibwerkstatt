'use strict';
// Block-Renderer: dispatched walker-Output (heading/paragraph/list/blockquote/
// poem/pre/messages/image/table/hr) auf die jeweilige Render-Sequenz. Rekursiv für
// list-/blockquote-Sub-Blocks. Eigene Module für die grösseren Fälle:
//   block-list.js  – Listen (Marker im hängenden Einzug, Ebenen-Einzug)
//   block-quote.js – Blockzitat, Gedicht, Codeblock (Einzugs-Stapel)
//   block-image.js – Bildgrösse, Höhenklemme, Legende mit dem Bild
//   block-messages.js – Nachrichtenverlauf (typografisch oder Sprechblasen)
//   table.js       – Tabellensatz (misst und paginiert selbst)
//   keep.js        – Keep-with-next-Vorausschau für Überschriften
//
// Jeder Textabsatz läuft über runs.js → justify.js (ein Textpfad). Der
// Folgeblock (`next`) wird mitgegeben, damit Überschriften und Bilder ihren
// Nachfolger in die Umbruchentscheidung nehmen können.

const { _renderDropCapParagraph } = require('./dropcap');
const { _renderRuns } = require('./runs');
const { layoutRuns, drawLayout } = require('./justify');
const { _fetchImage } = require('./images');
const { _currentPageIdx } = require('./layout');
const { renderTable } = require('./table');
const { renderList } = require('./block-list');
const { renderBlockquote, renderVerse } = require('./block-quote');
const { renderImage } = require('./block-image');
const { renderMessages } = require('./block-messages');
const { minLeadHeight, ensureRoom } = require('./keep');

// Autoren-Überschriften im Seitentext: Abstand danach (pt), nach Skala.
// subHeadings (h5/h6 unter einem gezeichneten Seitentitel) vs. Kapitelskala.
const SUB_HEADING_SPACE_AFTER = { 1: 8, other: 6 };
const HEADING_SPACE_AFTER = { 1: 24, 2: 14, other: 8 };
const HEADING_LINE_GAP_PT = 4;
const HEADING_SPACE_BEFORE_LINES = 0.6;
const DROPCAP_GAP_AFTER_LINES = 0.3;
const BLANKLINE_GAP_LINES = 1;
const HR_SPACE_BEFORE_PT = 6;
const HR_SPACE_AFTER_PT = 12;
const HR_WIDTH_PT = 0.5;
const RULE_COLOR = '#999999';
const DEFAULT_TEXT_COLOR = '#000000';

function _atTop(doc) { return doc.y <= doc.page.margins.top + 0.5; }

async function _renderHeading(doc, block, ctx, next) {
  const { font, firstParaHint, footnotes = null, columns = 1, columnGap = 0 } = ctx;
  const sizes = font.heading.sizes;
  // Zwei Skalen fuer dasselbe Markup, entschieden vom Kontext des Items:
  //
  //   subHeadings = true  → ueber diesem Text steht schon ein gezeichneter
  //     Seitentitel (h4). Die Ueberschriften des Autors sind dann eine Ebene
  //     TIEFER und laufen auf h5/h6 — sonst ueberragt ein `<h1>` im Seitentext
  //     mit 24 pt den 13-pt-Titel der Seite, in der es steht.
  //   subHeadings = false → hier zeichnet niemand einen Seitentitel
  //     (pageStructure='flatten', kapitellose Seiten). Dann ist die
  //     Autoren-Ueberschrift die oberste Marke im Fluss und behaelt die
  //     Kapitelskala h1/h2/h3.
  const sub = !!ctx.subHeadings;
  const sizePt = sub
    ? (block.level === 1 ? (sizes.h5 ?? sizes.h3) : (sizes.h6 ?? sizes.h3))
    : (block.level === 1 ? sizes.h1 : block.level === 2 ? sizes.h2 : sizes.h3);
  const space = sub
    ? (SUB_HEADING_SPACE_AFTER[block.level] ?? SUB_HEADING_SPACE_AFTER.other)
    : (HEADING_SPACE_AFTER[block.level] ?? HEADING_SPACE_AFTER.other);
  if (!_atTop(doc)) doc.moveDown(HEADING_SPACE_BEFORE_LINES);
  // Runs statt Klartext, wenn die Überschrift einen Notenmarker trägt (Walker
  // liefert `runs` nur dann) — sonst ginge die Note verloren.
  const runs = Array.isArray(block.runs) && block.runs.length ? block.runs : [{ text: block.text }];
  const opts = {
    sizePt,
    lineHeight: 1 + HEADING_LINE_GAP_PT / sizePt,
    align: 'left',
    textColor: font.heading.color || DEFAULT_TEXT_COLOR,
    fontKeyBase: 'heading',
    plainFont: true,
    hyphenate: null,
    footnotes, columns, columnGap,
  };
  if (columns === 1) {
    // Keep-with-next: Überschrift + zwei Zeilen des Folgeblocks oder Umbruch davor.
    const layout = layoutRuns(doc, runs, opts);
    const need = layout.lines.length * layout.advance + space + await minLeadHeight(doc, next, ctx);
    ensureRoom(doc, need);
    drawLayout(doc, layout, opts);
  } else {
    _renderRuns(doc, runs, opts);
  }
  doc.y += space;
  // Buchkonvention: erster Absatz nach Heading nicht eingerueckt.
  if (firstParaHint) firstParaHint.pending = true;
}

async function _renderParagraph(doc, block, ctx) {
  const { font, dropCapHint, firstParaHint, bodyFirstLineIndentPt = 0, hangingIndentPt = 0, textRole = 'body', columns = 1, columnGap = 0, hyphenate = null, widowOrphanControl = true, footnotes = null } = ctx;
  // Schriftbild des Fliesstexts. Standard ist die Body-Rolle; das
  // Quellenverzeichnis rendert unter der Rolle `bibliography` (Profile ohne den
  // Key fallen auf Body zurueck — dieselbe Fallback-Kette wie in fonts.js).
  const roleCfg = (textRole !== 'body' && font[textRole]) ? font[textRole] : font.body;
  if (dropCapHint?.pending && columns === 1) {
    const ok = await _renderDropCapParagraph(doc, block.runs, font, { hyphenate, widowOrphan: widowOrphanControl });
    if (ok) {
      dropCapHint.pending = false;
      if (firstParaHint) firstParaHint.pending = false;
      doc.moveDown(DROPCAP_GAP_AFTER_LINES);
      return;
    }
  }
  const skipIndent = firstParaHint?.pending;
  if (firstParaHint) firstParaHint.pending = false;
  _renderRuns(doc, block.runs, {
    sizePt: roleCfg.sizePt,
    lineHeight: roleCfg.lineHeight || font.body.lineHeight,
    align: 'justify',
    textColor: roleCfg.color || DEFAULT_TEXT_COLOR,
    firstLineIndent: skipIndent ? 0 : bodyFirstLineIndentPt,
    hangingIndentPt,
    fontKeyBase: textRole,
    columns, columnGap, hyphenate,
    // Der Layouter braucht den Fussnoten-Zustand, um den Platz der Noten
    // DIESER Zeile schon in die Umbruchentscheidung zu nehmen.
    footnotes,
    // Witwen/Waisen entscheidet der Layouter Zeile für Zeile (justify.js).
    widowOrphan: widowOrphanControl && columns === 1,
  });
  doc.moveDown(roleCfg.paragraphGap ?? font.body.paragraphGap);
}

async function _renderBlock(doc, block, ctx, next = null) {
  if (ctx.signal?.aborted) {
    const err = new Error('PDF render aborted');
    err.name = 'AbortError';
    throw err;
  }
  switch (block.kind) {
    case 'blankline':
      // Vom Autor gesetzte Leerzeile = Szenentrenner. Nur wirksam, wenn der
      // Erstzeilen-Einzug aktiv ist: sichtbarer Abstand + Folgeabsatz ohne Einzug.
      // Ohne Einzug trennt bereits der Absatzabstand — dann kein Extra-Gap.
      if ((ctx.bodyFirstLineIndentPt || 0) > 0) {
        if (!_atTop(doc)) doc.moveDown(BLANKLINE_GAP_LINES);
        if (ctx.firstParaHint) ctx.firstParaHint.pending = true;
      }
      return;
    case 'heading':
      return _renderHeading(doc, block, ctx, next);
    case 'paragraph':
      return _renderParagraph(doc, block, ctx);
    case 'list':
      return renderList(doc, block, ctx, _renderBlock);
    case 'blockquote':
      return renderBlockquote(doc, block, ctx, _renderBlock);
    case 'poem':
    case 'pre':
      return renderVerse(doc, block, ctx);
    case 'messages':
      return renderMessages(doc, block, ctx);
    case 'image':
      return renderImage(doc, block, ctx, next, _fetchImage);
    case 'pagebreak':
      doc.addPage();
      return;
    case 'blankpage': {
      // Eine bewusst leere Seite: erst auf neue Seite (die bleibt leer — ohne
      // Kopf-/Fusszeile und Seitenzahl, Zählung nach den Leerseiten-Regeln),
      // dann gleich weiter, damit Folgeinhalt erst auf der übernächsten Seite
      // landet.
      doc.addPage();
      ctx.blankPageIdxs?.add(_currentPageIdx(doc));
      doc.addPage();
      return;
    }
    case 'table':
      // Tabellensatz liegt in seinem eigenen Modul: er misst und bricht selbst,
      // statt im Textfluss zu laufen (lib/pdf-render/table.js).
      renderTable(doc, block, {
        font: ctx.font, table: ctx.table, linkColor: ctx.linkColor, footnotes: ctx.footnotes || null,
        // Anders als beim Bild kann eine Tabelle ueber Seiten laufen. Gemeldet
        // wird die Seite ihrer ERSTEN gezeichneten Zeile (bzw. der Beschriftung,
        // wenn sie oben steht) — im Verzeichnis steht, wo die Tabelle beginnt.
        onStart: block.bid ? () => ctx.onAnchorStart?.(block.bid) : null,
      });
      return;
    case 'hr': {
      const y = doc.y + HR_SPACE_BEFORE_PT;
      const startX = doc.page.margins.left;
      const endX = doc.page.width - doc.page.margins.right;
      doc.save();
      doc.lineWidth(HR_WIDTH_PT).strokeColor(RULE_COLOR).moveTo(startX, y).lineTo(endX, y).stroke();
      doc.restore();
      doc.y = y + HR_SPACE_AFTER_PT;
      return;
    }
    default:
      return;
  }
}

module.exports = { _renderBlock };
