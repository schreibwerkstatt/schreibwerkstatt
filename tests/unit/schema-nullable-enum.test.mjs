// Claude Structured Outputs lehnt ein Enum neben einem Typ-Array ab
// (`{ type: ['string', 'null'], enum: [...] }` → HTTP 400 «Enum value … does not
// match declared type»). Der Call fällt dann auf den Retry ohne Schema zurück:
// ein bezahlter Fehlversuch je Lauf und eine Antwort ohne Schema-Garantie.
// Nullbare Enums deshalb nur über `_nullableEnum` (prompts/schema-utils.js).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROMPTS = join(ROOT, 'public/js/prompts');

function listJs(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return listJs(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

function findViolations(node, path, out, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node.type) && Array.isArray(node.enum)) out.push(path || '(root)');
  for (const [k, v] of Object.entries(node)) findViolations(v, `${path}.${k}`, out, seen);
}

const looksLikeSchema = (v) => v && typeof v === 'object' && (v.type === 'object' || v.properties);

test('kein Enum neben einem Typ-Array in exportierten Schemas', async () => {
  const violations = [];
  for (const file of listJs(PROMPTS)) {
    const mod = await import(pathToFileURL(file).href);
    const rel = relative(ROOT, file);
    for (const [name, value] of Object.entries(mod)) {
      if (looksLikeSchema(value)) findViolations(value, `${rel}#${name}`, violations);
      if (typeof value === 'function' && /^build\w*Schema$/.test(name)) {
        for (const arg of [undefined, {}, { delta: true }]) {
          let built;
          try { built = value(arg); } catch { continue; }
          if (looksLikeSchema(built)) findViolations(built, `${rel}#${name}()`, violations);
        }
      }
    }
  }
  assert.deepEqual([...new Set(violations)], [], 'nullbares Enum über _nullableEnum bauen');
});

// Builder, die nur mit Fach-Argumenten (z.B. Stufen-Liste) ein Enum erzeugen,
// erreicht der Lauf oben nicht — darum zusätzlich die Quelltexte.
test('kein Enum neben einem Typ-Array im Quelltext der Prompts', () => {
  const pattern = /type:\s*\[[^\]]*\][^{}\n]*\benum\s*:/;
  const hits = listJs(PROMPTS)
    .flatMap((file) => readFileSync(file, 'utf8').split('\n')
      .map((line, i) => (pattern.test(line) ? `${relative(ROOT, file)}:${i + 1}` : null))
      .filter(Boolean));
  assert.deepEqual(hits, []);
});
