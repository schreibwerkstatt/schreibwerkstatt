// Gemeinsamer Lade-Rahmen der Admin-Karten (Geräte, Backup, JS-Fehler,
// KI-Parse-Fehler, Bücher, Kategorien). Jede Karte lädt beim Öffnen einmal,
// lädt auf «Aktualisieren» neu und gleicht bei der Tab-Rückkehr still ab — die
// drei Wege, ihre Flags und der Schutz gegen überholte Antworten stehen hier
// einmal statt sechsmal.
//
//   ...adminLoaderState('devices')                         // State
//   ...adminLoaderMethods('devices', {                     // Methoden
//     request() { return fetchJson('/admin/devices'); },
//     apply(data, { silent }) { assignIfChanged(this, 'devicesList', data.devices || [], silent); },
//   }),
//
// Erzeugt für das Präfix `p`:
//   State    `${p}Initialized`, `${p}Loading`, `${p}Error`, `_${p}LoadSeq`
//   Methoden `${p}Enter()`    — erstes Öffnen lädt, weitere sind No-op
//            `${p}Refresh()`  — neu laden (Knopf, Re-Klick)
//            `_${p}Load({ silent })` — `silent`: Tab-Rückkehr, kein Ladezustand,
//                               ein Fehler ändert nichts
//            `_${p}Invalidate()` — View-Reset: laufende Antwort verwerfen,
//                               beim nächsten Öffnen frisch laden
//
// Antworten, die ein späterer Aufruf überholt hat, werden verworfen (Zähler
// `_${p}LoadSeq`): ein langsamer Erst-Load überschriebe sonst den Stand nach
// «Aktualisieren» oder nach einer Änderung.
//
// Der Ladezustand blendet keine schon geladenen Daten aus: das Skelett steht
// nur, solange noch nichts da ist (`x-show="${p}Loading && !liste.length"`).

import { tFetchError } from '../i18n.js';
import { sameData } from '../utils/same-data.js';

export function adminLoaderState(p) {
  return {
    [`${p}Initialized`]: false,
    [`${p}Loading`]: false,
    [`${p}Error`]: '',
    [`_${p}LoadSeq`]: 0,
  };
}

export function adminLoaderMethods(p, { request, apply }) {
  const INIT = `${p}Initialized`;
  const LOADING = `${p}Loading`;
  const ERROR = `${p}Error`;
  const SEQ = `_${p}LoadSeq`;
  const LOAD = `_${p}Load`;
  const ENTER = `${p}Enter`;
  return {
    async [ENTER]() {
      if (this[INIT]) return;
      this[INIT] = true;
      await this[LOAD]();
    },

    [`${p}Refresh`]() {
      this[INIT] = false;
      return this[ENTER]();
    },

    async [LOAD]({ silent = false } = {}) {
      const seq = ++this[SEQ];
      if (!silent) {
        this[LOADING] = true;
        this[ERROR] = '';
      }
      try {
        const data = await request.call(this);
        if (seq !== this[SEQ]) return;
        apply.call(this, data, { silent });
        if (this[ERROR]) this[ERROR] = '';
      } catch (e) {
        if (seq !== this[SEQ]) return;
        if (!silent) this[ERROR] = tFetchError(e);
      } finally {
        if (seq === this[SEQ]) this[LOADING] = false;
      }
    },

    [`_${p}Invalidate`]() {
      this[SEQ]++;
      this[INIT] = false;
      this[LOADING] = false;
      this[ERROR] = '';
    },
  };
}

/** Weist `value` zu — beim stillen Abgleich nur, wenn sich inhaltlich etwas
 *  geändert hat (gleiche Daten, neue Identität liessen jede Zeile neu rendern). */
export function assignIfChanged(ctx, key, value, silent) {
  if (!silent || !sameData(value, ctx[key])) ctx[key] = value;
}

