// Anzeige-Form einer URL: ein Ort für «wie zeigt die App einen Link, der keinen
// Namen hat». Das `href` bleibt immer die volle URL; gekürzt wird nur der Text.
// Die Breite regelt danach `.url-short` (components/url-short.css) mit Ellipse —
// der Text hier ist die inhaltliche Kürzung (Host + letztes Pfadstück), die
// CSS-Ellipse die geometrische auf schmalen Leisten und Mobile.

/** Host ohne `www.`, '' bei ungültiger URL. */
export function urlHost(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./i, ''); } catch { return ''; }
}

/**
 * Kurzform: `host/…/letztes-stueck` — ohne Schema, `www.`, Query und Fragment.
 * Ein Pfad mit höchstens zwei Stücken bleibt ganz (`host/a/b`); ein überlanges
 * letztes Stück wird mittig gekürzt. Ungültige URLs kommen unverändert zurück.
 */
export function shortUrl(url, { maxTail = 32 } = {}) {
  const raw = String(url || '');
  let u;
  try { u = new URL(raw); } catch { return raw; }
  if (!/^https?:$/.test(u.protocol)) return raw;
  const host = u.hostname.replace(/^www\./i, '');
  const segs = u.pathname.split('/').filter(Boolean).map(s => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  if (!segs.length) return host;
  let tail = segs[segs.length - 1];
  if (tail.length > maxTail) {
    const keep = Math.max(4, Math.floor((maxTail - 1) / 2));
    tail = tail.slice(0, keep) + '…' + tail.slice(-keep);
  }
  if (segs.length === 1) return `${host}/${tail}`;
  if (segs.length === 2 && segs[0].length <= 16) return `${host}/${segs[0]}/${tail}`;
  return `${host}/…/${tail}`;
}

/** Link-Text: Label, wenn vorhanden, sonst die Kurzform der URL. */
export function linkText(label, url) {
  const l = String(label || '').trim();
  return l || shortUrl(url);
}
