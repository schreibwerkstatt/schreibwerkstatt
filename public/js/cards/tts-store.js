// Alpine.store('tts') — TTS / Proof-Listening-State (Notebook-Seitenansicht,
// Read-Modus). Vorher flach in der Root-God-State; jetzt eine schmale, benannte
// Store-Oberfläche. Der Store-Name liefert den Namespace, darum tragen die Keys
// kein `tts`-Präfix mehr (Zugriff via `$store.tts.playing`).
//
// Konsumenten greifen direkt zu (kein Root-Proxy): tts-proof.js (in den Root
// gespreadet) via `this.$store.tts.playing`, app-init.js setzt beim Boot
// `this.$store.tts.enabled`/`pause`, das Template editor-body-view.html bindet
// `$store.tts.*`. Damit ist die Abhängigkeit explizit statt über die Root-Singleton.
//
// Feld-Bedeutung:
//   enabled — /config `tts.enabled` (Admin enabled + Host gesetzt); blendet den
//             Vorlese-Dock in der Leseansicht ein. Voice/Speed/Format löst der
//             /tts/speak-Proxy serverseitig auf — kein Frontend-State dafür.
//   pause   — Atempause (ms) zwischen den Fragmenten (aus /config, Admin-konfig.):
//             fragmentMs Satz-zu-Satz, paragraphMs an Absatzgrenzen; 0 = keine.
//             Defaults mirroren die app-settings-Defaults.
//   playing — Session aktiv (inkl. pausiert).
//   paused  — pausiert.
//   loading — wartet auf Audio des aktuellen Satzes.
//   index/total — Satz-Fortschritt für die Status-Pille.
//   rate    — Lesetempo (playbackRate, pro Browser gemerkt: localStorage tts.rate).
//   continueReading — am Seitenende mit der nächsten Seite des Kapitels
//             weiterlesen (pro Browser gemerkt: localStorage tts.continue).

export function registerTtsStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('tts', {
    enabled: false,
    pause: { fragmentMs: 250, paragraphMs: 550 },
    playing: false,
    paused: false,
    loading: false,
    index: 0,
    total: 0,
    rate: 1,
    continueReading: false,
  });
}
