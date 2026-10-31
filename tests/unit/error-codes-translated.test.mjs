// Drift guard: jeder `error_code`, den routes/ oder lib/ als Literal verschicken,
// hat einen Text in BEIDEN Locales — `error.<CODE>` (tErrorRaw/tFetchErrorRaw in
// public/js/i18n.js) oder den Key im Namespace der Karte, die die Route bedient
// (FILE_NAMESPACES). Ohne Text zeigt das Frontend nur common.unknownError — der
// User erfährt nicht, was schiefging. Ausnahme: Programmier-/Vertragsfehler, die
// die UI nie auslöst (ALLOWLIST, je mit Begründung).
//
// Erkannt werden (Grenzen wie bei i18n-keys-defined: nur Literale):
//   - jedes UPPER_SNAKE-Literal rechts von `error_code:` / `error_code =`
//     (auch in Ternären und `|| 'FALLBACK'`)
//   - Code-Argumente der Helfer `_loadOwned`, `requireBlogTypeRoute`, `_imageErrorResponse`
//   - `disabledCode:` / `notFoundCode:` / `precheck:`-Rückgaben
//   - Fehler-Maps der Form `{ status: 4xx, code: 'X' }`
// Codes, die zur Laufzeit aus `e.code` durchgereicht werden, sieht der Test nicht.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const de = JSON.parse(readFileSync(join(ROOT, 'public/js/i18n/de.json'), 'utf8'));
const en = JSON.parse(readFileSync(join(ROOT, 'public/js/i18n/en.json'), 'utf8'));

// Route-Datei → Namespace, den ihre Karte statt `error.*` auflöst.
const FILE_NAMESPACES = {
  'routes/pdf-export.js': ['pdfExport.error'],
  'routes/jobs/pdf-export.js': ['pdfExport.error'],
  'routes/blog.js': ['blog.error'],
  'routes/hubspot.js': ['hubspot.error'],
  'routes/share/api.js': ['share.error'],
  'routes/admin-backup.js': ['admin.backup.err'],
  'routes/interview.js': ['interview.error'],
  'routes/jobs/interview.js': ['interview.error'],
  'routes/admin-usage.js': ['admin.usage.billing.error'],
};

const ID = 'Id-/Parameter-Parsing: die UI schickt die ID immer mit';
const SHAPE = 'Request-Form: die UI baut den Body fest, nur ein fremder Client trifft das';
const ALLOWLIST = {
  ACTID_REQ: ID,
  ACT_ID_REQUIRED: ID,
  BOOKID_REQ: ID,
  CHAPTER_ID_REQUIRED: ID,
  DRAFT_ID_REQ: ID,
  DRAFT_ID_REQUIRED: ID,
  FIGURE_ID_REQ: ID,
  ID_INVALID: ID,
  ID_REQUIRED: ID,
  INVALID_CHAPTER_ID: ID,
  INVALID_DELETION_ID: ID,
  INVALID_DEVICE_ID: 'Geräte-ID erzeugt der Client selbst (Save-Pipeline), nie User-Eingabe',
  INVALID_IDS: ID,
  INVALID_ISSUE_ID: ID,
  INVALID_TARGET_BOOK_ID: ID,
  INVALID_TARGET_ID: ID,
  ITEM_ID_REQUIRED: ID,
  KNOTEN_ID_REQUIRED: ID,
  MOTIF_ID_REQ: ID,
  BOOK_OR_CHAPTER_REQUIRED: ID,
  BAD_KIND: SHAPE,
  BAD_SCOPE: SHAPE,
  EMPTY_BODY: SHAPE,
  ENTITY_OR_PROFILE_REQUIRED: SHAPE,
  ENTITY_REQUIRED: SHAPE,
  FEEDBACK_INVALID: SHAPE,
  HTML_REQUIRED: SHAPE,
  INVALID_BODY: SHAPE,
  INVALID_FLAG: SHAPE,
  INVALID_INTENSITAET: 'Request-Form: Wert kommt aus fester Auswahl',
  INVALID_KEY: SHAPE,
  INVALID_LABEL: SHAPE,
  INVALID_LINK_KIND: 'Request-Form: Verknüpfungsart kommt aus fester Auswahl',
  INVALID_QUERY: SHAPE,
  INVALID_SAMPLE_BUCKET: SHAPE,
  INVALID_SCOPE: SHAPE,
  INVALID_STATUS: 'Request-Form: Status kommt aus fester Auswahl',
  ITEMS_REQUIRED: SHAPE,
  KIND_INVALID: 'Request-Form: Art kommt aus fester Auswahl',
  NOTHING_TO_UPDATE: SHAPE,
  NO_FIELDS: SHAPE,
  ORDER_REQ: SHAPE,
  PARAMS_INVALID: SHAPE,
  PINNED_REQUIRED: SHAPE,
  STATUS_INVALID: 'Request-Form: Status kommt aus fester Auswahl',
  TARGET_REQUIRED: SHAPE,
  UNKNOWN_KEY: 'Admin-Settings: Key kommt aus der Registry, nie getippt',
  VALUE_REQUIRED: SHAPE,
  VORSCHLAG_STATUS_INVALID: SHAPE,
  ZEITRAUM_REQUIRED: 'Request-Form: Zeitraum kommt aus fester Auswahl',
  INVALID_VERSION: 'Changelog-Version kommt aus der Versionsliste des Servers',
  BAD_NAME: 'Admin-Dateiname kommt aus der Server-Liste, nie getippt',
  INVALID_ANCHOR: 'Share-Reader (SSR, eigenes I18N): Anker-ID erzeugt der Reader selbst',
  INVALID_PARENT: 'Share-Kommentar: Parent-ID erzeugt die UI selbst',
  INVALID_TOKEN: 'Share-Reader (SSR, eigenes I18N): Leser-Token erzeugt der Reader selbst',
  NO_READER_TOKEN: 'Share-Reader (SSR, eigenes I18N): Leser-Token erzeugt der Reader selbst',
  NO_MESSAGE: 'Telemetrie-Endpunkt: kein UI-Text, nur Fehler-Upload',
  METRICS_COLLECT_FAILED: 'Metrics-API für Home Assistant, kein UI',
  BEARER_REQUIRED: 'Bearer-API (native Clients, Vertrag docs/clients.md), kein SPA-Text',
  INSUFFICIENT_SCOPE: 'Bearer-API (native Clients, Vertrag docs/clients.md), kein SPA-Text',
  DEVICE_SCOPE_FORBIDDEN: 'Geräte-Token (native Clients, Vertrag docs/clients.md), kein SPA-Text',
  EDITOR_API_UNSUPPORTED: 'Editor-Bundle-Vertrag der nativen Clients, kein SPA-Text',
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(c?js|mjs)$/.test(p)) out.push(p);
  }
  return out;
}

const LIT = /'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)'/g;
const PATTERNS = [
  /error_code\s*[:=]\s*(.*)$/,
  /(?:_loadOwned|requireBlogTypeRoute|_imageErrorResponse)\((.*)$/,
  /(?:disabledCode|notFoundCode)\s*:\s*(.*)$/,
  /precheck\s*:\s*(.*)$/,
  /\bstatus:\s*\d{3},\s*code:\s*(.*)$/,
];

function collectCodes() {
  const codes = new Map(); // code -> [{ rel, line }]
  for (const f of [...walk(join(ROOT, 'routes')), ...walk(join(ROOT, 'lib'))]) {
    const rel = relative(ROOT, f);
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const re of PATTERNS) {
        const m = line.match(re);
        if (!m) continue;
        for (const x of m[1].matchAll(LIT)) {
          if (!codes.has(x[1])) codes.set(x[1], []);
          codes.get(x[1]).push({ rel, line: i + 1 });
        }
      }
    });
  }
  return codes;
}

const codes = collectCodes();
const inBoth = (k) => k in de && k in en;
const translated = (code) =>
  inBoth('error.' + code) ||
  codes.get(code).every(({ rel }) => (FILE_NAMESPACES[rel] || []).some((ns) => inBoth(`${ns}.${code}`)));

test('Extraktion findet die error_code-Literale (Plausibilität)', () => {
  assert.ok(codes.size > 300, `nur ${codes.size} Codes gefunden — Muster kaputt?`);
});

test('jeder error_code aus routes/ und lib/ hat einen Text in de.json und en.json', () => {
  const missing = [...codes.keys()].filter((c) => !translated(c) && !(c in ALLOWLIST)).sort();
  const detail = missing
    .map((c) => `  ${c}  →  ${codes.get(c).slice(0, 3).map((o) => `${o.rel}:${o.line}`).join(', ')}`)
    .join('\n');
  assert.equal(
    missing.length, 0,
    `error_code ohne Übersetzung — Key \`error.<CODE>\` in de.json UND en.json ergänzen ` +
    `(Platzhalter = params der Route), oder bei reinem Programmierfehler mit Begründung ` +
    `in ALLOWLIST eintragen:\n${detail}`,
  );
});

test('ALLOWLIST ist aktuell (kein toter oder bereits übersetzter Eintrag)', () => {
  const stale = Object.keys(ALLOWLIST).filter((c) => !codes.has(c)).sort();
  assert.deepEqual(stale, [], `ALLOWLIST-Codes, die routes/ und lib/ nicht mehr verschicken: ${stale.join(', ')}`);
  const both = Object.keys(ALLOWLIST).filter((c) => codes.has(c) && translated(c)).sort();
  assert.deepEqual(both, [], `ALLOWLIST-Codes, die inzwischen übersetzt sind — aus der ALLOWLIST streichen: ${both.join(', ')}`);
});
