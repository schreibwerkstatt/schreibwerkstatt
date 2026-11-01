'use strict';
// Finetune-Export, Ereignisse im Autor-Chat: Datumswahl trotz Zitat-Labels,
// Buchstelle aus dem verknüpften Abschnitt, Szenen-Verknüpfung, keine Antwort
// unter der pushQA-Mindestlänge, Abschnitt-Suche nicht im Leser-Modell.

const test = require('node:test');
const assert = require('node:assert/strict');
const { eventWhen, eventExcerpt } = require('../../routes/jobs/finetune-export/samples/author-chat/event-data');
const { buildEventLinkSamples } = require('../../routes/jobs/finetune-export/samples/author-chat/event-links');

test('eventWhen: «unbekannt» und Zitat-Labels sind keine Zeitangabe', () => {
  assert.equal(eventWhen({ datum: 'unbekannt (vergangenheit)', datum_label: '…und dann kam er…' }, false).when, '');
  assert.equal(eventWhen({ datum: '', datum_label: 'Herbst 1835' }, false).when, 'Herbst 1835');
  assert.equal(eventWhen({ datum: '', datum_label: 'Das Unglück aber bestand darin...', datum_year: 1840 }, false).when, '1840');
  const span = eventWhen({ datum_year: 1840, datum_month: 3, datum_ende_year: 1842 }, false);
  assert.equal(span.when, 'von März 1840 bis 1842');
  assert.equal(span.end, '1842');
  assert.match(eventWhen({ datum: '1806', datum_unsicher: 1 }, false).when, /erschlossen/);
});

test('eventExcerpt: Fenster um die beteiligte Figur, auch ohne Absatzumbrüche', () => {
  const filler = 'Das Wetter war grau und niemand sprach über die Sache am Tisch. '.repeat(40);
  const scene = 'Lenoir griff nach dem silbernen Löffel und steckte ihn ein. Die Konsulin sah es genau. ';
  const page = { id: 7, chapter_id: 3, text: filler + scene.repeat(3) + filler };
  const e = { ereignis: 'Diebstahl des Silberzeugs', pageIds: [7],
    figs: [{ key: 'f1', name: 'Lenoir', names: ['Lenoir'] }] };
  const ex = eventExcerpt(e, { pageById: new Map([[7, page]]), maxChars: 600 });
  assert.ok(ex, 'Stelle gefunden');
  assert.ok(ex.text.startsWith('Lenoir griff'), ex.text.slice(0, 60));
  assert.ok(ex.text.length <= 600);
});

function collect() {
  const out = [];
  const scene = { id: 11, titel: 'Mittagessen', seite: 'Viertes Kapitel', kommentar: 'Die Familie isst schweigend zu Mittag.' };
  const e = {
    i: 0, ereignis: 'Einquartierung', datum: 'November 1806', end: '', storyDay: 32,
    subtyp: 'tod', subtypLabel: 'Tod', storyline: 'Franzosenzeit', bedeutung: '',
    kapitel: ['Erster Teil'], pageIds: [7],
    figs: [{ key: 'f1', fig_id: 'f1', name: 'Prahl', names: ['Prahl'] }], locs: [], scenes: [scene],
    excerpt: { text: 'Prahl fiel im Getümmel. '.repeat(12), page: { id: 7, chapter_id: 3 } },
    fullAnswer: 'Einquartierung. Zeitpunkt: November 1806.',
  };
  buildEventLinkSamples({
    langIsEn: false, events: [e], eventsBySceneId: new Map([[11, [e]]]),
    sceneRows: [scene], pushQA: (id, q, a, o) => out.push({ id, q, a, src: o?.sourceKey, unit: o?.unit }),
  });
  return out;
}

test('Ereignis-Verknüpfungen: Buchstelle mit sourceKey, Szene, Strang, Tag, Tod', () => {
  const out = collect();
  const kind = (k) => out.filter(s => s.id.split('|')[1] === k);
  assert.equal(kind('evtText')[0].src, 'ch:3');
  assert.equal(kind('evtText')[0].unit, 'evt:0');
  // Erzählen aus Figurensicht: Ziel ist die Buchstelle, nie die Karte.
  const pov = kind('evtTextFig');
  assert.equal(pov.length, 1);
  assert.match(pov[0].q, /Erzähle «Einquartierung» aus der Sicht von Prahl/);
  assert.ok(pov[0].a.startsWith('Prahl fiel im Getümmel.'));
  assert.ok(!/Zeitpunkt:/.test(pov[0].a));
  assert.equal(kind('evtSceneDetail').length, 0, 'Szenen-Kommentar (Lektorat) ist kein Inhalt');
  assert.match(kind('evtScene')[0].a, /Mittagessen/);
  assert.match(kind('sceneEvts')[0].a, /Einquartierung/);
  assert.match(kind('evtSl')[0].a, /Franzosenzeit/);
  assert.match(kind('evtDay')[0].a, /Tag 32/);
  assert.match(kind('evtLife')[0].q, /Wann stirbt Prahl/);
  assert.equal(kind('evtSec').length, 0, 'keine Abschnitt-Suche');
  // pushQA verwirft Antworten unter 20 Zeichen — kurze Fakten stehen als Satz.
  for (const s of out) assert.ok(s.a.trim().length >= 20, `${s.id}: «${s.a}»`);
});
