// Guard-Test für die Dropdown-/Context-Menu-Harmonisierung
// (DESIGN.md → „Context-Menu" / Dropdown-Variante).
//
// Verbindliche Frontend-Invariante: ALLE Aktions-Menüs nutzen das geteilte
// .context-menu-Vokabular, jeder Menü-Eintrag trägt ein führendes Sprite-Icon
// (.context-menu-item--icon + <svg class="icon"><use…>), und Aktions-Kategorien
// werden durch .context-menu-sep getrennt. Trigger sind Icon-Buttons
// (more-horizontal), nie ein „⋯"/„≡"-Glyph.
//
// Dieser Test fällt rot, sobald ein neues Menü ein Item ohne Icon einführt oder
// einen Glyph-Trigger nutzt — so bleiben alle Dropdowns einheitlich, ohne dass
// es jemand manuell prüft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const PARTIALS_DIR = fileURLToPath(new URL('../../public/partials', import.meta.url));
const INDEX_HTML = fileURLToPath(new URL('../../public/index.html', import.meta.url));

function sources() {
  const files = readdirSync(PARTIALS_DIR)
    .filter(f => f.endsWith('.html'))
    .map(f => [`partials/${f}`, readFileSync(`${PARTIALS_DIR}/${f}`, 'utf8')]);
  files.push(['index.html', readFileSync(INDEX_HTML, 'utf8')]);
  return files;
}

// Sammelt alle Treffer eines Selektors, inkl. der in <template> (Alpine
// x-for/x-if/x-teleport) gewickelten — querySelectorAll steigt nicht in
// Template-Content ab, darum manuell rekursiv über tpl.content.
function collectAll(html, selector) {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const out = [];
  const seen = new Set();
  const scan = (root) => {
    for (const el of root.querySelectorAll(selector)) {
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
    for (const tpl of root.querySelectorAll('template')) {
      if (tpl.content) scan(tpl.content);
    }
  };
  scan(document);
  return out;
}

const hasClass = (el, c) => (el.getAttribute('class') || '').split(/\s+/).includes(c);
const hasSpriteIcon = (el) => {
  const svg = el.querySelector('svg.icon, svg[class*="icon"]');
  return !!(svg && el.querySelector('use'));
};

test('Context-Menu: jeder Eintrag trägt ein Sprite-Icon (.context-menu-item--icon + <svg><use>)', () => {
  const offenders = [];
  for (const [file, html] of sources()) {
    for (const item of collectAll(html, '.context-menu-item')) {
      // Trenner/Header sind keine Einträge.
      if (hasClass(item, 'context-menu-sep') || hasClass(item, 'context-menu-header')) continue;
      const tag = item.tagName.toLowerCase();
      if (tag !== 'button' && tag !== 'label' && tag !== 'a') continue;
      if (!hasClass(item, 'context-menu-item--icon')) {
        offenders.push(`${file}: .context-menu-item ohne --icon-Modifier → ${item.outerHTML.slice(0, 90)}`);
        continue;
      }
      if (!hasSpriteIcon(item)) {
        offenders.push(`${file}: .context-menu-item--icon ohne <svg class="icon"><use…> → ${item.outerHTML.slice(0, 90)}`);
      }
    }
  }
  assert.equal(
    offenders.length, 0,
    `Context-Menu-Einträge ohne Icon (DESIGN.md → Context-Menu / Dropdown-Variante):\n${offenders.join('\n')}`,
  );
});

test('Context-Menu: jedes Menü hat ≥1 Icon-Eintrag (kein leeres/textiges Menü)', () => {
  const offenders = [];
  for (const [file, html] of sources()) {
    for (const menu of collectAll(html, '.context-menu')) {
      const items = [...menu.querySelectorAll('.context-menu-item')]
        .filter(i => !hasClass(i, 'context-menu-sep') && !hasClass(i, 'context-menu-header'));
      if (items.length && !items.some(i => hasClass(i, 'context-menu-item--icon'))) {
        offenders.push(`${file}: .context-menu ohne einen einzigen --icon-Eintrag`);
      }
    }
  }
  assert.equal(offenders.length, 0, `Context-Menu ohne Icon-Einträge:\n${offenders.join('\n')}`);
});

test('Context-Menu-Trigger: aria-haspopup="menu" sitzt nur auf Icon-Buttons (kein Glyph)', () => {
  const offenders = [];
  for (const [file, html] of sources()) {
    for (const btn of collectAll(html, 'button[aria-haspopup="menu"]')) {
      // Avatar-/Identitäts-Trigger zeigen ein Profilbild bzw. Initialen, kein
      // Aktions-Icon — bewusst ein eigenes Pattern (avatar-menu), kein Meatball.
      if (hasClass(btn, 'avatar-btn')) continue;
      // Plot-Anchor-Badge trägt die Fundstellen-Zahl als Text (Content-Trigger, kein
      // Aktions-Icon) und öffnet das Content-Fundstellen-Popover — Ausnahme wie Avatar.
      if (hasClass(btn, 'plot-beat-anchor')) continue;
      // Bearbeitungsstand-Plakette im Notebook-Kopf zeigt die aktuelle Stufe als
      // Text und öffnet deren Auswahl — ein Wert-Trigger wie eine Combobox.
      if (hasClass(btn, 'editor-edit-status__trigger')) continue;
      if (!hasSpriteIcon(btn)) {
        const txt = (btn.textContent || '').replace(/\s+/g, '');
        offenders.push(`${file}: Menü-Trigger ohne Sprite-Icon (Text "${txt.slice(0, 12)}") → more-horizontal-Icon nutzen`);
      }
    }
  }
  assert.equal(
    offenders.length, 0,
    `Menü-Trigger ohne Icon (DESIGN.md → Context-Menu / Dropdown-Variante):\n${offenders.join('\n')}`,
  );
});
