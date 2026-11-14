// Gate fuer das Zeilen-Ende aufklappbarer Listenzeilen (DESIGN.md „Zeilen-Ende",
// components/row-expand.css): ⋯-Menue und Aufklapp-Chevron sehen in jeder Karte
// gleich aus, sind gleich gross und liegen auf der Mittellinie der Zeile.
//
// Geprueft wird:
//   1. Jedes `.row-expand` steht in einem `.row-end` und ist dort das letzte Kind.
//   2. Ein `.history-chevron` in einer Listenzeile (`.entity-row`,
//      `.research-item-head`, `.weltfakten-row-line`) steht in einem `.row-expand`
//      — kein nackter Chevron, keine karteneigene Positionierung.
//   3. Im `.row-end` ist der ⋯-Knopf `.icon-btn.icon-btn--ghost`, und es steht
//      kein Stift daneben (der Titel oeffnet das Bearbeiten, Menue-Eintrag 1).
//   4. Der Zeilenkopf, der ein `.row-end` traegt, richtet mittig aus
//      (`align-items: center`, nie `baseline`).
//   5. Regeln auf `.row-end`/`.row-expand` stehen nur in row-expand.css (eine
//      Ausnahme per `:not(.row-end)` ist erlaubt — sie stylt das Ende nicht).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const OWNER_CSS = 'public/css/components/row-expand.css';
const ROW_HEADS = ['entity-row', 'research-item-head', 'weltfakten-row-line'];
const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'use', 'source', 'col', 'wbr', 'area', 'base', 'embed', 'param', 'track']);

const rel = (p) => relative(REPO_ROOT, p);
function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

// Mini-Elementbaum: reicht fuer die Partials (Attribute in Anfuehrungszeichen
// duerfen `>` enthalten, Kommentare werden zeilentreu ausgeblendet).
function parse(src) {
  const clean = src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const root = { tag: '#root', classes: [], children: [], attrs: '' };
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>"'\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>/g;
  for (const m of clean.matchAll(re)) {
    const [, closing, rawTag, attrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const cls = /\bclass\s*=\s*"([^"]*)"/.exec(attrs);
    const node = {
      tag, attrs, children: [], parent: stack[stack.length - 1],
      classes: cls ? cls[1].split(/\s+/).filter(Boolean) : [],
      line: clean.slice(0, m.index).split('\n').length,
    };
    node.parent.children.push(node);
    if (!selfClose && !VOID.has(tag)) stack.push(node);
  }
  return root;
}
function* nodes(n) { for (const c of n.children) { yield c; yield* nodes(c); } }
const has = (n, c) => n.classes.includes(c);
function ancestor(n, pred) { for (let p = n.parent; p; p = p.parent) if (pred(p)) return p; return null; }
// `<template>` ist im DOM kein Element-Kind: fuer „letztes Kind" und „Elternkopf"
// zaehlt der Inhalt so, als stuende er direkt da.
function elementChildren(n) { return n.children.flatMap(c => c.tag === 'template' ? elementChildren(c) : [c]); }
function elementParent(n) { let p = n.parent; while (p && p.tag === 'template') p = p.parent; return p; }

const files = [...walk(PARTIALS_DIR, '.html'), INDEX_HTML].map(f => [rel(f), parse(readFileSync(f, 'utf8'))]);
const all = files.flatMap(([file, root]) => [...nodes(root)].map(n => ({ file, n })));
const at = ({ file, n }) => `${file}:${n.line}`;

test('row-end: es gibt Konsumenten', () => {
  assert.ok(all.filter(x => has(x.n, 'row-end')).length >= 8, 'weniger als 8 `.row-end` gefunden — Parser oder Pfad pruefen');
});

test('row-end: jedes .row-expand steht als letztes Kind in einem .row-end', () => {
  const bad = [];
  for (const x of all.filter(x => has(x.n, 'row-expand'))) {
    const p = elementParent(x.n);
    if (!p || !has(p, 'row-end')) { bad.push(`${at(x)} (nicht direkt in .row-end)`); continue; }
    const kids = elementChildren(p);
    if (kids[kids.length - 1] !== x.n) bad.push(`${at(x)} (nicht letztes Kind)`);
  }
  assert.deepEqual(bad, [], `\n  ${bad.join('\n  ')}`);
});

test('row-end: Chevron einer Listenzeile nur im .row-expand', () => {
  const bad = all
    .filter(x => has(x.n, 'history-chevron'))
    .filter(x => ancestor(x.n, p => ROW_HEADS.some(c => has(p, c))))
    .filter(x => !has(elementParent(x.n), 'row-expand'))
    .map(at);
  assert.deepEqual(bad, [], `nackter Chevron in einer Listenzeile — in .row-end > .row-expand setzen:\n  ${bad.join('\n  ')}`);
});

test('row-end: ⋯ ist .icon-btn--ghost, kein Stift daneben', () => {
  const bad = [];
  for (const x of all.filter(x => has(x.n, 'row-end'))) {
    for (const b of [...nodes(x.n)].filter(n => n.tag === 'button')) {
      const icons = [...nodes(b)].map(n => /#([\w-]+)/.exec(n.attrs)?.[1]).filter(Boolean);
      if (icons.includes('pencil')) bad.push(`${x.file}:${b.line} Stift im Zeilen-Ende`);
      if (icons.includes('more-horizontal') && !(has(b, 'icon-btn') && has(b, 'icon-btn--ghost'))) bad.push(`${x.file}:${b.line} ⋯ ohne icon-btn--ghost`);
    }
  }
  // Der ⋯-Knopf der Recherche kommt per @include (recherche-item-menu-trigger).
  const trigger = readFileSync(join(PARTIALS_DIR, 'recherche-item-menu-trigger.html'), 'utf8');
  if (!/class="icon-btn icon-btn--ghost"/.test(trigger)) bad.push('recherche-item-menu-trigger.html ⋯ ohne icon-btn--ghost');
  assert.deepEqual(bad, [], `\n  ${bad.join('\n  ')}`);
});

// Selektorliste an Kommas der obersten Ebene trennen (`:not(.a, .b)` bleibt ganz).
function splitTop(list) {
  const out = []; let depth = 0, cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
function cssRules() {
  const rules = [];
  for (const file of walk(CSS_DIR, '.css')) {
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      rules.push({ file: rel(file), selectors: splitTop(m[1]), body: m[2] });
    }
  }
  return rules;
}
const rules = cssRules();

test('row-end: Zeilenkopf mit .row-end richtet mittig aus', () => {
  const heads = new Set();
  for (const x of all.filter(x => has(x.n, 'row-end'))) {
    const p = elementParent(x.n);
    const head = p.classes.find(c => ROW_HEADS.includes(c)) || p.classes[0];
    if (head) heads.add(head);
  }
  const bad = [];
  for (const h of heads) {
    const own = rules.filter(r => r.selectors.includes(`.${h}`));
    const align = own.map(r => /align-items:\s*([\w-]+)/.exec(r.body)?.[1]).filter(Boolean);
    if (!align.length || align.some(a => a !== 'center')) bad.push(`.${h}: align-items ${align.join('/') || '(fehlt)'}`);
  }
  assert.ok(heads.size >= 3, `nur ${heads.size} Zeilenkoepfe gefunden`);
  assert.deepEqual(bad, [], `Zeilenkopf mit .row-end muss align-items: center tragen:\n  ${bad.join('\n  ')}`);
});

test('row-end: Optik nur in components/row-expand.css', () => {
  const bad = rules
    .filter(r => r.file !== OWNER_CSS && r.selectors.some(s => /\.row-(end|expand)\b/.test(s.replace(/:not\([^)]*\)/g, ''))))
    .map(r => `${r.file}: ${r.selectors.join(', ')}`);
  assert.deepEqual(bad, [], `\n  ${bad.join('\n  ')}`);
});
