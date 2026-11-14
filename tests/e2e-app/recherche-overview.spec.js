// Recherche-Board: Uebersicht (Anriss) vs. aufgeklappte Zeile (Volltext lesen,
// darin bearbeiten; Muster Figuren/Orte, kein Dialog) — gegen die ECHTE App.
//
// Warum hier und nicht als Fixture-Harness: der Anriss-Cap und die Lesebreite
// sind CSS-Geometrie (nur ein Browser mit dem VOLLEN Shell-CSS sieht, ob
// abgeschnitten wird). Der Smoke oeffnet die Karte, prueft aber kein Verhalten. Nichts
// gestubbt: Anlegen, Bild-Upload und Klicks laufen ueber die echten Routen.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Text, der den Listen-Cap in JEDER Spaltenbreite ueberschreitet.
const LONG_BODY = 'Im Landesarchiv liegen die Prozessakten in zwoelf Kartons. '.repeat(60);
// 8x8-PNG (rot) — laeuft durch dieselbe sharp-Pipeline (prepareCover) wie ein
// echter Upload, inklusive Magic-Bytes-Pruefung und JPEG-Normalisierung.
const PNG_8PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGM4oaGBFTEMLQkAgl1GAWqNFmsAAAAASUVORK5CYII=';

test('recherche: Liste zeigt Anriss, aufgeklappte Zeile zeigt Volltext und bleibt verknuepfbar', async ({ page }) => {
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

  // ── Aufgeklappte Zeile: Volltext, lesbar gesetzt — kein Dialog ───────────
  const detail_ = longItem.locator('.research-detail');
  await longItem.locator('.row-expand').click();
  await expect(detail_).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(longItem.locator('.row-expand')).toHaveAttribute('aria-expanded', 'true');
  // Der Anriss weicht dem Volltext.
  await expect(teaser).toHaveCount(0);
  const detailText = detail_.locator('.research-detail__text');
  // Langer Text startet auch aufgeklappt gekappt (~10 Zeilen), der Umschalter
  // «Ganzen Text anzeigen» hebt den Cap auf.
  await expect(detailText).toHaveClass(/research-detail__text--clamped/);
  const more = detail_.locator('.research-detail__more');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(detailText).not.toHaveClass(/research-detail__text--clamped/);
  // Ungekappt: die sichtbare Hoehe ist die volle Inhaltshoehe.
  const detail = await detailText.evaluate(el => {
    const box = el.closest('.research-detail');
    return {
      h: el.getBoundingClientRect().height,
      full: el.scrollHeight,
      w: el.getBoundingClientRect().width,
      px: parseFloat(getComputedStyle(el).fontSize),
      // Verfuegbare Textbreite der Zeile.
      availW: box.clientWidth,
    };
  });
  expect(detail.h).toBeGreaterThanOrEqual(detail.full - 1);
  expect(detail.h).toBeGreaterThan(teaserBox.h * 3);
  // Lesetypografie: Lesegroesse. Der Satzspiegel ist bewusst NICHT zusaetzlich
  // gekappt — ein erfasster Artikel soll die Zeilenbreite nutzen statt in einer
  // schmalen Column mit leerem rechten Raum zu brechen (siehe
  // public/css/entities/recherche/detail.css, Abschnitt Lesemodus). Geprueft wird
  // darum: volle verfuegbare Breite, und kein Ausbrechen daraus.
  expect(detail.px).toBeGreaterThanOrEqual(15);
  expect(detail.w).toBeLessThanOrEqual(detail.availW + 1);
  expect(detail.w).toBeGreaterThanOrEqual(detail.availW - 1);
  // Der Permalink zeigt aufs offene Fundstueck.
  expect(page.url()).toContain(`/recherche/${made.long}`);

  // ── Bearbeiten IN der Zeile: Verknuepfen bleibt erreichbar ────────────────
  await longItem.locator('.research-item-title').click();
  await expect(detail_.locator('textarea.recherche-body-input')).toBeVisible();
  // Genau der Regressionsfall: im Bearbeiten-Modus war die Verknuepfen-Aktion
  // vorher weg, weil Anzeige- und Formular-Zweig sich ausgeschlossen haben.
  await expect(detail_.locator('.research-detail__link-actions button').first()).toBeVisible();
  await detail_.locator('.research-detail__link-actions button').first().click();
  const picker = page.locator('.recherche-link-picker');
  await expect(picker).toBeVisible();
  await picker.locator('.btn-compact').last().click(); // Abbrechen
  await expect(picker).toBeHidden();
  // Esc im Formular verwirft (Inline-Edit), die Zeile bleibt offen.
  await detail_.locator('textarea.recherche-body-input').press('Escape');
  await expect(detailText).toBeVisible();
  // Ein Kopf-Klick klappt im Bearbeiten-Modus nicht zu — im Lesemodus schon.
  await longItem.locator('.row-expand').click();
  await expect(detail_).toHaveCount(0);
  await expect(teaser).toBeVisible();
  // Zuklappen raeumt den Permalink. Auf den Hash WARTEN, nicht sofort lesen.
  await page.waitForFunction((id) => !location.hash.includes(`/recherche/${id}`), made.long);

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
  await expect(page.locator('dialog[open]')).toHaveCount(0);
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

  // Bearbeiten: der Titel oeffnet die Zeile aufgeklappt im Formular, mit den
  // Werten des Funds und derselben Aktionszeile (Speichern zuerst).
  await row.locator('.research-item-title').click();
  const detailBox = row.locator('.research-detail');
  await expect(detailBox.locator('input.recherche-title-input')).toHaveValue('Inline-Fund');
  await expect(detailBox.locator('.tag-input-chip')).toHaveText(['Archiv', 'Brief']);
  await expect(detailBox.locator('.research-detail__bar button').first()).toHaveClass(/\bprimary\b/);
  await detailBox.locator('.tag-input-chip-remove').first().click();
  await detailBox.locator('.research-detail__bar button.primary').click();
  await expect(detailBox.locator('.research-detail__bar')).toBeHidden();
  await expect(detailBox.locator('.research-tag')).toHaveText(['Brief']);

  // Klick daneben committet ein offenes Bearbeiten (Inline-Edit-Regel).
  await row.locator('.research-item-title').click();
  await detailBox.locator('input.recherche-title-input').fill('Inline-Fund neu');
  await page.locator('#recherche-card .card-title').click();
  await expect(detailBox.locator('.research-detail__bar')).toBeHidden();
  await expect(row.locator('.research-item-title')).toHaveText('Inline-Fund neu');
  await row.locator('.row-expand').click();
  await expect(detailBox).toHaveCount(0);

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

  const mdRow = page.locator(`[data-research-id="${made.md}"]`);
  await mdRow.locator('.row-expand').click();
  await expect(mdRow.locator('.research-detail__text li')).toHaveCount(2);
  await expect(mdRow.locator('.research-detail__text strong')).toHaveText('Fall-Eckdaten');

  await page.evaluate(async (ids) => {
    for (const id of ids) await fetch(`/research/${id}`, { method: 'DELETE' });
  }, [made.md, made.quote]);
});
