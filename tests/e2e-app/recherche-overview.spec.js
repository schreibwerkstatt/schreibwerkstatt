// Recherche-Board: Uebersicht (Anriss) vs. Detailansicht (Volltext lesen, darin
// bearbeiten) — gegen die ECHTE App.
//
// Warum hier und nicht als Fixture-Harness: der Anriss-Cap ist eine CSS-Hoehen-
// Aussage (nur ein Browser mit dem VOLLEN Shell-CSS sieht, ob abgeschnitten wird),
// und der Dialog haengt am nativen <dialog>/Top-Layer-Verhalten, das kein Harness
// nachstellt. Der Smoke oeffnet die Karte, prueft aber kein Verhalten. Nichts
// gestubbt: Anlegen, Bild-Upload und Klicks laufen ueber die echten Routen.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Text, der den Listen-Cap in JEDER Spaltenbreite ueberschreitet.
const LONG_BODY = 'Im Landesarchiv liegen die Prozessakten in zwoelf Kartons. '.repeat(60);
// 8x8-PNG (rot) — laeuft durch dieselbe sharp-Pipeline (prepareCover) wie ein
// echter Upload, inklusive Magic-Bytes-Pruefung und JPEG-Normalisierung.
const PNG_8PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGM4oaGBFTEMLQkAgl1GAWqNFmsAAAAASUVORK5CYII=';

test('recherche: Liste zeigt Anriss, Detailansicht zeigt Volltext und bleibt verknuepfbar', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const made = await page.evaluate(async ({ id, body, png }) => {
    const post = (payload) => fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, ...payload }),
    }).then(r => r.json());

    const long = await post({ kind: 'note', title: 'Aktenlage', body });
    const withImg = await post({ kind: 'image', title: 'Grundrissplan' });

    const bin = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const up = await fetch(`/research/${withImg.id}/image`, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bin,
    });
    const upBody = await up.json();
    return { long: long.id, img: withImg.id, upStatus: up.status, upBody };
  }, { id: bookId, body: LONG_BODY, png: PNG_8PX_B64 });
  // Ohne erfolgreichen Upload traegt das Item kein has_image und die Bild-
  // Zusicherung unten wuerde aus dem falschen Grund scheitern.
  expect(made.upStatus, JSON.stringify(made.upBody)).toBe(200);
  expect(made.upBody.has_image).toBe(true);

  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();

  // ── Liste: Anriss, nicht Volltext ─────────────────────────────────────────
  const longItem = page.locator(`[data-research-id="${made.long}"]`);
  const teaser = longItem.locator('.research-item-text');
  await expect(teaser).toBeVisible();
  // Der Cap ist echt: gerenderte Hoehe bleibt unter der Inhaltshoehe. Und er ist
  // knapp — ein einzelner Fund darf die Uebersicht nicht auffuellen.
  const teaserBox = await teaser.evaluate(el => ({ h: el.getBoundingClientRect().height, full: el.scrollHeight }));
  expect(teaserBox.h).toBeLessThan(teaserBox.full);
  expect(teaserBox.h).toBeLessThan(100);
  // Vorschaubild bleibt klein und ist ein Button (kein Neuer-Tab-Link mehr).
  const thumb = page.locator(`[data-research-id="${made.img}"] button.research-item-thumb`);
  await expect(thumb).toBeVisible();
  expect(await thumb.locator('img').evaluate(el => el.getBoundingClientRect().height))
    .toBeLessThanOrEqual(96 + 1);

  // ── Detailansicht: Volltext, lesbar gesetzt ───────────────────────────────
  const dialog = page.locator('dialog.research-dialog');
  await longItem.locator('.research-item-title').click();
  await expect(dialog).toBeVisible();
  const detailText = dialog.locator('.research-dialog__text');
  // Ungekappt: die sichtbare Hoehe ist die volle Inhaltshoehe.
  const detail = await detailText.evaluate(el => {
    const scroll = el.closest('.research-dialog__scroll');
    const cs = getComputedStyle(scroll);
    return {
      h: el.getBoundingClientRect().height,
      full: el.scrollHeight,
      w: el.getBoundingClientRect().width,
      px: parseFloat(getComputedStyle(el).fontSize),
      // Verfuegbare Textbreite des Panels (Scroll-Container minus Innenabstand).
      availW: scroll.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    };
  });
  expect(detail.h).toBeGreaterThanOrEqual(detail.full - 1);
  expect(detail.h).toBeGreaterThan(teaserBox.h * 3);
  // Lesetypografie: Lesegroesse. Der Satzspiegel ist bewusst NICHT zusaetzlich
  // gekappt — ein erfasster Artikel soll die Panelbreite nutzen statt in einer
  // schmalen Column mit leerem rechten Raum zu brechen (siehe
  // public/css/entities/recherche/dialog.css, Abschnitt Lesemodus). Geprueft wird
  // darum: volle verfuegbare Breite, und kein Ausbrechen daraus.
  expect(detail.px).toBeGreaterThanOrEqual(15);
  expect(detail.w).toBeLessThanOrEqual(detail.availW + 1);
  expect(detail.w).toBeGreaterThanOrEqual(detail.availW - 1);
  // Der Permalink zeigt aufs offene Fundstueck.
  expect(page.url()).toContain(`/recherche/${made.long}`);

  // ── Bearbeiten IM Dialog: Verknuepfen bleibt erreichbar ───────────────────
  await dialog.getByRole('button', { name: 'Bearbeiten' }).click();
  await expect(dialog.locator('textarea.recherche-body-input')).toBeVisible();
  // Genau der Regressionsfall: im Bearbeiten-Modus war die Verknuepfen-Aktion
  // vorher weg, weil Anzeige- und Formular-Zweig sich ausgeschlossen haben.
  await expect(dialog.locator('.research-dialog__link-actions button').first()).toBeVisible();
  await dialog.locator('.research-dialog__link-actions button').first().click();
  await expect(dialog.locator('.recherche-link-picker')).toBeVisible();
  await dialog.locator('.recherche-link-picker .btn-compact').last().click(); // Abbrechen
  await expect(dialog.locator('.recherche-link-picker')).toBeHidden();
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();          // Edit verlassen
  await expect(detailText).toBeVisible();

  // ── Schliessen per ESC raeumt Dialog + Permalink ──────────────────────────
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Auf den Hash WARTEN, nicht sofort lesen: die Permalink-Spiegelung laeuft als
  // Alpine-Effekt nach dem close-Event (sonst flaky).
  await page.waitForFunction((id) => !location.hash.includes(`/recherche/${id}`), made.long);
  // Und die Seite ist wieder bedienbar (kein zurueckgebliebenes inertes Dokument).
  await expect(longItem.locator('.research-item-title')).toBeEnabled();

  // Aufraeumen: die App-Suite teilt eine DB, fremde Specs sollen die Fundstuecke
  // nicht mitzaehlen.
  await page.evaluate(async (ids) => {
    for (const id of ids) await fetch(`/research/${id}`, { method: 'DELETE' });
  }, [made.long, made.img]);
});

// Anlegen ist ein Inline-Formular in der Karte (recherche-create.html), kein
// Modal: Toolbar-Knopf blendet es ein, Speichern legt an und blendet es aus.
test('recherche: Anlegen als Inline-Formular in der Karte', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();

  const form = page.locator('#recherche-card .recherche-create');
  await expect(form).toBeHidden();
  await page.locator('#recherche-card .card-toolbar > button.btn-compact').first().click();
  await expect(form).toBeVisible();
  // Kein Dialog: nichts im Top-Layer, der Rest der Karte bleibt bedienbar.
  await expect(page.locator('dialog.research-dialog[open]')).toHaveCount(0);
  await expect(form.locator('input.recherche-title-input')).toBeFocused();

  await form.locator('input.recherche-title-input').fill('Inline-Fund');
  await form.locator('textarea.recherche-body-input').fill('Inline erfasst.');
  // Tags als Chips (Baustein tagInput): Komma trennt, Enter uebernimmt.
  const tagField = form.locator('.tag-input-field');
  await tagField.fill('Archiv, Brief');
  await tagField.press('Enter');
  await expect(form.locator('.tag-input-chip')).toHaveText(['Archiv', 'Brief']);
  await form.locator('.recherche-create-actions button.primary').click();

  await expect(form).toBeHidden();
  const row = page.locator('.research-item', { hasText: 'Inline-Fund' }).first();
  await expect(row).toBeVisible();

  // Bearbeiten: dasselbe Formular im Detail-Dialog, mit den Werten des Funds und
  // derselben Aktionszeile (Speichern zuerst) in der festen Fussleiste.
  await row.locator('.research-item-title').click();
  const detailDlg = page.locator('dialog.research-dialog[open]');
  await detailDlg.getByRole('button', { name: 'Bearbeiten' }).click();
  await expect(detailDlg.locator('input.recherche-title-input')).toHaveValue('Inline-Fund');
  await expect(detailDlg.locator('.tag-input-chip')).toHaveText(['Archiv', 'Brief']);
  await expect(detailDlg.locator('.research-dialog__bar button').first()).toHaveClass(/\bprimary\b/);
  await detailDlg.locator('.tag-input-chip-remove').first().click();
  await detailDlg.locator('.research-dialog__bar button.primary').click();
  await expect(detailDlg.locator('.research-dialog__bar')).toBeHidden();
  await expect(detailDlg.locator('.research-tag')).toHaveText(['Brief']);
  await page.keyboard.press('Escape');
  await expect(detailDlg).toHaveCount(0);

  // Esc verwirft ein offenes Anlegen-Formular.
  await page.locator('#recherche-card .card-toolbar > button.btn-compact').first().click();
  await expect(form).toBeVisible();
  await form.locator('input.recherche-title-input').fill('verworfen');
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await expect(page.locator('.research-item', { hasText: 'verworfen' })).toHaveCount(0);

  await page.evaluate(async (id) => {
    const rows = await fetch(`/research?book_id=${id}`).then(r => r.json());
    for (const r of rows) await fetch(`/research/${r.id}`, { method: 'DELETE' });
  }, bookId);
});

// Beschreibungstexte kommen oft als Markdown (Recherche-Chat-Vorschläge): Board-
// Anriss und Detailansicht rendern es über den Chat-Renderer — Roh-HTML bleibt
// escaped. Ein Zitat ist Wortlaut und wird NICHT als Markdown gelesen.
test('recherche: Markdown im Beschreibungstext wird gerendert, Zitat bleibt Wortlaut', async ({ page }) => {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const made = await page.evaluate(async (id) => {
    const post = (payload) => fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, ...payload }),
    }).then(r => r.json());
    const md = await post({ kind: 'note', title: 'MD-Notiz',
      body: '**Fall-Eckdaten**\n\n- Tatdatum: 2024\n- Ort: Binningen\n\n<img src=x onerror=alert(1)>' });
    const quote = await post({ kind: 'quote', title: 'MD-Zitat', body: 'Er sagte: **nie** wieder.' });
    return { md: md.id, quote: quote.id };
  }, bookId);

  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  const teaser = page.locator(`[data-research-id="${made.md}"] .research-item-text`);
  await expect(teaser.locator('strong')).toHaveText('Fall-Eckdaten');
  await expect(teaser.locator('li')).toHaveCount(2);
  await expect(teaser.locator('img')).toHaveCount(0);
  await expect(teaser).toContainText('<img src=x');

  const quoteTeaser = page.locator(`[data-research-id="${made.quote}"] .research-item-text`);
  await expect(quoteTeaser).toHaveText('Er sagte: **nie** wieder.');

  const dialog = page.locator('dialog.research-dialog');
  await page.locator(`[data-research-id="${made.md}"] .research-item-title`).click();
  await expect(dialog.locator('.research-dialog__text li')).toHaveCount(2);
  await expect(dialog.locator('.research-dialog__text strong')).toHaveText('Fall-Eckdaten');
  await page.keyboard.press('Escape');

  await page.evaluate(async (ids) => {
    for (const id of ids) await fetch(`/research/${id}`, { method: 'DELETE' });
  }, [made.md, made.quote]);
});
