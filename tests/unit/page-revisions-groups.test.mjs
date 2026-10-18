// Sitzungs-Gruppierung + Summary-Deutung der Revisionsliste
// (public/js/page-revisions-groups.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRevisions, summaryInfo, SESSION_GAP_MS } from '../../public/js/page-revisions-groups.js';

const T0 = Date.parse('2026-06-01T12:00:00.000Z');
let nextId = 1;
function rev(minAgo, extra = {}) {
  return {
    id: nextId++, source: 'main', user_email: 'a@x.test', client: 'Firefox · Linux',
    summary: null, pinned: 0, created_at: new Date(T0 - minAgo * 60_000).toISOString(), ...extra,
  };
}

test('groupRevisions: Autosaves einer Sitzung buendeln, Luecke trennt', () => {
  const list = [rev(0), rev(2), rev(5), rev(30), rev(31)];
  const groups = groupRevisions(list);
  assert.deepEqual(groups.map(g => g.items.length), [3, 2]);
  assert.equal(groups[0].key, list[0].id, 'Kopf = juengster Stand');
});

test('groupRevisions: anderer User, Client oder Aktions-Quelle steht allein', () => {
  const list = [
    rev(0), rev(1, { user_email: 'b@x.test' }), rev(2, { user_email: 'b@x.test', client: 'Mac-App' }),
    rev(3, { source: 'chat-apply' }), rev(4), rev(5, { source: 'focus' }),
  ];
  assert.deepEqual(groupRevisions(list).map(g => g.items.length), [1, 1, 1, 1, 2]);
});

test('groupRevisions: angeheftet oder mit Summary bricht die Sitzung', () => {
  const list = [rev(0), rev(1, { pinned: 1 }), rev(2), rev(3, { summary: 'baseline' }), rev(4)];
  assert.deepEqual(groupRevisions(list).map(g => g.items.length), [1, 1, 1, 1, 1]);
});

test('groupRevisions: Luecke genau am Deckel gehoert noch dazu', () => {
  const gapMin = SESSION_GAP_MS / 60_000;
  assert.equal(groupRevisions([rev(0), rev(gapMin)]).length, 1);
  assert.equal(groupRevisions([rev(0), rev(gapMin + 1)]).length, 2);
});

test('summaryInfo: Server-Formate', () => {
  assert.deepEqual(summaryInfo('baseline'), { kind: 'baseline', revId: null });
  assert.deepEqual(summaryInfo('before split'), { kind: 'beforeSplit', revId: null });
  assert.deepEqual(summaryInfo('restored from #42'), { kind: 'restore', revId: 42 });
  assert.equal(summaryInfo('split → #7'), null);
  assert.equal(summaryInfo(null), null);
});
