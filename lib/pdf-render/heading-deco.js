'use strict';
// Schmuck der Kapitel-, Unterkapitel- und Abschnittsueberschriften im PDF:
// die Kapitelnummer ueber dem Titel (Praefix, Groesse, Versalien/Kapitaelchen,
// Sperrung, Trenner) und die Linie bzw. das Ornament ueber/unter dem Titel.
// Bedeutung und Masse sind SSoT in lib/heading-style.js (geteilt mit dem EPUB);
// hier steht nur das Zeichnen mit pdfkit. Keine Transparenz: PDF/X-3 verbietet
// sie, darum wird der Trenner mit einer aufgehellten Vollfarbe gesetzt.

const hs = require('../heading-style');

// Hex-Farbe mit Weiss mischen (amount 0..1 = Anteil Weiss).
function _lighten(hex, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#999999';
  const n = parseInt(m[1], 16);
  const ch = (shift) => {
    const c = (n >> shift) & 0xff;
    return Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

function _numberFont(doc) {
  return doc._registeredFonts && doc._registeredFonts['heading-number'] ? 'heading-number' : 'heading';
}

// Satzwerte der Nummernzeile + des Trenners.
function _numberSpec(doc, text, { titleSize, style, lang }) {
  const { text: shown, scale } = hs.numberCaseApplied(text, style, lang);
  const size = titleSize * (style.numberSizePct / 100) * scale;
  const tracking = style.numberTracking ? size * hs.NUMBER_TRACKING_EM : 0;
  const dividerSize = titleSize * 0.5;
  return { shown, size, tracking, dividerSize, font: _numberFont(doc) };
}

function _textWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

// Hoehe des Nummernblocks (fuer die Keep-with-next-Pruefung). Laesst Font und
// Groesse auf der Nummer stehen — der Aufrufer setzt seine danach neu.
function chapterNumberHeight(doc, text, opts) {
  if (!text) return 0;
  const s = _numberSpec(doc, text, opts);
  const w = _textWidth(doc);
  doc.font(s.font).fontSize(s.size);
  let h = doc.heightOfString(s.shown, { width: w, characterSpacing: s.tracking }) + s.size * 0.6;
  if (opts.style.numberDivider) {
    doc.fontSize(s.dividerSize);
    h += doc.heightOfString(hs.NUMBER_DIVIDER, { width: w }) + s.dividerSize * 0.6;
  }
  return h;
}

// Setzt die Kapitelnummer (und den Trenner) ab doc.y; doc.y steht danach auf
// der Titelzeile.
function drawChapterNumber(doc, text, opts) {
  if (!text) return;
  const { align, color, style } = opts;
  const s = _numberSpec(doc, text, opts);
  doc.font(s.font).fontSize(s.size).fillColor(color);
  doc.text(s.shown, { align, characterSpacing: s.tracking });
  doc.y += s.size * 0.6;
  if (style.numberDivider) {
    doc.fontSize(s.dividerSize).fillColor(_lighten(color, 0.5));
    doc.text(hs.NUMBER_DIVIDER, { align, characterSpacing: s.dividerSize * 0.3 });
    doc.y += s.dividerSize * 0.6;
    doc.fillColor(color);
  }
}

// Masse einer Linie / eines Ornaments: Hoehe und belegte Breite.
function _ruleBox(style, emSize) {
  const lw = hs.RULE_WEIGHT_PT[style.ruleWeight] || 1;
  switch (style.ruleStyle) {
    case 'double':   return { h: lw * 2 + Math.max(lw, 1.5), lw };
    case 'stars':    return { h: emSize * 0.8, lw, ornW: emSize * 3.2 };
    case 'asterism': return { h: emSize * 1.25, lw, ornW: emSize * 1.4 };
    case 'diamond':  return { h: Math.max(4, emSize * 0.35) * 2, lw };
    case 'dots':     return { h: Math.max(2, emSize * 0.24), lw, ornW: emSize * 2.2 };
    default:         return { h: lw, lw };
  }
}

const GAP_BEFORE_BELOW = 4;
const GAP_AFTER = 8;

// Hoehe, die drawRule von doc.y an verbraucht (fuer Keep-with-next).
function ruleHeight(style, emSize, where = 'below') {
  return (where === 'below' ? GAP_BEFORE_BELOW : 0) + _ruleBox(style, emSize).h + GAP_AFTER;
}

// Zeichnet Linie/Ornament ab doc.y und setzt doc.y dahinter. `where`: 'below'
// (unter einer Ueberschrift, kleiner Vorabstand) oder 'above'.
function drawRule(doc, { style, align, color, emSize, where = 'below' }) {
  const left = doc.page.margins.left;
  const fullW = _textWidth(doc);
  const box = _ruleBox(style, emSize);
  const yTop = doc.y + (where === 'below' ? GAP_BEFORE_BELOW : 0);
  const len = hs.isLineRule(style.ruleStyle) || style.ruleStyle === 'diamond'
    ? hs.ruleLength(style, align, fullW, emSize)
    : Math.min(box.ornW, fullW);
  const x0 = align === 'center' ? left + (fullW - len) / 2 : left;
  const { lw } = box;
  const prevX = doc.x;

  doc.save();
  doc.strokeColor(color).fillColor(color).lineWidth(lw);
  const hline = (y, x1 = x0, x2 = x0 + len) => doc.moveTo(x1, y).lineTo(x2, y).stroke();
  switch (style.ruleStyle) {
    case 'double': {
      const gap = Math.max(lw, 1.5);
      hline(yTop + lw / 2);
      hline(yTop + lw * 1.5 + gap);
      break;
    }
    case 'dotted':
      doc.lineCap('round').dash(0.01, { space: Math.max(lw * 2.5, 1.5) });
      hline(yTop + lw / 2);
      doc.undash().lineCap('butt');
      break;
    case 'dashed':
      doc.dash(lw * 4, { space: lw * 3 });
      hline(yTop + lw / 2);
      doc.undash();
      break;
    case 'stars':
    case 'asterism': {
      const size = style.ruleStyle === 'stars' ? emSize : emSize * 0.8;
      doc.font('heading').fontSize(size);
      const starW = doc.widthOfString('*');
      const draw = (y, n, step) => {
        const total = starW * n + step * (n - 1);
        let x = x0 + (len - total) / 2;
        for (let i = 0; i < n; i++, x += starW + step) doc.text('*', x, y, { lineBreak: false });
      };
      if (style.ruleStyle === 'stars') draw(yTop, 3, emSize * 0.9);
      else { draw(yTop, 1, 0); draw(yTop + size * 0.55, 2, size * 0.35); }
      break;
    }
    case 'diamond': {
      const d = box.h / 2;
      const cx = x0 + len / 2;
      const cy = yTop + d;
      hline(cy, x0, cx - d - 3);
      hline(cy, cx + d + 3, x0 + len);
      doc.polygon([cx, cy - d], [cx + d, cy], [cx, cy + d], [cx - d, cy]).fill();
      break;
    }
    case 'dots': {
      const r = box.h / 2;
      const step = (len - r * 2) / 2;
      for (let i = 0; i < 3; i++) doc.circle(x0 + r + i * step, yTop + r, r).fill();
      break;
    }
    default:
      hline(yTop + lw / 2);
  }
  doc.restore();
  doc.x = prevX;
  doc.y = yTop + box.h + GAP_AFTER;
}

module.exports = { chapterNumberHeight, drawChapterNumber, drawRule, ruleHeight, _lighten };
