'use strict';

// DOCX-Parser für Folder-Import. mammoth.convertToHtml liefert sauberes HTML
// aus Word-Markup. Bilder werden im MVP gedroppt (warning gesetzt), Tabellen
// behält mammoth als <table>. html-clean greift später im Content-Store.

const mammoth = require('mammoth');
const { assertZipWithinLimits, DOC_ZIP_LIMITS } = require('../zip-limits');

async function parseDocx(buffer, { zipLimits = DOC_ZIP_LIMITS } = {}) {
  // mammoth oeffnet das ZIP selbst und laesst sich nicht deckeln — darum erst
  // die gedeckelte Probe (lib/zip-limits.js), dann mammoth.
  await assertZipWithinLimits(buffer, zipLimits);
  const warnings = [];
  let imageCount = 0;
  const options = {
    convertImage: mammoth.images.imgElement(() => {
      imageCount += 1;
      return { src: '' };
    }),
  };
  const result = await mammoth.convertToHtml({ buffer }, options);
  if (imageCount) warnings.push({ code: 'IMAGES_DROPPED', count: imageCount });
  for (const m of (result.messages || [])) {
    if (m.type === 'warning' || m.type === 'error') {
      warnings.push({ code: 'MAMMOTH', message: m.message, level: m.type });
    }
  }
  let html = result.value || '';
  html = html.replace(/<img[^>]*src=""[^>]*>/g, '');
  return { html, warnings };
}

module.exports = { parseDocx };
