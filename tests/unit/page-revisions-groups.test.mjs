// Sitzungs-Gruppierung, Zeichen-Deltas + Summary-Deutung der Revisionsliste
// (public/js/page-revisions-groups.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRevisions, groupByDay, filterGroups, revisionDeltas, summaryInfo, SESSION_GAP_MS } from '../../public/js/page-revisions-groups.js';

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
    rev(3, { source: 'chat-apply' }), rev(4), rev(5),
  ];
  assert.deepEqual(groupRevisions(list).map(g => g.items.length), [1, 1, 1, 1, 2]);
});

test('groupRevisions: andere Quelle aus dem laufenden Schreiben bricht die Sitzung', () => {
  const list = [rev(0), rev(1), rev(2, { source: 'focus' }), rev(3, { source: 'focus' }), rev(4, { source: 'book' })];
  const groups = groupRevisions(list);
  assert.deepEqual(groups.map(g => g.items.length), [2, 2, 1]);
  for (const g of groups) assert.equal(new Set(g.items.map(r => r.source)).size, 1, 'Quelle je Sitzung gleich');
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

test('groupByDay: Sitzungen nach Tag des juengsten Saves, Reihenfolge bleibt', () => {
  const dayOf = (iso) => String(iso || '').slice(0, 10);
  const mk = (iso) => ({ key: iso, items: [{ created_at: iso }] });
  const groups = [mk('2026-06-02T08:00:00Z'), mk('2026-06-02T07:00:00Z'), mk('2026-06-01T23:00:00Z')];
  const days = groupByDay(groups, dayOf);
  assert.deepEqual(days.map(d => [d.key, d.groups.length]), [['2026-06-02', 2], ['2026-06-01', 1]]);
  assert.deepEqual(groupByDay([], dayOf), []);
});

test('revisionDeltas: erste Revision gegen leeren Stand, nur wenn nichts mehr nachzuladen', () => {
  const list = [rev(0, { chars: 130 }), rev(1, { chars: 100 }), rev(2, { chars: 40 })];
  const full = revisionDeltas(list, { hasMore: false });
  assert.equal(full.span(list[2], list[2]), 40, 'allererste Revision: gegen 0');
  assert.equal(full.span(list[0], list[2]), 130, 'Spanne bis zur ersten: ganzer Text');
  assert.equal(full.span(list[0], list[1]), 90);

  const windowed = revisionDeltas(list, { hasMore: true, older: null });
  assert.equal(windowed.span(list[2], list[2]), null, 'Vorgaengerin nur nicht geladen: kein Delta');
  assert.equal(windowed.span(list[0], list[2]), null);
  const withOlder = revisionDeltas(list, { hasMore: true, older: { id: 999, chars: 10 } });
  assert.equal(withOlder.span(list[0], list[2]), 120, 'am Fensterrand gegen `older`');

  assert.equal(full.base({ id: 12345 }), null, 'nicht in der Liste (angeheftet ausserhalb)');
});

test('revisionDeltas.sum: ohne Filter = ganzer Tag, Luecke am Fensterrand = null', () => {
  const list = [rev(0, { chars: 300 }), rev(1, { chars: 250, source: 'chat-apply' }), rev(2, { chars: 200 }), rev(3, { chars: 150 })];
  const groups = groupRevisions(list);
  assert.deepEqual(groups.map(g => g.items.length), [1, 1, 2]);
  assert.equal(revisionDeltas(list).sum(groups), 300, 'teleskopiert bis zum leeren Stand');
  assert.equal(revisionDeltas(list, { hasMore: true }).sum(groups), null);
  assert.equal(revisionDeltas(list).sum([]), null);
});

test('Filter: Sitzungen aus der Vollliste, Delta ohne fremde Saves', () => {
  const A = 'a@x.test';
  const B = 'b@x.test';
  // DESC: A schreibt, B dazwischen, A davor — A-Saves sind in der Vollliste
  // nicht zusammenhaengend und duerfen keine gemeinsame Sitzung bilden.
  const list = [
    rev(0, { user_email: A, chars: 500 }),
    rev(1, { user_email: A, chars: 480 }),
    rev(2, { user_email: B, chars: 400 }),
    rev(3, { user_email: A, chars: 100 }),
    rev(4, { user_email: A, chars: 60 }),
  ];
  const d = revisionDeltas(list);
  const onlyA = filterGroups(groupRevisions(list), r => r.user_email === A);
  assert.deepEqual(onlyA.map(g => g.items.length), [2, 2], 'B trennt die Sitzungen von A');
  assert.equal(d.span(onlyA[0].items[0], onlyA[0].items[1]), 100, 'juengere A-Sitzung: 500 gegen B (400)');
  assert.equal(d.span(onlyA[1].items[0], onlyA[1].items[1]), 100, 'aeltere A-Sitzung: 100 gegen leeren Stand');
  assert.equal(d.sum(onlyA), 200, 'Tag gefiltert: nur A, Bs +300 fehlt');
  assert.equal(d.sum(groupRevisions(list)), 500, 'ungefiltert: ganzer Tag');
});
