// Gate fuer das Schliessen von Panels (DESIGN.md „Panel schliessen",
// public/CLAUDE.md): ein Panel, eine Box oder ein Banner, das sich wegklicken
// laesst (KI-Vorschlaege, Export-Befunde, Hinweis-Banner, Onboarding-Karte),
// schliesst ueber ein ×-Icon oben rechts — `icon-btn icon-btn--ghost` in der
// Kopfzeile (`.card-section-head` o. ae.) bzw. `btn-card-close` im Kartenkopf —,
// nie ueber einen Text-Knopf («Ausblenden», «Vorschläge schliessen»). Der Text
// wandert in `data-tip` + `aria-label`.
//
// Geprueft wird ein Eigenbau-Signal: ein `<button>` mit `x-text`, dessen
// i18n-Key nach Schliessen/Ausblenden heisst (`….dismiss`, `….close`,
// `….closePanel`, `….hide`, `common.close`, `common.hide`). Wer so einen Knopf
// braucht, weil er KEIN Panel schliesst (Entscheidung je Eintrag, Umschalter,
// Dialog-Fuss), traegt ihn mit Begruendung in ALLOWED ein.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const rel = (p) => relative(REPO_ROOT, p);

// `datei|key` → Begruendung.
const ALLOWED = new Map([
  ['public/partials/admin-settings-api.html|common.hide', 'Einmal-Anzeige eines API-Tokens: ausgeschriebenes «Verbergen», damit das Geheimnis nicht versehentlich weggeklickt wird'],
  ['public/partials/user-settings-devices.html|common.hide', 'Einmal-Anzeige eines Geräte-Tokens (wie Admin-API-Token)'],
  ['public/partials/buchlandkarte-redundanz.html|redundanz.dismiss', 'Entscheidung je Paar («Ignorieren»), schliesst kein Panel'],
  ['public/partials/ideen-check-hint.html|ideen.check.dismiss', 'Antwort «Noch offen» neben «Erledigt», schliesst kein Panel'],
  ['public/partials/kontinuitaet-issue.html|kontinuitaet.dismiss', 'Entscheidung je Befund (Umschalter mit undismiss)'],
  ['public/partials/editor-findings.html|evidence.close', 'Umschalter Suchen/Schliessen am Befund, kein eigenes Panel'],
  ['public/partials/page-revisions-viewer.html|editor.revisions.viewer.close', 'Fusszeile eines nativen <dialog>; × im Kopf ist zusätzlich da'],
  ['public/index.html|common.close', 'Fusszeile des Offline-Rettungs-Dialogs; × im Kopf ist zusätzlich da'],
  ['public/index.html|onboarding.welcome.dismiss', 'Banner-Paar Aktion + «Nicht mehr anzeigen» (dauerhaft, nicht nur schliessen)'],
]);

const CLOSE_KEY = /(?:^|\.)(?:dismiss|close|closePanel|hide)$/;

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const htmlFiles = () => [...walk(PARTIALS_DIR, '.html'), INDEX_HTML];

function findTextCloseButtons() {
  const hits = [];
  for (const file of htmlFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<button\b[^>]*>/gs)) {
      const xText = m[0].match(/\bx-text="([^"]*)"/);
      if (!xText) continue;
      for (const k of xText[1].matchAll(/'(\w+(?:\.\w+)+)'/g)) {
        if (!CLOSE_KEY.test(k[1])) continue;
        const line = src.slice(0, m.index).split('\n').length;
        hits.push({ id: `${rel(file)}|${k[1]}`, where: `${rel(file)}:${line}` });
      }
    }
  }
  return hits;
}

test('Panels schliessen per ×-Icon, nicht per Text-Knopf', () => {
  const bad = findTextCloseButtons()
    .filter((h) => !ALLOWED.has(h.id))
    .map((h) => `${h.where} — Text-Knopf mit Schliessen-Key (${h.id.split('|')[1]}); `
      + '× als icon-btn icon-btn--ghost oben rechts, Text in data-tip/aria-label');
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('Allowlist enthält keine toten Einträge', () => {
  const seen = new Set(findTextCloseButtons().map((h) => h.id));
  const stale = [...ALLOWED.keys()].filter((id) => !seen.has(id));
  assert.deepEqual(stale, [], `Nicht mehr gefunden, aus ALLOWED streichen: ${stale.join(', ')}`);
});
