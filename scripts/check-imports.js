#!/usr/bin/env node
'use strict';
// Import-Gate: findet Symbole, die ein Modul BENUTZT, aber nicht IMPORTIERT —
// der Fehler, der beim Aufteilen von Modulen entsteht (Symbol wandert in eine
// neue Datei, der Import bleibt zurueck) — und die Gegenrichtung: ein Import
// bzw. Namespace-Zugriff auf einen Export, den das Zielmodul nicht (mehr) hat
// (Facade vergisst beim Split den Re-Export).
//
// Geprueft werden BEIDE Haelften des Projekts, weil der Fehler in beiden
// entsteht und in beiden erst spaet auffliegt:
//   public/js  (Browser-ESM) — schlaegt erst zur Laufzeit zu, oft in einem
//              selten betretenen Codepfad, und kommt darum typischerweise erst
//              aus dem Prod-Error-Tracker zurueck.
//   server.js+logger.js+lib+db+routes (Server-CJS) — `node --check` sieht es nicht (die Datei ist
//              syntaktisch gueltig), und ein Modul laedt fehlerfrei: erst der
//              Aufruf der betroffenen Funktion wirft ReferenceError. Ein
//              Facade-Split kann so eine Domaene still zerlegen.
//
// Verfahren: `tsc` je Bereich laufen lassen und AUSSCHLIESSLICH diese Diagnosen
// auswerten:
//   TS2304 / TS2552  "Cannot find name 'x'" (ohne / mit Namensvorschlag)
//   TS2305 / TS2724  "Module has no exported member 'x'" (ohne / mit Vorschlag) —
//                    ESM-`import { x }` und destrukturiertes CJS-`require`
//   TS2339           NUR wenn der Typ ein Modul-Namespace ist
//                    ("... on type 'typeof import(...)'"): `mod.x` auf ein
//                    `require`/`import * as` ohne diesen Export. Jedes andere
//                    TS2339 ist gewoehnliches Typ-Rauschen und bleibt verworfen.
// Alle uebrigen Typfehler
// (das Projekt ist nicht getypt) werden verworfen — das hier ist kein Typecheck
// und soll keiner werden. Echte Browser-Globals (Alpine, vis, Chart) stehen in
// public/js/_globals.d.ts, JSDoc-Typnamen des Servers in _globals-server.d.ts.
//
// Exit 0 = keine fehlenden Imports. Exit 1 = Treffer oder Werkzeugfehler.

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AREAS = [
  { label: 'public/js', project: path.join(ROOT, 'public', 'js', 'tsconfig.check.json'),
    globals: 'public/js/_globals.d.ts', globalsWhat: 'ein Browser-Global' },
  { label: 'server.js + logger.js + lib + db + routes', project: path.join(ROOT, 'tsconfig.check.json'),
    globals: '_globals-server.d.ts', globalsWhat: 'ein JSDoc-Typname' },
];

// Paare ohne/mit Namensvorschlag ("Did you mean 'writeNormalSnapshot'?"):
// TypeScript waehlt je nachdem, ob ein aehnlicher Name in Reichweite ist — wer
// nur 2304 (bzw. 2305) prueft, verliert genau die Faelle mit nahem Nachbarnamen.
const MISSING_NAME_CODES = /error TS(?:2304|2552):/;
const MISSING_EXPORT_CODES = /error TS(?:2305|2724):/;
// TS2339 steht auf der ersten Zeile der Diagnose samt Typnamen; die Einschraenkung
// auf `typeof import(` haelt die ~2000 uebrigen TS2339 des ungetypten Codes raus.
const MISSING_NS_MEMBER = /error TS2339:.*typeof import\(/;
const isHit = l => MISSING_NAME_CODES.test(l) || MISSING_EXPORT_CODES.test(l) || MISSING_NS_MEMBER.test(l);

let tscBin;
try {
  // Ueber package.json + bin-Feld: TypeScript 7 gibt bin/tsc nicht in der
  // exports-Map frei, require.resolve('typescript/bin/tsc') scheitert dort.
  const pkgPath = require.resolve('typescript/package.json');
  const pkg = require(pkgPath);
  tscBin = path.join(path.dirname(pkgPath), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tsc);
} catch {
  console.error('[check-imports] typescript nicht gefunden — devDependencies fehlen. Fix: npm ci');
  process.exit(1);
}

let failed = false;
for (const area of AREAS) {
  const res = spawnSync(process.execPath, [tscBin, '-p', area.project, '--pretty', 'false'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (res.error) {
    console.error(`[check-imports] tsc liess sich nicht starten (${area.label}): ${res.error.message}`);
    process.exit(1);
  }

  const lines = `${res.stdout || ''}${res.stderr || ''}`.split('\n');

  // Konfigurationsfehler (TS5xxx/TS6xxx) melden sich ohne Datei-Prefix und wuerden
  // sonst als "keine Treffer" durchgehen — dann prueft das Gate stillschweigend
  // nichts mehr.
  const configErrors = lines.filter(l => /^error TS/.test(l));
  if (configErrors.length) {
    console.error(`[check-imports] tsc-Konfigurationsfehler (${area.label}) — das Gate hat NICHTS geprueft:`);
    for (const l of configErrors) console.error(`  ${l}`);
    process.exit(1);
  }

  const hits = lines.filter(isHit);
  if (hits.length) {
    const names = hits.filter(l => MISSING_NAME_CODES.test(l));
    const exports = hits.filter(l => !MISSING_NAME_CODES.test(l));
    if (names.length) {
      console.error(`[check-imports] ${names.length} benutzte(s) Symbol(e) ohne Import in ${area.label}:\n`);
      for (const l of names) console.error(`  ${l}`);
      console.error(`\nFix: fehlenden Import ergaenzen. Ist das Symbol wirklich ${area.globalsWhat},`);
      console.error(`gehoert es nach ${area.globals} — aber nur dann.\n`);
    }
    if (exports.length) {
      console.error(`[check-imports] ${exports.length} Zugriff(e) auf nicht vorhandene Exporte in ${area.label}:\n`);
      for (const l of exports) console.error(`  ${l}`);
      console.error(`\nFix: Export im Zielmodul ergaenzen (Facade: Re-Export vergessen?) oder den`);
      console.error(`Import auf das Modul umstellen, in das das Symbol gewandert ist.\n`);
    }
    failed = true;
    continue;
  }

  console.log(`[check-imports] OK — keine fehlenden Imports/Exporte in ${area.label}.`);
}

if (failed) process.exit(1);
