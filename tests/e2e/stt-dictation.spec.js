// E2E: STT-Diktat im Notebook-Editor (Harness mit gemocktem getUserMedia/
// MediaRecorder/AudioContext; /stt/transcribe ist im Test-Server gemockt und
// liefert "Hallo Welt"). Prueft: Button nur bei sttEnabled, VAD-Segment ->
// Text am Cursor + Autosave-Trigger, Stop gibt Mic frei, Permission-Denial ->
// i18n-Fehler ohne Crash.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/stt-harness.html';

async function ready(page, url = HARNESS) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
}

// Caret ans Ende des Editor-Inhalts setzen.
async function placeCaret(page) {
  await page.evaluate(() => {
    const el = document.getElementById('editor');
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  });
}

// Caret an den Anfang des Editor-Inhalts setzen (collapse to start). `userSet`
// markiert ihn als bewusst gesetzt (sonst gilt er als veraltet -> Editorende).
async function placeCaretStart(page, userSet) {
  await page.evaluate((flag) => {
    const el = document.getElementById('editor');
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(true);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    window.__sttApp.$store.stt.caretUserSet = !!flag;
  }, userSet);
}

// Ein VAD-Segment ausloesen (sprechen -> Stille -> Schnitt) und auf das
// eingefuegte Transkript warten.
async function dictateOneSegment(page) {
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__voice = false; });
  await page.waitForFunction(() => document.getElementById('editor').textContent.includes('Hallo Welt'));
}

test('Mic-Klick ohne bewussten Caret haengt ans Editorende an', async ({ page }) => {
  await ready(page, HARNESS + '?enabled=true');
  // Veralteter Caret am Anfang, NICHT bewusst gesetzt -> muss ans Ende anhaengen.
  await placeCaretStart(page, false);
  await dictateOneSegment(page);

  const text = await page.evaluate(() => document.getElementById('editor').textContent);
  expect(text.startsWith('Start')).toBe(true);
  expect(text.trimEnd().endsWith('Hallo Welt')).toBe(true);
});

test('Bewusst gesetzter Caret: Diktat fuegt dort ein', async ({ page }) => {
  await ready(page, HARNESS + '?enabled=true');
  // Bewusster Caret am Anfang -> Diktat erscheint VOR "Start.".
  await placeCaretStart(page, true);
  await dictateOneSegment(page);

  const text = await page.evaluate(() => document.getElementById('editor').textContent);
  expect(text.startsWith('Hallo Welt')).toBe(true);
  expect(text.includes('Start.')).toBe(true);
});

test('Lange Sprechpause -> zweites Segment wird neuer Absatz', async ({ page }) => {
  await ready(page, HARNESS + '?enabled=true');
  // Harness-VAD: silenceMs=150 -> Absatzschwelle = 150*2.5 = 375ms Gesamtpause.
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);

  // Segment 1: sprechen -> Stille (Silence-Cut).
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(350);
  await page.evaluate(() => { window.__voice = false; });
  // Lange Pause (> Absatzschwelle), danach wieder sprechen.
  await page.waitForTimeout(550);
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(350);
  await page.evaluate(() => { window.__voice = false; });
  await page.waitForTimeout(400);

  // Zwei <p>: der urspruengliche + ein neuer Absatz fuers zweite Segment.
  await page.waitForFunction(() => document.querySelectorAll('#editor p').length >= 2);
  const lastP = await page.evaluate(() => {
    const ps = document.querySelectorAll('#editor p');
    return ps[ps.length - 1].textContent;
  });
  expect(lastP.includes('Hallo Welt')).toBe(true);
});

test('Button nur bei sttEnabled vorhanden', async ({ page }) => {
  await ready(page, HARNESS + '?enabled=false');
  await expect(page.locator('#stt-mic')).toHaveCount(0);

  await ready(page, HARNESS + '?enabled=true');
  await expect(page.locator('#stt-mic')).toHaveCount(1);
});

test('VAD-Segment fuegt Transkript am Cursor ein + triggert Autosave', async ({ page }) => {
  await ready(page);
  await placeCaret(page);

  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);
  await expect(page.locator('#stt-mic')).toHaveAttribute('aria-pressed', 'true');

  // Sprechen simulieren, dann Stille -> VAD schneidet das Segment.
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__voice = false; });

  // Eingefuegter Text erscheint + Autosave (dirty) getriggert.
  await page.waitForFunction(() => document.getElementById('editor').textContent.includes('Hallo Welt'));
  const dirty = await page.evaluate(() => window.__dirtyCount);
  expect(dirty).toBeGreaterThan(0);

  // Aufnahme laeuft weiter (naechstes Segment) — Button bleibt gedrueckt.
  await expect(page.locator('#stt-mic')).toHaveAttribute('aria-pressed', 'true');
});

test('Stop gibt Mikrofon frei (kein Leak)', async ({ page }) => {
  await ready(page);
  await placeCaret(page);
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);

  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === false);
  const stopped = await page.evaluate(() => window.__micStopped);
  expect(stopped).toBeGreaterThan(0);
  await expect(page.locator('#stt-mic')).toHaveAttribute('aria-pressed', 'false');
});

test('Segmente werden in Sprechreihenfolge eingefuegt, auch wenn Transkripte out-of-order zurueckkommen', async ({ page }) => {
  // Erstes Segment kuenstlich stark verzoegern, zweites sofort beantworten ->
  // die Transkripte loesen in UMGEKEHRTER Reihenfolge auf. Trotzdem muss "AAA"
  // (frueher gesprochen) vor "BBB" im Text stehen — die Insert-Kette serialisiert.
  let n = 0;
  await page.route('**/stt/transcribe*', async (route) => {
    const i = ++n;
    if (i === 1) await new Promise((r) => setTimeout(r, 800)); // erstes Segment langsam
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: i === 1 ? 'AAA' : 'BBB' }) });
    } catch { /* Request ggf. abgebrochen */ }
  });
  await ready(page, HARNESS + '?enabled=true');
  await placeCaret(page);
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);

  // Segment 1: sprechen -> Stille (Silence-Cut, langsame Antwort).
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__voice = false; });
  await page.waitForTimeout(250);
  // Segment 2: sprechen -> Stille (Silence-Cut, schnelle Antwort).
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__voice = false; });
  await page.waitForTimeout(250);

  await page.waitForFunction(() => {
    const t = document.getElementById('editor').textContent;
    return t.includes('AAA') && t.includes('BBB');
  });
  const text = await page.evaluate(() => document.getElementById('editor').textContent);
  expect(text.indexOf('AAA')).toBeLessThan(text.indexOf('BBB'));
});

test('Harter Stopp (Kontextwechsel) verwirft noch laufende Transkripte', async ({ page }) => {
  // Antwort verzoegern, dann waehrend der Transkription hart stoppen (wie bei
  // Seiten-/Buchwechsel oder Verlassen des Edit-Modus) -> der Abort bricht den
  // Request ab, das spaet eintreffende "Hallo Welt" darf NICHT mehr im Editor landen.
  await page.route('**/stt/transcribe*', async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'Hallo Welt' }) });
    } catch { /* Request abgebrochen */ }
  });
  await ready(page, HARNESS + '?enabled=true');
  await placeCaret(page);
  const before = await page.evaluate(() => document.getElementById('editor').textContent);

  const reqSent = page.waitForRequest('**/stt/transcribe*');
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__voice = false; });
  await page.waitForTimeout(250);
  await reqSent; // Request ist raus, Antwort noch unterwegs
  await page.evaluate(() => window.__sttApp._sttStop()); // harter Stopp
  expect(await page.evaluate(() => window.__sttApp.$store.stt.recording)).toBe(false);

  await page.waitForTimeout(900);
  const after = await page.evaluate(() => document.getElementById('editor').textContent);
  expect(after).toBe(before);
});

test('Mic-Klick waehrend laufender Transkription: Transkript kommt noch in den Text', async ({ page }) => {
  await page.route('**/stt/transcribe*', async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'Hallo Welt' }) });
    } catch { /* Request abgebrochen */ }
  });
  await ready(page, HARNESS + '?enabled=true');
  await placeCaret(page);

  const reqSent = page.waitForRequest('**/stt/transcribe*');
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__voice = false; });
  await page.waitForTimeout(250);
  await reqSent;
  await page.locator('#stt-mic').click(); // Diktat beenden
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === false);
  // Mikrofon ist sofort frei, der „Transkribiert"-Status steht noch.
  expect(await page.evaluate(() => window.__micStopped)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__sttApp.$store.stt.busy)).toBe(true);

  await page.waitForFunction(() => document.getElementById('editor').textContent.includes('Hallo Welt'));
});

test('Mic-Klick mitten im Sprechen: der letzte Abschnitt wird noch gesendet und eingefuegt', async ({ page }) => {
  await ready(page, HARNESS + '?enabled=true');
  await placeCaret(page);
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);
  // Sprechen und SOFORT stoppen — keine Sprechpause, also kein VAD-Schnitt.
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(300);
  const reqSent = page.waitForRequest('**/stt/transcribe*');
  await page.locator('#stt-mic').click();
  await reqSent;
  await page.waitForFunction(() => document.getElementById('editor').textContent.includes('Hallo Welt'));
  expect(await page.evaluate(() => window.__sttApp.$store.stt.recording)).toBe(false);
});

test('Kurzes Geraeusch (unter Mindest-Sprechdauer) wird nicht gesendet', async ({ page }) => {
  let requests = 0;
  page.on('request', (r) => { if (r.url().includes('/stt/transcribe')) requests++; });
  await ready(page, HARNESS + '?enabled=true');
  await placeCaret(page);
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);
  // Genau ein lauter VAD-Tick (Husten/Klick), danach Stille -> Silence-Cut.
  await page.evaluate(() => new Promise((resolve) => {
    const app = window.__sttApp;
    window.__voice = true;
    app._sttVadTick();
    window.__voice = false;
    resolve();
  }));
  await page.waitForTimeout(500); // Silence-Cut ist durch (silenceMs=150)
  expect(requests).toBe(0);
  await page.evaluate(() => window.__sttApp._sttStop());
});

test('Klick an eine andere Stelle waehrend des Diktats: naechster Abschnitt landet dort', async ({ page }) => {
  let n = 0;
  await page.route('**/stt/transcribe*', async (route) => {
    const i = ++n;
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: i === 1 ? 'Eins' : 'Zwei' }) });
    } catch { /* abgebrochen */ }
  });
  await ready(page, HARNESS + '?enabled=true');
  await placeCaret(page);
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__voice = false; });
  await page.waitForFunction(() => document.getElementById('editor').textContent.includes('Eins'));

  // User setzt den Caret an den Anfang (wie _onEditClick im echten Editor).
  await page.evaluate(() => {
    const el = document.getElementById('editor');
    const r = document.createRange();
    r.setStart(el.querySelector('p').firstChild, 0);
    r.collapse(true);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    window.__sttApp._sttReanchorFromUser();
  });
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__voice = false; });
  await page.waitForFunction(() => document.getElementById('editor').textContent.includes('Zwei'));

  const text = await page.evaluate(() => document.getElementById('editor').textContent);
  expect(text.indexOf('Zwei')).toBeLessThan(text.indexOf('Start'));
  expect(text.indexOf('Start')).toBeLessThan(text.indexOf('Eins'));
  await page.evaluate(() => window.__sttApp._sttStop());
});

test('getUserMedia bekommt Mono + DSP-Constraints', async ({ page }) => {
  await ready(page, HARNESS + '?enabled=true');
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);
  const c = await page.evaluate(() => window.__lastConstraints);
  expect(c.audio.channelCount).toBe(1);
  expect(c.audio.noiseSuppression).toBe(true);
  expect(c.audio.echoCancellation).toBe(true);
  expect(c.audio.autoGainControl).toBe(true);
});

test('Kaputter 200-Body -> Fehler-Toast statt stiller Drop', async ({ page }) => {
  await page.route('**/stt/transcribe*', async (route) => {
    // 200, aber kein gueltiges JSON -> res.json() wirft.
    try { await route.fulfill({ status: 200, contentType: 'application/json', body: 'NICHT JSON' }); } catch { /* abgebrochen */ }
  });
  await ready(page, HARNESS + '?enabled=true');
  await placeCaret(page);
  const before = await page.evaluate(() => document.getElementById('editor').textContent);
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__voice = false; });

  await page.waitForFunction(() => window.__toasts.some((t) => t.message === 'stt.error.failed'));
  const after = await page.evaluate(() => document.getElementById('editor').textContent);
  expect(after).toBe(before); // nichts eingefuegt
  await page.evaluate(() => window.__sttApp._sttStop()); // Toast-Flut beim Teardown vermeiden
});

test('401 (Session abgelaufen) -> Aufnahme stoppt, kein Fehler-Toast', async ({ page }) => {
  await page.route('**/stt/transcribe*', async (route) => {
    try { await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error_code: 'NOT_LOGGED_IN' }) }); } catch { /* abgebrochen */ }
  });
  await ready(page, HARNESS + '?enabled=true');
  await placeCaret(page);
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === true);
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__voice = false; });

  // 401 -> _sttStop -> Aufnahme aus; kein Fehler-Toast (Session-Banner kaeme global).
  await page.waitForFunction(() => window.__sttApp.$store.stt.recording === false);
  const toasts = await page.evaluate(() => window.__toasts.map((t) => t.message));
  expect(toasts).not.toContain('stt.error.failed');
});

test('Mic-Permission verweigert -> i18n-Fehler, kein Crash', async ({ page, consoleGuard }) => {
  await ready(page, HARNESS + '?deny=true');
  await placeCaret(page);
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__toasts.length > 0);
  const toast = await page.evaluate(() => window.__toasts[0]);
  expect(toast.message).toBe('stt.error.permission');
  // Recording wurde nicht gestartet.
  expect(await page.evaluate(() => window.__sttApp.$store.stt.recording)).toBe(false);
});
