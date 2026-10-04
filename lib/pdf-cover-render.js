'use strict';
// Separates Umschlag-PDF (Phase 4 druckfertiger PDF-Export). Rendert einen
// einzelnen Bogen: Rueckseite | Buchruecken | Vorderseite, mit Beschnitt,
// Schnitt- + Falzmarken, Klappentext und EAN-13 aus der ISBN. Pure Funktion
// (kein DB-/Routen-Zugriff) — Buffers werden vom Aufrufer geladen.
//
// Geometrie (von links nach rechts, gefaltet liegt die Vorderseite rechts):
//   Bleed | Rueckseite(trimW) | Ruecken(spine) | Vorderseite(trimW) | Bleed
// Rueckenbreite = coverSpec.paperBulkMmPer1000 × pageCount / 1000 (mm).
//
// Front-Bild = das hochgeladene Titelbild (cover_image), Rueckseite optional
// als eigenes Bild + Klappentext, Buchruecken optional als eigenes Bild (fuer
// durchgehende Motive). Randabfallende Bilder laufen in den Anschnitt.

const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const { MM_TO_PT, _pageSize } = require('./pdf-render/layout');
const { _registerFonts, _patchDocTextSanitizer, _patchSoftHyphenStripper } = require('./pdf-render/fonts');
const { _patchBlackToK } = require('./pdf-render/color');
const { drawEan13, measureEan13, isValidEan13 } = require('./pdf-barcode');

function computeSpineMm(coverSpec) {
  const pages = Math.max(0, coverSpec?.pageCount || 0);
  const bulk  = Math.max(0, coverSpec?.paperBulkMmPer1000 || 0);
  return (pages * bulk) / 1000;
}

// Bild deckt die Box [x,y,w,h] vollstaendig (center-crop) via Clip — fuer
// randabfallende Panels, die in den Anschnitt laufen sollen.
async function _placeImageCover(doc, buf, x, y, w, h) {
  let meta;
  try { meta = await sharp(buf).metadata(); } catch { return; }
  if (!meta.width || !meta.height) return;
  const ratio = meta.width / meta.height;
  const boxRatio = w / h;
  let drawW, drawH;
  if (ratio > boxRatio) { drawH = h; drawW = h * ratio; }
  else                  { drawW = w; drawH = w / ratio; }
  const drawX = x + (w - drawW) / 2;
  const drawY = y + (h - drawH) / 2;
  doc.save();
  doc.rect(x, y, w, h).clip();
  doc.image(buf, drawX, drawY, { width: drawW, height: drawH });
  doc.restore();
}

// Schnittmarken an den 4 Bogenecken + Falzmarken am Ruecken (oben/unten im
// Anschnitt). Hairlines, bis exakt an die Trim-/Falzkante.
function _drawCoverMarks(doc, { bleedPt, sheetW, sheetH, spineX, frontX }) {
  const len = Math.min(bleedPt, 5 * MM_TO_PT);
  const L = bleedPt, T = bleedPt, R = sheetW - bleedPt, B = sheetH - bleedPt;
  doc.save();
  doc.lineWidth(0.25).strokeColor('#000000').undash();
  const seg = (x1, y1, x2, y2) => doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
  seg(L, T - len, L, T); seg(L - len, T, L, T);   // oben-links
  seg(R, T - len, R, T); seg(R, T, R + len, T);   // oben-rechts
  seg(L, B, L, B + len); seg(L - len, B, L, B);   // unten-links
  seg(R, B, R, B + len); seg(R, B, R + len, B);   // unten-rechts
  // Falzmarken am Ruecken (links + rechts der Ruecken-Saeule).
  for (const fx of [spineX, frontX]) {
    seg(fx, T - len, fx, T);
    seg(fx, B, fx, B + len);
  }
  doc.restore();
}

/**
 * @param {object} args
 * @param {object} args.book          - Book-Metadata (Domain-Shape)
 * @param {object} args.profile       - Validiertes Profil { config }
 * @param {Buffer|null} args.frontImageBuf - Front-/Titelbild (sharp-prepared)
 * @param {Buffer|null} args.backImageBuf  - Rueckseiten-Bild (optional)
 * @param {Buffer|null} args.spineImageBuf - Buchruecken-Bild (optional)
 * @param {string|null} args.lang     - 'de' | 'en'
 * @returns {Promise<Buffer>} Umschlag-PDF-Buffer
 */
async function renderCoverBuffer({ book, profile, frontImageBuf, backImageBuf, spineImageBuf, lang }) {
  const config = profile.config;
  const cs = config.coverSpec || {};
  const docLang = (lang === 'en' || lang === 'de') ? lang : 'de';

  const [trimW, trimH] = _pageSize(config.layout);
  const bleedPt = Math.max(0, config.print?.bleedMm || 0) * MM_TO_PT;
  const spinePt = computeSpineMm(cs) * MM_TO_PT;
  const sheetW = bleedPt + trimW + spinePt + trimW + bleedPt;
  const sheetH = bleedPt + trimH + bleedPt;

  const backX  = bleedPt;                     // Rueckseite (links)
  const spineX = bleedPt + trimW;             // Buchruecken
  const frontX = bleedPt + trimW + spinePt;   // Vorderseite (rechts)
  const trimTop = bleedPt;

  const pdfaConf = String(config.pdfa?.conformance || 'B').toLowerCase();
  // Autor wie im Innenteil: buch-weiter Publikationsname aus config.extras.
  const author = String(config.extras?.authorName || '').trim();
  const usePdfa = !!config.pdfa?.enabled;
  const docOpts = {
    size: [sheetW, sheetH],
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    autoFirstPage: false,
    bufferPages: true,
    pdfVersion: '1.7',
    tagged: true,
    displayTitle: true,
    lang: docLang,
    info: {
      Title:    `${book.name || ''} — Umschlag`,
      Author:   author,
      Creator:  'schreibwerkstatt',
      Producer: 'pdfkit',
    },
  };
  if (usePdfa) docOpts.subset = `PDF/A-2${pdfaConf}`;
  const doc = new PDFDocument(docOpts);

  await _registerFonts(doc, config.font);
  if (usePdfa) _patchDocTextSanitizer(doc);
  _patchSoftHyphenStripper(doc);
  // K-only-Schwarz auch auf dem Umschlag (Klappentext, Rückentitel, EAN-Ziffern)
  // — nur ausserhalb von PDF/A (dort sRGB-OutputIntent, kein DeviceCMYK erlaubt).
  if (config.print?.blackTextKOnly && !usePdfa) _patchBlackToK(doc);

  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.addPage({ size: [sheetW, sheetH], margins: { top: 0, right: 0, bottom: 0, left: 0 } });

  // Hintergrundfarbe ueber das ganze Blatt (inkl. Anschnitt).
  const bg = /^#[0-9a-fA-F]{6}$/.test(cs.backgroundColor || '') ? cs.backgroundColor : '#ffffff';
  doc.save(); doc.rect(0, 0, sheetW, sheetH).fill(bg); doc.restore();

  // Vorderseite: Front-Bild fuellt die Vorderseite + laeuft rechts/oben/unten
  // in den Anschnitt. Linke Kante = Ruecken-Falz (kein Bleed).
  if (frontImageBuf) {
    await _placeImageCover(doc, frontImageBuf, frontX, 0, trimW + bleedPt, sheetH);
  }
  // Rueckseite: Back-Bild fuellt links/oben/unten in den Anschnitt.
  if (backImageBuf) {
    await _placeImageCover(doc, backImageBuf, 0, 0, trimW + bleedPt, sheetH);
  }
  // Buchruecken: eigenes Bild fuellt die Ruecken-Saeule (oben/unten in den
  // Anschnitt). Der Ruecken-Titeltext wird spaeter darueber gezeichnet.
  if (spineImageBuf && spinePt > 0) {
    await _placeImageCover(doc, spineImageBuf, spineX, 0, spinePt, sheetH);
  }

  const f = config.font;
  const innerMargin = 15 * MM_TO_PT;

  // Klappentext (Rueckseite, oben links im Trim).
  if (cs.blurb) {
    const ab = f.authorBio || f.body;
    doc.save();
    doc.font('authorBio').fontSize(ab.sizePt || 11).fillColor(ab.color || '#1a1a1a');
    doc.text(cs.blurb, backX + innerMargin, trimTop + innerMargin, {
      width: trimW - 2 * innerMargin,
      align: 'left',
      lineGap: ((f.body.lineHeight || 1.45) - 1) * (ab.sizePt || 11),
    });
    doc.restore();
  }

  // EAN-13 unten rechts auf der Rueckseite. Branchenstandard (BISG): eine weisse
  // Barcode-Flaeche von 2" × 1.2" (50.8 × 30.48 mm) mit 0.25" (6.35 mm)
  // Sicherheitsabstand zu den Trim-Kanten (rechts = Ruecken-Falz spineX, unten =
  // Trim-Unterkante). Die weisse Flaeche sichert Scanbarkeit ueber Bild/Farbe und
  // reserviert Platz fuer ein optionales Preis-Add-on. Der EAN-13 sitzt scan-
  // optimal (SC2/100 %) horizontal + vertikal in dieser Flaeche zentriert.
  const e = config.extras || {};
  if (e.barcode && e.isbn && isValidEan13(e.isbn)) {
    const SAFE = 6.35 * MM_TO_PT;
    const fieldW = 50.8 * MM_TO_PT;
    const fieldH = 30.48 * MM_TO_PT;
    const fieldX = spineX - SAFE - fieldW;
    const fieldY = trimTop + trimH - SAFE - fieldH;
    doc.save();
    doc.rect(fieldX, fieldY, fieldW, fieldH).fill('#ffffff');
    doc.restore();
    const bc = measureEan13({ font: 'imprint' });
    const bcX = fieldX + (fieldW - bc.width) / 2;
    const bcY = fieldY + (fieldH - bc.height) / 2;
    drawEan13(doc, bcX, bcY, e.isbn, { font: 'imprint', color: '#000000' });
  }

  // Buchruecken: Titel rotiert (90° = liest top->bottom, DE/CH-Konvention),
  // vertikal + horizontal zentriert. Nur ab ~6 mm Ruecken (sonst unleserlich).
  const spineText = cs.spineText || book.name || '';
  if (spinePt >= 6 * MM_TO_PT && spineText) {
    const spineFontSize = Math.min(f.title.sizePt || 14, Math.max(8, (spinePt / MM_TO_PT) * 0.6));
    const cx = spineX + spinePt / 2;
    const cy = trimTop + trimH / 2;
    doc.save();
    doc.rotate(90, { origin: [cx, cy] });
    doc.font('title').fontSize(spineFontSize).fillColor(f.title.color || '#1a1a1a');
    doc.text(spineText, cx - trimH / 2, cy - spineFontSize / 2, {
      width: trimH, align: 'center', lineBreak: false,
    });
    doc.restore();
  }

  // TrimBox/BleedBox + Schnitt-/Falzmarken (nur mit Beschnitt sinnvoll).
  if (bleedPt > 0) {
    doc.page.dictionary.data.TrimBox  = [bleedPt, bleedPt, sheetW - bleedPt, sheetH - bleedPt];
    doc.page.dictionary.data.BleedBox = [0, 0, sheetW, sheetH];
    if (config.print?.cropMarks) {
      _drawCoverMarks(doc, { bleedPt, sheetW, sheetH, spineX, frontX });
    }
  }

  doc.flushPages();
  doc.end();
  return done;
}

module.exports = { renderCoverBuffer, computeSpineMm };
