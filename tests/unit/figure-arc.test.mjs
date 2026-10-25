// Bogen-Messung der Figuren-Werkstatt (lib/figure-arc.js) — pure Rechnung.
//
// Getestet wird vor allem die Invariante, an der die ganze Schicht haengt:
// UNGESCANNT IST UNGEPRUEFT, NICHT ABWESEND. Ohne die faellt jede geplante
// Figur als „steht nicht im Buch" an, und die Messung waere Rauschen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeArcFindings, ARC_MIN_CHAPTERS, ARC_MIN_HITS } = require('../../lib/figure-arc.js');
const { PSYCHE_KERNE } = require('../../lib/draft-mindmap-extract.js');

const ORDER = Array.from({ length: 9 }, (_, i) => i + 1);      // 9 Kapitel
const alleKerne = (on = []) => Object.fromEntries(PSYCHE_KERNE.map(k => [k, on.includes(k)]));

function draft(over = {}) {
  return { id: 1, name: 'Mara', geplant: alleKerne(), counts: {}, occ: {}, ...over };
}
const codes = f => f.map(x => x.code);

test('ungescannt liefert KEINE Befunde (ungeprueft ist nicht abwesend)', () => {
  const d = draft({ geplant: alleKerne(['lie', 'wound', 'bogen']), counts: {}, occ: {} });
  assert.deepEqual(computeArcFindings({ drafts: [d], chapterOrder: ORDER, scanned: false }), []);
  // Und mit Scan feuert derselbe Stand sehr wohl — sonst testet der Fall nichts.
  assert.ok(computeArcFindings({ drafts: [d], chapterOrder: ORDER, scanned: true }).length === 0,
    'Figur ohne jede Spur im Text gilt als ungeschrieben, nicht als fehlerhaft');
});

test('geplanter Kern ohne Text meldet nur, wenn die Figur sonst im Buch steht', () => {
  const ohneSpur = draft({ geplant: alleKerne(['wound']), counts: {}, occ: {} });
  assert.deepEqual(computeArcFindings({ drafts: [ohneSpur], chapterOrder: ORDER, scanned: true }), [],
    'noch nicht geschrieben ist kein Befund');

  const mitSpur = draft({
    geplant: alleKerne(['wound', 'want']),
    counts: { want: 3, wound: 0 },
    occ: { want: [{ chapterId: 1, n: 2 }, { chapterId: 5, n: 1 }] },
  });
  assert.deepEqual(codes(computeArcFindings({ drafts: [mitSpur], chapterOrder: ORDER, scanned: true })),
    ['kernOhneText']);
});

test('bogenOhneBeleg verdraengt den allgemeinen Befund (keine doppelte Buchfuehrung)', () => {
  const d = draft({
    geplant: alleKerne(['bogen', 'want']),
    counts: { want: 2, bogen: 0 },
    occ: { want: [{ chapterId: 1, n: 1 }, { chapterId: 4, n: 1 }] },
  });
  const f = computeArcFindings({ drafts: [d], chapterOrder: ORDER, scanned: true });
  assert.deepEqual(codes(f), ['bogenOhneBeleg']);
  assert.equal(f.filter(x => x.kern === 'bogen').length, 1);
});

test('wandelOhneEinloesung: Luege am Schluss so dicht wie am Anfang', () => {
  const ungebrochen = draft({
    geplant: alleKerne(['lie']),
    counts: { lie: 6 },
    occ: { lie: [{ chapterId: 1, n: 3 }, { chapterId: 8, n: 3 }] },
  });
  assert.deepEqual(codes(computeArcFindings({ drafts: [ungebrochen], chapterOrder: ORDER, scanned: true })),
    ['wandelOhneEinloesung']);

  // Gegenprobe: dieselbe Zahl Fundstellen, aber nach hinten ausduennend = Wandel.
  const gebrochen = draft({
    geplant: alleKerne(['lie']),
    counts: { lie: 6 },
    occ: { lie: [{ chapterId: 1, n: 5 }, { chapterId: 8, n: 1 }] },
  });
  assert.deepEqual(computeArcFindings({ drafts: [gebrochen], chapterOrder: ORDER, scanned: true }), []);
});

test('Verteilung wiegt Fundstellen, nicht Kapitel', () => {
  // Vorn EIN Kapitel mit 5 Treffern, hinten ZWEI Kapitel mit je 1. Nach Kapiteln
  // gezaehlt waere hinten (2) >= vorn (1) und der Befund feuerte faelschlich.
  const d = draft({
    geplant: alleKerne(['wound']),
    counts: { wound: 7 },
    occ: { wound: [{ chapterId: 1, n: 5 }, { chapterId: 7, n: 1 }, { chapterId: 9, n: 1 }] },
  });
  assert.deepEqual(computeArcFindings({ drafts: [d], chapterOrder: ORDER, scanned: true }), []);
});

test('kurzes Buch: kein Bogen-Urteil (zu wenig Kapitel fuer vorn/hinten)', () => {
  const kurz = Array.from({ length: ARC_MIN_CHAPTERS - 1 }, (_, i) => i + 1);
  const d = draft({
    geplant: alleKerne(['lie']),
    counts: { lie: ARC_MIN_HITS + 2 },
    occ: { lie: [{ chapterId: 1, n: 3 }, { chapterId: kurz.length, n: 3 }] },
  });
  assert.deepEqual(computeArcFindings({ drafts: [d], chapterOrder: kurz, scanned: true }), []);
});

test('kernNurPunktuell: Kern taucht in genau einem Kapitel auf', () => {
  const d = draft({
    geplant: alleKerne(['need']),
    counts: { need: 4 },
    occ: { need: [{ chapterId: 3, n: 4 }] },
  });
  const f = computeArcFindings({ drafts: [d], chapterOrder: ORDER, scanned: true });
  assert.deepEqual(codes(f), ['kernNurPunktuell']);
  assert.equal(f[0].params.kapitel, 3);
});

test('Befunde sind nach Schwere sortiert', () => {
  const d = draft({
    geplant: alleKerne(['lie', 'wound', 'want']),
    counts: { lie: 6, wound: 0, want: 4 },
    occ: {
      lie: [{ chapterId: 1, n: 3 }, { chapterId: 8, n: 3 }],   // stark
      want: [{ chapterId: 2, n: 4 }],                           // schwach
    },
  });
  const f = computeArcFindings({ drafts: [d], chapterOrder: ORDER, scanned: true });
  assert.deepEqual(codes(f), ['wandelOhneEinloesung', 'kernOhneText', 'kernNurPunktuell']);
});

test('jeder Befundcode traegt quelle=messung und eine Figur', () => {
  const d = draft({
    geplant: alleKerne(['lie', 'wound', 'bogen']),
    counts: { lie: 6, wound: 0, bogen: 0 },
    occ: { lie: [{ chapterId: 1, n: 3 }, { chapterId: 8, n: 3 }] },
  });
  for (const f of computeArcFindings({ drafts: [d], chapterOrder: ORDER, scanned: true })) {
    assert.equal(f.quelle, 'messung');
    assert.equal(f.figur, 'Mara');
    assert.equal(f.draft_id, 1);
    assert.ok(PSYCHE_KERNE.includes(f.kern));
  }
});

test('Kopf- und Schlussdrittel sind gleich breit (kein Uebergewicht hinten)', () => {
  // 7 Kapitel: Kopf = Pos. 0–1, Schluss = Pos. 5–6. Pos. 4 ist Mitte. Mit
  // floor(n·2/3) begaenne der Schluss bei Pos. 4 und die Mitte zaehlte als
  // „Wandel bleibt aus".
  const seven = Array.from({ length: 7 }, (_, i) => i + 1);
  const mitte = draft({
    geplant: alleKerne(['lie']),
    counts: { lie: 6 },
    occ: { lie: [{ chapterId: 1, n: 3 }, { chapterId: 5, n: 3 }] },
  });
  assert.deepEqual(computeArcFindings({ drafts: [mitte], chapterOrder: seven, scanned: true }), []);

  const schluss = draft({
    geplant: alleKerne(['lie']),
    counts: { lie: 6 },
    occ: { lie: [{ chapterId: 1, n: 3 }, { chapterId: 6, n: 3 }] },
  });
  assert.deepEqual(codes(computeArcFindings({ drafts: [schluss], chapterOrder: seven, scanned: true })),
    ['wandelOhneEinloesung']);
});
