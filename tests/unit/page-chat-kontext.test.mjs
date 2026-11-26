// Abschnitts-Chat, Zusatzkontext: Zeitstrahl des Buchs und Kontinuitäts-Befunde des
// Kapitels in Block 1 (kapitel-stabil), offene Ideen im übrigen Buch in Block 2
// (nach Lage zum Abschnitt). Jeder Block hat einen Deckel aus dem Kontextfenster —
// ein kleines lokales Modell bekommt weniger, und was fehlt, steht im Prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { buildChatSystemPrompt } = await import('../../public/js/prompts.js');
const {
  buildPageChatZeitstrahlLines, buildPageChatKontinuitaetLines, buildPageChatBuchIdeenLines, buildPageChatSzenenLines,
} = await import('../../public/js/prompts/page-chat-kontext.js');
const require = createRequire(import.meta.url);
const { pageChatKontextCaps } = require('../../routes/jobs/chat/page-chat-context.js');

const ev = (i, imKapitel = false) => ({
  datum: `2024-12-${String(i).padStart(2, '0')}`, ereignis: `Ereignis ${i} `.repeat(4),
  kapitel: [`Kapitel ${i}`], figuren: ['Lilli'], imKapitel,
});

test('Zeitstrahl: alle Ereignisse in Reihenfolge, ohne Kappungs-Hinweis', () => {
  const lines = buildPageChatZeitstrahlLines([ev(1), ev(2)], { maxChars: 10000 });
  assert.match(lines[0], /ZEITSTRAHL DES BUCHS/);
  assert.ok(lines.join('\n').indexOf('Ereignis 1') < lines.join('\n').indexOf('Ereignis 2'));
  assert.ok(!lines.join('\n').includes('NUR '));
});

test('Zeitstrahl über dem Deckel: Kapitel-Ereignisse zuerst, Kappung ausgewiesen, Reihenfolge bleibt', () => {
  const list = Array.from({ length: 30 }, (_, i) => ev(i + 1, i === 25));
  const lines = buildPageChatZeitstrahlLines(list, { maxChars: 600 });
  const text = lines.join('\n');
  assert.match(text, /NUR \d+ von 30 Ereignissen/);
  assert.ok(text.includes('Ereignis 26'), 'Ereignis des Kapitels bleibt');
  assert.ok(text.includes('Ereignis 1 '), 'danach die frühesten');
  const body = lines.slice(2, -1);
  assert.ok(body.join('\n').length <= 600);
});

test('Kontinuität: schwerste zuerst beim Kappen, leer → kein Block', () => {
  assert.deepEqual(buildPageChatKontinuitaetLines([]), []);
  const issues = [
    { schwere: 'niedrig', beschreibung: 'Bettseite '.repeat(10) },
    { schwere: 'kritisch', beschreibung: 'Name der Tochter '.repeat(5) },
  ];
  const text = buildPageChatKontinuitaetLines(issues, { maxChars: 120 }).join('\n');
  assert.ok(text.includes('Name der Tochter'));
  assert.ok(!text.includes('Bettseite'));
  assert.match(text, /NUR 1 von 2 Befunden/);
});

test('Buch-Ideen: nach Lage gruppiert, beim Kappen die nächstgelegenen', () => {
  const ideen = [
    { content: 'Weihnachten beim Vater: Auflösung', ort: 'Weihnachten', lage: 'spaeter', abstand: 1, index: 12 },
    { content: 'Sarah im Möbelhaus', ort: 'Kapitel 6', lage: 'frueher', abstand: 4, index: 6 },
    { content: 'Rigi-Ausflug planen '.repeat(6), ort: 'Kapitel 14', lage: 'spaeter', abstand: 9, index: 20 },
    { content: 'Titel des Buchs klären', ort: null, lage: 'buch', abstand: Infinity, index: Infinity },
  ];
  const all = buildPageChatBuchIdeenLines(ideen, { maxChars: 10000 }).join('\n');
  assert.ok(all.indexOf('Frühere Teile') < all.indexOf('Sarah im Möbelhaus'));
  assert.ok(all.indexOf('Spätere Teile') < all.indexOf('Weihnachten beim Vater'));
  assert.ok(all.indexOf('Weihnachten beim Vater') < all.indexOf('Rigi-Ausflug'), 'Lesereihenfolge innerhalb der Gruppe');
  assert.match(all, /Ohne Ort[\s\S]*Titel des Buchs/);
  assert.match(all, /Nicht Ziel von ideen_aenderungen/);
  const capped = buildPageChatBuchIdeenLines(ideen, { maxChars: 90 }).join('\n');
  assert.ok(capped.includes('Weihnachten beim Vater'));
  assert.ok(!capped.includes('Rigi-Ausflug'));
  assert.match(capped, /NUR \d+ von 4 Ideen/);
});

test('System-Prompt: Zeitstrahl/Kontinuität in Block 1, Buch-Ideen in Block 2', () => {
  const blocks = buildChatSystemPrompt('A', 'Text', [], null, null, null, null, null, {
    zeitstrahl: [ev(1)],
    kontinuitaet: [{ schwere: 'mittel', beschreibung: 'Wochentag passt nicht' }],
    buchIdeen: [{ content: 'Sarah im Möbelhaus', ort: 'Kapitel 6', lage: 'frueher', abstand: 1, index: 1 }],
    kontextMaxChars: { zeitstrahl: 5000, kontinuitaet: 5000, ideen: 5000 },
  });
  assert.match(blocks[0].text, /ZEITSTRAHL DES BUCHS[\s\S]*KONTINUITÄTS-BEFUNDE/);
  assert.ok(!blocks[0].text.includes('Sarah im Möbelhaus'));
  assert.match(blocks[1].text, /OFFENE IDEEN IM ÜBRIGEN BUCH[\s\S]*Sarah im Möbelhaus/);
});

test('Deckel: Anteil am Budget mit Boden und Decke', () => {
  const klein = pageChatKontextCaps({ inputBudgetChars: 40000 });
  assert.equal(klein.zeitstrahl, 2000);
  assert.equal(klein.kontinuitaet, 1200);
  const winzig = pageChatKontextCaps({ inputBudgetChars: 1000 });
  assert.equal(winzig.ideen, 1500);
  const gross = pageChatKontextCaps({ inputBudgetChars: 3_000_000 });
  assert.deepEqual(gross, { zeitstrahl: 30000, kontinuitaet: 12000, ideen: 30000, szenen: 30000 });
});

test('Frühere Szenen: Lesereihenfolge, nahe zuerst beim Kappen, in Block 2', () => {
  const szenen = [
    { titel: 'Pizzaabend: Lilli beichtet die Nacht', ort: 'Kapitel 1', figuren: ['Lilli', 'Marie'], abstand: 9, index: 1 },
    { titel: 'Sarah im Möbelhaus', ort: 'Kapitel 6', figuren: ['Lilli', 'Sarah'], abstand: 3, index: 7 },
  ];
  const text = buildPageChatSzenenLines(szenen, { maxChars: 5000 }).join('\n');
  assert.ok(text.indexOf('Pizzaabend') < text.indexOf('Sarah im Möbelhaus'));
  assert.match(text, /\[Kapitel 6\] Sarah im Möbelhaus \(Lilli, Sarah\)/);
  const capped = buildPageChatSzenenLines(szenen, { maxChars: 50 }).join('\n');
  assert.ok(capped.includes('Sarah im Möbelhaus') && !capped.includes('Pizzaabend'));
  assert.match(capped, /NUR 1 von 2 Szenen/);
  const blocks = buildChatSystemPrompt('A', 'Text', [], null, null, null, null, null, { szenen, kontextMaxChars: { szenen: 5000 } });
  assert.ok(!blocks[0].text.includes('FRÜHERE SZENEN'));
  assert.match(blocks[1].text, /FRÜHERE SZENEN MIT FIGUREN DIESES ABSCHNITTS/);
});
