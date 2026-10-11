// Alpine.store('stt') — STT-Diktat-State (nur Notebook-Editor). Vorher flach in
// der Root-God-State; jetzt eine schmale, benannte Store-Oberfläche. Der
// Store-Name liefert den Namespace, darum tragen die Keys kein `stt`-Präfix mehr
// (Zugriff via `$store.stt.recording`).
//
// Konsumenten greifen direkt zu (kein Root-Proxy): stt-dictation.js/stt-time.js/
// figur-lookup.js (in den Root gespreadet) via `this.$store.stt.*`, der
// Edit-Lifecycle via `app.$store.stt.*`, app-init.js setzt beim Boot
// `this.$store.stt.enabled/vad`, das Template editor-body-edit.html bindet
// `$store.stt.*`. stt-time.js watcht `() => this.$store.stt.recording`.
//
// Feld-Bedeutung:
//   enabled — /config `stt.enabled` (Admin enabled + Host gesetzt); blendet den
//             Mic-Button in der Notebook-Toolbar ein. Sprache löst der Proxy aus
//             der Buch-Locale auf — kein Frontend-State dafür.
//   vad     — browserseitige VAD-Segmentierung (aus /config).
//   recording — aktive Aufnahme.
//   pending — kurzlebiger Re-Entry-Guard während getUserMedia/Stop läuft.
//   transcribing — Anzahl laufender Transkriptions-Requests.
//   busy    — davon abgeleiteter Anzeige-Flag mit Mindest-Standzeit (verhindert
//             Sub-Sekunden-Flackern des „Transkribiert"-Status bei kurzen
//             Segmenten; gesetzt via _sttBusyOn/_sttBusyOff in stt-dictation.js).
//   caretUserSet — true, sobald der User bewusst per Klick einen Caret im
//             Edit-Feld gesetzt hat. Steuert den Einfüge-Anker: gesetzt → Diktat
//             startet an der Caret-Position, sonst hängt es ans Editorende an.
//             Auto-Fokus beim Öffnen des Edit-Modus zählt NICHT.

export function registerSttStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('stt', {
    enabled: false,
    vad: { silenceMs: 1200, threshold: 0.015, maxSegmentS: 30 },
    recording: false,
    pending: false,
    transcribing: 0,
    busy: false,
    caretUserSet: false,
  });
}
