// Länder-Picklist für Schauplatz-Verortung. Speicherformat ist
// ISO-3166-1-alpha-2 (lowercase); Labels werden über Intl.DisplayNames in der
// UI-Sprache erzeugt — kein hartcodierter Klartext, kein i18n-Key pro Land.
// Liste bewusst kuratiert (Schwerpunkt DACH + häufige Roman-Schauplätze), nicht
// die vollen ~250 ISO-Codes — eine knappe Combobox schlägt eine endlose Liste.

const COUNTRY_CODES = [
  'ch', 'de', 'at', 'li',
  'fr', 'it', 'es', 'pt', 'gb', 'ie', 'nl', 'be', 'lu',
  'dk', 'se', 'no', 'fi', 'is',
  'pl', 'cz', 'sk', 'hu', 'si', 'hr', 'gr', 'ro', 'bg',
  'ru', 'ua', 'tr',
  'us', 'ca', 'mx', 'br', 'ar',
  'cn', 'jp', 'kr', 'in', 'th', 'vn',
  'au', 'nz',
  'eg', 'ma', 'za', 'il',
];

// Startansicht der Geo-Karte je Land [lat, lng, zoom] — greift, wenn ein Buch
// mit Schauplatz-Land noch keinen verorteten Ort hat (statt Weltansicht). Deckt
// genau COUNTRY_CODES ab (gegated: tests/unit/country-codes.test.mjs).
const COUNTRY_VIEW = {
  ch: [46.8, 8.2, 7], de: [51.2, 10.4, 6], at: [47.6, 14.1, 7], li: [47.16, 9.55, 11],
  fr: [46.6, 2.4, 6], it: [42.8, 12.6, 6], es: [40.2, -3.6, 6], pt: [39.6, -8.0, 6],
  gb: [54.0, -2.5, 6], ie: [53.2, -8.0, 7], nl: [52.2, 5.3, 7], be: [50.6, 4.6, 8],
  lu: [49.8, 6.1, 9], dk: [56.1, 10.0, 7], se: [62.0, 15.5, 5], no: [64.5, 12.0, 5],
  fi: [64.5, 26.0, 5], is: [64.9, -18.6, 6], pl: [52.0, 19.4, 6], cz: [49.8, 15.5, 7],
  sk: [48.7, 19.7, 7], hu: [47.2, 19.4, 7], si: [46.1, 14.8, 8], hr: [44.8, 16.0, 7],
  gr: [39.0, 22.5, 6], ro: [45.9, 25.0, 6], bg: [42.7, 25.3, 7], ru: [61.5, 99.0, 3],
  ua: [48.5, 31.3, 6], tr: [39.0, 35.2, 6], us: [39.5, -98.4, 4], ca: [58.0, -96.0, 3],
  mx: [23.6, -102.5, 5], br: [-10.8, -52.9, 4], ar: [-38.4, -63.6, 4], cn: [35.0, 104.0, 4],
  jp: [37.5, 138.0, 5], kr: [36.3, 127.9, 7], in: [22.0, 79.0, 5], th: [15.1, 101.0, 6],
  vn: [16.0, 106.0, 5], au: [-25.7, 134.5, 4], nz: [-41.5, 172.8, 5], eg: [26.8, 30.8, 6],
  ma: [31.8, -7.1, 6], za: [-29.0, 25.1, 5], il: [31.4, 35.0, 8],
};

/** Startansicht { center: [lat, lng], zoom } für einen ISO-2-Code, sonst null. */
export function countryView(code) {
  const v = COUNTRY_VIEW[String(code || '').trim().toLowerCase()];
  return v ? { center: [v[0], v[1]], zoom: v[2] } : null;
}

/** Lokalisiertes Land-Label für einen ISO-2-Code. Fallback: Code in Versalien. */
export function countryLabel(code, lang = 'de') {
  const cc = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(cc) || cc;
  } catch {
    return cc;
  }
}

/** Combobox-Optionen [{ value, label }], alphabetisch nach lokalisiertem Label. */
export function countryOptions(lang = 'de') {
  return COUNTRY_CODES
    .map(cc => ({ value: cc, label: countryLabel(cc, lang) }))
    .sort((a, b) => a.label.localeCompare(b.label, lang));
}

export { COUNTRY_CODES };
