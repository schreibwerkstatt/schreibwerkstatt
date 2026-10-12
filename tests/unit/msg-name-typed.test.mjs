// Kurzweg zum Absender (messages/msg-html.js#msgNameFromTyped): welche getippte
// Zeile «Name:» beim Enter zur Absenderzeile wird und welche Nachricht bleibt.
// Das Enter-Verhalten selbst (Undo, Seite, Focus-Ausschluss) prüft
// tests/e2e-app/notebook-msg-thread.spec.js im echten Browser.

import test from 'node:test';
import assert from 'node:assert/strict';

const { msgNameFromTyped, MSG_NAME_MAX } = await import('../../public/js/messages/msg-html.js');

test('Zeile nur aus «Name:» liefert den Namen ohne Doppelpunkt', () => {
  assert.equal(msgNameFromTyped('Anna:'), 'Anna');
  assert.equal(msgNameFromTyped('Tante Rosa:'), 'Tante Rosa');
  assert.equal(msgNameFromTyped('  Mama :  '), 'Mama');
  assert.equal(msgNameFromTyped('Jean-Luc:'), 'Jean-Luc');
  assert.equal(msgNameFromTyped('D’Artagnan:'), 'D’Artagnan');
  assert.equal(msgNameFromTyped('Dr. Graf:'), 'Dr. Graf');
  assert.equal(msgNameFromTyped('Zoë:'), 'Zoë');
  assert.equal(msgNameFromTyped('Agent 47:'), 'Agent 47');
  assert.equal(msgNameFromTyped('Anna B.:'), 'Anna B.');
});

test('Nachrichten mit Text nach dem Doppelpunkt bleiben Nachrichten', () => {
  assert.equal(msgNameFromTyped('Achtung: Zug fällt aus'), null);
  assert.equal(msgNameFromTyped('PS: bring Brot mit'), null);
  assert.equal(msgNameFromTyped('Anna: hallo'), null);
});

test('ohne Doppelpunkt am Ende, mit Satzzeichen oder ohne Buchstaben: kein Absender', () => {
  assert.equal(msgNameFromTyped('Anna'), null);
  assert.equal(msgNameFromTyped(':'), null);
  assert.equal(msgNameFromTyped(''), null);
  assert.equal(msgNameFromTyped('Wo bist du?:'), null);
  assert.equal(msgNameFromTyped('ok, gut:'), null);
  assert.equal(msgNameFromTyped('14.32:'), null);
  assert.equal(msgNameFromTyped('Anna::'), null);
  assert.equal(msgNameFromTyped('-Anna:'), null);
});

test(`höchstens ${MSG_NAME_MAX} Zeichen`, () => {
  assert.equal(msgNameFromTyped(`${'a'.repeat(MSG_NAME_MAX)}:`), 'a'.repeat(MSG_NAME_MAX));
  assert.equal(msgNameFromTyped(`${'a'.repeat(MSG_NAME_MAX + 1)}:`), null);
});
