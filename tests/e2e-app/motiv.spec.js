// Motiv-Werkstatt — Interaktions-Smoke gegen die echte App (playwright.app.config.js).
// Deckt die Schreibpfade ab, die der reine Karten-Öffnen-Smoke NICHT prüft:
// Thema/Motiv anlegen, Motiv auswählen, Beziehung setzen, Graph-Aufbau — alles am
// echten Card-/Root-Scope gegen /motifs + Wegwerf-DB, mit Konsolenfehler-Guard.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');

async function bootApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null, { timeout: 30000 },
  );
}
async function selectSeededBook(page) {
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && Array.isArray(window.Alpine.store('nav').pages) && window.Alpine.store('nav').pages.length > 0,
    bookId, { timeout: 20000 },
  );
  return bookId;
}

test.describe.configure({ mode: 'serial' });

test('Motiv-Werkstatt: anlegen, verknüpfen, Graph — ohne Konsolenfehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  // Karte öffnen + Sub-Mount abwarten.
  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => !!document.querySelector('.card--motiv'), null, { timeout: 10000 });
  await page.waitForFunction(
    () => { const c = window.Alpine.$data(document.querySelector('.card--motiv')); return c && !c.loading; },
    null, { timeout: 10000 },
  );

  // Thema + zwei Motive anlegen, erstes selektieren, Beziehung setzen — alles am
  // echten Scope gegen das Backend. Gezählt wird der Zuwachs, nicht der Bestand:
  // die Datei läuft `serial`, ein Retry startet sie auf der DB des Vorlaufs neu.
  const result = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    const before = { themes: card.themes.length, motifs: card.motifs.length, relations: card.relations.length };

    card.newThemeName = 'Wasser & Schuld';
    await card.addTheme();

    card.newMotifName = 'Regen';
    await card.addMotif();               // selektiert das neue Motiv
    const firstId = card.selectedMotifId;

    card.newMotifName = 'Spiegel';
    await card.addMotif();
    const secondId = card.selectedMotifId;

    // Beziehung Regen → Spiegel.
    await card.selectMotif(firstId);
    card.newRelationTargetId = String(secondId);
    card.newRelationTyp = 'kontrastiert';
    await card.addRelation();

    return {
      themes: card.themes.length - before.themes,
      motifs: card.motifs.length - before.motifs,
      relations: card.relations.length - before.relations,
      relTyp: card.relations.find(r => r.from_motif_id === firstId && r.to_motif_id === secondId)?.typ,
      semanticActiveIsBool: typeof card.semanticActive() === 'boolean',
    };
  });

  expect(result.themes, 'ein Thema angelegt').toBe(1);
  expect(result.motifs, 'zwei Motive angelegt').toBe(2);
  expect(result.relations, 'eine Beziehung angelegt').toBe(1);
  expect(result.relTyp).toBe('kontrastiert');
  expect(result.semanticActiveIsBool, 'semanticActive() liefert Boolean (Task 1)').toBe(true);

  // Graph rendert (vis-network lazy) — Netzwerk-Instanz + Motiv-Knoten vorhanden.
  await page.waitForFunction(
    () => { const c = window.Alpine.$data(document.querySelector('.card--motiv')); return !!c._motivNetwork; },
    null, { timeout: 10000 },
  );

  await page.waitForTimeout(300);
  guard.assertClean('Motiv-Werkstatt Interaktion');
});

// Regression: Verknüpfungs-Comboboxen sind transiente Picker mit $event.detail.
// Ein Temp-x-model wäre im combobox-change-Handler noch stale (x-modelable synct
// asynchron via Effect-Flush) — die erste Auswahl landete dann nirgends, die
// zweite fügte die vorherige hinzu.
test('Motiv-Werkstatt: erste Combobox-Auswahl landet sofort im Link-Puffer (dirty)', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => {
    const el = document.querySelector('.card--motiv');
    if (!el) return false;
    const c = window.Alpine.$data(el);
    return c && !c.loading;
  }, null, { timeout: 15000 });

  await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.newMotifName = 'Combobox-Regression';
    await card.addMotif(); // selektiert das neue Motiv
    card.motivDetailTab = 'links'; // Verknüpfungen leben im eigenen Reiter
  });

  // Kapitel-Verknüpfung über die ECHTE Combobox wählen (3. Link-Gruppe) —
  // genau EIN Klick muss reichen. Trigger vorher ZENTRIEREN: die Combobox
  // schliesst bei Window-Scroll, und der Autofokus aufs Suchfeld scrollt nach,
  // wenn das Dropdown unter dem Viewport-Rand aufginge.
  // Schliesst die Liste zwischen Öffnen und Klick (Scroll, Re-Render im
  // CI-Takt), neu öffnen — geprüft wird unten, dass EINE Auswahl reicht.
  const chapGroup = page.locator('.motiv-link-group').nth(2);
  const opt = chapGroup.locator('.combobox-option').first();
  await expect(async () => {
    await chapGroup.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    if (!(await opt.isVisible())) await chapGroup.locator('.combobox-trigger').click();
    await opt.click({ timeout: 2000 });
  }).toPass({ timeout: 20000 });

  await page.waitForFunction(() => {
    const c = window.Alpine.$data(document.querySelector('.card--motiv'));
    return c.editChapters.length === 1 && c.motifDirty();
  }, null, { timeout: 5000 });

  // Save/Cancel-Icons erscheinen (motifDirty).
  await expect(page.locator('.motiv-editor-head .icon-btn--success')).toBeVisible();

  guard.assertClean('Motiv-Werkstatt Combobox-Link');
});

// Regression: Re-Klick auf den bereits gewählten Graph-Knoten (selectMotif mit
// derselben ID) darf ungespeicherte Edit-Puffer nicht verwerfen.
test('Motiv-Werkstatt: Re-Select desselben Motivs behält ungespeicherte Edits', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => {
    const el = document.querySelector('.card--motiv');
    if (!el) return false;
    const c = window.Alpine.$data(el);
    return c && !c.loading;
  }, null, { timeout: 15000 });

  const result = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.newMotifName = 'Reselect-Regression';
    await card.addMotif();
    const id = card.selectedMotifId;
    card.editName = 'Umbenannt aber ungespeichert';
    // Graph-Knoten-Klick auf das gewählte Motiv → selectMotif(gleiche ID).
    await card.selectMotif(id);
    return { editName: card.editName, dirty: card.motifDirty() };
  });

  expect(result.editName).toBe('Umbenannt aber ungespeichert');
  expect(result.dirty).toBe(true);

  guard.assertClean('Motiv-Werkstatt Re-Select');
});

// Regression: Wechsel auf ein ANDERES Motiv committet ausstehende Änderungen
// (wie das Beat-Edit-Panel der Plot-Werkstatt: Wechsel = Save, kein stilles
// Verwerfen).
test('Motiv-Werkstatt: Motivwechsel speichert ungespeicherte Edits', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => {
    const el = document.querySelector('.card--motiv');
    if (!el) return false;
    const c = window.Alpine.$data(el);
    return c && !c.loading;
  }, null, { timeout: 15000 });

  const result = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.newMotifName = 'Wechsel-Quelle';
    await card.addMotif();
    const firstId = card.selectedMotifId;
    card.newMotifName = 'Wechsel-Ziel';
    await card.addMotif();
    const secondId = card.selectedMotifId;

    // Erstes Motiv wählen, umbenennen, dann ohne Save aufs zweite wechseln.
    await card.selectMotif(firstId);
    card.editName = 'Wechsel-Quelle umbenannt';
    await card.selectMotif(secondId);

    return {
      selectedId: card.selectedMotifId,
      secondId,
      firstName: card.motifById(firstId)?.name,
      err: card.errorMessage,
    };
  });

  expect(result.selectedId).toBe(result.secondId);
  expect(result.firstName, 'Rename beim Wechsel committet').toBe('Wechsel-Quelle umbenannt');
  expect(result.err).toBe('');

  guard.assertClean('Motiv-Werkstatt Commit-on-Switch');
});

// Schnellweg im Themen-Editor: Motiv mit getipptem Namen anlegen und sofort dem
// offenen Thema zuordnen. Prüft beides — die Verdrahtung (theme_id gesetzt,
// Auswahl wandert in den Motiv-Editor, Draft geleert) UND dass das ausgelagerte
// Themen-Editor-Fragment (@include motiv-panel-theme) überhaupt im Baum landet:
// es hängt hinter `x-if`, kein anderer Test öffnet diesen Panel-Zustand.
test('Motiv-Werkstatt: Themen-Editor legt ein Motiv direkt im Thema an', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => {
    const el = document.querySelector('.card--motiv');
    if (!el) return false;
    const c = window.Alpine.$data(el);
    return c && !c.loading;
  }, null, { timeout: 15000 });

  // Thema anlegen → addTheme selektiert es, der Themen-Editor rendert.
  await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.newThemeName = 'Schnellweg-Thema';
    await card.addTheme();
  });
  const quickInput = page.locator('.motiv-theme-addmotif input');
  await expect(quickInput, 'Schnellweg-Zeile im Themen-Editor gerendert').toBeVisible();

  const result = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    const themeId = card.selectedThemeId;
    card.newThemeMotifName = 'Schnellweg-Motiv';
    await card.addMotifToTheme();
    const m = card.motifById(card.selectedMotifId);
    return {
      themeId,
      motifName: m?.name,
      motifThemeId: m?.theme_id,
      selectedThemeId: card.selectedThemeId,
      draft: card.newThemeMotifName,
      err: card.errorMessage,
    };
  });

  expect(result.motifName, 'Motiv unter dem getippten Namen angelegt').toBe('Schnellweg-Motiv');
  expect(result.motifThemeId, 'dem offenen Thema zugeordnet').toBe(result.themeId);
  expect(result.selectedThemeId, 'Motiv-Editor loest den Themen-Editor ab').toBe(null);
  expect(result.draft, 'Draft nach dem Anlegen geleert').toBe('');
  expect(result.err).toBe('');

  guard.assertClean('Motiv-Werkstatt Schnellweg');
});

async function openMotivCard(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => {
    const el = document.querySelector('.card--motiv');
    if (!el) return false;
    const c = window.Alpine.$data(el);
    return c && !c.loading;
  }, null, { timeout: 15000 });
}

// Baum im Seitenpanel: ohne Auswahl stehen die Motive unter ihrem Thema; ein
// Klick öffnet den Editor, der Rückweg hebt auch die Markierung im Graph auf.
test('Motiv-Werkstatt: Baum im Panel öffnet Motive, Zurück hebt die Graph-Markierung auf', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openMotivCard(page);

  const ids = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.newThemeName = 'Baum-Thema';
    await card.addTheme();
    const themeId = card.selectedThemeId;
    card.newThemeMotifName = 'Baum-Motiv';
    await card.addMotifToTheme();
    const motifId = card.selectedMotifId;
    await card.selectMotif(null);
    card.setMotivView('graph');
    return { themeId, motifId };
  });

  const row = page.locator(`.motiv-tree-motif[data-motif-id="${ids.motifId}"]`);
  await expect(row, 'Motiv steht im Baum').toBeVisible();
  await expect(page.locator(`.motiv-tree-group[data-theme-id="${ids.themeId}"] .motiv-tree-motif[data-motif-id="${ids.motifId}"]`),
    'unter seinem Thema').toHaveCount(1);

  await row.locator('.motiv-tree-name').click();
  await expect(page.locator('.motiv-panel .motiv-editor .motiv-name-input')).toHaveValue('Baum-Motiv');

  await page.waitForFunction(() => !!window.Alpine.$data(document.querySelector('.card--motiv'))._motivNetwork, null, { timeout: 10000 });
  await page.locator('.motiv-panel .motiv-editor-titlerow .icon-btn').first().click();
  await expect(row, 'zurück im Baum').toBeVisible();
  // Rohe Instanz: die Auswahl-API liest private Felder, über den Alpine-Proxy wirft sie.
  const selected = await page.evaluate(async (id) => {
    const c = window.Alpine.$data(document.querySelector('.card--motiv'));
    const net = () => window.Alpine.raw(c._motivNetwork);
    await c.selectMotif(id);
    const whileOpen = net().getSelectedNodes();
    await c.selectMotif(null);
    return { whileOpen, after: net().getSelectedNodes().length };
  }, ids.motifId);
  expect(selected.whileOpen, 'Auswahl im Graph gespiegelt').toEqual(['m' + ids.motifId]);
  expect(selected.after, 'Graph-Auswahl aufgehoben').toBe(0);

  guard.assertClean('Motiv-Werkstatt Baum');
});

// Gliederung: Zeile aufklappen zeigt den geteilten Detail-Editor in der Tabelle
// (nicht im Panel); Klick daneben speichert, die Zeile bleibt offen.
test('Motiv-Werkstatt: Gliederung — Zeile aufklappen, Klick daneben speichert', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openMotivCard(page);

  const motifId = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.newMotifName = 'Gliederung-Motiv';
    await card.addMotif();
    const id = card.selectedMotifId;
    await card.selectMotif(null);
    card.setMotivView('outline');
    return id;
  });

  const table = page.locator('.motiv-outline-table');
  await expect(table).toBeVisible();
  const nameBtn = table.locator('.motiv-outline-row .motiv-outline-name', { hasText: 'Gliederung-Motiv' });
  await nameBtn.click();
  const nameInput = table.locator('.motiv-outline-detail .motiv-name-input');
  await expect(nameInput).toHaveValue('Gliederung-Motiv');
  await expect(page.locator('.motiv-panel .motiv-editor'), 'nicht zugleich im Panel').toHaveCount(0);

  await nameInput.fill('Gliederung umbenannt');
  await page.locator('.motiv-outline-filter .filter-search-input').click(); // Klick daneben
  await page.waitForFunction((id) => {
    const c = window.Alpine.$data(document.querySelector('.card--motiv'));
    return c.motifById(id)?.name === 'Gliederung umbenannt' && !c.motifDirty();
  }, motifId, { timeout: 5000 });
  await expect(nameInput, 'Zeile bleibt offen').toBeVisible();

  guard.assertClean('Motiv-Werkstatt Gliederung');
});

// Detail-Editor: Trigger als Chips (Komma übernimmt, nicht bestätigter Draft
// zählt beim Speichern mit); Beziehungstyp ändern; Duplikat wird gemeldet.
test('Motiv-Werkstatt: Trigger-Chips, Beziehungstyp ändern, Duplikat-Meldung', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openMotivCard(page);

  await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.setMotivView('graph');
    card.motivDetailTab = 'details';
    card.newMotifName = 'Chip-Ziel';
    await card.addMotif();
    card.newMotifName = 'Chip-Motiv';
    await card.addMotif();
  });

  const input = page.locator('.motiv-panel .motiv-trigger-input');
  await input.fill('Regen, Fluss,');
  await expect(page.locator('.motiv-panel .motiv-trigger-chip')).toHaveCount(2);
  await input.fill('ertrinken'); // nicht mit Enter bestätigt

  const result = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    await card.saveMotifEdit();
    const m = card.selectedMotif();
    const target = card.motifs.find(x => x.name === 'Chip-Ziel');
    card.newRelationTargetId = String(target.id);
    card.newRelationTyp = 'verstaerkt';
    await card.addRelation();
    const rel = card.relationsForSelected()[0];
    await card.setRelationTyp(rel, 'kontrastiert');
    const typAfter = card.relationsForSelected()[0]?.typ;
    card.errorMessage = '';
    card.newRelationTargetId = String(target.id);
    card.newRelationTyp = 'kontrastiert';
    await card.addRelation(); // Duplikat
    return {
      triggers: m.trigger_terms,
      rescanOffered: card.triggerRescanMotifId === m.id,
      typAfter,
      relCount: card.relationsForSelected().length,
      err: card.errorMessage,
      expectedErr: window.__app.t('motiv.relations.exists'),
    };
  });

  expect(result.triggers).toEqual(['Regen', 'Fluss', 'ertrinken']);
  expect(result.rescanOffered, 'Einzel-Scan nach Trigger-Änderung angeboten').toBe(true);
  expect(result.typAfter).toBe('kontrastiert');
  expect(result.relCount).toBe(1);
  expect(result.err).toBe(result.expectedErr);

  guard.assertClean('Motiv-Werkstatt Chips/Beziehungen');
});


// Baum: ein Motiv per Griff in ein anderes Thema ziehen setzt theme_id und
// ordnet es dort an der Drop-Stelle ein (SortableJS-Fallback, echter Zeiger).
test('Motiv-Werkstatt: Baum — Motiv per Drag in ein anderes Thema verschieben', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openMotivCard(page);

  const ids = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.setMotivView('graph');
    card.newThemeName = 'Drag-Quelle';
    await card.addTheme();
    const fromTheme = card.selectedThemeId;
    card.newThemeMotifName = 'Drag-Motiv';
    await card.addMotifToTheme();
    const motifId = card.selectedMotifId;
    card.newThemeName = 'Drag-Ziel';
    await card.addTheme();
    const toTheme = card.selectedThemeId;
    card.newThemeMotifName = 'Drag-Nachbar';
    await card.addMotifToTheme();
    await card.selectMotif(null);
    return { fromTheme, toTheme, motifId };
  });

  const row = page.locator(`.motiv-tree-motif[data-motif-id="${ids.motifId}"]`);
  await expect(row).toBeVisible();
  await page.waitForTimeout(400); // Sortable bindet lazy nach dem Mount
  const grip = await row.locator('.motiv-motif-grip').boundingBox();
  const target = await page.locator(`.motiv-tree-motifs[data-group="${ids.toTheme}"]`).boundingBox();

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 8, grip.y + grip.height / 2 + 14, { steps: 4 });
  await page.mouse.move(target.x + 30, target.y + 2, { steps: 12 });
  await page.waitForTimeout(80);
  await page.mouse.up();

  await page.waitForFunction(({ motifId, toTheme }) => {
    const c = window.Alpine.$data(document.querySelector('.card--motiv'));
    return c.motifById(motifId)?.theme_id === toTheme && !c.loading;
  }, ids, { timeout: 5000 });
  await expect(page.locator(`.motiv-tree-group[data-theme-id="${ids.toTheme}"] .motiv-tree-motif[data-motif-id="${ids.motifId}"]`),
    'im Ziel-Thema gerendert').toHaveCount(1);

  guard.assertClean('Motiv-Werkstatt Baum-Drag');
});

// Undo/Redo (book/motiv/history.js über cards/board-history.js): Anlegen,
// Feldänderung, Beziehung und Löschen samt Wiederanlage — serverseitig geprüft.
test('Motiv-Werkstatt: Undo/Redo — Umbenennen, Löschen mit Wiederanlage, Anlegen', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => {
    const el = document.querySelector('.card--motiv');
    const c = el && window.Alpine.$data(el);
    return c && !c.loading;
  }, null, { timeout: 15000 });

  const r = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    const names = () => card.motifs.map(m => m.name);
    card._clearHistory();
    card.newMotifName = 'Undo-Motiv A';
    await card.addMotif();
    const aId = card.selectedMotifId;
    card.newMotifName = 'Undo-Motiv B';
    await card.addMotif();
    const bId = card.selectedMotifId;
    await card.selectMotif(aId);
    card.newRelationTargetId = String(bId);
    card.newRelationTyp = 'kontrastiert';
    await card.addRelation();
    await card.selectMotif(aId);
    card.editName = 'Undo-Motiv A2';
    await card.saveMotifEdit();
    const renamed = names().includes('Undo-Motiv A2');

    // Umbenennen zurück + wieder vor.
    await card.historyUndo();
    const undoneRename = names().includes('Undo-Motiv A') && !names().includes('Undo-Motiv A2');
    await card.historyRedo();
    const redoneRename = names().includes('Undo-Motiv A2');

    // Löschen ist rückgängig machbar: neue ID, Beziehung kommt mit.
    window.__app.appConfirm = async () => true;
    await card.deleteMotif(card.motifById(aId));
    const gone = !names().includes('Undo-Motiv A2');
    await card.historyUndo();
    const back = card.motifs.find(m => m.name === 'Undo-Motiv A2');
    const relBack = !!back && card.relations.some(x => x.from_motif_id === back.id && x.to_motif_id === bId);
    // Ein älterer Record (Umbenennen) zeigt jetzt auf die neue ID.
    const remapped = card._undoStack.some(x => x.kind === 'motif-edit' && x.id === back?.id);
    await card.historyRedo();
    const goneAgain = !names().includes('Undo-Motiv A2');
    return { renamed, undoneRename, redoneRename, gone, back: !!back, relBack, remapped, goneAgain };
  });
  expect(r).toEqual({ renamed: true, undoneRename: true, redoneRename: true, gone: true, back: true, relBack: true, remapped: true, goneAgain: true });

  // Knöpfe im Kartenkopf spiegeln den Stack.
  await expect(page.locator('.card--motiv .card-actions button[aria-label="Rückgängig"], .card--motiv .card-actions button[aria-label="Undo"]').first()).toBeEnabled();
  guard.assertClean('Motiv-Werkstatt Undo/Redo');
});
