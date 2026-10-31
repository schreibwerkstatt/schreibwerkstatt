'use strict';
// Denkphase im Fortschrittsbalken (adaptives Thinking, nur Claude). Während des
// Denkens streamt der Provider keinen Text, nur Pings — ein rein zeichenbasierter
// Balken stünde minutenlang still und spränge dann. Darum rückt die Call-Fraktion in
// der Denkphase zeitbasiert asymptotisch bis THINK_SHARE vor (Timer, weil keine
// Events kommen); der gestreamte Text füllt danach den Rest. Monoton in Zeit und
// Zeichen → der Balken läuft nie rückwärts.
// Konsumenten: aiCall (./ai.js) und der Abschnitts-Chat (../chat/page-chat.js), der
// callAIChat direkt aufruft.

// Anteil einer Call-Fraktion, den das Denken höchstens füllt, Zeitkonstante der
// Annäherung (nach TAU ~63 % davon) und Tick-Intervall des Timers. TAU grob an einem
// Opus-5.5-Lektorat-Pass (~1 Min Denken).
const THINK_SHARE = 0.6;
const THINK_TAU_MS = 40000;
const THINK_TICK_MS = 1000;

/**
 * @param {{ onTick?: () => void }} [opts] onTick: läuft im Sekundentakt, solange
 *   gedacht wird (ohne onTick kein Timer — der Aufrufer hat keinen Balken).
 */
function createThinkPhase({ onTick = null } = {}) {
  let active = false;
  let startMs = null;
  let floor = 0;
  let timer = null;
  const share = () => (startMs == null ? floor
    : Math.max(floor, THINK_SHARE * (1 - Math.exp(-(Date.now() - startMs) / THINK_TAU_MS))));
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  return {
    get active() { return active; },
    /** Fraktion 0..1 des Calls bei `done` (0..1) Anteil gestreamten Texts. */
    fraction(done) {
      const t = share();
      return t + (1 - t) * Math.min(1, Math.max(0, done));
    },
    /** Liefert true bei einem Wechsel. */
    set(on) {
      if (active === on) return false;
      active = on;
      if (on) {
        startMs = Date.now();
        if (onTick && !timer) {
          timer = setInterval(onTick, THINK_TICK_MS);
          timer.unref?.();
        }
      } else {
        floor = share();
        startMs = null;
        stopTimer();
      }
      return true;
    },
  };
}

module.exports = { createThinkPhase, THINK_SHARE, THINK_TAU_MS, THINK_TICK_MS };
