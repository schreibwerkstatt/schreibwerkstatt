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
