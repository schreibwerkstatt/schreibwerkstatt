// Plot-Werkstatt: Beat verschieben ohne Drag — die Tastatur-/Touch-Alternative
// zum SortableJS-Griff. Im Beat-Edit wählt man Akt (+ Strang, sobald es Stränge
// gibt) oder rückt den Beat innerhalb seiner Zelle nach oben/unten.
//
// Alles läuft über die geprüfte Drop-Mechanik (beats.js#_dropBeat →
// _persistCells → PUT /plot/beats/order, Undo-Record `beat-place`,
// loadBoard-Rollback bei Fehler) — bewusst KEIN eigener PUT daneben, sonst gäbe
// es zwei Wege, die Zell-Reihenfolge zu schreiben.

export const beatMoveMethods = {
  // Zulässige Ziel-Akte für einen Strang (Hybrid-Invariante, serverseitig
  // `_actFitsThread` / ACT_THREAD_MISMATCH): hat der Strang eine eigene
  // Aktstruktur, nur seine Akte; sonst die geteilten. Archivierte nur, wenn
  // eingeblendet — ausser der Beat sitzt schon dort (keepActId), sonst wäre der
  // aktuelle Wert in der Auswahl nicht darstellbar.
  _moveActsForThread(threadId, keepActId = null) {
    const tid = threadId ?? null;
    const own = tid != null && this._threadHasOwn(tid);
    return (this.acts || [])
      .filter(a => (own ? a.thread_id === tid : a.thread_id == null))
      .filter(a => this._actVisible(a) || a.id === keepActId)
      .sort((a, b) => a.position - b.position);
  },

  beatMoveActOptions(beat) {
    if (!beat) return [];
    const app = window.__app;
    return this._moveActsForThread(beat.thread_id, beat.act_id).map(a => ({
      value: a.id,
      label: a.archiviert ? `${a.name} (${app.t('plot.act.archivedBadge')})` : a.name,
    }));
  },

  // Stränge als Ziel — nur solche, die mindestens einen zulässigen Akt haben.
  // „ohne Strang" trägt den Wert '' (Combobox-Werte sind string-verglichen).
  beatMoveThreadOptions(beat) {
    if (!beat) return [];
    const app = window.__app;
    const cur = beat.thread_id ?? null;
    const opts = [];
    for (const l of this.threadLanes()) {
      if (!this._moveActsForThread(l.id, l.id === cur ? beat.act_id : null).length) continue;
      opts.push({ value: l.id == null ? '' : l.id, label: l.thread ? l.thread.name : app.t('plot.thread.noThread') });
    }
    return opts;
  },

  // Position des Beats in seiner Zelle (ungefilterte Liste — dieselbe, die
  // _dropBeat neu nummeriert).
  _beatCellPos(beat) {
    const list = this.beatsForCell(beat.act_id, beat.thread_id ?? null);
    return { list, idx: list.findIndex(b => b.id === beat.id) };
  },

  canMoveBeatStep(beat, dir) {
    if (!beat) return false;
    const { list, idx } = this._beatCellPos(beat);
    return idx >= 0 && idx + dir >= 0 && idx + dir < list.length;
  },

  async moveBeatStep(beat, dir) {
    if (!this.canMoveBeatStep(beat, dir)) return;
    const { list, idx } = this._beatCellPos(beat);
    const rest = list.filter(b => b.id !== beat.id);
    // _dropBeat fügt VOR beforeBeatId ein; null = ans Zellen-Ende.
    const before = rest[idx + dir]?.id ?? null;
    await this._moveBeatVia(beat, beat.act_id, beat.thread_id ?? null, before, dir < 0 ? 'up' : 'down');
  },

  // Akt und/oder Strang wechseln. Passt der aktuelle Akt nicht zum Ziel-Strang
  // (eigene vs. geteilte Akte), landet der Beat auf dem Akt derselben Position
  // im Ziel-Scope — dieselbe Abbildung wie beim Auflösen einer Aktstruktur.
  async moveBeatTo(beat, actId, threadId) {
    if (!beat) return;
    const tid = (threadId === '' || threadId == null) ? null : Number(threadId);
    let aid = (actId === '' || actId == null) ? null : Number(actId);
    const allowed = this._moveActsForThread(tid, beat.act_id);
    if (!allowed.some(a => a.id === aid)) {
      const from = this._moveActsForThread(beat.thread_id, beat.act_id);
      const pos = Math.max(0, from.findIndex(a => a.id === beat.act_id));
      aid = allowed.length ? allowed[Math.min(pos, allowed.length - 1)].id : null;
    }
    if (aid == null) return;
    if (aid === beat.act_id && tid === (beat.thread_id ?? null)) return;
    // Eingeklappter Ziel-Akt: aufklappen, sonst verschwände der Beat aus dem Bild.
    if (this.isActCollapsed?.(aid)) this.toggleActCollapsed(aid);
    await this._moveBeatVia(beat, aid, tid, null, null);
  },

  // Kurzlebiger Re-Entry-Guard (async, nicht im Initial-State — siehe
  // cards/CLAUDE.md „State explizit deklariert"): ein Doppelklick auf „nach
  // oben" darf nicht zwei Drops auf denselben Ausgangsstand absetzen.
  async _moveBeatVia(beat, actId, threadId, beforeId, focusKey) {
    if (this._beatMoveInFlight || this.busy) return;
    this._beatMoveInFlight = true;
    try {
      this._dragBeatId = beat.id;
      await this._dropBeat(actId, threadId, beforeId);
    } finally {
      this._beatMoveInFlight = false;
    }
    // Der Beat-Edit wird in der Ziel-Zelle neu aufgebaut — den Fokus dorthin
    // nachziehen, damit die Tastatur-Bedienung nicht am <body> landet.
    this.$nextTick(() => {
      const card = this._visibleBeatEl(beat.id);
      if (!card) return;
      const sel = focusKey ? `[data-beat-move="${focusKey}"]` : '.plot-beat-move-act .combobox-trigger';
      const target = card.querySelector(sel);
      (target && !target.disabled ? target : card.querySelector('.plot-beat-move-act .combobox-trigger'))?.focus();
    });
  },
};
