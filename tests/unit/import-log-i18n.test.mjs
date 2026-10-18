// Import-Log, Skip-Gründe und Parser-Warnungen des Ordner-/Manuskript-Imports
// werden in der Import-Karte per t() gerendert (lib/import-audit.js). Jeder
// Key, den der Code erzeugen kann, muss in BEIDEN Locales stehen — sonst sieht
// der User den rohen Key. Die Listen werden aus dem Quelltext gelesen, damit
// ein neuer audit()-/recordSkip()-Aufruf oder Warn-Code ohne Text CI rot macht.
//
// Lauf: `node --test tests/unit/import-log-i18n.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const locales = {
  de: JSON.parse(read('public/js/i18n/de.json')),
  en: JSON.parse(read('public/js/i18n/en.json')),
};
const JOBS = ['routes/jobs/folder-import.js', 'routes/jobs/manuscript-import.js'];

function collect() {
  const keys = new Set();
  for (const f of JOBS) {
    const src = read(f);
    for (const m of src.matchAll(/audit\('(?:info|warn)',\s*'([\w.]+)'/g)) keys.add(m[1]);
    for (const m of src.matchAll(/recordSkip\([^,]+,\s*'([A-Z_]+)'\)/g)) keys.add(`folderImport.skipReason.${m[1]}`);
    for (const m of src.matchAll(/recordSkip\([^)]*\?\s*'([A-Z_]+)'\s*:\s*'([A-Z_]+)'\)/g)) {
      keys.add(`folderImport.skipReason.${m[1]}`);
      keys.add(`folderImport.skipReason.${m[2]}`);
    }
    for (const m of src.matchAll(/reason:\s*'([A-Z_]+)'/g)) keys.add(`folderImport.skipReason.${m[1]}`);
  }
  for (const f of readdirSync(path.join(root, 'lib/import-parsers'))) {
    const src = read(`lib/import-parsers/${f}`);
    // Warnungen, nicht geworfene Fehler (`throw Object.assign(…, { code })`).
    for (const m of src.matchAll(/warnings\.push\(\{\s*code:\s*'([A-Z_]+)'/g)) keys.add(`folderImport.warning.${m[1]}`);
    for (const m of src.matchAll(/merged\.push\(\{\s*code:\s*'([A-Z_]+)'/g)) keys.add(`folderImport.warning.${m[1]}`);
  }
  return keys;
}

test('Import-Log/Skip-Gründe/Warnungen: jeder erzeugbare Key steht in de und en', () => {
  const keys = collect();
  assert.ok(keys.size >= 20, `zu wenige Keys gefunden (${keys.size}) — Regex an den Code angepasst?`);
  for (const k of ['importLog.doneFolder', 'importLog.doneManuscript', 'folderImport.skipReason.NO_DATE', 'folderImport.warning.IMAGES_DROPPED']) {
    assert.ok(keys.has(k), `Sammler findet ${k} nicht`);
  }
  for (const [lang, dict] of Object.entries(locales)) {
    const missing = [...keys].filter(k => typeof dict[k] !== 'string');
    assert.deepEqual(missing, [], `${lang}.json fehlt`);
  }
  for (const lang of Object.keys(locales)) assert.equal(typeof locales[lang]['folderImport.warning.unknown'], 'string');
});
