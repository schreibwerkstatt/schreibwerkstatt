'use strict';
// Keep-with-next: eine Überschrift (Kapitel-, Seiten-, Autoren-Überschrift),
// eine Bildlegende oder Tabellenbeschriftung darf nicht allein am Seitenfuss
// stehen. Vor dem Setzen wird gemessen, ob die Überschrift UND der Anfang des
// Folgeblocks (mindestens zwei Zeilen) noch auf die Seite passen — sonst beginnt
// beides auf der nächsten.
//
// Gemessen wird mit denselben Formeln, mit denen der Folgeblock später gesetzt
// wird (measure.js#lineAdvance = Layouter-Vorschub), damit Vorausschau und Satz
// nicht auseinanderlaufen. Bilder werden über denselben Cache geholt, den der
// Bild-Renderer gleich darauf benutzt — die Vorausschau kostet keinen zweiten
// Decode.

const { lineAdvance } = require('./measure');
const { _fetchImage } = require('./images');
const { normalizeTableConfig } = require('./table');

// So viele Zeilen des Folgeblocks müssen mit der Überschrift auf der Seite stehen.
const KEEP_LINES = 2;

function _bodyAdvance(doc, ctx) {
  const font = ctx.font || {};
  const role = (ctx.textRole && ctx.textRole !== 'body' && font[ctx.textRole]) ? font[ctx.textRole] : (font.body || {});
  const sizePt = role.sizePt || (font.body && font.body.sizePt) || 11;
  const lh = role.lineHeight || (font.body && font.body.lineHeight) || 1.4;
  return lineAdvance(doc, ctx.textRole && font[ctx.textRole] ? ctx.textRole : 'body', sizePt, lh);
}

/** Mindesthöhe, die der Block `next` direkt unter einer Überschrift braucht:
 *  zwei Textzeilen, ein ganzes Bild (es wird nie geteilt), Tabellenkopf
 *  plus zwei Zeilen bzw. beim Nachrichtenverlauf Absender/Hinweis plus erste
 *  Nachricht (in Sprechblasen die ganze erste Blase). Unbekanntes/fehlendes → zwei Fliesstextzeilen; ein
 *  Seitenumbruch-Block → 0 (dort folgt ohnehin eine neue Seite). */
async function minLeadHeight(doc, next, ctx) {
  if (!next) return 0;
  switch (next.kind) {
    case 'pagebreak':
    case 'blankpage':
      return 0;
    case 'image': {
      const fetched = await _fetchImage(next.src, ctx.imageCache, ctx.imageOpts);
      if (!fetched || !fetched.width) return 0;
      const maxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const w = Math.min(maxW, fetched.naturalWidthPt || fetched.width);
      const frameH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
      return Math.min(frameH * 0.9, w * (fetched.height / fetched.width));
    }
    case 'table': {
      const cfg = normalizeTableConfig(ctx.table);
      const body = (ctx.font && ctx.font.body) || {};
      const sizePt = Math.max(4, (body.sizePt || 11) * cfg.fontScale);
      const rowH = sizePt * (body.lineHeight || 1.35) + cfg.padding * 2;
      const rows = Math.min(KEEP_LINES, (next.rows || []).length) + (next.header ? 1 : 0);
      return rows * rowH + 4;
    }
    case 'messages': {
      // Absender-/Hinweiszeilen bis zur ersten Nachricht plus deren Anfang —
      // in Sprechblasen die ganze erste Blase (sie wird nie geteilt). Lazy:
      // block-messages.js braucht selbst `ensureRoom` aus diesem Modul.
      if (!next.lines || !next.lines.length || !ctx.font || !ctx.font.body) return KEEP_LINES * _bodyAdvance(doc, ctx);
      const { messagesLeadHeight } = require('./block-messages');
      return messagesLeadHeight(doc, next.lines, 0, ctx, ctx.messages?.style === 'bubbles');
    }
    default:
      return KEEP_LINES * _bodyAdvance(doc, ctx);
  }
}

/** Ist auf der aktuellen Seite noch `needed` pt Platz? Sonst umbrechen — aber
 *  nie auf einer frischen Seite (dort hülfe ein Umbruch nichts). Liefert true,
 *  wenn umbrochen wurde. */
function ensureRoom(doc, needed) {
  const fresh = doc.y <= doc.page.margins.top + 0.5;
  if (fresh) return false;
  if (doc.y + needed <= doc.page.maxY()) return false;
  doc.addPage();
  doc.y = doc.page.margins.top;
  return true;
}

module.exports = { minLeadHeight, ensureRoom, KEEP_LINES };
