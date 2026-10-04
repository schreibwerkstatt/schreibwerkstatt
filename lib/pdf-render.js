'use strict';
// Facade. Implementierung in lib/pdf-render/<thematic>.js gesplittet:
//   layout.js   – Page-Geometrie, Kapitel-Numerierung
//   fonts.js    – Font-Bootstrapping + PDF/A-Glyph-Sanitizer
//   images.js   – Bild-Loader (sharp-normalisiert)
//   runs.js     – Inline-Run-Renderer (bold/italic/underline/link)
//   dropcap.js  – DropCap-Paragraph mit Two-Pass-Fit
//   blocks.js   – Walker-Output → pdfkit-Render (heading/paragraph/list/...)
//   chrome.js   – Header/Footer-Stempler + Token-Replacement
//   pages.js    – Cover, Title, Widmung, Impressum, TOC
//   coalesce.js – Gruppen → Render-Blöcke (flatten/nested)
//   index.js    – renderPdfBuffer-Orchestrator

module.exports = require('./pdf-render/index');
