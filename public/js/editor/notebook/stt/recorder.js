// Aufnahme-Seite des Diktats: Lifecycle, Start/Stop, das browserseitige
// WebAudio-RMS-VAD und die Segmentierung.
//
// Segmentierung ueber einen MediaRecorder-Stop/Start-Zyklus: `stop()` liefert
// ein standalone-dekodierbares Segment (eigener Container-Header) — ein blosses
// Slicen der dataavailable-Chunks ergaebe headerlose, nicht dekodierbare
// Fragmente.
//
// Ruft ueber `this` in die Nachbarmodule: compute.js (RMS, Schnitt-Entscheidung,
// Mime-Wahl, Rausch-Schwelle) und transport.js (`_sttSendSegment`).

import { caretRangeIn, anchorCaretToEnd } from '../../utils.js';
import { EVT } from '../../../events.js';

// Rausch-Kalibrierung: Fenster, in dem vor dem ersten Sprechen der
// Geraeuschboden gesammelt wird (blockiert die Spracherkennung nicht).
const STT_CALIB_MS = 350;
// Absatz-Erkennung: ist die Gesamt-Sprechpause >= silenceMs * Faktor, gilt die
// Segmentgrenze als Absatzgrenze (neuer `<p>`) statt nur als Satzgrenze.
const STT_PARAGRAPH_FACTOR = 2.5;
// VAD-Takt. Zugleich die Einheit, in der die Sprechdauer eines Segments gezaehlt wird.
const STT_TICK_MS = 100;
// Mindest-Sprechdauer eines Segments, bevor es gesendet wird. Ein einzelner
// lauter Frame (Husten, Tastenklick, Stuhlruecken) ist keine Sprache — Whisper
// antwortet auf solche Fetzen mit Geisterphrasen. Zwei Ticks reichen fuer ein
// kurzes „Ja.".
const STT_MIN_VOICED_MS = 200;
// Spaetestens nach dieser Zeit gibt ein beendender Stopp das Mikrofon frei,
// auch wenn der Recorder sein letztes `onstop` schuldig bleibt.
const STT_RELEASE_FALLBACK_MS = 1500;
// Liefert das Mikrofon nach dieser Zeit seit Aufnahmestart noch digitale
// Stille (stummgeschaltet, falsches/totes Geraet), kommt ein Hinweis.
const STT_SILENT_MIC_MS = 8000;

export const sttRecorderMethods = {
  _initSttDictation(signal) {
    // Runtime-Handles (MediaRecorder/AudioContext/Stream/Interval) — bewusst
    // kein deklarierter Karten-State, sondern ein Runtime-Container analog den
    // async-Re-Entry-Guards. Pro Aufnahme-Session neu befuellt, bei Stop genullt.
    this._sttRt = null;
    this._sttBusyTimer = null; // Mindest-Standzeit-Timer fuer den „Transkribiert"-Status
    // Vorwaerts-Anker: der zuletzt von STT eingefuegte Knoten. Der Caret der
    // naechsten Einfuegung wird HINTER diesen gesetzt — nie die Live-Selection
    // gelesen, die der Browser nach laengeren Pausen (Fokusverlust) an den
    // Editoranfang zuruecksetzt und den Caret sonst „nach oben" springen liesse.
    // Bewegt sich ausschliesslich vorwaerts; pro Session zurueckgesetzt.
    this._sttLastNode = null;
    // Vom User waehrend der Aufnahme gesetzte Einfuegestelle (Klick/Tippen ins
    // Feld, siehe `_sttReanchorFromUser`). Hat Vorrang vor `_sttLastNode`, bis
    // das naechste Segment dort eingefuegt ist.
    this._sttUserRange = null;
    // Per Mic-Klick beendete Session, deren letzte Transkripte noch eintreffen
    // (siehe `_sttStop({ finish: true })`). Ein harter Stopp verwirft auch sie.
    this._sttDraining = null;
    // Aufnahme beenden + den bewussten-Caret-Anker zuruecksetzen (neuer Kontext
    // = kein gueltiger Anker mehr; STT haengt wieder ans Editorende an, bis der
    // User erneut bewusst klickt).
    const stop = () => {
      this.$store.stt.caretUserSet = false;
      if (this.$store.stt.recording || this.$store.stt.pending || this._sttDraining) this._sttStop();
    };
    window.addEventListener(EVT.BOOK_CHANGED, stop, { signal });
    window.addEventListener(EVT.VIEW_RESET, stop, { signal });
    // Edit-Modus verlassen / Seite gewechselt -> Aufnahme beenden, Mic freigeben.
    this.$watch('editMode', (on) => { if (!on) stop(); });
    this.$watch(() => this.currentPage?.id, () => stop());
  },

  // ── Toggle / Start / Stop ────────────────────────────────────────────────

  async toggleSttDictation() {
    if (this.$store.stt.pending) return; // Re-Entry-Guard waehrend getUserMedia/Stop
    // Mic-Klick = der User ist fertig: was er bis hierher gesagt hat, kommt
    // noch in den Text (anders als bei Seiten-/Kontextwechsel).
    if (this.$store.stt.recording) { this._sttStop({ finish: true }); return; }
    await this._sttStart();
  },

  async _sttStart() {
    if (!this.$store.stt.enabled || this.$store.stt.recording || this.$store.stt.pending) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      this._showJobToast?.({ message: this.t('stt.error.unavailable'), severity: 'err', jobType: 'stt', bookId: null });
      return;
    }
    const mime = this._computeSttMime((m) => {
      try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
    });
    this.$store.stt.pending = true;
    // Start-Generation: `_sttStop` zaehlt sie hoch. Endet getUserMedia erst,
    // nachdem der User waehrend des Berechtigungs-Prompts gestoppt, den Edit-
    // Modus verlassen oder die Seite gewechselt hat, gibt der Start das Mikrofon
    // sofort wieder frei, statt ohne sichtbaren Editor weiter aufzunehmen.
    const seq = (this._sttStartSeq = (this._sttStartSeq || 0) + 1);
    let stream;
    try {
      // Mono + DSP-Filter: kleinere Segmente (Diktat = ein Sprecher) und weniger
      // Whisper-Halluzinationen an der Quelle. Boolean-Constraints sind
      // best-effort — ein Geraet, das sie nicht kann, wirft hier nicht.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      this.$store.stt.pending = false;
      const key = e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
        ? 'stt.error.permission' : 'stt.error.unavailable';
      this._showJobToast?.({ message: this.t(key), severity: 'err', jobType: 'stt', bookId: null });
      return;
    }
    if (seq !== this._sttStartSeq || !this.editMode) {
      stream.getTracks().forEach(t => t.stop());
      // Abgebrochen von `_sttStop`: der hat `pending` schon geraeumt. Sonst
      // (Edit-Modus weg ohne Stop) selbst raeumen, sonst bliebe der Mic-Knopf
      // am Re-Entry-Guard haengen.
      if (seq === this._sttStartSeq) this.$store.stt.pending = false;
      return;
    }

    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      stream.getTracks().forEach(t => t.stop());
      this.$store.stt.pending = false;
      this._showJobToast?.({ message: this.t('stt.error.unavailable'), severity: 'err', jobType: 'stt', bookId: null });
      return;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    let audioCtx, source, analyser;
    try {
      audioCtx = new AudioCtx();
      source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
    } catch {
      try { audioCtx?.close(); } catch { /* noop */ }
      stream.getTracks().forEach(t => t.stop());
      this.$store.stt.pending = false;
      this._showJobToast?.({ message: this.t('stt.error.unavailable'), severity: 'err', jobType: 'stt', bookId: null });
      return;
    }
    const timeDomain = new Uint8Array(analyser.fftSize);

    const rt = {
      stream, rec, audioCtx, source, analyser, timeDomain,
      chunks: [],
      vadTimer: null,
      segmentStart: 0,
      lastVoiceTs: 0,
      hasVoice: false,
      voicedMs: 0, // Sprechdauer im laufenden Segment (gegen STT_MIN_VOICED_MS)
      micAlive: false, // irgendein Signal seit Start (Stumm-Mikrofon-Hinweis)
      silentWarned: false,
      startedAt: 0,
      mime: rec.mimeType || mime || 'audio/webm',
      stopping: false,
      // Hart beendet (Kontextwechsel, 401/404): kein Transkript dieser Session
      // wird mehr eingefuegt. Ein beendender Stopp setzt das Flag NICHT.
      dead: false,
      released: false,
      // AbortController dieser Session: bricht beim harten Stopp alle laufenden
      // Transkriptions-Requests (inkl. Retry-Waits) ab.
      abort: new AbortController(),
      // Einfuege-Reihenfolge: die Fetches laufen parallel (Durchsatz), die DOM-
      // Einfuegung jedes Segments wird aber ueber diese Promise-Kette in
      // Sende-Reihenfolge serialisiert — sonst koennte ein spaeter gesendetes,
      // aber schneller transkribiertes Segment (oder eines nach Retry) vor einem
      // frueheren im Text landen.
      // Laeuft noch eine per Mic-Klick beendete Session aus, haengt diese hinter
      // deren Kette — ihr letzter Satz kommt vor dem ersten neuen.
      insertChain: (this._sttDraining && !this._sttDraining.dead)
        ? this._sttDraining.insertChain : Promise.resolve(),
      // Cut-Grund des zuletzt geschnittenen Segments; bestimmt, ob das naechste
      // Segment einen neuen Satz beginnt (silence = Sprechpause = Satzgrenze).
      lastCutReason: null,
      // Grenz-Art VOR dem aktuell aufgenommenen Segment: 'none' | 'sentence' |
      // 'paragraph'. silence-Cut => mind. 'sentence'; eine deutlich laengere
      // Gesamtpause stuft beim naechsten Sprechen auf 'paragraph' hoch.
      boundaryKindForNext: 'none',
      silenceCutAt: null, // Zeitpunkt des letzten silence-Cuts (fuer Pausenmessung)
      // VAD-Threshold dieser Session: startet beim Admin-Wert, wird durch die
      // Rausch-Kalibrierung ggf. angehoben.
      threshold: this.$store.stt.vad.threshold,
      calibrating: true,
      calibStart: 0,
      noiseSum: 0,
      noiseCount: 0,
    };
    this._sttRt = rt;
    if (!this._sttDraining || this._sttDraining.dead) {
      this._sttLastNode = null; // frischer Vorwaerts-Anker pro Aufnahme-Session
    }
    this._sttUserRange = null;

    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) rt.chunks.push(e.data); };
    rec.onstop = () => {
      const blob = rt.chunks.length ? new Blob(rt.chunks, { type: rt.mime }) : null;
      rt.chunks = [];
      // Grenz-Art VOR diesem Segment (ggf. waehrend der Aufnahme auf 'paragraph'
      // hochgestuft) bestimmt, wie das Transkript angefuegt wird.
      const boundaryKind = rt.boundaryKindForNext;
      if (blob && blob.size > 0 && rt.hasVoice && rt.voicedMs >= STT_MIN_VOICED_MS && !rt.dead) {
        this._sttSendSegment(rt, blob, rt.mime, boundaryKind);
      }
      // Beendender Stopp: das letzte Segment ist raus -> jetzt Mikrofon frei.
      if (rt.stopping) {
        this._sttRelease(rt);
        rt.insertChain.then(() => { if (this._sttDraining === rt) this._sttDraining = null; });
        return;
      }
      // Grenze fuer das naechste Segment: silence-Cut => mind. neuer Satz;
      // max-Cut (Dauer-Sprechen) => keine Grenze (mitten im Satz).
      rt.boundaryKindForNext = (rt.lastCutReason === 'silence') ? 'sentence' : 'none';
      rt.lastCutReason = null;
      // Naechstes Segment, falls noch aktiv.
      if (!rt.stopping && this.$store.stt.recording) {
        rt.hasVoice = false;
        rt.voicedMs = 0;
        rt.segmentStart = this._sttNow();
        rt.lastVoiceTs = rt.segmentStart;
        try { rec.start(); } catch { /* noop */ }
      }
    };

    rt.segmentStart = this._sttNow();
    rt.lastVoiceTs = rt.segmentStart;
    rt.calibStart = rt.segmentStart;
    rt.startedAt = rt.segmentStart;
    try { rec.start(); } catch { /* noop */ }
    this.$store.stt.recording = true;
    this.$store.stt.pending = false;
    // Einfüge-Anker bestimmen: hat der User bewusst per Klick einen Caret im
    // Edit-Feld gesetzt (sttCaretUserSet) und steht dieser noch im Editor, wird
    // dort eingefügt (nur sichtbar scrollen). Sonst — z. B. blosser Mic-Klick
    // ohne Caret-Platzierung — hängt das Diktat ans Editorende an.
    if (this.$store.stt.caretUserSet && this._sttCaretInEditor()) {
      this._scrollEditCaretIntoView?.();
    } else {
      this._sttAnchorToEnd();
    }
    rt.vadTimer = setInterval(() => this._sttVadTick(), STT_TICK_MS);
  },

  // True, wenn die aktuelle Selection (Caret) innerhalb des Edit-Felds liegt.
  _sttCaretInEditor() {
    return !!caretRangeIn(this._getEditEl?.());
  },

  // Setzt den Caret ans Ende des Editorinhalts und scrollt dorthin — Anker fuer
  // die erste Diktat-Einfuegung (siehe _sttStart). Anders als die Panels der
  // Toolbar verschiebt das Diktat die Selection wirklich: der User schreibt
  // danach IM Editor weiter.
  _sttAnchorToEnd() {
    const editEl = this._getEditEl?.();
    if (!editEl) return;
    try {
      anchorCaretToEnd(editEl);
      this._scrollEditCaretIntoView?.();
    } catch { /* noop */ }
  },

  _sttNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  },

  _sttVadTick() {
    const rt = this._sttRt;
    if (!rt || !this.$store.stt.recording) return;
    rt.analyser.getByteTimeDomainData(rt.timeDomain);
    const rms = this._computeRms(rt.timeDomain);
    const now = this._sttNow();
    const voiced = rms >= rt.threshold;

    // Stumm-Mikrofon-Hinweis: kommt lange nach dem Start noch gar kein Signal
    // an (stummgeschaltet, falsches Geraet), einmal pro Session melden — sonst
    // steht nur „Hoert zu …" da und es passiert nichts. Wer nur nachdenkt und
    // schweigt, loest ihn nicht aus: gemessen wird digitale Stille, nicht
    // fehlende Sprache.
    if (!rt.micAlive && this._sttMicAlive(rt, rms)) rt.micAlive = true;
    else if (!rt.micAlive && !rt.silentWarned && (now - rt.startedAt) >= STT_SILENT_MIC_MS) {
      rt.silentWarned = true;
      this._showJobToast?.({ message: this.t('stt.error.silentMic'), severity: 'err', jobType: 'stt', bookId: null });
    }

    // Rausch-Kalibrierung: vor dem ersten Sprechen die ruhigen Frames sammeln
    // und den Threshold ueber den Geraeuschboden legen. Blockiert die
    // Spracherkennung NICHT (es gilt bis zur Finalisierung der Admin-Wert);
    // wird sofort gesprochen oder fehlen ruhige Frames, bleibt es beim Wert.
    if (rt.calibrating) {
      if (!voiced) { rt.noiseSum += rms; rt.noiseCount++; }
      if (voiced || (now - rt.calibStart) >= STT_CALIB_MS) {
        if (rt.noiseCount >= 2) {
          rt.threshold = this._computeNoiseThreshold(rt.noiseSum / rt.noiseCount, this.$store.stt.vad.threshold);
        }
        rt.calibrating = false;
      }
    }

    const decision = this._computeVadCut({
      rms,
      threshold: rt.threshold,
      now,
      segmentStart: rt.segmentStart,
      lastVoiceTs: rt.lastVoiceTs,
      hasVoice: rt.hasVoice,
      silenceMs: this.$store.stt.vad.silenceMs,
      maxSegmentS: this.$store.stt.vad.maxSegmentS,
    });
    if (decision.voiced) { rt.hasVoice = true; rt.lastVoiceTs = now; rt.voicedMs += STT_TICK_MS; }

    // Absatz-Erkennung: erstes Sprechen nach einem silence-Cut -> Gesamtpause
    // messen (silenceMs vor dem Cut + Luecke bis jetzt). Ist sie deutlich
    // laenger als eine normale Sprechpause, wird die vorausgehende Grenze von
    // 'sentence' auf 'paragraph' hochgestuft (neuer Absatz statt nur ". ").
    if (decision.voiced && rt.silenceCutAt != null && rt.boundaryKindForNext === 'sentence') {
      const totalPause = (now - rt.silenceCutAt) + this.$store.stt.vad.silenceMs;
      if (totalPause >= this.$store.stt.vad.silenceMs * STT_PARAGRAPH_FACTOR) {
        rt.boundaryKindForNext = 'paragraph';
      }
      rt.silenceCutAt = null;
    }

    if (decision.cut && rt.rec.state === 'recording') {
      rt.lastCutReason = decision.reason;
      // Pausenanfang fuer die Absatz-Messung des naechsten Segments merken.
      rt.silenceCutAt = decision.reason === 'silence' ? now : null;
      // stop() triggert onstop -> Segment senden + naechstes Segment starten.
      try { rt.rec.stop(); } catch { /* noop */ }
    }
  },

  // True, sobald das Mikrofon irgendein Signal liefert. Der 8-Bit-Pegel des
  // VAD rundet das Grundrauschen eines leisen Raums (nach Rauschunterdrueckung)
  // auf exakt 0 — darum hier die Float-Samples, in denen auch ein sehr leiser
  // Raum nicht exakt null ist. Nur ein stummgeschaltetes Geraet ist es.
  _sttMicAlive(rt, rms) {
    if (rms > 0) return true;
    const a = rt.analyser;
    if (typeof a.getFloatTimeDomainData !== 'function') return false;
    rt.floatDomain ||= new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(rt.floatDomain);
    for (let i = 0; i < rt.floatDomain.length; i++) {
      if (Math.abs(rt.floatDomain[i]) > 1e-6) return true;
    }
    return false;
  },

  // „Transkribiert"-Status mit Mindest-Standzeit: An sofort beim Start eines
  // Segment-Uploads, Aus erst, wenn KEIN Request mehr laeuft — und dann
  // verzoegert (600 ms), damit kurze Segmente den Status nicht aufblitzen
  // lassen.
  _sttBusyOn() {
    this.$store.stt.transcribing++;
    this.$store.stt.busy = true;
    if (this._sttBusyTimer) { clearTimeout(this._sttBusyTimer); this._sttBusyTimer = null; }
  },
  _sttBusyOff() {
    this.$store.stt.transcribing = Math.max(0, this.$store.stt.transcribing - 1);
    if (this.$store.stt.transcribing > 0) return;
    if (this._sttBusyTimer) clearTimeout(this._sttBusyTimer);
    this._sttBusyTimer = setTimeout(() => { this.$store.stt.busy = false; this._sttBusyTimer = null; }, 600);
  },

  // Zwei Arten zu stoppen:
  //  - beendend (`finish: true`, Mic-Klick/Tastenkuerzel): das laufende
  //    Segment wird noch abgeschlossen und gesendet, laufende Transkripte
  //    werden noch eingefuegt. Die Session wandert nach `_sttDraining`; der
  //    „Transkribiert"-Status bleibt stehen, bis der letzte Satz im Text ist.
  //  - hart (Default: Seiten-/Buchwechsel, Edit-Modus verlassen, 401/404):
  //    laufende Requests und Retry-Waits werden abgebrochen, kein Transkript
  //    der Session (auch keiner auslaufenden) wird mehr eingefuegt.
  _sttStop({ finish = false } = {}) {
    const rt = this._sttRt;
    this._sttStartSeq = (this._sttStartSeq || 0) + 1; // laufenden Start entwerten
    this.$store.stt.recording = false;
    this.$store.stt.pending = false;
    this._sttRt = null;
    this._sttUserRange = null;
    if (rt?.vadTimer) { clearInterval(rt.vadTimer); rt.vadTimer = null; }

    if (finish && rt) {
      rt.stopping = true;
      this._sttDraining = rt;
      // stop() feuert onstop -> letztes Segment senden -> _sttRelease. Ohne
      // laufende Aufnahme gibt es kein onstop mehr: sofort freigeben.
      let stopped = false;
      try { if (rt.rec.state === 'recording') { rt.rec.stop(); stopped = true; } } catch { /* noop */ }
      if (stopped) {
        setTimeout(() => this._sttRelease(rt), STT_RELEASE_FALLBACK_MS);
      } else {
        this._sttRelease(rt);
        rt.insertChain.then(() => { if (this._sttDraining === rt) this._sttDraining = null; });
      }
      return;
    }

    this.$store.stt.busy = false;
    this.$store.stt.transcribing = 0;
    if (this._sttBusyTimer) { clearTimeout(this._sttBusyTimer); this._sttBusyTimer = null; }
    const draining = this._sttDraining;
    this._sttDraining = null;
    this._sttLastNode = null;
    for (const r of [rt, draining]) {
      if (!r || r.dead) continue;
      r.dead = true;
      r.stopping = true;
      // Laufende Transkriptions-Requests + Retry-Waits abbrechen. Bewusst VOR
      // rec.stop(): der finale onstop koennte sonst noch ein Segment senden.
      try { r.abort.abort(); } catch { /* noop */ }
      try { if (r.rec.state === 'recording') r.rec.stop(); } catch { /* noop */ }
      this._sttRelease(r);
    }
  },

  // Mikrofon, Audio-Graph und Stream einer Session freigeben. Idempotent: der
  // beendende Stopp ruft es aus onstop UND aus dem Fallback-Timer.
  _sttRelease(rt) {
    if (!rt || rt.released) return;
    rt.released = true;
    try { rt.stream.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
    try { rt.source.disconnect(); } catch { /* noop */ }
    try { rt.audioCtx.close(); } catch { /* noop */ }
  },
};
