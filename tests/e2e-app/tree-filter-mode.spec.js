// Seitenbaum im Filtermodus (Suche + Stand-Filter) und die Struktur-Aktionen,
// die den Baum in place aendern — gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: beide Filter rendern KOPIEN der Baum-Items aus Memos
// (app.js#_searchTree, tree/edit-status.js#_editFilterTree). Ob eine In-Place-
// Aenderung dort ankommt, entscheidet die Baum-Revision (tree/build.js#
// _bumpTreeRev) im Zusammenspiel mit Alpine-Reaktivitaet und x-for — das sieht
// nur der gerenderte Baum.
//
// Geprüfte Zusagen:
//   1. Stand-Filter: ein Mehr-Abschnitt-Kapitel mit genau einem unfertigen
//      Abschnitt behaelt seinen Kapitelkopf (keine Ein-Abschnitt-Zeile), und das
//      Kontextmenue der Zeile wirkt auf den Abschnitt.
//   2. Stand-Filter: ein neu eingehaengter Abschnitt erscheint, ein geloeschter
//      verschwindet — ohne Reload.
//   3. Stand-Filter ohne Stufen-Kette (gescheiterter /redaktion-Fetch) wirft
//      nicht und zeigt den ganzen Baum.
//   4. Alle Abschnitte fertig → Hinweis mit Knopf, der den Filter aufhebt.
//   5. Suche nach einem Kapitelnamen zeigt dessen Unterkapitel samt Abschnitten mit.
//   6. Leeres Kapitel laesst sich per Rechtsklick loeschen.
//   7. Typeahead: ein Buchstabe springt zum naechsten passenden Eintrag.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const TREE = '#partial-sidebar [role="tree"]';

async function json(page, method, url, body) {
  return page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return r.ok ? r.json().catch(() => null) : null;
  }, [method, url, body]);
}

// Erstes Kapitel mit mindestens zwei Abschnitten und ohne Unterkapitel.
async function multiChapter(page) {
  return page.evaluate(() => {
    const it = window.Alpine.store('nav').tree.find(i => !i.solo && !i.hasChildren && i.pages.length >= 2);
    return it ? { id: it.id, name: it.name, pages: it.pages.map(p => ({ id: p.id, name: p.name })) } : null;
  });
}

async function setChapterStatus(page, chapterId, status) {
  await json(page, 'PUT', '/redaktion/chapter/' + chapterId, { status });
}

async function lastStage(page) {
  return page.evaluate(() => window.Alpine.store('badges').editStatusChain.at(-1));
}

test.describe('Seitenbaum im Filtermodus', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await selectSeededBook(page);
    await page.waitForSelector(`${TREE} a.page-item`);
    await page.waitForFunction(() => window.Alpine.store('badges').editStatusChain.length > 0);
  });

  test.afterEach(async ({ page }) => {
    // Spec-Reruns teilen die DB: Stand aller Kapitel zuruecksetzen.
    await page.evaluate(async () => {
      for (const c of window.Alpine.store('nav').tree.filter(i => !i.solo)) {
        await fetch('/redaktion/chapter/' + c.id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: null }),
        });
      }
      window.__app.treeEditFilter = false;
    }).catch(() => {});
  });

  test('Stand-Filter: Mehr-Abschnitt-Kapitel mit einem Treffer behält den Kopf', async ({ page }) => {
    const ch = await multiChapter(page);
    test.skip(!ch, 'Seed ohne Kapitel mit zwei Abschnitten');
    await setChapterStatus(page, ch.id, await lastStage(page));
    const open = ch.pages[1];
    await json(page, 'PUT', '/redaktion/page/' + open.id, { status: null });
    await page.evaluate(async () => {
      await window.__app.refreshPageStatus();
      window.__app.treeEditFilter = true;
    });

    const header = page.locator(`${TREE} [data-tree-key="c${ch.id}"]`);
    const row = page.locator(`${TREE} a.page-item[data-page-id="${open.id}"]`);
    await expect(header).toBeVisible();
    await expect(row).toBeVisible();
    await expect(page.locator(`${TREE} a.page-item[data-page-id="${ch.pages[0].id}"]`)).toHaveCount(0);
    await expect(row.locator('.page-item--chapter-name')).toHaveCount(0);
    // Tag zeigt die Trefferzahl wie bei der Suche.
    await expect(header.locator('.tree-chapter-meta .tag:not(.tree-chapter-excluded-tag)')).toHaveText(/^1\b/);

    await row.click({ button: 'right' });
    await expect(page.locator('.pagetree-context-menu .context-menu-header:not(.context-menu-header--inline)')).toHaveText(open.name);
    await expect(page.locator('.pagetree-context-menu .context-menu-item:visible', { hasText: 'Kapitel löschen' })).toHaveCount(0);
    await expect(page.locator('.pagetree-context-menu .context-menu-item:visible', { hasText: 'Abschnitt löschen' })).toHaveCount(1);
    await page.keyboard.press('Escape');

    // Auf-/Zuklappen ist im Filter wirkungslos und bleibt aus.
    await expect(page.locator('#partial-sidebar .sidebar-action-group button:has(use[href="/icons.svg#chevron-up"])')).toBeDisabled();
    await header.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(row).toBeVisible();
    expect(await page.evaluate((id) => window.Alpine.store('nav').tree.find(i => i.id === id).open, ch.id)).toBe(true);
  });

  test('Stand-Filter: neuer Abschnitt erscheint, gelöschter verschwindet', async ({ page }) => {
    const ch = await multiChapter(page);
    test.skip(!ch, 'Seed ohne Kapitel mit zwei Abschnitten');
    await setChapterStatus(page, ch.id, await lastStage(page));
    await json(page, 'PUT', '/redaktion/page/' + ch.pages[0].id, { status: null });
    await page.evaluate(async () => {
      await window.__app.refreshPageStatus();
      window.__app.treeEditFilter = true;
    });
    await expect(page.locator(`${TREE} a.page-item[data-page-id="${ch.pages[0].id}"]`)).toBeVisible();

    const created = await json(page, 'POST', '/content/pages', { chapter_id: ch.id, name: 'Filter-Neu', html: '<p></p>' });
    expect(created?.id).toBeTruthy();
    try {
      await page.evaluate(([cid, pg]) => {
        const item = window.__app._findTreeChapter(cid);
        window.__app._insertCreatedPageIntoTree(item, pg);
      }, [ch.id, created]);
      const row = page.locator(`${TREE} a.page-item[data-page-id="${created.id}"]`);
      await expect(row).toBeVisible();
      await page.evaluate((id) => window.__app.deletePageById(id, { confirm: false }), created.id);
      await expect(row).toHaveCount(0);
    } finally {
      await json(page, 'DELETE', '/content/pages/' + created.id);
    }
  });

  test('Stand-Filter ohne Stufen-Kette wirft nicht', async ({ page, consoleGuard }) => {
    void consoleGuard;
    await page.evaluate(() => {
      window.__app.treeEditFilter = true;
      window.__app._applyPageStatus({}); // wie ein gescheiterter /redaktion-Fetch
    });
    const total = await page.evaluate(() => window.Alpine.store('nav').pages.length);
    await expect(page.locator(`${TREE} a.page-item`)).toHaveCount(total);
    await page.evaluate(() => window.__app.refreshPageStatus());
  });

  test('alle Abschnitte fertig: Hinweis hebt den Filter auf', async ({ page }) => {
    const done = await lastStage(page);
    const ids = await page.evaluate(() => window.Alpine.store('nav').tree.filter(i => !i.solo && !i.parent_id).map(i => i.id));
    for (const id of ids) await setChapterStatus(page, id, done);
    for (const id of await page.evaluate(() => window.Alpine.store('nav').tree.filter(i => i.solo).map(i => i.pages[0].id))) {
      await json(page, 'PUT', '/redaktion/page/' + id, { status: done });
    }
    await page.evaluate(async () => {
      await window.__app.refreshPageStatus();
      window.__app.treeEditFilter = true;
    });
    const off = page.locator('#partial-sidebar .sidebar-empty-book button', { hasText: 'Filter aufheben' });
    await expect(off).toBeVisible();
    await off.click();
    await expect(page.locator(`${TREE} a.page-item`).first()).toBeVisible();
    for (const id of await page.evaluate(() => window.Alpine.store('nav').tree.filter(i => i.solo).map(i => i.pages[0].id))) {
      await json(page, 'PUT', '/redaktion/page/' + id, { status: null });
    }
  });

  test('Suche nach Kapitelname zeigt Unterkapitel mit', async ({ page }) => {
    const ch = await multiChapter(page);
    test.skip(!ch, 'Seed ohne passendes Kapitel');
    const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);
    const sub = await json(page, 'POST', '/content/chapters', { book_id: Number(bookId), name: 'Unterteil Filtertest', parent_chapter_id: ch.id });
    expect(sub?.id).toBeTruthy();
    const pg = await json(page, 'POST', '/content/pages', { chapter_id: sub.id, name: 'Tief drin', html: '<p></p>' });
    try {
      await page.evaluate(() => window.__app.loadPages({ source: 'manual', fresh: true }));
      await page.fill('#partial-sidebar .page-search', ch.name);
      // Das Unterkapitel hat einen Abschnitt → eine Ein-Abschnitt-Zeile mit
      // seinem Namen, kein eigener Kopf.
      const row = page.locator(`${TREE} a.page-item[data-page-id="${pg.id}"]`);
      await expect(row).toBeVisible();
      await expect(row.locator('.page-item--chapter-name')).toHaveText('Unterteil Filtertest');
    } finally {
      await page.fill('#partial-sidebar .page-search', '');
      if (pg?.id) await json(page, 'DELETE', '/content/pages/' + pg.id);
      await json(page, 'DELETE', '/content/chapters/' + sub.id);
      await page.evaluate(() => window.__app.loadPages({ source: 'manual', fresh: true }));
    }
  });

  test('leeres Kapitel per Rechtsklick löschen', async ({ page }) => {
    const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);
    const created = await json(page, 'POST', '/content/chapters', { book_id: Number(bookId), name: 'Leer zum Löschen' });
    expect(created?.id).toBeTruthy();
    try {
      await page.evaluate(() => window.__app.loadPages({ source: 'manual', fresh: true }));
      const header = page.locator(`${TREE} [data-tree-key="c${created.id}"]`);
      await expect(header).toBeVisible();
      await page.evaluate(() => { window.__app.appConfirm = async () => true; });
      await header.click({ button: 'right' });
      await page.locator('.pagetree-context-menu .context-menu-item', { hasText: 'Kapitel löschen' }).click();
      await expect(header).toHaveCount(0);
      expect(await page.evaluate((id) => !!window.__app._findTreeChapter(id), created.id)).toBe(false);
    } finally {
      await json(page, 'DELETE', '/content/chapters/' + created.id);
    }
  });

  test('Typeahead springt zum nächsten passenden Eintrag', async ({ page }) => {
    await page.evaluate(() => window.__app.setAllChaptersOpen(true));
    const items = page.locator(`${TREE} [data-tree-key]:visible`);
    const first = items.first();
    await first.focus();
    const startKey = await first.getAttribute('data-tree-key');
    const letter = await page.evaluate((key) => {
      // Ein Buchstabe, mit dem ein ANDERER sichtbarer Eintrag beginnt.
      const els = [...document.querySelectorAll('#partial-sidebar [data-tree-key]')].filter(e => e.offsetParent);
      const label = (e) => (e.querySelector('.tree-chapter-name, .page-name')?.textContent || '').trim().toLowerCase();
      const other = els.find(e => e.dataset.treeKey !== key && label(e));
      return label(other)[0];
    }, startKey);
    await page.keyboard.press(letter);
    const focused = await page.evaluate(() => document.activeElement?.dataset?.treeKey);
    expect(focused).not.toBe(startKey);
    const label = await page.evaluate(() => {
      const el = document.activeElement;
      return (el.querySelector('.tree-chapter-name, .page-name')?.textContent || '').trim().toLowerCase();
    });
    expect(label.startsWith(letter)).toBe(true);
    await expect(page.locator(`${TREE} [data-tree-key][tabindex="0"]`)).toHaveCount(1);
  });
});
