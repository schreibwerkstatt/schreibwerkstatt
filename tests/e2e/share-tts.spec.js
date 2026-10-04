// E2E: Vorlese-Dock im Share-Reader (public/js/share-reader/tts.js) gegen ein
// Harness mit gemocktem Audio und Fetch-Stub. Prueft die Reader-Glue um den
// geteilten Abspielkern: Dock-Aufbau, Satztrennung nach der Buchsprache,
// <br> als Pause, Vor/Zurueck, Lesetempo, Fehler-Status ohne eingefrorene
// Tasten, kein Stop beim Wechsel in den Hintergrund.

const { test, expect } = require('./_helpers/fixtures');

const URL = 'http://localhost:8765/tests/fixtures/share-tts-harness.html';
const dock = (page) => page.locator('.tts-dock');
const btn = (page, label) => dock(page).locator(`button[aria-label="${label}"]`);

async function startReading(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await expect(dock(page)).toHaveCount(1);
  await btn(page, 'tts_listen').click();
  await page.waitForFunction(() => window.__audios.length >= 1);
}

test('Dock startet, markiert den Satz und zeigt den Fortschritt', async ({ page }) => {
  await startReading(page);
  await page.waitForFunction(() => CSS.highlights.has('tts-sentence'));
  await expect(dock(page).locator('.tts-status')).toHaveText('tts_reading');
  await expect(btn(page, 'tts_pause')).toHaveAttribute('aria-pressed', 'true');
});

test('<br> wird als Pause gesprochen, nicht zusammengeklebt', async ({ page }) => {
  await startReading(page);
  await btn(page, 'tts_skip').click();
  await page.waitForFunction(() => window.__sent.some(t => t.includes('Veilchen')));
  const sent = await page.evaluate(() => window.__sent.join(' | '));
  expect(sent).toContain('Haus, Veilchen');
  expect(sent).not.toContain('HausVeilchen');
});

test('Vor und Zurueck wechseln den Satz, auch pausiert', async ({ page }) => {
  await startReading(page);
  await btn(page, 'tts_pause').click();
  await expect(btn(page, 'tts_resume')).toBeVisible();
  const hl = () => page.evaluate(() => [...CSS.highlights.get('tts-sentence')][0].toString());
  await btn(page, 'tts_skip').click();
  await expect.poll(hl).toContain('Rosen');
  await btn(page, 'tts_prev').click();
  await expect.poll(hl).toContain('erste Satz');
});

test('Lesetempo schaltet zyklisch und wirkt aufs laufende Audio', async ({ page }) => {
  await startReading(page);
  const rate = dock(page).locator('.dock-btn--text');
  await expect(rate).toHaveText('1×');
  await rate.click();
  await expect(rate).toHaveText('1.25×');
  expect(await page.evaluate(() => window.__audios.at(-1).playbackRate)).toBe(1.25);
});

test('Fehler zeigt kurz den Status, die Tasten folgen trotzdem dem Zustand', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { window.__fail = true; });
  await btn(page, 'tts_listen').click();
  await expect(dock(page).locator('.tts-status')).toHaveText('ERR');
  // Waehrend der Fehler steht: Session endet (alle Saetze scheitern) → Haupttaste
  // ist sofort wieder „Vorlesen", nicht erst nach Ablauf des Fehlerfensters.
  await expect(btn(page, 'tts_listen')).toBeVisible({ timeout: 3000 });
});

test('Wechsel in den Hintergrund stoppt das Vorlesen nicht', async ({ page }) => {
  await startReading(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(btn(page, 'tts_pause')).toBeVisible();
});
