// buildChatSystemPrompt: offene Ideen werden als eigene Section eingespielt.
// Wenn keine Ideen vorhanden sind, darf die Section nicht erscheinen.
// Der Builder liefert ein Array von System-Cache-Blöcken ([{text, ttl?}]) — für
// die Assertions joinen wir die Block-Texte zum Gesamt-Prompt.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildChatSystemPrompt } = await import('../../public/js/prompts.js');

const joinBlocks = (blocks) => blocks.map(b => b.text).join('\n');

test('Ideen-Section: ohne Ideen kein Block', () => {
  const out = joinBlocks(buildChatSystemPrompt('Seite A', 'Inhalt.', [], null));
  assert.ok(!out.includes('OFFENE IDEEN'));
});

test('Ideen-Section: mit Ideen erscheint Block + Hinweis', () => {
  const ideen = [
    { scope: 'page',    content: 'Szene mit Storm einfügen.',          created_at: '2026-04-25T10:00:00.000Z' },
    { scope: 'chapter', content: 'Verbindung zu Kapitel 3 hinterfragen.', created_at: '2026-04-25T11:00:00.000Z' },
  ];
  const out = joinBlocks(buildChatSystemPrompt('Seite A', 'Inhalt.', [], null, null, null, ideen));
  assert.ok(out.includes('=== OFFENE IDEEN (Notizen des Autors für diesen Abschnitt + das umliegende Kapitel) ==='));
  assert.ok(out.includes('[Abschnitt] Szene mit Storm einfügen.'));
  assert.ok(out.includes('[Kapitel] Verbindung zu Kapitel 3 hinterfragen.'));
  assert.ok(out.includes('2026-04-25')); // Datum sichtbar
  assert.ok(out.includes('wandle sie aber nicht eigenmächtig in vorschlaege-Einträge'));
});

test('Ideen-Section: leeres Array erzeugt keinen Block', () => {
  const out = joinBlocks(buildChatSystemPrompt('Seite A', 'Inhalt.', [], null, null, null, []));
  assert.ok(!out.includes('OFFENE IDEEN'));
});

// Verdrahtung: der Builder allein beweist nichts — der Seiten-Chat-Job muss
// Ideen und letztes Lektorat auch LADEN und übergeben. Ohne diesen Test fiel
// die Übergabe beim Umzug in die Job-Queue unbemerkt auf `null, null`.
test('Seiten-Chat-Job übergibt offene Ideen + letztes Lektorat an den Builder', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../routes/jobs/chat/page-chat.js', import.meta.url), 'utf8');
  assert.match(src, /getOpenIdeen\(session\.page_id, userEmail\)/);
  assert.match(src, /getLatestPageCheck\(session\.page_id, userEmail\)/);
  assert.match(src, /buildChatSystemPrompt\([\s\S]*?pageChangeNote, ideen, lektorat,/);
});
