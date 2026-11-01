// Nutzungs-Events am Root (docs/usage-events.md) gegen die ECHTE App: der
// Sitzungsstart beim Boot und die Editor-Sitzung, abgeleitet aus der innersten
// offenen Flaeche (Bucheditor › Fokus › Notebook) — nur im vollen Baum mit den
// echten Show-Flags pruefbar.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

function eventsOf(page) {
  const seen = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/usage/event') seen.push(JSON.parse(r.postData() || '{}'));
  });
  return seen;
}

test('Boot meldet session.start; Bucheditor oeffnen/schliessen meldet eine Sitzung', async ({ page }) => {
  const seen = eventsOf(page);
  await bootApp(page);
  await expect.poll(() => seen.find(e => e.event === 'session.start')).toBeTruthy();
  const start = seen.find(e => e.event === 'session.start');
  expect(['browser', 'pwa']).toContain(start.meta.surface);

  await page.evaluate(() => { window.__app.showBookEditorCard = true; });
  await expect.poll(() => seen.find(e => e.event === 'editor.open')?.meta).toEqual({ editor: 'book' });
  await page.evaluate(() => { window.__app.showBookEditorCard = false; });
  await expect.poll(() => seen.find(e => e.event === 'editor.close')?.meta?.editor).toBe('book');
  expect(Number.isInteger(seen.find(e => e.event === 'editor.close').meta.durationSec)).toBe(true);
});

test('Fokus innerhalb des Edit-Modus zaehlt als Fokus-Sitzung, nicht doppelt', async ({ page }) => {
  const seen = eventsOf(page);
  await bootApp(page);
  // Flags direkt: geprueft wird die Ableitung, nicht der Einstieg in die Editoren.
  await page.evaluate(() => { window.__app.editMode = true; });
  await expect.poll(() => seen.filter(e => e.event === 'editor.open').map(e => e.meta.editor)).toEqual(['notebook']);
  await page.evaluate(() => { window.__app.focusActive = true; });
  await expect.poll(() => seen.filter(e => e.event.startsWith('editor.')).map(e => `${e.event}:${e.meta.editor}`))
    .toEqual(['editor.open:notebook', 'editor.close:notebook', 'editor.open:focus']);
  await page.evaluate(() => { window.__app.focusActive = false; window.__app.editMode = false; });
  await expect.poll(() => seen.filter(e => e.event === 'editor.close').map(e => e.meta.editor)).toEqual(['notebook', 'focus']);
});

test('Datenschutzerklaerung nennt die Nutzungsdaten und verspricht keine Tracking-Freiheit mehr', async ({ page }) => {
  await page.goto('/datenschutz');
  const body = page.locator('body');
  await expect(body).toContainText(/Nutzungsdaten|Usage data/);
  await expect(body).not.toContainText(/kein Tracking|No tracking/);
  await expect(body).not.toContainText('{{');
});
