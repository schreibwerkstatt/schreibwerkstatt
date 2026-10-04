#!/usr/bin/env node
'use strict';
// PostToolUse-Hook (Edit|Write|MultiEdit): erinnert an die drift-gateten
// Folge-Artefakte, die laut CLAUDE.md im selben Commit mitgepflegt werden
// muessen — sonst wird der zugehoerige Drift-Test in CI rot bzw. eine Metrik
// erscheint nie in Home Assistant. Reine Reminder (kein Auto-Regen), weil
// squash:regen bei Recreate-Migrationen FORCE_LEGACY_MIGRATIONS=1 braucht und
// docs/erd.md + die HA-Configs handgepflegt sind. No-op + still bei anderen
// Dateien.
//   • db/migrations.js          → squash:regen + docs/erd.md
//   • db/squashed-schema.js     → docs/erd.md
//   • lib/metrics/defs.js       → docs/homeassistant/* + metrics.name.* (i18n)
//   • public/css/**.css (neu)   → DESIGN.md „CSS-File-Inventar" + index.html
//                                 (gegated durch design-css-inventory-drift.test)
//   • public/partials/*.html (neu, unverdrahtet) → Wiring + ggf. DESIGN.md-Pattern
// Die CSS-/Partial-Zweige sind selbst-loeschend: sie feuern nur, solange das
// Artefakt fehlt — nicht bei Edits an bereits dokumentierten/verdrahteten Dateien.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let fp = '';
  try {
    fp = (JSON.parse(raw || '{}').tool_input || {}).file_path || '';
  } catch {
    process.exit(0);
  }
  if (!fp) process.exit(0);

  const p = fp.split(path.sep).join('/');
  const reminders = [];

  if (/\/db\/migrations\.js$/.test(p)) {
    reminders.push(
      'db/migrations.js bearbeitet → vor dem Commit:',
      '  • npm run squash:regen  (Recreate-Migration? dann FORCE_LEGACY_MIGRATIONS=1 npm run squash:regen) — sonst squash-drift.test rot',
      '  • docs/erd.md aktualisieren (Stand-Zeile: Schema-Version + Tabellen-Anzahl, betroffene Bloecke/FK-Kanten) — sonst erd-drift.test rot',
    );
  } else if (/\/db\/squashed-schema\.js$/.test(p)) {
    reminders.push(
      'db/squashed-schema.js bearbeitet → docs/erd.md im selben Commit aktualisieren (sonst erd-drift.test rot).',
    );
  }

  // Neue projekteigene CSS-Datei (nicht vendor) → muss ins „CSS-File-Inventar"
  // von DESIGN.md. Selbst-loeschend: feuert nur, solange die (public/css/…)-
  // Referenz im Inventar fehlt — bei Edits an bereits dokumentierten Files still.
  const cssMatch = p.match(/\/public\/(css\/.+\.css)$/);
  if (cssMatch) {
    let design = '';
    try { design = fs.readFileSync(path.join(ROOT, 'DESIGN.md'), 'utf8'); } catch { /* ignore */ }
    if (design && !design.includes(`(public/${cssMatch[1]})`)) {
      reminders.push(
        `Neue CSS-Datei public/${cssMatch[1]} ist noch nicht im „CSS-File-Inventar" von DESIGN.md →`,
        '  • eine Inventar-Zeile im passenden Abschnitt ergaenzen (Datei-Link + Inhalt)',
        '  • Datei als <link> in public/index.html einhaengen (Cascade-Order = Lade-Order)',
        '  • sonst wird design-css-inventory-drift.test rot',
      );
    }
  }

  // Neues Partial → ggf. neues UI-Pattern, das laut Regel „UI-Patterns nur aus
  // DESIGN.md" dokumentiert gehoert. Selbst-loeschend: feuert nur, solange das
  // Partial nirgends (ausser in sich selbst) als partial-<name>/@include <name>
  // verdrahtet ist — also genau bei brandneuen, noch nicht eingebundenen Partials.
  const partialMatch = p.match(/\/public\/partials\/(.+)\.html$/);
  if (partialMatch) {
    const name = partialMatch[1];
    const selfFile = path.join(ROOT, 'public', 'partials', `${name}.html`);
    let wired = false;
    try {
      const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
      if (idx.includes(`partial-${name}`)) wired = true;
    } catch { /* ignore */ }
    if (!wired) {
      try {
        const dir = path.join(ROOT, 'public', 'partials');
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.html')) continue;
          const full = path.join(dir, f);
          if (full === selfFile) continue; // Selbstreferenz im @include-Doku-Kommentar ignorieren
          const txt = fs.readFileSync(full, 'utf8');
          if (txt.includes(`partial-${name}`) || txt.includes(`@include ${name}`)) { wired = true; break; }
        }
      } catch { /* ignore */ }
    }
    if (!wired) {
      reminders.push(
        `Neues Partial public/partials/${name}.html (noch nirgends als partial-${name}/@include ${name} verdrahtet) →`,
        '  • via <div id="partial-' + name + '"> in index.html/ein Eltern-Partial einbinden (oder <!-- @include ' + name + ' --> im Template)',
        '  • bringt es ein neues UI-Pattern? → erst in DESIGN.md dokumentieren (Markup + CSS-Datei + Use-Case), dann verwenden (Regel „UI-Patterns nur aus DESIGN.md")',
      );
    }
  }

  if (/\/lib\/metrics\/defs\.js$/.test(p)) {
    reminders.push(
      'lib/metrics/defs.js bearbeitet → bei neuer /metrics-Kennzahl im selben Commit ergaenzen:',
      '  • metrics.name.<name> in public/js/i18n/{de,en}.json (Anzeigename in /metrics.json)',
      '  • docs/homeassistant/configuration.yaml (REST-Sensor + ggf. abgeleiteter template:-Sensor)',
      '  • docs/homeassistant/dashboard.yaml (Dashboard-Kachel)',
      '  • docs/homeassistant/README.md (Sensor-Uebersicht)',
    );
  }

  if (reminders.length) {
    console.log('[drift-reminder] ' + reminders.join('\n'));
  }
  process.exit(0);
});
