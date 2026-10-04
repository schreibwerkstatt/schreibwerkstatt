// Abspielkern des Vorlesens (public/js/tts-player.js) — SSoT beider Oberflaechen
// (Notebook-Leseansicht + Share-Reader). Ohne Browser: Audio ist ein Fake, das
// Ende eines Segments loest der Test selbst aus; kein CSS.highlights (der Kern
// markiert dann nichts, der Ablauf bleibt gleich).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTtsPlayer, clearTtsAudioCache } from '../../public/js/tts-player.js';

const audios = [];
class FakeAudio {
  constructor(src) { this.src = src; this.paused = true; this.currentTime = 0; this._l = {}; this.playbackRate = 1; audios.push(this); }
  addEventListener(ev, cb) { (this._l[ev] = this._l[ev] || []).push(cb); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  end() { (this._l.ended || []).forEach(cb => cb()); }
}
globalThis.Audio = FakeAudio;

const tick = () => new Promise(r => setTimeout(r, 0));
async function until(cond, ms = 1000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await tick();
  }
}
const segs = (...texts) => texts.map((text, i) => ({ text, block: { id: i }, startOff: 0, endOff: text.length }));
const ok = () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), { status: 200 });

function setup(requestImpl) {
  const calls = [];
  const events = { failed: 0, fatal: [], stops: [], state: null };
  const player = createTtsPlayer({
    request: (text, signal) => { calls.push(text); return requestImpl(text, signal, calls.length); },
    getPause: () => ({ fragmentMs: 0, paragraphMs: 0 }),
    onState: (s) => { events.state = s; },
    onFailed: () => { events.failed++; },
    onFatal: (st) => { events.fatal.push(st); },
    onStop: (info) => { events.stops.push(info); },
  });
  return { player, calls, events };
}
const lastAudio = () => audios[audios.length - 1];

test.beforeEach(() => { audios.length = 0; clearTtsAudioCache(); });

test('liest alle Segmente der Reihe nach und meldet das Ende', async () => {
  const { player, calls, events } = setup(async () => ok());
  player.start(segs('Eins.', 'Zwei.', 'Drei.'));
  for (let i = 0; i < 3; i++) {
    await until(() => audios.length === i + 1 && !lastAudio().paused);
    lastAudio().end();
  }
  await until(() => events.stops.length === 1);
  assert.equal(events.stops[0].ended, true);
  assert.deepEqual(calls, ['Eins.', 'Zwei.', 'Drei.']);
  assert.equal(player.isActive(), false);
});

test('Weiter wirkt auch, waehrend ein Satz noch synthetisiert wird', async () => {
  const { player, events } = setup((text, signal) => (text === 'Langsam.'
    ? new Promise((_res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))
    : Promise.resolve(ok())));
  player.start(segs('Langsam.', 'Schnell.'));
  await until(() => events.state?.loading === true);
  player.skip();
  await until(() => events.state?.index === 2 && audios.length === 1);
  assert.equal(events.state.loading, false);
  player.stop();
});

test('Zurueck springt zum vorigen Satz (bzw. startet einen laufenden neu)', async () => {
  const { player, events } = setup(async () => ok());
  player.start(segs('A eins.', 'B zwei.', 'C drei.'), 2);
  await until(() => audios.length === 1);
  assert.equal(events.state.index, 3);
  player.prev();
  await until(() => events.state.index === 2);
  await until(() => audios.length === 2);
  lastAudio().currentTime = 5; // laeuft schon laenger → Neustart desselben Satzes
  player.prev();
  await until(() => audios.length === 3);
  assert.equal(events.state.index, 2);
  player.stop();
});

test('408 wird nicht wiederholt (der Server hat schon 20 s gewartet), Fehler einmal gemeldet', async () => {
  const { player, calls, events } = setup(async () => new Response('{}', { status: 408 }));
  player.start(segs('Eins.', 'Zwei.'));
  await until(() => events.stops.length === 1);
  assert.equal(calls.length, 2);
  assert.equal(events.failed, 1);
});

test('503 wird einmal wiederholt', async () => {
  const { player, calls } = setup(async (_t, _s, n) => (n === 1 ? new Response('{}', { status: 503 }) : ok()));
  player.start(segs('Eins.'));
  await until(() => audios.length === 1, 3000);
  assert.deepEqual(calls, ['Eins.', 'Eins.']);
  player.stop();
});

test('404/401/403 beenden die Session', async () => {
  for (const status of [404, 401, 403]) {
    const { player, events } = setup(async () => new Response('{}', { status }));
    player.start(segs('Eins.', 'Zwei.'));
    await until(() => events.fatal.length === 1);
    assert.deepEqual(events.fatal, [status]);
    assert.equal(player.isActive(), false);
  }
});

test('Audio-Cache: dieselben Saetze werden nicht erneut synthetisiert', async () => {
  const { player, calls, events } = setup(async () => ok());
  player.start(segs('Gleich.'));
  await until(() => audios.length === 1);
  lastAudio().end();
  await until(() => events.stops.length === 1);
  player.start(segs('Gleich.'));
  await until(() => audios.length === 2);
  assert.equal(calls.length, 1);
  player.stop();
});

test('Pause waehrend des Ladens: gespielt wird erst nach dem Fortsetzen', async () => {
  let release;
  const { player, events } = setup(() => new Promise((res) => { release = () => res(ok()); }));
  player.start(segs('Eins.'));
  await until(() => events.state?.loading === true);
  player.pause();
  release();
  await until(() => events.state?.loading === false);
  await tick();
  assert.equal(audios.length, 0);
  player.resume();
  await until(() => audios.length === 1 && !lastAudio().paused);
  player.stop();
});

test('updateSegments haengt die Position an den gleichlautenden Satz', async () => {
  const { player, events } = setup(async () => ok());
  player.start(segs('A.', 'B.', 'C.'), 1);
  await until(() => audios.length === 1);
  player.updateSegments(segs('Neu.', 'A.', 'B.', 'C.'));
  assert.equal(events.state.index, 3);
  lastAudio().end();
  await until(() => events.state.index === 4);
  player.stop();
});

test('Lesetempo wirkt auf das laufende Audio', async () => {
  const { player } = setup(async () => ok());
  player.start(segs('Eins.'));
  await until(() => audios.length === 1);
  player.setRate(1.25);
  assert.equal(lastAudio().playbackRate, 1.25);
  assert.equal(player.state().rate, 1.25);
  player.stop();
});

test('Stop raeumt auf: keine weitere Wiedergabe, onStop mit Position', async () => {
  const { player, events } = setup(async () => ok());
  player.start(segs('A.', 'B.', 'C.'), 1);
  await until(() => audios.length === 1);
  player.stop();
  await tick();
  assert.equal(events.stops.length, 1);
  assert.equal(events.stops[0].ended, false);
  assert.equal(events.stops[0].index, 1);
  assert.equal(events.stops[0].seg.text, 'B.');
  assert.equal(audios.length, 1);
  assert.equal(lastAudio().paused, true);
});
