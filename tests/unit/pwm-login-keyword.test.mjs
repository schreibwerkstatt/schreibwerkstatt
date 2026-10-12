// Tripwire: kein App-Eingabefeld darf fuer Passwort-Manager wie ein Login-Feld
// aussehen. Bitwarden ehrt `data-bwignore` nur noch, wenn der User das in den
// Extension-Einstellungen aktiviert hat; ohne das entscheidet die Heuristik.
// Die nimmt id/name/class/placeholder/…, entfernt Bindestriche und sucht die
// Login-Stichwoerter als SUBSTRING — `confirm-dialog-input` wird zu
// `confirmdialoginput` und enthaelt `login` (dia·login·put). Ein formloses
// Textfeld ohne Passwortfeld auf der Seite gilt dann als Schritt eines
// mehrstufigen Logins, und Bitwarden blendet sein Inline-Menue ein.
// Echte Konto-Felder stehen in ALLOW.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PUBLIC_DIR = join(REPO_ROOT, 'public');

// Bitwarden AutoFillConstants.UsernameFieldNames + EmailFieldNames, Leerzeichen
// und Bindestriche entfernt wie im Matcher.
const KEYWORDS = [
  'username', 'userid', 'customerid', 'loginid', 'login',
  'benutzername', 'benutzerid',
  'email', 'emailaddress', 'emailadresse',
];

// Felder, die tatsaechlich Konto-/Login-Daten tragen: Passwort-Manager erwuenscht.
const ALLOW = new Set([
  'public/partials/admin-users-tab-users.html:adminUsersInviteEmail',
  'public/partials/book-settings-sync.html:blogForm.username',
  'public/register.html:email',
]);

const SKIP_TYPES = /\btype="(password|checkbox|radio|hidden|file|range|color|submit|button|reset|image|search)"/;
// Nur statische Attribute: `:placeholder="…"` ist ein Alpine-Ausdruck, Bitwarden
// sieht erst den ausgewerteten Text.
const ATTRS = /(?<=\s)(class|id|name|placeholder|title|aria-label|autocomplete|data-[\w-]+)="([^"]*)"/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'vendor') walk(full, out);
    } else if (/\.(html|js)$/.test(entry)) out.push(full);
  }
  return out;
}

function fieldKey(tag) {
  return tag.match(/\bx-model="([^"]*)"/)?.[1]
    || tag.match(/\bname="([^"]*)"/)?.[1]
    || tag.match(/\bid="([^"]*)"/)?.[1]
    || '';
}

test('kein Eingabefeld traegt ein Login-Stichwort fuer Passwort-Manager', () => {
  const hits = [];
  for (const file of walk(PUBLIC_DIR)) {
    if (file.endsWith('sw-manifest.js')) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<input\b[^>]*>/gs)) {
      const tag = m[0];
      if (SKIP_TYPES.test(tag)) continue;
      const values = [...tag.matchAll(ATTRS)].map(a => a[2].toLowerCase().replace(/[-\s]/g, ''));
      const kw = KEYWORDS.find(k => values.some(v => v.includes(k)));
      if (!kw) continue;
      const rel = relative(REPO_ROOT, file);
      if (ALLOW.has(`${rel}:${fieldKey(tag)}`)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      hits.push(`${rel}:${line} enthaelt «${kw}»: ${tag.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  assert.deepEqual(hits, [], 'Klasse/id/name umbenennen (z.B. `-field` statt `-input` nach `dialog`):\n' + hits.join('\n'));
});

// Zur Laufzeit liest Bitwarden den ausgewerteten Placeholder/Titel und den
// Text des umschliessenden <label>. Erfasst: i18n-Keys im <input>-Tag und die
// Label-Keys von `settingField` (rendert `<label><span>Label</span><input>`).
const I18N = Object.fromEntries(['de', 'en'].map(loc =>
  [loc, JSON.parse(readFileSync(join(PUBLIC_DIR, 'js', 'i18n', `${loc}.json`), 'utf8'))]));
const ALLOW_KEYS = new Set([
  'admin.users.invite.emailPlaceholder',
]);

test('kein uebersetzter Feldtext traegt ein Login-Stichwort', () => {
  const hits = [];
  const check = (rel, key) => {
    if (ALLOW_KEYS.has(key)) return;
    for (const [loc, dict] of Object.entries(I18N)) {
      const v = dict[key];
      if (typeof v !== 'string') continue;
      const norm = v.toLowerCase().replace(/[-\s]/g, '');
      const kw = KEYWORDS.find(k => norm.includes(k));
      if (kw) hits.push(`${rel}: ${key} (${loc}) enthaelt «${kw}»: ${v}`);
    }
  };
  for (const file of walk(PUBLIC_DIR)) {
    if (file.endsWith('sw-manifest.js')) continue;
    const src = readFileSync(file, 'utf8');
    const rel = relative(REPO_ROOT, file);
    for (const m of src.matchAll(/<input\b[^>]*>/gs)) {
      if (SKIP_TYPES.test(m[0])) continue;
      for (const k of m[0].matchAll(/\bt(?:Raw)?\('([\w.]+)'/g)) check(rel, k[1]);
    }
    for (const m of src.matchAll(/settingField\(\{[^}]*?\btype: '(?:num|text)'[^}]*?\blabel: '([\w.]+)'|settingField\(\{[^}]*?\blabel: '([\w.]+)'[^}]*?\btype: '(?:num|text)'/g)) {
      check(rel, m[1] || m[2]);
    }
  }
  assert.deepEqual(hits, [], 'Feldtext umformulieren (z.B. «Anmeldung» statt «Login», «name@…» statt «email@…»):\n' + hits.join('\n'));
});
