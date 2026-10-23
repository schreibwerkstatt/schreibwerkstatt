// Die Screenshots der Landing-Page: eine Aufnahme je Feature-Kachel, und
// jede Datei existiert tatsächlich.
//
// Warum ein Gate: public/landing.html verweist auf public/img/landing/*.webp.
// Fehlt eine Datei, zeigt die Kachel ein leeres Bild — auf einer Seite, die
// ohne Anmeldung jeder sieht. Der Verweis ist im HTML hart kodiert (es sind
// Assets, keine Inhalte), also kann ihn hier nichts auflösen; dieser Test
// prüft stattdessen, dass jede Referenz eine Datei trifft.
//
// Erzeugt werden die Bilder mit `npm run shots:landing`
// (scripts/landing-shots.js). Der Test liest ausserdem die echten Bildmasse:
// das Skript muss exakt 920 × 614 liefern, wie das Markup behauptet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'landing.html'), 'utf8');
const IMG_DIR = path.join(ROOT, 'public', 'img', 'landing');

/** Die Bildverweise je Feature-Kachel: [src, alt]. */
const shots = [...HTML.matchAll(/<img class="public-feature-shot"[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/g)]
  .map(m => ({ src: m[1], alt: m[2] }));

/** Die Nummern der gerenderten Feature-Kacheln (Reihenfolge = Nummer). */
const featNumbers = [...HTML.matchAll(/<h3>\{\{feat(\d+)Title\}\}<\/h3>/g)].map(m => Number(m[1]));

test('Landing-Screenshots: je Feature-Kachel genau ein Screenshot', () => {
  assert.ok(featNumbers.length > 0, 'landing.html rendert keinen Feature-Block');
  assert.equal(shots.length, featNumbers.length,
    `Es sind ${shots.length} Screenshots für ${featNumbers.length} Feature-Kacheln — ` +
    'die Kacheln und die Bilder müssen gleich viele sein');
});

test('Landing-Screenshots: jede Datei existiert und liegt unter /img/landing/', () => {
  const missing = [];
  for (const s of shots) {
    assert.ok(s.src.startsWith('/img/landing/'),
      `Screenshot-Pfad muss unter /img/landing/ liegen (pre-auth ausgeliefert): ${s.src}`);
    const file = path.join(ROOT, 'public', s.src.replace(/^\//, ''));
    if (!fs.existsSync(file)) missing.push(s.src);
    else if (fs.statSync(file).size === 0) missing.push(`${s.src} (leer)`);
  }
  assert.deepEqual(missing, [], `Fehlende Landing-Screenshots:\n${missing.join('\n')}`);
});

test('Landing-Screenshots: die Bilder sind dekorativ (alt="")', () => {
  // Das Bild steht neben dem Kacheltitel (h3), der schon sagt, was es zeigt.
  // Ein Alt-Text mit demselben Titel liesse den Screenreader jeden Titel
  // zweimal vorlesen; ein Dateiname («schreiben.webp») waere schlimmer.
  for (let i = 0; i < shots.length; i++) {
    assert.equal(shots[i].alt, '', `Screenshot ${i + 1} (${shots[i].src}): alt muss leer sein`);
  }
});

test('Landing-Screenshots: die Bilder sind 3:2 (Kachelbild, kein Ausschnitt-Verhältnis)', () => {
  // Das Seitenverhältnis entscheidet über das Layout: die Kachel gibt dem
  // Bild eine feste Höhe. Ein anderes Verhältnis würde die Bilder verzerren
  // (object-fit: cover schneidet, nicht verzerrt — der Test sichert die
  // Übereinstimmung mit dem CSS-Verhältnis 3/2).
  for (const s of shots) {
    const m = /width="(\d+)" height="(\d+)"/.exec(
      new RegExp(`<img class="public-feature-shot"[^>]*src="${s.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`).exec(HTML)?.[0] || ''
    );
    assert.ok(m, `Screenshot ${s.src}: width/height fehlen im Markup`);
    const ratio = Number(m[1]) / Number(m[2]);
    assert.ok(Math.abs(ratio - 1.5) < 0.01,
      `Screenshot ${s.src}: Verhältnis ${ratio.toFixed(3)} statt 3:2`);
  }
});

test('Landing: das Prinzip «Die KI schreibt nicht für dich» steht in beiden Locales', () => {
  const locales = ['de', 'en'].map(l =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'js', 'i18n', `${l}.json`), 'utf8')));
  for (const [i, dict] of locales.entries()) {
    const locale = i === 0 ? 'de' : 'en';
    assert.ok(dict['landing.principleTitle'], `${locale}: landing.principleTitle fehlt`);
    assert.ok(dict['landing.principleText'], `${locale}: landing.principleText fehlt`);
    assert.ok(dict['landing.principleTitle'].length > 10, `${locale}: Titel zu kurz`);
    assert.ok(dict['landing.principleText'].length > 80, `${locale}: Text zu kurz`);
  }
  // Der Titel steht in der Seite — sonst ist der Text eine tote i18n-Zeile.
  assert.ok(HTML.includes('{{principleTitle}}'), 'landing.html rendert {{principleTitle}} nicht');
  assert.ok(HTML.includes('{{principleText}}'), 'landing.html rendert {{principleText}} nicht');
});

test('Landing-Screenshots: jede Datei ist tatsächlich 920 × 614 (wie im Markup)', async () => {
  // Das Markup kündigt width/height an; eine schmalere Datei als angekündigt
  // skaliert der Browser still hoch (unscharf) oder lässt sie im Rahmen
  // schwimmen. Darum die Masse der Datei selbst lesen, nicht nur das Markup.
  const wrong = [];
  for (const s of shots) {
    const tag = new RegExp(`<img class="public-feature-shot"[^>]*src="${s.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`).exec(HTML)?.[0] || '';
    const m = /width="(\d+)" height="(\d+)"/.exec(tag);
    const file = path.join(ROOT, 'public', s.src.replace(/^\//, ''));
    if (!m || !fs.existsSync(file)) continue; // decken die Tests oben ab
    const { width, height } = await sharp(file).metadata();
    if (width !== 920 || height !== 614) wrong.push(`${s.src}: Datei ${width}×${height} statt 920×614`);
    else if (width !== Number(m[1]) || height !== Number(m[2])) wrong.push(`${s.src}: Markup ${m[1]}×${m[2]}, Datei ${width}×${height}`);
  }
  assert.deepEqual(wrong, [], `Landing-Screenshots mit falschen Massen (npm run shots:landing):\n${wrong.join('\n')}`);
});
