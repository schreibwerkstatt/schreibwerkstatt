// Vorschlags-Zustände des Abschnitts-Chats (public/js/chat/page-chat-marks.js
// #_refreshVorschlagStates): nicht gefunden vs. veraltet vs. mehrdeutig, und
// „übernommen" wird wieder offen, wenn der Text zurück ist (Strg+Z/Abbrechen).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageChatMarksMethods } from '../../public/js/chat/page-chat-marks.js';

function card(html, vorschlaege) {
  globalThis.window = { __app: { editMode: false, originalHtml: html, updatePageView() {} } };
  const patches = [];
  const c = {
    chatMessages: [{ id: 7, role: 'assistant', vorschlaege }],
    _patchChatVorschlag: (msgId, vIdx, action, body) => patches.push({ msgId, vIdx, action, body }),
    ...pageChatMarksMethods,
  };
  c._refreshVorschlagStates();
  return { v: c.chatMessages[0].vorschlaege, patches };
}

test('nicht gefunden (Server-match) ist nicht „veraltet"; mehrdeutig eigener Zustand', () => {
  const { v } = card('<p>Er kam. Er kam. Sie ging.</p>', [
    { original: 'nirgends', ersatz: 'x', match: 'not_found' },
    { original: 'war einmal da', ersatz: 'x' },
    { original: 'Er kam.', ersatz: 'Er lief.' },
    { original: 'Sie ging.', ersatz: 'Sie lief.' },
  ]);
  assert.deepEqual(v.map(x => [!!x._notFound, !!x._stale, !!x._ambiguous]), [
    [true, false, false], [false, true, false], [false, false, true], [false, false, false],
  ]);
});

test('übernommen, Ersatz weg und Original wieder da → wieder offen + PATCH applied:false', () => {
  const { v, patches } = card('<p>Der Hund bellt laut.</p>', [
    { original: 'bellt laut', ersatz: 'bellt leise', applied: true, applied_at: 'x' },
  ]);
  assert.equal(v[0]._applied, false);
  assert.equal(v[0].applied, undefined);
  assert.deepEqual(patches, [{ msgId: 7, vIdx: 0, action: 'applied', body: { applied: false } }]);
});

test('übernommen und Ersatz steht da → bleibt übernommen, rückgängig-fähig', () => {
  const { v, patches } = card('<p>Der Hund bellt leise.</p>', [
    { original: 'bellt laut', ersatz: 'bellt leise', applied: true },
  ]);
  assert.equal(v[0]._applied, true);
  assert.equal(v[0]._undoable, true);
  assert.equal(patches.length, 0);
});

test('Original steckt im Ersatz → kein Wiederöffnen (Rest einer späteren Bearbeitung)', () => {
  const { v, patches } = card('<p>Ein Haus steht da.</p>', [
    { original: 'Haus', ersatz: 'grosses Haus', applied: true },
  ]);
  assert.equal(v[0]._applied, true);
  assert.equal(patches.length, 0);
});

test('Rückgängig-Fähigkeit trotz Anführungszeichen-Normalisierung nach dem Übernehmen', () => {
  const { v } = card('<p>Sie rief: «Komm», und ging.</p>', [
    { original: 'sagte: "Komm"', ersatz: 'rief: "Komm"', applied: true },
  ]);
  assert.equal(v[0]._applied, true);
  assert.equal(v[0]._undoable, true);
});
