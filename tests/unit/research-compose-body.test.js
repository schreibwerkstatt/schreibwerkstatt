'use strict';
// routes/research-scrape.js#composeBody — Dubletten-Regel der Beschreibung:
// kurze Beschreibungen nur, wenn der Text mit ihnen beginnt; lange auch, wenn
// sie irgendwo im Text stehen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { composeBody } = require('../../routes/research-scrape.js');

test('kurze Beschreibung irgendwo im Text ist KEINE Dublette', () => {
  const text = 'Ein langer Artikel ueber Olten. Zurueck zur Startseite.';
  assert.equal(composeBody('Startseite', text), `Startseite\n\n${text}`);
});

test('kurze Beschreibung am Textanfang ist eine Dublette', () => {
  const text = 'Startseite der Stadt Olten mit allen Neuigkeiten.';
  assert.equal(composeBody('Startseite', text), text);
});

test('lange Beschreibung mitten im Text ist eine Dublette', () => {
  const desc = 'Im Keller des alten Stadthauses lagen die Akten ueber hundert Jahre unberuehrt';
  const text = `Vorspann. ${desc}, bis ein Archivar sie fand.`;
  assert.equal(composeBody(desc, text), text);
});

test('lange Beschreibung, deren Anfang den Text eroeffnet, ist eine Dublette', () => {
  const desc = 'Im Keller des alten Stadthauses lagen die Akten ueber hundert Jahre … weiterlesen';
  const text = 'Im Keller des alten Stadthauses lagen die Akten ueber hundert Jahre, bis jemand kam.';
  assert.equal(composeBody(desc, text), text);
});
