// Figuren-Werkstatt: Bearbeiten der Mindmap gegen die ECHTE App — geschütztes
// Löschen (Entf + Kontextmenü), Rückgängig/Wiederholen, ein Save zur Zeit und
// die Konflikt-Rückfrage bei 409 DRAFT_CONFLICT.
//
// Warum diese Schicht: Entf läuft über jsMinds Shortcut-Provider (eigener
// Handler `safedel` statt des eingebauten `delnode`), die Rückfrage über den
// echten appConfirm-Dialog und der Undo-Stapel über die Edit-Events von jsMind —
// nichts davon existiert in einem Fixture-Harness.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--werkstatt';
const RUN = String(Date.now()).slice(-6);
const DIALOG = '#app-confirm-dialog';

async function openWerkstattWithDraft(page, name) {
  const bookId = await selectSeededBook(page);
  const draft = await page.evaluate(async ({ bookId, name }) => {
    const r = await fetch(`/draft-figures/${bookId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(`POST /draft-figures fehlgeschlagen: ${r.status}`);
    return r.json();
  }, { bookId, name });
  await page.evaluate(() => window.__app.toggleFigurWerkstattCard());
  await expect(page.locator(CARD)).toBeVisible();
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('figur-werkstatt:select', { detail: { draftId: id } })), draft.id);
  await expect(page.locator(`${CARD} jmnode.root`)).toHaveText(name);
  return draft;
}

async function deleteDraft(page, id) {
  await page.evaluate((id) => fetch(`/draft-figures/${id}`, { method: 'DELETE' }), id);
}

const card = (page, fn, arg) => page.evaluate(([src, a]) => {
  const c = window.Alpine.$data(document.querySelector('.card--werkstatt'));
  return new Function('c', 'a', src)(c, a);
}, [fn, arg]);

// Knoten auswählen und Entf im Canvas drücken (geht über jsMinds Shortcut-Provider).
async function pressDeleteOn(page, nodeId) {
  await card(page, 'c._jm.select_node(a);', nodeId);
  await page.locator(`${CARD} .jsmind-inner`).focus();
  await page.keyboard.press('Delete');
}

const hasNode = (page, id) => card(page, 'return !!c._jm.get_node(a);', id);

test('Entf: Kern-Knoten bleibt, Blatt geht, Rückgängig/Wiederholen tragen', async ({ page }) => {
  await bootApp(page);
  const draft = await openWerkstattWithDraft(page, `Lösch-Probe ${RUN}`);
  try {
    // Kern: gesperrt, mit Hinweis.
    await pressDeleteOn(page, 'want');
    expect(await hasNode(page, 'want')).toBe(true);
    await expect(page.locator(`${CARD} .card-status--error`)).toBeVisible();
    // Container mit Kern darunter ebenso.
    await pressDeleteOn(page, 'subtext');
    expect(await hasNode(page, 'subtext')).toBe(true);

    // Blatt ohne Kinder: sofort weg, ohne Rückfrage.
    await pressDeleteOn(page, 'musikgeschmack');
    expect(await hasNode(page, 'musikgeschmack')).toBe(false);
    await expect(page.locator(DIALOG)).not.toBeVisible();
    expect(await card(page, 'return c.isDirty();')).toBe(true);

    // Rückgängig über den Knopf, Wiederholen per Tastatur.
    await page.locator(`${CARD} .werkstatt-mindmap-controls button[aria-label="Rückgängig"]`).click();
    expect(await hasNode(page, 'musikgeschmack')).toBe(true);
    await page.locator(`${CARD} .jsmind-inner`).focus();
    await page.keyboard.press('Control+Shift+z');
    expect(await hasNode(page, 'musikgeschmack')).toBe(false);
  } finally {
    await deleteDraft(page, draft.id);
  }
});

test('Teilbaum löschen fragt nach; Abbrechen lässt ihn stehen', async ({ page }) => {
  await bootApp(page);
  const draft = await openWerkstattWithDraft(page, `Teilbaum-Probe ${RUN}`);
  try {
    // „Stimme" hat drei Unterknoten und ist kein Kern.
    await pressDeleteOn(page, 'stimme');
    const dialog = page.locator(DIALOG);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect(await hasNode(page, 'stimme')).toBe(true);

    // Über das Kontextmenü, diesmal bestätigt.
    await card(page, 'c._jm.select_node(a);', 'stimme');
    await page.locator(`${CARD} jmnode[nodeid="stimme"]`).click({ button: 'right' });
    await page.locator(`${CARD} .werkstatt-context-menu .context-menu-item--danger`).click();
    await dialog.locator('.confirm-dialog-btn--danger').click();
    expect(await hasNode(page, 'stimme')).toBe(false);
    expect(await hasNode(page, 'sprechweise')).toBe(false);

    // Kern-Knoten: Löschen-Eintrag gesperrt.
    await page.locator(`${CARD} jmnode[nodeid="want"]`).click({ button: 'right' });
    await expect(page.locator(`${CARD} .werkstatt-context-menu .context-menu-item--danger`)).toBeDisabled();
  } finally {
    await deleteDraft(page, draft.id);
  }
});

test('Zwei Saves gleichzeitig: kein Konflikt gegen sich selbst', async ({ page }) => {
  await bootApp(page);
  const draft = await openWerkstattWithDraft(page, `Save-Probe ${RUN}`);
  try {
    const res = await card(page, `
      c.editNotes = 'erste';
      const first = c.saveDraft();
      c.editNotes = 'zweite';
      const second = c.saveDraft();
      return Promise.all([first, second]).then(r => ({ r, err: c.errorMessage }));
    `);
    expect(res.r).toEqual([true, true]);
    expect(res.err).toBe('');
    const server = await page.evaluate((id) => fetch(`/draft-figures/by-id/${id}`).then(r => r.json()), draft.id);
    expect(server.notes).toBe('zweite');
  } finally {
    await deleteDraft(page, draft.id);
  }
});

test('409 DRAFT_CONFLICT: „Meine Version speichern" überschreibt den neueren Stand', async ({ page }) => {
  await bootApp(page);
  const draft = await openWerkstattWithDraft(page, `Konflikt-Probe ${RUN}`);
  try {
    // Zweiter Tab schreibt dazwischen.
    await page.evaluate((id) => fetch(`/draft-figures/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'aus dem anderen Tab' }),
    }), draft.id);

    const saved = card(page, `c.editNotes = 'meine Notiz'; return c.saveDraft();`);
    const dialog = page.locator(DIALOG);
    await expect(dialog).toBeVisible();
    await dialog.locator('.confirm-dialog-btn--danger').click();
    expect(await saved).toBe(true);

    const server = await page.evaluate((id) => fetch(`/draft-figures/by-id/${id}`).then(r => r.json()), draft.id);
    expect(server.notes).toBe('meine Notiz');
    expect(await card(page, 'return c.isDirty();')).toBe(false);
  } finally {
    await deleteDraft(page, draft.id);
  }
});

test('409 DRAFT_CONFLICT: Esc auf beiden Rückfragen verliert nichts', async ({ page }) => {
  await bootApp(page);
  const draft = await openWerkstattWithDraft(page, `Konflikt-Esc ${RUN}`);
  try {
    await page.evaluate((id) => fetch(`/draft-figures/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'fremd' }),
    }), draft.id);

    const saved = card(page, `c.editNotes = 'lokal'; return c.saveDraft();`);
    const dialog = page.locator(DIALOG);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();     // zweite Rückfrage: Server-Version laden?
    await page.keyboard.press('Escape');
    expect(await saved).toBe(false);
    expect(await card(page, 'return c.editNotes;')).toBe('lokal');
    const server = await page.evaluate((id) => fetch(`/draft-figures/by-id/${id}`).then(r => r.json()), draft.id);
    expect(server.notes).toBe('fremd');
  } finally {
    await deleteDraft(page, draft.id);
  }
});
