'use strict';
// Zwischenablage fuer Import-Uploads (.swbook, Ordner-ZIP, Manuskript): der
// POST legt den Buffer ab, der Job-Worker holt ihn. Eine Map mit Deckeln.
//
// Why: ein Upload darf bis zu 200 MB gross sein und wartet bis zur TTL im
// Speicher. Ohne Deckel kann ein einzelner User mit verschiedenen Dateien
// beliebig viele solcher Buffer gleichzeitig parken. Darum zwei Grenzen:
// wenige offene Buffer pro User und eine Summe ueber alle User.
//
// Bleibt eine `Map` (jobId -> Eintrag), damit Worker und Tests sie wie bisher
// mit get/set/delete benutzen.

const crypto = require('crypto');

class ImportBufferStore extends Map {
  /**
   * @param {{ ttlMs: number, maxPerUser: number, maxTotalBytes: number }} opts
   */
  constructor({ ttlMs, maxPerUser, maxTotalBytes }) {
    super();
    this.ttlMs = ttlMs;
    this.maxPerUser = maxPerUser;
    this.maxTotalBytes = maxTotalBytes;
  }

  totalBytes() {
    let n = 0;
    for (const e of this.values()) n += e?.buffer?.length || 0;
    return n;
  }

  countForUser(email) {
    const e = String(email || '').toLowerCase();
    let n = 0;
    for (const v of this.values()) if (String(v?.userEmail || '').toLowerCase() === e) n += 1;
    return n;
  }

  /** null = darf abgelegt werden; sonst der error_code fuer die 429-Antwort. */
  admissionError(email, size) {
    if (this.countForUser(email) >= this.maxPerUser) return 'IMPORT_PENDING';
    if (this.totalBytes() + size > this.maxTotalBytes) return 'IMPORT_CAPACITY';
    return null;
  }

  /** Ablegen + TTL-Aufraeumen planen. `entry.userEmail` ist Pflicht (Deckel). */
  put(jobId, entry) {
    this.set(jobId, entry);
    const t = setTimeout(() => this.delete(jobId), this.ttlMs);
    t.unref?.();
  }
}

/** Inhalts-Hash fuer die Dedup (zwei gleich grosse, verschiedene Dateien sind
 *  nicht dasselbe Import). */
function contentHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { ImportBufferStore, contentHash };
