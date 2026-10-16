// Titel-Kopf im BUCHEDITOR und die Freigabe-Übersicht der Struktur-Karte, gegen
// die ECHTE App.
//
// WARUM DIESE SCHICHT: beides ist buchtyp-gegatet. Der Smoke öffnet die Karten
// am Demo-Buch — einem Roman —, der Kopf bleibt dort verborgen, und keine seiner
// Alpine-Expressions wird je ausgewertet (Alpine schluckt Expression-Fehler in
// nicht gerenderten Zweigen vollständig).
//
// Geprüfte Zusagen:
//   1. Im Ressort steht ein gesetzter Titel über dem Beitrag — AUSSERHALB des
//      Bodys (er gelangt nicht in `block.html`).
//   2. Leere Felder erscheinen nur am aktiven Beitrag.
//   3. Speichern beim Verlassen über PUT /headline/page/:id, ohne den Block
//      dirty zu machen und ohne `pages.updated_at` zu bewegen.
//   4. Im Blog ist die Struktur-Karte da und zeigt «Vor der Freigabe offen»
//      für einen Beitrag mit verfehlter Form.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const card = (page) => page.locator('.card--bookeditor');
const cardData = (page) => page.evaluate(() => {
  const d = window.Alpine.$data(document.querySelector('.card--bookeditor'));
  return { dirty: d.dirtyCount, active: d.activePageId };
});

async function setBuchtyp(page, buchtyp) {
  await page.evaluate(async (bt) => {
    const bookId = window.Alpine.store('nav').selectedBookId;
    const res = await fetch(`/booksettings/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'de', region: 'CH', buchtyp: bt }),
    });
    if (!res.ok) throw new Error('booksettings PUT ' + res.status);
    await window.__app.loadBooks();
  }, buchtyp);
}

const putHead = (page, pageId, body) => page.evaluate(async ([id, b]) => {
  const res = await fetch(`/headline/page/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  });
  if (!res.ok) throw new Error('headline PUT ' + res.status);
}, [pageId, body]);

const getHead = (page, pageId) => page.evaluate(async (id) =>
  (await (await fetch(`/headline/page/${id}`)).json()).headline, pageId);

const pageStamp = (page, pageId) => page.evaluate(async (id) =>
  (await (await fetch(`/content/pages/${id}`)).json()).updated_at, pageId);

test.describe('Bucheditor: Titel-Kopf · Struktur-Karte: Freigabe-Übersicht', () => {
  let originalBuchtyp = null;

  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await selectSeededBook(page);
    originalBuchtyp = await page.evaluate(() => {
      const nav = window.Alpine.store('nav');
      return nav.books.find(b => String(b.id) === String(nav.selectedBookId))?.buchtyp || null;
    });
  });

  // Das Testbuch wird umgetypt; am Ende zurück auf den AUSGANGSTYP (nicht
  // pauschal Roman — welches Buch der Seed zuerst liefert, ändert sich), damit
  // die übrigen Specs derselben DB ihr Buch so sehen, wie sie es erwarten.
  test.afterEach(async ({ page }) => {
    await setBuchtyp(page, originalBuchtyp).catch(() => {});
  });

  test('Kopf über dem Beitrag, ausserhalb des Bodys; Speichern ohne dirty', async ({ page }) => {
    await setBuchtyp(page, 'journalismus');
    const ids = await page.evaluate(() => window.Alpine.store('nav').pages.slice(0, 2).map(p => p.id));
    await putHead(page, ids[0], { dachzeile: 'RESSORT-PROBE', titel: 'Schlagzeile Probe' });

    await page.evaluate(() => window.__app.toggleBookEditorCard());
    const first = card(page).locator(`[data-outline-page-id="${ids[0]}"]`);
    await expect(first.locator('.book-editor-head__field--titel')).toHaveValue('Schlagzeile Probe', { timeout: 15000 });
    await expect(first.locator('.book-editor-head__field--dachzeile')).toHaveValue('RESSORT-PROBE');
    // Ungefüllter Lead an einem NICHT aktiven Beitrag: kein Platz.
    await expect(first.locator('.book-editor-head__field--lead')).toBeHidden();
    // Der Kopf ist kein Text: nicht im Body, nicht in block.html.
    await expect(first.locator('.book-editor-page-body')).not.toContainText('Schlagzeile Probe');
    const inHtml = await page.evaluate((id) => {
      const d = window.Alpine.$data(document.querySelector('.card--bookeditor'));
      return d.blocks.find(b => b.pageId === id)?.html.includes('Schlagzeile Probe');
    }, ids[0]);
    expect(inHtml).toBe(false);

    // Zweiter Beitrag aktivieren → leere Felder erscheinen dort.
    const second = card(page).locator(`[data-outline-page-id="${ids[1]}"]`);
    await expect(second.locator('.book-editor-head')).toBeHidden();
    await second.locator('.book-editor-page-body').click();
    await expect.poll(async () => (await cardData(page)).active).toBe(ids[1]);
    const lead = second.locator('.book-editor-head__field--lead');
    await expect(lead).toBeVisible();

    const stampBefore = await pageStamp(page, ids[1]);
    await lead.click();
    await page.keyboard.type('Ein Lead aus dem Bucheditor.');
    await second.locator('.book-editor-head__field--titel').click();   // Lead verlassen → speichern
    await expect.poll(async () => (await getHead(page, ids[1]))?.lead, { timeout: 10000 })
      .toBe('Ein Lead aus dem Bucheditor.');
    expect((await cardData(page)).dirty, 'der Kopf macht den Block nicht dirty').toBe(0);
    expect(await pageStamp(page, ids[1]), 'der Kopf bewegt pages.updated_at nicht').toBe(stampBefore);

    // Aufräumen: die Köpfe leeren (Smoke-DB lebt über den Lauf).
    await putHead(page, ids[0], { dachzeile: null, titel: null });
    await putHead(page, ids[1], { lead: null });
  });

  test('Blog: Struktur-Karte da, «Vor der Freigabe offen» listet verfehlte Form', async ({ page }) => {
    await setBuchtyp(page, 'blog');
    const pageId = await page.evaluate(() => window.Alpine.store('nav').pages[0].id);
    // Textsorte setzen: im Blog geht das jetzt (vorher war die Karte dort weg).
    // Einen echten Befund gibt es ohne KI-Lauf nicht — die Bedenken-Logik selbst
    // prüft tests/integration/bearbeitungsstand.test.js, hier zählt das Rendern.
    await page.evaluate(async (id) => {
      await fetch(`/textsorte/page/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ textsorte: 'kommentar' }),
      });
    }, pageId);

    await page.evaluate(() => window.__app.toggleStrukturCard());
    const sk = page.locator('.card--struktur');
    await expect(sk).toBeVisible({ timeout: 15000 });
    await expect(sk.locator('.struktur-table')).toBeVisible();

    // Bedenken in den Karten-State legen, wie sie der Server liefern würde, und
    // das Rendern der Übersicht prüfen (Expressions, Entity-Refs, Plaketten).
    await page.evaluate((id) => {
      const d = window.Alpine.$data(document.querySelector('.card--struktur'));
      d.strukturBedenken = { [id]: { struktur: { urteil: 'verfehlt' }, otone: [{ source_id: 999999, title: 'Gespräch Probe', oton_auth: 'ausstehend', count: 1 }] } };
    }, pageId);
    const section = sk.locator('.struktur-bedenken');
    await expect(section).toBeVisible();
    await expect(section.locator('.struktur-bedenken-item')).toHaveCount(1);
    await expect(section.locator('.struktur-urteil--verfehlt')).toBeVisible();
    await expect(section.locator('.struktur-bedenken-oton .badge-warn')).toBeVisible();

    // Und der echte Endpunkt antwortet im Blog (enabled) — ohne Befund leer.
    const real = await page.evaluate(async () => {
      const bookId = window.Alpine.store('nav').selectedBookId;
      return (await fetch(`/redaktion/${bookId}/bedenken`)).json();
    });
    expect(real.enabled).toBe(true);

    await page.evaluate(async (id) => {
      await fetch(`/textsorte/page/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ textsorte: null }),
      });
    }, pageId);
  });
});
