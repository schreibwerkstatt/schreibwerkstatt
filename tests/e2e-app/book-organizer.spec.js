// Buchorganizer gegen die ECHTE App (Server + SQLite + Alpine).
//
// Warum hier und nicht als Fixture-Harness: der geprüfte Pfad ist ein
// Zusammenspiel aus Root (`_applyCollabChanges` → `_removePageFromTree` →
// `page:removed`-Event) und der echten Karten-Instanz mit ihrem Lifecycle-
// Listener — ein Harness müsste beide Seiten nachbauen und würde genau die
// Koppelung nicht messen, um die es geht.
//
// Regressions-Abdeckung für: eine remote geloeschte Seite (Collab-Feed
// `kind: 'delete'`, z.B. auf einem anderen Geraet geloescht) verschwand zwar
// aus dem Sidebar-Pagetree (in-place Splice auf nav.tree/nav.pages), blieb
// aber im offenen Buchorganizer als Zeile stehen, weil kein `pages:loaded`
// feuert und die Karte ihr workTree nie neu snapshotete.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard.js');
const { bootApp, selectSeededBook } = require('./_helpers/app.js');

async function openOrganizer(page) {
  await page.evaluate(() => window.__app.toggleBookOrganizerCard());
  await expect(page.locator('.card--organizer')).toBeVisible();
  await page.waitForFunction(() =>
    document.querySelectorAll('.card--organizer .organizer-page').length > 0);
}

function organizerRowIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.card--organizer .organizer-page')]
      .map((li) => li.dataset.pageId));
}

// Simuliert den Eingang eines Remote-Deletes aus dem Collab-Poll (kein
// Server-Call: `_applyCollabChanges` behandelt kind:'delete' rein lokal).
function remoteDelete(page, pageId, name) {
  return page.evaluate(({ id, n }) => window.__app._applyCollabChanges([{
    kind: 'delete',
    page_id: id,
    page_name: n,
    chapter_id: null,
    updated_at: new Date().toISOString(),
    last_editor_email: 'other@example.com',
    last_editor_name: 'Other',
    is_self: false,
    device_label: null,
  }]), { id: pageId, n: name });
}

test('remote-delete einer Kapitel-Seite aktualisiert die Organizer-Liste', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await openOrganizer(page);

  const rows = await organizerRowIds(page);
  expect(rows.length).toBeGreaterThan(0);
  const victim = parseInt(rows[rows.length - 1], 10);

  await remoteDelete(page, victim, 'X');
  await page.waitForTimeout(400);

  const after = await organizerRowIds(page);
  expect(after.includes(String(victim)), 'Zeile aus Organizer-Liste entfernt').toBe(false);
  const navHas = await page.evaluate((id) =>
    window.Alpine.store('nav').pages.some((p) => p.id === id), victim);
  expect(navHas, 'Seite aus nav.pages entfernt').toBe(false);
  guard.assertClean('remote-delete kapitel-seite');
});

test('remote-delete einer Solo-Seite aktualisiert die Organizer-Liste', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Solo-Seite (ohne Kapitel) lokal im Store nachziehen — sie existiert nur
  // clientseitig, das reicht: der gepruefte Pfad ist rein clientseitig.
  const soloId = await page.evaluate(async (bid) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const created = await contentRepo.createPage({ book_id: parseInt(bid, 10), name: 'Solo-Remote-Delete', html: '<p>x</p>' });
    await window.__app.loadPages();
    return created.id;
  }, bookId);

  await openOrganizer(page);
  const rows = await organizerRowIds(page);
  expect(rows.includes(String(soloId)), 'Solo-Zeile vorhanden').toBe(true);

  await remoteDelete(page, soloId, 'Solo-Remote-Delete');
  await page.waitForTimeout(400);

  const after = await organizerRowIds(page);
  expect(after.includes(String(soloId)), 'Solo-Zeile aus Organizer-Liste entfernt').toBe(false);
  guard.assertClean('remote-delete solo-seite');

  // Hygiene: die Suite teilt sich eine DB pro Lauf — die Test-Seite serverseitig
  // aufraeumen (der Remote-Delete oben war bewusst nur clientseitig).
  await page.evaluate(async (id) => {
    const { contentRepo } = await import('/js/repo/content.js');
    await contentRepo.deletePage(id);
  }, soloId);
});

// Lokales Loeschen (Sidebar-Kontextmenue, Editor, Organizer) laeuft seit der
// Konsolidierung durch EINE Root-Methode: `deletePageById`. Sie entfernt die Seite
// in-place aus dem Store (kein `loadPages`-Refetch, der den Sidebar-Tree leeren
// wuerde) und meldet es per `page:removed` — worauf der offene Organizer seinen
// Workstate nachzieht. Beide Enden gehoeren in denselben Test: die Karte liest
// nicht den Server, sondern genau diesen Store.
test('deletePageById entfernt die Seite aus Sidebar-Store, Organizer und Server', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const victim = await page.evaluate(async (bid) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const created = await contentRepo.createPage({ book_id: parseInt(bid, 10), name: 'Local-Delete-Ziel', html: '<p>x</p>' });
    await window.__app.loadPages();
    return created.id;
  }, bookId);

  await openOrganizer(page);
  expect((await organizerRowIds(page)).includes(String(victim))).toBe(true);

  // `loadPages` mitzaehlen: ein Refetch waere kein Fehler im Ergebnis, aber genau
  // das Flackern, das die In-Place-Entfernung vermeidet.
  const res = await page.evaluate(async (id) => {
    const root = window.__app;
    const orig = root.loadPages.bind(root);
    let reloads = 0;
    root.loadPages = async (...a) => { reloads++; return orig(...a); };
    const ok = await root.deletePageById(id, { confirm: false });
    root.loadPages = orig;
    const probe = await fetch('/content/pages/' + id);
    return { ok, reloads, probeStatus: probe.status,
             navHas: window.Alpine.store('nav').pages.some((p) => p.id === id) };
  }, victim);

  expect(res.ok, 'deletePageById meldet Erfolg').toBe(true);
  expect(res.navHas, 'Seite aus nav.pages entfernt').toBe(false);
  expect(res.probeStatus, 'Seite serverseitig geloescht').toBe(404);
  expect(res.reloads, 'kein loadPages-Refetch').toBe(0);

  await page.waitForTimeout(400);
  expect((await organizerRowIds(page)).includes(String(victim)),
    'Zeile aus Organizer-Liste entfernt').toBe(false);
  guard.assertClean('local delete via deletePageById');
});

// Der Organizer-Knopf ist nur noch eine Huelle um dieselbe Root-Methode
// (Rueckfrage + Saving-Flag + History-Invalidierung). Der Test faehrt ueber die
// Karten-Methode, damit die Verdrahtung Karte → Root mitgeprueft ist.
test('Organizer-deletePage laeuft durch dieselbe Methode', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const victim = await page.evaluate(async (bid) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const created = await contentRepo.createPage({ book_id: parseInt(bid, 10), name: 'Organizer-Delete-Ziel', html: '<p>x</p>' });
    await window.__app.loadPages();
    return created.id;
  }, bookId);

  await openOrganizer(page);
  const card = '.card--organizer';

  const res = await page.evaluate(async ({ sel, id }) => {
    const ctx = window.Alpine.$data(document.querySelector(sel));
    // Rueckfrage ueberspringen: der Dialog ist nicht Gegenstand dieses Tests.
    window.__app.appConfirm = async () => true;
    await ctx.deletePage(id);
    const probe = await fetch('/content/pages/' + id);
    return { probeStatus: probe.status,
             navHas: window.Alpine.store('nav').pages.some((p) => p.id === id) };
  }, { sel: card, id: victim });

  expect(res.probeStatus, 'Seite serverseitig geloescht').toBe(404);
  expect(res.navHas, 'Seite aus nav.pages entfernt').toBe(false);
  await page.waitForTimeout(400);
  expect((await organizerRowIds(page)).includes(String(victim))).toBe(false);
  guard.assertClean('organizer delete');
});

// Kapitel aus dem Sidebar-Kontextmenue (Root `createChapter`) haengt sich
// in-place in nav.tree, ohne Reload. Der offene Organizer muss es per
// `chapter:added` in seinen Workstate holen — sonst fehlt es im naechsten
// Order-PUT, und der Server lehnt den Tree mit MISSING_CHAPTER ab.
test('Sidebar-Kapitelanlage bei offenem Organizer landet im Workstate und im Order-PUT', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await openOrganizer(page);

  const chapterId = await page.evaluate(async () => {
    window.__app.newChapterTitle = 'Sidebar-Kapitel';
    const item = await window.__app.createChapter();
    return item.id;
  });

  await expect(page.locator(`.card--organizer .organizer-chapter[data-chapter-id="${chapterId}"]`)).toBeVisible();

  // Ein Reorder ueber den Organizer-Pfad muss durchgehen (kein MISSING_CHAPTER).
  const ok = await page.evaluate(async () => {
    const el = document.querySelector('.card--organizer');
    const card = window.Alpine.$data(el);
    card.workTree.reverse();
    return card._persistOrder({ mirror: 'chapters' });
  });
  expect(ok, 'Order-PUT mit dem neuen Kapitel akzeptiert').toBe(true);
  guard.assertClean('sidebar-kapitel im organizer');

  await page.evaluate(async (id) => {
    const { contentRepo } = await import('/js/repo/content.js');
    await contentRepo.deleteChapter(id);
  }, chapterId);
});

// ── Eigene Fixtures fuer die folgenden Tests ─────────────────────────────────
// Kapitel + Seiten frisch anlegen, damit die Tests nicht von der Seed-Struktur
// abhaengen (Kapitelzahl entscheidet z.B. ueber den Start-Zuklapp-Zustand).
async function seedChapter(page, bookId, name, pageNames) {
  return page.evaluate(async ({ bid, n, pn }) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const ch = await contentRepo.createChapter({ book_id: parseInt(bid, 10), name: n });
    const pages = [];
    for (const p of pn) {
      pages.push((await contentRepo.createPage({ book_id: parseInt(bid, 10), chapter_id: ch.id, name: p, html: '<p>x</p>' })).id);
    }
    await window.__app.loadPages();
    return { chapterId: ch.id, pageIds: pages };
  }, { bid: bookId, n: name, pn: pageNames });
}

async function cleanupChapter(page, chapterId) {
  await page.evaluate(async (cid) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const nav = window.Alpine.store('nav');
    for (const p of nav.pages.filter((x) => x.chapter_id === cid)) {
      try { await contentRepo.deletePage(p.id); } catch {}
    }
    try { await contentRepo.deleteChapter(cid); } catch {}
  }, chapterId);
}

const organizerData = (page, fn, arg) => page.evaluate(({ src, a }) => {
  const ctx = window.Alpine.$data(document.querySelector('.card--organizer'));
  // eslint-disable-next-line no-new-func
  return new Function('ctx', 'a', `return (async () => { ${src} })()`)(ctx, a);
}, { src: fn, a: arg });

// Aufklappen erzeugt x-if-gatete Seitenlisten. Der Sprung zum Kapitel muss
// Sortable daran binden — sonst ist DnD in genau dem Kapitel tot, zu dem der
// User gerade gesprungen ist.
test('Sprung zu einem zugeklappten Kapitel bindet Sortable an seine Seitenliste', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const { chapterId } = await seedChapter(page, bookId, 'Sprungziel', ['J1', 'J2']);
  await openOrganizer(page);

  await organizerData(page, 'ctx.collapseAll(); await ctx.$nextTick();');
  await expect(page.locator(`.card--organizer ul[data-organizer="page-list"][data-chapter-id="${chapterId}"]`)).toHaveCount(0);

  await organizerData(page, 'await ctx.jumpToChapter(String(a));', chapterId);
  const ul = page.locator(`.card--organizer ul[data-organizer="page-list"][data-chapter-id="${chapterId}"]`);
  await expect(ul).toHaveCount(1);
  const bound = await organizerData(page, `
    const ul = document.querySelector('.card--organizer ul[data-organizer="page-list"][data-chapter-id="' + a + '"]');
    return ctx._sortables.some((s) => s.el === ul);`, chapterId);
  expect(bound, 'Sortable-Instanz an der neu sichtbaren Liste').toBe(true);
  guard.assertClean('jump binds sortable');
  await cleanupChapter(page, chapterId);
});

// Der Tagebuch-Kalender cacht identity-gated auf nav.pages. Das Loeschen muss
// die Identitaet erneuern — auch wenn der Organizer gar nicht offen ist.
test('Loeschen erneuert nav.pages-Identitaet auch bei geschlossenem Organizer', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const { chapterId, pageIds } = await seedChapter(page, bookId, 'Kalender-Cache', ['K1']);
  const res = await page.evaluate(async (id) => {
    const nav = window.Alpine.store('nav');
    const before = nav.pages;
    const shown = window.__app.showBookOrganizerCard;
    const ok = await window.__app.deletePageById(id, { confirm: false });
    return { ok, shown, changed: nav.pages !== before, has: nav.pages.some((p) => p.id === id) };
  }, pageIds[0]);
  expect(res.shown, 'Organizer ist zu').toBeFalsy();
  expect(res.ok).toBe(true);
  expect(res.has).toBe(false);
  expect(res.changed, 'neue Array-Identitaet invalidiert den Kalender-Cache').toBe(true);
  guard.assertClean('delete renews pages identity');
  await cleanupChapter(page, chapterId);
});

// Zeilen-Comboboxen montieren erst beim Klick (Leistung bei vielen Seiten):
// vorher nur ein Platzhalter-Trigger, nachher genau eine echte Instanz, die sich
// beim Schliessen wieder abbaut und den Fokus an den Platzhalter zurueckgibt.
test('Zeilen-Combobox montiert erst beim Klick und verschiebt die Seite', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const a = await seedChapter(page, bookId, 'Lazy-Quelle', ['L1']);
  const b = await seedChapter(page, bookId, 'Lazy-Ziel', []);
  await openOrganizer(page);

  const realCombos = page.locator('.card--organizer .organizer-page .combobox-dropdown');
  await expect(realCombos).toHaveCount(0);

  const key = `${a.pageIds[0]}:chapter`;
  const trigger = page.locator(`.card--organizer [data-row-combo="${key}"]`);
  await trigger.click();
  await expect(realCombos).toHaveCount(1);
  await expect(page.locator('.card--organizer .organizer-page .combobox-dropdown')).toBeVisible();
  // Fokus im Suchfeld (combobox.js#toggle fokussiert einen Frame nach dem
  // Einblenden) — Voraussetzung dafuer, dass Escape/Tippen die Liste erreicht.
  await expect(page.locator('.card--organizer .organizer-page .combobox-search')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(realCombos).toHaveCount(0);
  await expect(page.locator(`.card--organizer [data-row-combo="${key}"]`)).toBeFocused();

  await page.locator(`.card--organizer [data-row-combo="${key}"]`).click();
  await page.locator('.card--organizer .organizer-page .combobox-option', { hasText: 'Lazy-Ziel' }).click();
  await expect.poll(() => page.evaluate((id) =>
    window.Alpine.store('nav').pages.find((p) => p.id === id)?.chapter_id, a.pageIds[0])).toBe(b.chapterId);
  await expect(realCombos).toHaveCount(0);
  guard.assertClean('lazy row combobox');
  await cleanupChapter(page, a.chapterId);
  await cleanupChapter(page, b.chapterId);
});

// Neues Sub-Kapitel ohne loadPages (kein Flackern): Workstate und Sidebar-Tree
// werden in-place nachgezogen, Depth-First-Ordnung bleibt erhalten.
test('Sub-Kapitel-Anlage spiegelt in-place ohne loadPages', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const parent = await seedChapter(page, bookId, 'Eltern', ['E1']);
  await openOrganizer(page);

  const res = await organizerData(page, `
    const root = window.__app;
    root.appPrompt = async () => 'Kind-Neu';
    const orig = root.loadPages.bind(root);
    let reloads = 0;
    root.loadPages = async (...x) => { reloads++; return orig(...x); };
    await ctx.createSubchapter(a);
    root.loadPages = orig;
    const tree = window.Alpine.store('nav').tree;
    const pi = tree.findIndex((t) => t.id === a);
    const child = tree[pi + 1];
    return { reloads, childName: child?.name, childParent: child?.parent_id, childDepth: child?.depth,
             parentHasChildren: tree[pi].hasChildren,
             inWork: ctx._findChapter(a).node.subchapters.map((c) => c.name),
             childId: child?.id };`, parent.chapterId);
  expect(res.reloads, 'kein loadPages').toBe(0);
  expect(res.childName).toBe('Kind-Neu');
  expect(res.childParent).toBe(parent.chapterId);
  expect(res.childDepth).toBe(2);
  expect(res.parentHasChildren).toBe(true);
  expect(res.inWork).toEqual(['Kind-Neu']);
  await expect(page.locator(`.card--organizer .organizer-chapter[data-chapter-id="${res.childId}"]`)).toBeVisible();

  // Server-Stand passt: ein Order-PUT ueber den Workstate geht durch.
  const ok = await organizerData(page, 'return ctx._persistOrder({ mirror: "chapters" });');
  expect(ok).toBe(true);
  guard.assertClean('subchapter in place');
  await page.evaluate(async (id) => {
    const { contentRepo } = await import('/js/repo/content.js');
    await contentRepo.deleteChapter(id);
  }, res.childId);
  await cleanupChapter(page, parent.chapterId);
});

test('Escape im Namensfeld verwirft die Umbenennung', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const { chapterId, pageIds } = await seedChapter(page, bookId, 'Esc-Kapitel', ['Esc-Seite']);
  await openOrganizer(page);

  const input = page.locator(`.card--organizer .organizer-page[data-page-id="${pageIds[0]}"] input.organizer-name`);
  await input.click();
  await input.fill('Verworfen');
  await input.press('Escape');
  await expect(input).toHaveValue('Esc-Seite');
  await expect(page.locator('.card--organizer')).toBeVisible();
  await page.waitForTimeout(300);
  const serverName = await page.evaluate(async (id) => (await (await fetch('/content/pages/' + id)).json()).name, pageIds[0]);
  expect(serverName).toBe('Esc-Seite');
  guard.assertClean('escape rename');
  await cleanupChapter(page, chapterId);
});

// Geloeschte Seiten liegen im Papierkorb. Undo stellt sie wieder her — neue ID,
// alte Position, gleicher Inhalt — und Redo loescht sie erneut.
test('Undo nach Seiten-Loeschen stellt die Seite an alter Stelle wieder her', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const { chapterId, pageIds } = await seedChapter(page, bookId, 'Undo-Delete', ['U1', 'U2', 'U3']);
  await openOrganizer(page);

  const res = await organizerData(page, `
    window.__app.appConfirm = async () => true;
    await ctx.deletePage(a.victim);
    await new Promise((r) => setTimeout(r, 300));
    const afterDelete = ctx._findChapter(a.cid).node.pages.map((p) => p.name);
    await ctx.historyUndo();
    await new Promise((r) => setTimeout(r, 500));
    const restored = ctx._findChapter(a.cid).node.pages;
    return { afterDelete, names: restored.map((p) => p.name), newId: restored[1]?.id,
             redo: ctx._redoStack.length };`, { victim: pageIds[1], cid: chapterId });
  expect(res.afterDelete).toEqual(['U1', 'U3']);
  expect(res.names, 'alte Position').toEqual(['U1', 'U2', 'U3']);
  expect(res.newId).not.toBe(pageIds[1]);
  expect(res.redo).toBe(1);
  const html = await page.evaluate(async (id) => (await (await fetch('/content/pages/' + id)).json()).html, res.newId);
  expect(html).toContain('x');

  const redo = await organizerData(page, `
    await ctx.historyRedo();
    await new Promise((r) => setTimeout(r, 300));
    return ctx._findChapter(a).node.pages.map((p) => p.name);`, chapterId);
  expect(redo).toEqual(['U1', 'U3']);
  guard.assertClean('undo delete via trash');
  await cleanupChapter(page, chapterId);
});

// Aufrufe aus Unterkomponenten (hier: Zeile der klappbaren Laengenverteilung,
// eigenes x-data) duerfen Sortable nicht an deren DOM binden. `this.$root` waere
// dort die Unterkomponente — `_initSortables` faende keine Listen, und nach dem
// Sprung stuende die ganze Karte ohne DnD da.
test('Sprung aus der Laengenverteilung laesst DnD auf der ganzen Karte intakt', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await openOrganizer(page);
  await organizerData(page, 'ctx.collapseAll(); await ctx.$nextTick();');

  const tile = page.locator('.card--organizer .organizer-lengthdist');
  await expect(tile).toBeVisible();
  await tile.locator('.collapsible-toggle').click();
  const row = tile.locator('.overview-chapter-row').first();
  await row.click();
  await page.waitForTimeout(300);

  const res = await organizerData(page, `
    const lists = [...document.querySelectorAll('.card--organizer [data-organizer]')];
    return { lists: lists.length,
             bound: lists.filter((el) => ctx._sortables.some((s) => s.el === el)).length };`);
  expect(res.lists).toBeGreaterThan(0);
  expect(res.bound, 'jede Liste der Karte hat eine Sortable-Instanz').toBe(res.lists);
  guard.assertClean('lengthdist jump keeps dnd');
});
