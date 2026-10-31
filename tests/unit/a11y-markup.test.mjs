// Gate fuer Markup-A11y in Partials + index.html (DESIGN.md „Sortierbare
// Tabelle", „Form-Patterns" → „Label-Zuordnung", „Accessibility").
//
// Geprueft wird:
//   1. Sortierbare Tabellenkoepfe nur ueber den Spread `x-bind="sortTh('key')"`
//      — handverdrahtetes `sortBy`/`sortClass`/`ariaSort` hat keine Tastatur-
//      Bedienung.
//   2. Jedes `<label class="card-form-label">` ist einem Feld zugeordnet:
//      `for`/`:for`, ein umschlossenes Feld, oder seine `id`/`:id` steht in
//      einem `aria-labelledby` derselben Datei.
//   3. Ein `<button>`, dessen `:class` einen Zustand zeigt (`is-active`,
//      `--active`, `--on`, `--selected`), sagt ihn auch dem Screenreader:
//      `aria-pressed` (Segment/Schalter), `role=tab` + `aria-selected` (Reiter),
//      `aria-expanded` (Panel), `menuitemcheckbox` + `aria-checked` (Menue),
//      `aria-current` (Position) — oder kommt aus einem `x-bind`-Spread.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const FILES = [
  ...readdirSync(PARTIALS_DIR).filter((f) => f.endsWith('.html')).map((f) => join(PARTIALS_DIR, f)),
  join(REPO_ROOT, 'public', 'index.html'),
];

// Vorlaeufige Ausnahmen: Datei-Praefix → Begruendung.
const ALLOW = [
  { prefix: 'book-settings', reason: 'wird parallel umgebaut' },
];
const allowed = (file) => ALLOW.some((a) => basename(file).startsWith(a.prefix));

// Knoepfe, deren Beschriftung selbst mit dem Zustand wechselt (Aktion statt
// Schalter: «Archivieren»/«Zurueckholen») oder deren Klasse nur kurz
// aufblitzt — `aria-pressed` daneben wuerde den Zustand doppelt sagen.
// Eintrag = Datei + eindeutiger Ausschnitt aus dem Tag.
const TOGGLE_ALLOW = [
  ['editor-page-toolbar.html', "'is-active': quotesNormalizedFlash"],
  ['editor-page-toolbar.html', "'context-menu-item--on': quotesNormalizedFlash"],
  ['page-history.html', 'btn-toggle-saved--on'],
  ['plot-beat-edit.html', "'is-active': beat.verworfen"],
  ['plot-board-flat.html', "'is-active': act.archiviert"],
  ['plot-board-grid.html', "'is-active': act.archiviert"],
  ['plot-thread-menu.html', "'context-menu-item--on': threadHasOwnActs"],
  ['reference.html', "'is-active': referenceScope === 'book'"],
  ['search.html', "'is-active': scopeMode === 'book'"],
  ['snapshots.html', "'snapshots-publish-btn--on': isPublished(s)"],
];

const TAG_RE = (name) => new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'g');
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name.replace(/[$:]/g, '\\$&')}="([^"]*)"`));
  return m ? m[1] : null;
};
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

export function sortThViolations(src) {
  const out = [];
  for (const m of src.matchAll(/\b(sortBy|sortClass|ariaSort)\(/g)) out.push(`${m[1]} @${lineOf(src, m.index)}`);
  return out;
}

export function labelViolations(src) {
  const out = [];
  const labelledBy = [];
  for (const m of src.matchAll(/\s:?aria-labelledby="([^"]*)"/g)) labelledBy.push(m[1]);
  for (const m of src.matchAll(TAG_RE('label'))) {
    const tag = m[0];
    const cls = attr(tag, 'class') || '';
    if (!cls.split(/\s+/).includes('card-form-label')) continue;
    if (attr(tag, 'for') != null || attr(tag, ':for') != null) continue;
    const end = src.indexOf('</label>', m.index + tag.length);
    const inner = end < 0 ? '' : src.slice(m.index + tag.length, end);
    if (/<(input|textarea|select|button)\b|x-data="(combobox|numInput|radioGroup)/.test(inner)) continue;
    const dynId = attr(tag, ':id');
    const id = attr(tag, 'id');
    if (dynId && labelledBy.some((v) => v === dynId)) continue;
    if (id && labelledBy.some((v) => v.split(/\s+/).includes(id) || v.includes(`'${id}'`))) continue;
    out.push(`@${lineOf(src, m.index)} ${tag.slice(0, 90)}`);
  }
  return out;
}

const STATE_CLASS_RE = /is-active|--active\b|--on\b|--selected\b/;
const STATE_ARIA_RE = /\s:?(aria-(pressed|selected|expanded|checked|current)|x-bind)=/;

export function toggleViolations(src, file = '') {
  const out = [];
  for (const m of src.matchAll(TAG_RE('button'))) {
    const tag = m[0];
    const cls = attr(tag, ':class');
    if (!cls || !STATE_CLASS_RE.test(cls) || STATE_ARIA_RE.test(tag)) continue;
    if (TOGGLE_ALLOW.some(([f, snip]) => f === file && tag.includes(snip))) continue;
    out.push(`@${lineOf(src, m.index)} ${tag.replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  return out;
}

test('sortierbare <th> nur via x-bind="sortTh(…)"', () => {
  const bad = [];
  for (const f of FILES) {
    if (allowed(f)) continue;
    for (const v of sortThViolations(readFileSync(f, 'utf8'))) bad.push(`${basename(f)} ${v}`);
  }
  assert.deepEqual(bad, [], 'Tabellenkopf ohne sortTh-Spread:\n' + bad.join('\n'));
});

test('jedes card-form-label ist einem Feld zugeordnet', () => {
  const bad = [];
  for (const f of FILES) {
    if (allowed(f)) continue;
    for (const v of labelViolations(readFileSync(f, 'utf8'))) bad.push(`${basename(f)} ${v}`);
  }
  assert.deepEqual(bad, [], 'card-form-label ohne for/aria-labelledby (DESIGN.md „Label-Zuordnung"):\n' + bad.join('\n'));
});

test('Zustands-Knoepfe tragen ihren Zustand als ARIA', () => {
  const bad = [];
  for (const f of FILES) {
    if (allowed(f)) continue;
    for (const v of toggleViolations(readFileSync(f, 'utf8'), basename(f))) bad.push(`${basename(f)} ${v}`);
  }
  assert.deepEqual(bad, [], 'Knopf mit Zustandsklasse ohne aria-pressed/-selected/-expanded/-checked/-current:\n' + bad.join('\n'));
});

test('Gate-Pruefer erkennen Verstoesse (Mutation)', () => {
  assert.equal(sortThViolations(`<th @click="sortBy('a')" :class="sortClass('a')"></th>`).length, 2);
  assert.equal(sortThViolations(`<th x-bind="sortTh('a')"></th>`).length, 0);
  assert.equal(labelViolations(`<label class="card-form-label" x-text="x"></label><input>`).length, 1);
  assert.equal(labelViolations(`<label class="card-form-label" :for="$id('fld')"></label>`).length, 0);
  assert.equal(labelViolations(`<label class="card-form-label" :id="$id('fld')"></label><div :aria-labelledby="$id('fld')"></div>`).length, 0);
  assert.equal(labelViolations(`<label class="card-form-label" :id="$id('fld')"></label><div :aria-labelledby="$id('other')"></div>`).length, 1);
  assert.equal(labelViolations(`<label class="card-form-label"><input type="checkbox"> x</label>`).length, 0);
  assert.equal(toggleViolations(`<button :class="{ 'seg-toggle--active': a }"></button>`).length, 1);
  assert.equal(toggleViolations(`<button :class="{ 'seg-toggle--active': a }" :aria-pressed="a"></button>`).length, 0);
});
