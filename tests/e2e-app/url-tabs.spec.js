// Reiter-Permalinks (URL_TABS in public/js/cards/card-request.js) gegen die
// ECHTE App: `#book/:id/einstellungen/expose`, `#meine-buecher/fertig`,
// `#admin/users/invites` …
//
// Warum diese Schicht: der Reiter lebt in der Sub-Komponente, der Hash-Router
// liest den Store-Spiegel (`$store.nav.cardTab`), den setupCardLifecycle über
// `tabRequest.current` schreibt. Ob Spiegel, Lazy-Partial und Reiter-Wunsch beim
// Deep-Link zusammenspielen, sieht nur die gebootete App.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, waitBooted } = require('./_helpers/app');

// view: Hash ohne Reiter ({id} = Buch-ID); tab: ein Nicht-Grund-Reiter; def: Grund-Reiter.
const CASES = [
  { name: 'Bucheinstellungen',   view: '#book/{id}/einstellungen', tab: 'expose',    def: 'book',       sel: '.card--settings',       field: 'bookSettingsTab' },
  { name: 'PDF-Export',          view: '#book/{id}/pdf',           tab: 'cover',     def: 'layout',     sel: '.card--pdfexport',      field: 'activeTab' },
  { name: 'EPUB-Export',         view: '#book/{id}/epub',          tab: 'metadata',  def: 'typography', sel: '.card--epubexport',     field: 'activeTab' },
  { name: 'DOCX-Export',         view: '#book/{id}/docx',          tab: 'structure', def: 'layout',     sel: '.card--docxexport',     field: 'activeTab' },
  { name: 'Wortschatz',          view: '#book/{id}/wortschatz',    tab: 'phrases',   def: 'terms',      sel: '.card--wortschatz',     field: 'wortschatzTab' },
  { name: 'Motiv-Werkstatt',     view: '#book/{id}/motiv',         tab: 'outline',   def: 'graph',      sel: '.card--motiv',          field: 'motivView' },
  { name: 'Meine Bücher',        view: '#meine-buecher',           tab: 'fertig',    def: 'aktiv',      sel: '.card--mybooks',        field: 'myBooksTab' },
  { name: 'Admin-Nutzer',        view: '#admin/users',             tab: 'invites',   def: 'users',      sel: '.card--admin-users',    field: 'adminUsersTab' },
  { name: 'Admin-Einstellungen', view: '#admin/settings',          tab: 'smtp',      def: 'auth',       sel: '.card--admin-settings', field: 'adminSettingsTab' },
];

const tabOf = (page, sel, field) => page.evaluate(
  ({ sel, field }) => window.Alpine.$data(document.querySelector(sel))?.[field], { sel, field });
const setTab = (page, sel, field, value) => page.evaluate(
  ({ sel, field, value }) => { window.Alpine.$data(document.querySelector(sel))[field] = value; },
  { sel, field, value });
const hashNow = (page) => new URL(page.url()).hash;
const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);

for (const c of CASES) {
  test(`${c.name}: Reiter-Permalink (Deep-Link, Reload, Reiterwechsel)`, async ({ page }) => {
    await bootApp(page);
    const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
    const base = c.view.replace('{id}', bookId);
    const link = `${base}/${c.tab}`;

    // Deep-Link öffnet die Karte auf dem Reiter.
    await go(page, link);
    await expect(page.locator(c.sel)).toBeVisible();
    await expect.poll(() => tabOf(page, c.sel, c.field)).toBe(c.tab);
    await expect.poll(() => hashNow(page)).toBe(link);

    // Reload auf dem Permalink: Karte wird erst durch den Deep-Link gemountet.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitBooted(page);
    await expect(page.locator(c.sel)).toBeVisible();
    await expect.poll(() => tabOf(page, c.sel, c.field)).toBe(c.tab);
    expect(hashNow(page)).toBe(link);

    // Hash ohne Reiter bei offener Karte (Zurück auf die Karten-URL) → Grund-Reiter.
    await go(page, base);
    await expect.poll(() => tabOf(page, c.sel, c.field)).toBe(c.def);
    await expect.poll(() => hashNow(page)).toBe(base);

    // Reiterwechsel in der Karte → Hash folgt; Grund-Reiter → ohne Suffix.
    await setTab(page, c.sel, c.field, c.tab);
    await expect.poll(() => hashNow(page)).toBe(link);
    await setTab(page, c.sel, c.field, c.def);
    await expect.poll(() => hashNow(page)).toBe(base);

    // Unbekannter Reiter (alter Link, Tippfehler): Karte offen, Reiter verworfen.
    await go(page, `${base}/gibtsnicht`);
    await expect(page.locator(c.sel)).toBeVisible();
    await expect.poll(() => hashNow(page)).toBe(base);
    expect(await tabOf(page, c.sel, c.field)).toBe(c.def);
  });
}
