// Undo/Redo-Kern für Karten mit eigener Aktions-Historie (Plot-Werkstatt,
// Ideen-Board, Recherche-Board, Motiv-Werkstatt). Die Karte liefert nur, was
// fachlich ist — wie ein Record zurück- bzw. vorwärts gedreht wird —, der Kern
// trägt Stack, Deckel, Flight-Schutz, Epoche und Fehler-Requeue.
//
// Tastatur: `bindBoardHistoryKeys` (board-history-keys.js). Knöpfe im Kartenkopf
// rufen `historyUndo()` / `historyRedo()` und sperren über `canUndo()`/`canRedo()`.
//
// Records sind Plain-Objekte `{ kind, … }` und tragen before UND after, damit
// derselbe Record beide Richtungen bedient. Sind before und after gleich,
// verwirft `_pushUndo` den Record (`isNoopRecord`) — die Karten brauchen dafür
// keinen eigenen Vergleich.
//
// Pflicht-Methoden der Karte:
//   _applyInverse(rec) → Promise<boolean>   Undo eines Records
//   _applyForward(rec) → Promise<boolean>   Redo eines Records
// Optionale Hooks der Karte:
//   _historyBusy()            → true sperrt Undo/Redo (laufender Save o.ä.)
//   _historySetBusy(flag)     → Karte zeigt/sperrt während des Flights
//   _historyBeforeApply()     → z.B. offenen Inline-Edit verwerfen (Undo heisst
//                               zurückdrehen, nicht den Entwurf speichern)
//   _historyBeforeStep()      → async, vor jedem Schritt abgewartet (z.B. noch
//                               laufende Blur-Umbenennungen, Organizer)
//   _historyStaleReason(rec, dir) → null oder `{ key, params }`; passt der Record
//                               nicht mehr zum Bestand, wird die Historie verworfen
//   _historyOnDropped(reason) → zeigt die Meldung zum Verwerfen (Default: nichts)
//   _historyDropsRedo(rec)    → true, wenn nach dem Undo dieses Records kein Redo
//                               möglich ist (Default: `create-*`, weil ein Redo
//                               eine Neuanlage mit neuer ID wäre)
//
// Löschen ist rückgängig machbar, indem der Delete-Record einen Snapshot trägt
// und das Undo neu anlegt. Die neue ID schreibt die Karte über
// `_remapHistory(fn)` in alle übrigen Records um.
//
// Der Gegen-Stack wird ERST NACH dem Flight beschrieben: `_pushUndo` verwirft
// Records, solange `_inHistoryFlight` steht (Schutz davor, dass eine
// wiederhergestellte Mutation sich selbst wieder aufzeichnet). Leert ein Applier
// die Historie (Fehler → Reload), wird der Record nicht zurückgelegt — er
// gehörte zu einem Stack, den es nicht mehr gibt (`_historyEpoch`).

export const HISTORY_MAX = 10;

// Reihenfolge-unabhängiger Vergleich für Plain-Daten (Snapshots aus JSON-Feldern).
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Record ohne Wirkung: trägt before UND after, und beide sind gleich. Pure. */
export function isNoopRecord(rec) {
  return !!rec && 'before' in rec && 'after' in rec && stableJson(rec.before) === stableJson(rec.after);
}

export function boardHistoryState() {
  return {
    _undoStack: [],
    _redoStack: [],
    _inHistoryFlight: false,
    _historyEpoch: 0,
  };
}

export const boardHistoryMethods = {
  _clearHistory() {
    this._undoStack = [];
    this._redoStack = [];
    this._historyEpoch = (this._historyEpoch || 0) + 1;
  },

  _pushUndo(record, { clearRedo = true } = {}) {
    if (this._inHistoryFlight || !record) return;
    // Nichts geändert (Öffnen und ungeändert schliessen, Drop an dieselbe Stelle):
    // kein Schritt — ein Undo, das nichts zurückdreht, und ein geleerter Redo-Stack.
    if (isNoopRecord(record)) return;
    this._undoStack.push(record);
    while (this._undoStack.length > HISTORY_MAX) this._undoStack.shift();
    if (clearRedo) this._redoStack = [];
  },

  _pushRedo(record) {
    this._redoStack.push(record);
    while (this._redoStack.length > HISTORY_MAX) this._redoStack.shift();
  },

  // fn(rec) für jeden Record beider Stacks (und ggf. weitere, z.B. den gerade
  // im Flug befindlichen) — Ort für ID-Remaps nach einer Wiederherstellung.
  _remapHistory(fn, ...extra) {
    for (const rec of [...this._undoStack, ...this._redoStack, ...extra]) fn(rec);
  },

  canUndo() { return this._undoStack.length > 0 && !this._inHistoryFlight && !this._historyIsBusy(); },
  canRedo() { return this._redoStack.length > 0 && !this._inHistoryFlight && !this._historyIsBusy(); },

  _historyIsBusy() {
    return typeof this._historyBusy === 'function' ? !!this._historyBusy() : false;
  },

  // Gescheiterter Record: einmal zurücklegen (Netz-Wackler → nochmal versuchen),
  // beim zweiten Fehlschlag die Historie verwerfen. Ein Record, dessen Ziel
  // verschwunden ist (in anderem Tab gelöscht → 404), scheitert sonst bei jedem
  // Strg+Z erneut und versperrt alle älteren Schritte.
  _requeueFailed(rec, stack) {
    if (rec._failed) { this._clearHistory(); return; }
    rec._failed = true;
    stack.push(rec);
  },

  async _historyStep(dir) {
    if (typeof this._historyBeforeStep === 'function') await this._historyBeforeStep();
    if (this._inHistoryFlight || this._historyIsBusy()) return;
    const from = dir === 'undo' ? this._undoStack : this._redoStack;
    // Erst prüfen, dann den Entwurf verwerfen: bei leerem Stack ginge sonst ein
    // offener Entwurf verloren, ohne dass etwas zurückgedreht wird.
    if (!from.length) return;
    if (typeof this._historyBeforeApply === 'function') this._historyBeforeApply();
    const rec = from.pop();
    if (!rec) return;
    if (typeof this._historyStaleReason === 'function') {
      const stale = this._historyStaleReason(rec, dir);
      if (stale) {
        this._clearHistory();
        if (typeof this._historyOnDropped === 'function') this._historyOnDropped(stale);
        return;
      }
    }
    const epoch = this._historyEpoch || 0;
    const setBusy = typeof this._historySetBusy === 'function' ? (f) => this._historySetBusy(f) : () => {};
    this._inHistoryFlight = true;
    setBusy(true);
    let ok = false;
    try {
      ok = dir === 'undo' ? await this._applyInverse(rec) : await this._applyForward(rec);
    } finally {
      this._inHistoryFlight = false;
      setBusy(false);
    }
    if ((this._historyEpoch || 0) !== epoch) return;
    if (!ok) { this._requeueFailed(rec, from); return; }
    rec._failed = false;
    if (dir === 'redo') { this._pushUndo(rec, { clearRedo: false }); return; }
    const dropsRedo = typeof this._historyDropsRedo === 'function'
      ? this._historyDropsRedo(rec)
      : String(rec.kind || '').startsWith('create-');
    if (dropsRedo) this._redoStack = [];
    else this._pushRedo(rec);
  },

  historyUndo() { return this._historyStep('undo'); },
  historyRedo() { return this._historyStep('redo'); },
};
