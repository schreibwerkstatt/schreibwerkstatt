'use strict';
// Header/Footer-Stempler. Wird im zweiten Pass nach Body-Render über
// bufferedPageRange auf jede Body-Page angewandt. Token-Replacement für
// {title}/{author}/{chapter}/{pageTitle}/{page}/{pages}.

// Tokens für Header/Footer:
//   {title}     – Buchtitel (book.name)
//   {author}    – Autorname
//   {chapter}   – Aktueller Kapitelname (textuell)
//   {pageTitle} – Aktueller Seitenname (textuell), Fallback Kapitel
//   {page}      – Aktuelle Seitenzahl (Zahl, ab pageNumberStart)
//   {pages}     – Gesamtanzahl Body-Seiten (Zahl)
function _replaceTokens(s, ctx) {
  return String(s || '')
    .replace(/\{title\}/g,     ctx.title || '')
    .replace(/\{author\}/g,    ctx.author || '')
    .replace(/\{chapter\}/g,   ctx.chapter || '')
    .replace(/\{pageTitle\}/g, ctx.pageTitle || ctx.chapter || '')
    .replace(/\{page\}/g,      ctx.page != null ? String(ctx.page) : '')
    .replace(/\{pages\}/g,     ctx.pages != null ? String(ctx.pages) : '');
}

// pdfkit prüft bei jedem text()-Call, ob `doc.y` ausserhalb der writable area
// (margins.top..page.height-margins.bottom) liegt; falls ja, wird automatisch
// eine neue Seite eingefügt. Header (im Top-Margin) und Footer (im
// Bottom-Margin) liegen genau dort. Lösung: Margins für die Header-/Footer-
// Phase auf 0 setzen, schreiben, dann zurücksetzen.
// fonts (optional): { header: { key, size, color }, footer: { key, size, color } }
// — Schriftbild pro Zeile. Fehlt es, gilt der Default (body-Font, 9pt, #666666).
// Kopf- und Fusszeile dürfen unterschiedliche Schrift/Grösse/Farbe tragen; die
// Breitenmessung (widthOfString) muss darum je Zeile die passende Font aktiv haben.
function _drawHeaderFooter(doc, layout, ctx, outerMargins, fonts) {
  const skipHeader = !!ctx.skipHeader;
  const skipFooter = !!ctx.skipFooter;
  if (skipHeader && skipFooter) return;
  const DEFAULT_SPEC = { key: 'body', size: 9, color: '#666666' };
  const headerSpec = (fonts && fonts.header) || DEFAULT_SPEC;
  const footerSpec = (fonts && fonts.footer) || DEFAULT_SPEC;
  // Font-Variant je Slot: bold/italic wählen den vorregistrierten Variant-Key
  // (z.B. header-bolditalic). Fällt der Variant-Key mangels Registrierung aus,
  // regelt safeReg beim Font-Setup den Fallback auf die Basis-Familie.
  const variantKey = (baseKey, style) => {
    if (style.bold && style.italic) return `${baseKey}-bolditalic`;
    if (style.bold)   return `${baseKey}-bold`;
    if (style.italic) return `${baseKey}-italic`;
    return baseKey;
  };
  const applySlot = (spec, style) =>
    doc.font(variantKey(spec.key, style)).fontSize(spec.size).fillColor(spec.color);
  const { width } = doc.page;
  const pageW = width;
  // outerMargins beschreibt die Seitenränder OHNE Body-Inset, bereits nach der
  // Parität DIESER Seite gespiegelt (page-geometry.js#marginsFor). Header/Footer
  // muss am äusseren Rand stehen, auch wenn die Body-Page mit Inset-Margins
  // gerendert wurde. Danach werden die Ränder der Seite zurückgeschrieben, die
  // vorgefunden wurden — nicht die Aussenränder (sonst trüge eine Verso-Seite
  // hinterher die Recto-Ränder).
  const pageMargins = doc.page.margins;
  const origMargins = outerMargins ? { ...outerMargins } : { ...doc.page.margins };
  doc.save();
  doc.page.margins = { top: 0, right: origMargins.right, bottom: 0, left: origMargins.left };

  // Verso/Recto-Slot-Auflösung: bei isVerso & vorhandenem verso-Text diesen
  // verwenden, sonst Default (recto). Erlaubt unterschiedliche Inhalte pro
  // Seitenseite (klassisch: verso=Buchtitel, recto=Kapitel). Die Auszeichnung
  // (bold/italic/upper aus layout.hfStyle) folgt dem aufgelösten Slot: zeigt
  // eine Verso-Seite den Recto-Text, gilt auch die Recto-Auszeichnung.
  const isVerso = !!ctx.isVerso;
  const styleRoot = layout.hfStyle || {};
  const EMPTY_STYLE = { bold: false, italic: false, upper: false };
  // pos: 'Left' | 'Center' | 'Right'; zone: 'header' | 'footer'.
  const resolveSlot = (zone, pos) => {
    const rectoKey = zone + pos;              // headerLeft
    const versoKey = zone + 'Verso' + pos;    // headerVersoLeft
    const useVerso = isVerso && layout[versoKey] != null && String(layout[versoKey]).length > 0;
    const side = useVerso ? 'verso' : 'recto';
    const text = useVerso ? layout[versoKey] : layout[rectoKey];
    const style = (styleRoot[zone] && styleRoot[zone][side] && styleRoot[zone][side][pos.toLowerCase()]) || EMPTY_STYLE;
    return { text, style };
  };

  const innerW = pageW - origMargins.left - origMargins.right;
  const headerY = origMargins.top - 22;
  const footerY = doc.page.height - origMargins.bottom + 10;
  const GAP = 12;

  // 3-Spalten-Layout mit Kollisionsschutz: messe natürliche Breiten der drei
  // Slots (jeweils mit der Slot-eigenen Font aktiv), passt Σ + 2*GAP in innerW,
  // bekommt jeder Slot natürliche Breite + anteiligen Rest. Sonst gleichmässig
  // dritteln + ellipsis-Truncation.
  const writeRow = (zone, y, spec) => {
    // Token-Ersetzung + optionale Versalien pro Slot.
    const prep = (pos) => {
      const { text, style } = resolveSlot(zone, pos);
      let txt = text ? _replaceTokens(text, ctx) : '';
      if (txt && style.upper) txt = txt.toUpperCase();
      return { txt, style };
    };
    const L = prep('Left'), C = prep('Center'), R = prep('Right');
    // Breite je Slot mit der zugehörigen Font-Variante messen.
    const measure = (slot) => {
      if (!slot.txt) return 0;
      applySlot(spec, slot.style);
      return doc.widthOfString(slot.txt);
    };
    const lw = measure(L), cw = measure(C), rw = measure(R);
    const filled = (L.txt ? 1 : 0) + (C.txt ? 1 : 0) + (R.txt ? 1 : 0);
    const gaps = Math.max(0, filled - 1) * GAP;
    const fits = lw + cw + rw + gaps <= innerW;
    let leftW, centerW, rightW;
    if (fits) {
      const slack = (innerW - lw - cw - rw - gaps) / Math.max(1, filled);
      leftW   = lw + (L.txt ? slack : 0);
      centerW = cw + (C.txt ? slack : 0);
      rightW  = rw + (R.txt ? slack : 0);
    } else {
      const colW = (innerW - 2 * GAP) / 3;
      leftW = centerW = rightW = colW;
    }
    const opts = { lineBreak: false, ellipsis: true };
    if (L.txt) {
      applySlot(spec, L.style);
      doc.text(L.txt, origMargins.left, y, { ...opts, width: leftW, align: 'left' });
    }
    if (C.txt) {
      applySlot(spec, C.style);
      const cx = origMargins.left + (innerW - centerW) / 2;
      doc.text(C.txt, cx, y, { ...opts, width: centerW, align: 'center' });
    }
    if (R.txt) {
      applySlot(spec, R.style);
      const rx = origMargins.left + innerW - rightW;
      doc.text(R.txt, rx, y, { ...opts, width: rightW, align: 'right' });
    }
  };

  if (!skipHeader) writeRow('header', headerY, headerSpec);
  if (!skipFooter) writeRow('footer', footerY, footerSpec);

  if ((!skipHeader && layout.headerRule) || (!skipFooter && layout.footerRule)) {
    doc.save();
    doc.lineWidth(0.5).strokeColor('#999999');
    if (!skipHeader && layout.headerRule) {
      const y = headerY + 14;
      doc.moveTo(origMargins.left, y).lineTo(origMargins.left + innerW, y).stroke();
    }
    if (!skipFooter && layout.footerRule) {
      const y = footerY - 4;
      doc.moveTo(origMargins.left, y).lineTo(origMargins.left + innerW, y).stroke();
    }
    doc.restore();
  }

  doc.page.margins = pageMargins;
  doc.restore();
}

// Schnittmarken: pro Ecke je eine vertikale + horizontale Hairline im Anschnitt,
// bis exakt an die Trim-Ecke. pdfkit zeichnet mit Ursprung oben links.
function _drawCropMarks(doc, bleed, len) {
  const w = doc.page.width, h = doc.page.height;
  const L = bleed, T = bleed, R = w - bleed, B = h - bleed;
  doc.save();
  doc.lineWidth(0.25).strokeColor('#000000').undash();
  const seg = (x1, y1, x2, y2) => doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
  seg(L, T - len, L, T);  seg(L - len, T, L, T);   // oben-links
  seg(R, T - len, R, T);  seg(R, T, R + len, T);   // oben-rechts
  seg(L, B, L, B + len);  seg(L - len, B, L, B);   // unten-links
  seg(R, B, R, B + len);  seg(R, B, R + len, B);   // unten-rechts
  doc.restore();
}

// Kapitel-/Seitentitel-Trennlinie unter der Überschrift. Verbraucht doc.y +
// setzt ihn hinter die Linie, damit der Folgeabsatz darunter beginnt.
function _drawTitleRule(doc, color = '#000000') {
  const ruleY = doc.y + 4;
  const startX = doc.page.margins.left;
  const endX = doc.page.width - doc.page.margins.right;
  doc.save();
  doc.lineWidth(1).strokeColor(color)
     .moveTo(startX, ruleY).lineTo(endX, ruleY).stroke();
  doc.restore();
  doc.y = ruleY + 8;
}

module.exports = { _drawHeaderFooter, _replaceTokens, _drawCropMarks, _drawTitleRule };
