// Alpine.store('catalog') — geteilte Fach-Daten, die von mehreren Karten
// gelesen/geschrieben werden: `figuren`, `orte`, `songs`, `szenen`,
// `globalZeitstrahl`, `zeitstrahlChronology`. Kein Root-Proxy: alle Konsumenten
// greifen direkt zu — Root-Computeds/-Slices + in den Root gespreadete
// Fachmodule (book/figuren.js etc.) via `this.$store.catalog.*`, Karten/Helper
// via `Alpine.store('catalog').*`, Templates via `$store.catalog.*`. Die
// Root-Lookup-Maps `figurenById`/`orteById`/`szenenById` lesen ebenfalls hier.

// Letzte übernommene Server-Antwort je Katalog-Liste: Buch, Rohtext, gebautes Array.
const _lastAssigned = new Map();

// Liste aus einer Server-Antwort in den Katalog schreiben — ausser die Antwort ist
// für dasselbe Buch identisch mit der zuletzt übernommenen UND der Store hält noch
// genau das daraus gebaute Array (jede andere Zuweisung, z.B. ein lokales Löschen,
// bricht die Identität). Mehrere Pfade laden beim Öffnen einer Karte dasselbe; eine
// neue Array-Identität mit gleichem Inhalt liesse jede Zeile, jeden Reiter und jede
// Ableitung über die ganze Liste neu auswerten — bei einigen hundert Einträgen
// Sekunden Main-Thread. `build` formt die Rohliste (Default: unverändert).
// Liefert true, wenn neu zugewiesen wurde.
export function assignCatalogList(key, bookId, list, build = (l) => l) {
  const store = window.Alpine.store('catalog');
  const raw = JSON.stringify(list);
  const last = _lastAssigned.get(key);
  if (last && last.bookId === String(bookId) && last.raw === raw
      && window.Alpine.raw(store[key]) === last.arr) return false;
  const arr = build(list);
  store[key] = arr;
  _lastAssigned.set(key, { bookId: String(bookId), raw, arr });
  return true;
}

export function registerCatalogStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('catalog', {
    figuren: [],
    orte: [],
    songs: [],
    szenen: [],
    globalZeitstrahl: [],
    // Abgeleitete Jahres-Kennzahlen der Zeitstrahl-Ansicht (nur bei
    // book_settings.zeitlinie_real befüllt, sonst null). Siehe ereignisse.js.
    zeitstrahlChronology: null,
    // Kanonische Zeitstrahl-Daten (zeitstrahl_events) sind geladen. Verhindert,
    // dass der figuren-basierte Fallback (_buildGlobalZeitstrahl) die vom Server
    // geladene SSoT überschreibt — sonst clobbert ein paralleles loadFiguren die
    // datierten Events und das Jahres-Band flackert/verschwindet. Reset bei
    // Buchwechsel via clear().
    zeitstrahlServerLoaded: false,

    clear() {
      this.figuren = [];
      this.orte = [];
      this.songs = [];
      this.szenen = [];
      this.globalZeitstrahl = [];
      this.zeitstrahlChronology = null;
      this.zeitstrahlServerLoaded = false;
    },
  });
}
