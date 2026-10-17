'use strict';
// Gedeckeltes Lesen von ZIP-Archiven aus User-Uploads (.swbook, Ordner-Import,
// DOCX/ODT). EINZIGER Weg, ein vom User geliefertes ZIP zu entpacken.
//
// Why: das Upload-Limit deckelt nur die KOMPRIMIERTE Groesse. Ein Deflate-Strom
// waechst bis ~1000:1 — 200 MB Upload sind sonst 200 GB im Speicher (Zip-Bombe),
// und `entry.async('string')` haelt das Ergebnis am Stueck. Die im Central
// Directory deklarierte Groesse dient nur als frueher Abbruch; sie stammt vom
// Angreifer und kann luegen. Massgeblich ist das Mitzaehlen WAEHREND des
// Entpackens (`internalStream`): wird der Deckel ueberschritten, wird der Strom
// angehalten und verworfen, bevor mehr als ein Chunk ueber dem Limit liegt.

const JSZip = require('jszip');

const MB = 1024 * 1024;

// Innenleben eines Office-Dokuments (DOCX/ODT): XML + eingebettete Bilder.
const DOC_ZIP_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxEntryBytes: 64 * MB,
  maxTotalBytes: 256 * MB,
});

/** Fehler „Archiv entpackt zu gross". `message` ist ein i18n-Key (Job-Vertrag
 *  wie `i18nError` in routes/jobs/shared), `code` fuer die Aufrufer. */
class ZipLimitError extends Error {
  constructor(reason, limitBytes) {
    super('job.error.archiveTooLarge');
    this.name = 'ZipLimitError';
    this.code = 'ZIP_LIMIT';
    this.reason = reason;
    this.i18nParams = { mb: Math.round((limitBytes || 0) / MB) };
  }
}

function _declaredSize(entry) {
  const n = entry?._data?.uncompressedSize;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Entpackt einen Eintrag mit Byte-Zaehlung. `keep=false` verwirft die Daten
 *  (reine Pruefung). Liefert Buffer bzw. die gezaehlte Laenge. */
function _inflate(entry, maxBytes, keep) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let settled = false;
    let stream;
    try { stream = entry.internalStream('uint8array'); }
    catch (e) { reject(e); return; }
    stream
      .on('data', (chunk) => {
        if (settled) return;
        n += chunk.length;
        if (n > maxBytes) {
          settled = true;
          try { stream.pause(); } catch { /* Strom ist ohnehin verworfen */ }
          chunks.length = 0;
          reject(new ZipLimitError('entry', maxBytes));
          return;
        }
        if (keep) chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
      })
      .on('error', (e) => { if (!settled) { settled = true; reject(e); } })
      .on('end', () => {
        if (settled) return;
        settled = true;
        resolve(keep ? Buffer.concat(chunks, n) : n);
      })
      .resume();
  });
}

/**
 * Oeffnet ein ZIP und liefert einen Leser mit gemeinsamem Byte-Budget.
 * @param {Buffer} buffer
 * @param {{maxEntries:number, maxEntryBytes:number, maxTotalBytes:number}} limits
 * @returns {Promise<{ zip: JSZip, entries: object[], file(name:string): object|null,
 *   read(entry:object|string, type?:'nodebuffer'|'string'): Promise<Buffer|string|null>,
 *   consumed(): number }>}
 */
async function openCappedZip(buffer, limits) {
  const { maxEntries, maxEntryBytes, maxTotalBytes } = limits;
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter(f => !f.dir);
  if (entries.length > maxEntries) throw new ZipLimitError('entries', maxTotalBytes);
  let declared = 0;
  for (const e of entries) {
    const d = _declaredSize(e);
    if (d == null) continue;
    if (d > maxEntryBytes) throw new ZipLimitError('entry', maxEntryBytes);
    declared += d;
  }
  if (declared > maxTotalBytes) throw new ZipLimitError('total', maxTotalBytes);

  let used = 0;
  // `opts.maxBytes` verschaerft den Eintragsdeckel fuer diesen einen Lesezugriff
  // (Ordner-Import: zu grosse Einzeldatei wird uebersprungen, nicht das Archiv).
  async function read(entryOrName, type = 'nodebuffer', opts = {}) {
    const entry = typeof entryOrName === 'string' ? zip.file(entryOrName) : entryOrName;
    if (!entry) return null;
    const entryCap = Math.min(maxEntryBytes, opts.maxBytes || Infinity);
    const d = _declaredSize(entry);
    if (d != null && d > entryCap) throw new ZipLimitError('entry', entryCap);
    const left = maxTotalBytes - used;
    const cap = Math.min(entryCap, left);
    let buf;
    try {
      buf = await _inflate(entry, cap, true);
    } catch (e) {
      // Ueberschreitung des Rest-Budgets meldet den Gesamtdeckel, nicht den
      // Eintragsdeckel — sonst stuende in der Meldung die falsche Zahl.
      if (e instanceof ZipLimitError && cap < entryCap) throw new ZipLimitError('total', maxTotalBytes);
      if (e instanceof ZipLimitError) throw new ZipLimitError('entry', entryCap);
      throw e;
    }
    used += buf.length;
    return type === 'string' ? buf.toString('utf8') : buf;
  }

  return {
    zip,
    entries,
    file: (name) => zip.file(name),
    read,
    consumed: () => used,
  };
}

/** Entpackt jeden Eintrag zur Probe (ohne die Daten zu halten). Fuer Parser,
 *  die das ZIP selbst oeffnen (mammoth) und sich nicht deckeln lassen: erst
 *  nach bestandener Probe bekommt der Parser den Buffer. */
async function assertZipWithinLimits(buffer, limits) {
  const { maxEntryBytes, maxTotalBytes } = limits;
  const { entries } = await openCappedZip(buffer, limits);
  let used = 0;
  for (const entry of entries) {
    const cap = Math.min(maxEntryBytes, maxTotalBytes - used);
    try {
      used += await _inflate(entry, cap, false);
    } catch (e) {
      if (e instanceof ZipLimitError && cap < maxEntryBytes) throw new ZipLimitError('total', maxTotalBytes);
      throw e;
    }
  }
  return used;
}

module.exports = {
  openCappedZip,
  assertZipWithinLimits,
  ZipLimitError,
  DOC_ZIP_LIMITS,
};
