// Download aus dem Browser anstossen: unsichtbarer Anker, Klick, weg.

/** Lädt `href` herunter; `filename` überschreibt den Namen, den der Server mitschickt. */
export function downloadHref(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Lädt einen im Browser erzeugten Blob herunter. Die Object-URL wird erst
 * verzögert freigegeben — Safari bricht den Download sonst ab.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  downloadHref(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Lädt eine Server-Datei erst per fetch und speichert sie nur bei Erfolg —
 * eine Fehlerantwort (JSON) wirft wie `fetchJson` (`status`, `code`, `body`),
 * statt als Navigation die Seite zu ersetzen. Für Dateien, die in den Speicher
 * passen (Logs, Exporte); grosse Downloads bereiten den Snapshot serverseitig
 * vor und laden per `downloadHref` (Muster: Admin-Backup).
 */
export async function downloadChecked(url, fallbackName = 'download') {
  let r;
  try { r = await fetch(url, { cache: 'no-store' }); }
  catch (e) { e.status = 0; throw e; }
  if (!r.ok) {
    let body = null;
    try { body = await r.json(); } catch (_) {}
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    err.code = body?.error_code || null;
    err.body = body;
    throw err;
  }
  const cd = r.headers.get('content-disposition') || '';
  const name = cd.match(/filename="?([^";]+)"?/i)?.[1] || fallbackName;
  downloadBlob(await r.blob(), name);
}
