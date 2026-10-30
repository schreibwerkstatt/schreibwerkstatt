'use strict';
// Extrahiert Plain-Text aus einem PDF-Upload-Buffer (Recherche-Fundstueck und
// Quelle). Rein lesend: das Original-PDF wird unveraendert als BLOB abgelegt,
// der hier gewonnene Text dient nur der FTS-Suche, dem Embedding-Index und den
// KI-Verknuepfungsvorschlaegen (research-link). Nie generativ im Buchtext.
//
// Magic-Bytes-Check vor unpdf, damit nicht beliebige BLOBs an den Parser wandern.
// unpdf ist ESM-only → dynamisches import() (analog prompts-loader.js).
//
// SSoT des Upload-Limits: `MAX_INPUT_BYTES` gilt fuer den express.raw-Body
// (lib/pdf-attachment.js), die Parser-Vorpruefung hier und — ueber /config —
// die Vorpruefung im Browser. Keine zweite Zahl daneben stellen.

const MAX_INPUT_BYTES = 25 * 1024 * 1024;  // SSoT, s. lib/pdf-attachment.js
const MAX_TEXT_CHARS  = 200000;            // gespeicherte Text-Laenge deckeln
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 && PDF_MAGIC.every((b, i) => buf[i] === b);
}

/**
 * @param {Buffer} input  PDF-Upload-Buffer
 * @returns {Promise<{ text: string, pages: number, chars: number, truncated: boolean }>}
 *   `truncated` meldet, dass der Volltext bei MAX_TEXT_CHARS abgeschnitten wurde —
 *   ohne das Flag verschwindet die zweite Haelfte eines dicken Fachbuchs
 *   lautlos aus Suche und Index.
 * @throws bei Nicht-PDF, leerem/zu grossem Buffer oder Parser-Fehler.
 */
async function extractPdfText(input) {
  if (!Buffer.isBuffer(input)) throw new Error('pdf-not-buffer');
  if (input.length === 0) throw new Error('pdf-empty');
  if (input.length > MAX_INPUT_BYTES) throw new Error('pdf-too-large');
  if (!isPdf(input)) throw new Error('pdf-unsupported-format');

  const { extractText, getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(input));
  const { text, totalPages } = await extractText(doc, { mergePages: true });

  const full = String(text || '')
    .replace(/\u0000/g, '')        // NUL aus kaputten Streams
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const normalized = full.slice(0, MAX_TEXT_CHARS);

  return {
    text: normalized,
    pages: Number(totalPages) || 0,
    chars: normalized.length,
    truncated: full.length > MAX_TEXT_CHARS,
  };
}

/**
 * Seitenweise Variante fuer `read_web_page` (lib/url-scrape.js): je Seite ein
 * normalisierter Text, damit ein langes PDF ab einer bestimmten Seite gelesen
 * und durchsucht werden kann. Eigene Funktion statt Option an extractPdfText:
 * der Upload-Pfad speichert dessen Text, und der soll sich nicht verschieben.
 *
 * Die Seitentexte sind zusammen (mit Absatzfuge) auf MAX_TEXT_CHARS gedeckelt —
 * derselbe Deckel wie der Volltext: die angeschnittene Seite wird gekuerzt, die
 * folgenden fallen weg; `truncated` meldet es, `total` bleibt die echte
 * Seitenzahl. `info`/`xmp` stammen aus DEMSELBEN Dokument-Proxy (ein Parse statt
 * zwei fuer Text und Metadaten).
 *
 * @param {Buffer} input
 * @returns {Promise<{ pages: string[], total: number, truncated: boolean, info: Record<string,string>, xmp: string }>}
 * @throws wie extractPdfText.
 */
async function extractPdfPages(input) {
  if (!Buffer.isBuffer(input)) throw new Error('pdf-not-buffer');
  if (input.length === 0) throw new Error('pdf-empty');
  if (input.length > MAX_INPUT_BYTES) throw new Error('pdf-too-large');
  if (!isPdf(input)) throw new Error('pdf-unsupported-format');

  const { extractText, getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(input));
  const { text, totalPages } = await extractText(doc, { mergePages: false });
  const all = (Array.isArray(text) ? text : [String(text || '')]).map(t => String(t || '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
  const { pages, truncated } = capPageTexts(all, MAX_TEXT_CHARS);
  const meta = await _metaFromDoc(doc);
  return { pages, total: Number(totalPages) || all.length, truncated, ...meta };
}

/** Seitentexte so kappen, dass `pages.join('\n\n')` hoechstens `max` Zeichen hat. */
function capPageTexts(all, max) {
  const pages = [];
  let used = 0;
  for (let i = 0; i < all.length; i++) {
    const sep = i ? 2 : 0;
    const room = max - used - sep;
    if (room <= 0) return { pages, truncated: true };
    if (all[i].length > room) { pages.push(all[i].slice(0, room)); return { pages, truncated: true }; }
    pages.push(all[i]);
    used += sep + all[i].length;
  }
  return { pages, truncated: false };
}

const XMP_MAX_CHARS = 50000;

/**
 * Info-Dictionary + rohes XMP-Paket eines PDFs (fuer die Kennungssuche der
 * Quellen-Erfassung, lib/source-pdf-ident.js). Wirft nie: Metadaten sind ein
 * Zusatz, ein PDF ohne oder mit kaputtem Info-Block ist trotzdem lesbar.
 *
 * @param {Buffer} input  bereits von extractPdfText akzeptierter Buffer
 * @returns {Promise<{ info: Record<string, string>, xmp: string }>}
 */
async function readPdfMeta(input) {
  if (!isPdf(input)) return { info: {}, xmp: '' };
  try {
    const { getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(input));
    return await _metaFromDoc(doc);
  } catch {
    return { info: {}, xmp: '' };
  }
}

// Info-Dictionary + XMP aus einem schon geoeffneten Dokument-Proxy. Wirft nie.
async function _metaFromDoc(doc) {
  try {
    const meta = await doc.getMetadata();
    const info = {};
    for (const [k, v] of Object.entries(meta?.info || {})) {
      if (typeof v === 'string' && v.trim()) info[k] = v.trim().slice(0, 1000);
      // Eigene Schluessel (z.B. /doi) legt pdf.js unter `Custom` ab.
      else if (k === 'Custom' && v && typeof v === 'object') {
        for (const [ck, cv] of Object.entries(v)) {
          if (typeof cv === 'string' && cv.trim()) info[ck] = cv.trim().slice(0, 1000);
        }
      }
    }
    const raw = typeof meta?.metadata?.getRaw === 'function' ? meta.metadata.getRaw() : '';
    return { info, xmp: String(raw || '').slice(0, XMP_MAX_CHARS) };
  } catch {
    return { info: {}, xmp: '' };
  }
}

module.exports = { extractPdfText, extractPdfPages, readPdfMeta, capPageTexts, isPdf, MAX_INPUT_BYTES, MAX_TEXT_CHARS };
