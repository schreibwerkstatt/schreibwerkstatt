// Die Lektorat-Regeln aus prompt-config.json `commonRules` (GRUNDREGEL «nur zweifelsfrei
// Falsches melden» + Meldekatalog «WAS GEMELDET WERDEN SOLL») gehören ausschliesslich an
// den Lektorat-Prompt. An Chat-, Bewertungs-, Analyse- und Extraktions-Prompts
// widersprachen sie deren Auftrag (Chat: Stilvorschläge machen; Struktur-Check: «Sprache,
// Rechtschreibung und Stil sind nicht dein Thema»; Stilprofil: «ohne zu werten»).
// Die Sprachnorm der Locale (baseRules) bekommt jeder Prompt weiterhin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(new URL('../../prompt-config.json', import.meta.url), 'utf8'));
const prompts = await import('../../public/js/prompts.js');

const COMMON_MARKERS = {
  cloud: ['GRUNDREGEL: Nur eindeutig, zweifelsfrei und ohne Einschränkung', 'WAS GEMELDET WERDEN SOLL'],
  local: ['GRUNDREGEL: Nur eindeutig, zweifelsfrei falsche Stellen melden'],
};
const ORTHO_MARKER = 'SCHWEIZER SCHRIFTDEUTSCH';

function systemPrompts(p) {
  return Object.entries(p).filter(([k, v]) => k.startsWith('SYSTEM_') && typeof v === 'string' && v);
}

for (const [cls, provider] of [['cloud', 'claude'], ['local', 'ollama']]) {
  test(`${cls}: commonRules nur im Lektorat-Prompt, Sprachnorm überall`, () => {
    prompts.configurePrompts(cfg, provider);
    const p = prompts.getLocalePromptsForBook('de-CH', 'roman', null, false);
    for (const m of COMMON_MARKERS[cls]) assert.ok(p.SYSTEM_LEKTORAT.includes(m), `SYSTEM_LEKTORAT trägt «${m}»`);
    const others = systemPrompts(p).filter(([k]) => !k.startsWith('SYSTEM_LEKTORAT'));
    assert.ok(others.length > 10, 'genug Prompts geprüft');
    for (const [k, v] of others) {
      for (const m of COMMON_MARKERS[cls]) assert.ok(!v.includes(m), `${k} trägt die Lektorat-Regel «${m}»`);
    }
    for (const k of ['SYSTEM_CHAT', 'SYSTEM_BOOK_CHAT', 'SYSTEM_BUCHBEWERTUNG', 'SYSTEM_STRUKTUR', 'SYSTEM_KOMPLETT_EXTRAKTION']) {
      assert.ok(p[k].includes(ORTHO_MARKER), `${k} behält die Sprachnorm`);
    }
  });
}

test('Lektorat-Prompt: Sprachnorm, commonRules und Autorenstil in dieser Reihenfolge', () => {
  prompts.configurePrompts(cfg, 'claude');
  const s = prompts.getLocalePromptsForBook('de-CH', 'roman', null, false).SYSTEM_LEKTORAT;
  const i = (m) => s.indexOf(m);
  assert.ok(i(ORTHO_MARKER) >= 0 && i(ORTHO_MARKER) < i('GRUNDREGEL') && i('GRUNDREGEL') < i('AUTORENSTIL IMITIEREN'));
});

test('Abschnitts-Chat behält die Autorenstil-Regel, Buch-Chat bekommt sie nicht', () => {
  prompts.configurePrompts(cfg, 'claude');
  const p = prompts.getLocalePromptsForBook('de-CH', 'roman', null, false);
  assert.ok(p.SYSTEM_CHAT.includes('AUTORENSTIL IMITIEREN'));
  assert.ok(!p.SYSTEM_BOOK_CHAT.includes('AUTORENSTIL IMITIEREN'));
});
