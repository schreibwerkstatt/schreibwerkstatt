// Analyse-Block des Lektorats (public/js/editor/lektorat-analysis.js) — SSoT
// für frischen Lauf und Verlaufseintrag. Gate: Badges/Überschriften kommen aus
// i18n (keine deutschen Literale), KI-Felder sind escaped (x-html-Sink).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderLektoratAnalysisHtml } from '../../public/js/editor/lektorat-analysis.js';

const en = JSON.parse(readFileSync(new URL('../../public/js/i18n/en.json', import.meta.url), 'utf8'));
const t = (k) => en[k] ?? k;

test('Badges und Überschriften sind übersetzt', () => {
  const html = renderLektoratAnalysisHtml(t, {
    szenen: [{ wertung: 'stark', titel: 'A' }, { wertung: 'schwach', titel: 'B' }, { wertung: '??', titel: 'C' }],
    stilanalyse: 'S', fazit: 'F',
  });
  assert.ok(html.includes(`badge-ok">${en['szenen.rating.stark']}<`));
  assert.ok(html.includes(`badge-err">${en['szenen.rating.schwach']}<`));
  assert.ok(html.includes(`badge-warn">${en['szenen.rating.mittel']}<`));
  assert.ok(html.includes(en['lektorat.section.szenen']));
  assert.ok(html.includes(en['lektorat.section.stilanalyse']));
  assert.ok(!/>(stark|schwach|mittel|Szenen|Stilanalyse)</.test(html), 'kein deutsches Literal');
});

test('KI-Felder werden escaped', () => {
  const html = renderLektoratAnalysisHtml(t, {
    szenen: [{ wertung: 'stark', titel: '<img onerror=x>', kommentar: '<b>k</b>' }],
    stilanalyse: '<script>', fazit: '"&<',
  });
  assert.ok(!html.includes('<img') && !html.includes('<script>') && !html.includes('<b>'));
});

test('leere Eingabe → leerer String', () => {
  assert.equal(renderLektoratAnalysisHtml(t, {}), '');
  assert.equal(renderLektoratAnalysisHtml(t, { szenen: null }), '');
});
