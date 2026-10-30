// Reine Rechenschicht der Schullaufbahn (public/js/book/school-path.js):
// Stichtag-Grenzfaelle, Schuljahreswechsel, Repetition, Wegwechsel, Normalisierung.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHUL_VORLAGEN, normalizeSchulsystem, resolveSchulsystem, schulsystemAusVorlage,
  einschulungsJahre, schoolStageAt, schoolStagesForYear, wegAblauf, normalizeRepetitionen,
  wegKeys, geburtAusText, schuljahrStart,
} from '../../public/js/book/school-path.js';

const SO = schulsystemAusVorlage('ch_so_1990');

test('Vorlagen: jeder Weg nennt nur Stufen der Vorlage, Standardweg existiert', () => {
  for (const [key, tpl] of Object.entries(SCHUL_VORLAGEN)) {
    const stufen = new Set(tpl.stufen.map(s => s.key));
    for (const w of tpl.wege) for (const s of w.stufen) assert.ok(stufen.has(s), `${key}/${w.key}: ${s}`);
    assert.ok(tpl.wege.some(w => w.key === tpl.standardWeg), key);
    assert.equal(new Set(tpl.wege.map(w => w.key)).size, tpl.wege.length, `${key}: Weg-Keys eindeutig`);
  }
});

test('Normalisierung: unbekannt → null, Zahlen geklemmt, fremder Standardweg faellt zurueck', () => {
  assert.equal(normalizeSchulsystem(null), null);
  assert.equal(normalizeSchulsystem({ vorlage: 'mars' }), null);
  assert.equal(normalizeSchulsystem('kein json'), null);
  const n = normalizeSchulsystem({ vorlage: 'ch_so_1990', einschulungsalter: 99, jahre: { obergym: 0, bez: '4', fremd: 3 }, standard_weg: 'xyz', stichtag: { monat: 2, tag: 31 } });
  assert.equal(n.einschulungsalter, 9);
  assert.equal(n.jahre.obergym, 1);
  assert.equal(n.jahre.bez, 4);
  assert.ok(!('fremd' in n.jahre));
  assert.equal(n.standard_weg, 'oberstufe_lehre');
  assert.deepEqual(n.stichtag, { monat: 2, tag: 28 });
  assert.deepEqual(normalizeSchulsystem(JSON.stringify(SO)), SO);
  assert.equal(SO.jahre.obergym, 4, 'Obergym-Default 4 Jahre');
});

test('Stichtag 30. April: am Stichtag geboren → im selben Jahr eingeschult, am Tag danach ein Jahr spaeter', () => {
  assert.deepEqual(einschulungsJahre({ y: 1985, m: 4, d: 30 }, SO), [1991]);
  assert.deepEqual(einschulungsJahre({ y: 1985, m: 5, d: 1 }, SO), [1992]);
  assert.deepEqual(einschulungsJahre({ y: 1985, m: 1, d: 15 }, SO), [1991]);
  assert.deepEqual(einschulungsJahre({ y: 1985, m: 12 }, SO), [1992]);
  // April ohne Tag: Stichtag ist der letzte Apriltag → eindeutig.
  assert.deepEqual(einschulungsJahre({ y: 1985, m: 4 }, SO), [1991]);
  // Nur das Jahr: beide Varianten, die wahrscheinlichere (nach dem Stichtag) zuerst.
  assert.deepEqual(einschulungsJahre({ y: 1985 }, SO), [1992, 1991]);
});

test('Schuljahr: Herbst = Schuljahr ab August, Fruehjahr = Vorjahr', () => {
  assert.equal(schuljahrStart(1999, 9, SO), 1999);
  assert.equal(schuljahrStart(1999, 8, SO), 1999);
  assert.equal(schuljahrStart(1999, 7, SO), 1998);
  assert.equal(schuljahrStart(1999, null, SO), 1999);
});

test('Bez: Primar 6, dann 1.–3. Bez, danach abgeschlossen', () => {
  const geburt = { y: 1986, m: 2, d: 1 }; // eingeschult Aug 1992
  const at = (jahr, monat = 10) => schoolStageAt({ geburt, system: SO, figur: { weg: 'bez' }, jahr, monat });
  assert.equal(at(1992, 6).status, 'vor_einschulung');
  assert.deepEqual([at(1992).stufe, at(1992).klasse], ['primar', 1]);
  assert.deepEqual([at(1997).stufe, at(1997).klasse], ['primar', 6]);
  assert.deepEqual([at(1998).stufe, at(1998).klasse], ['bez', 1]);
  assert.equal(at(1998).schuljahr, '1998/1999');
  assert.deepEqual([at(2000).stufe, at(2000).klasse], ['bez', 3]);
  const nach = at(2001);
  assert.equal(nach.status, 'abgeschlossen');
  assert.equal(nach.letzte_stufe, 'bez');
  assert.equal(nach.abschluss_jahr, 2001);
});

test('Repetition verlaengert die Stufe um ein Jahr', () => {
  const geburt = { y: 1986, m: 2, d: 1 };
  const figur = { weg: 'bez', repetitionen: [{ stufe: 'primar', klasse: 3 }] };
  const ablauf = wegAblauf(SO, 'bez', figur.repetitionen);
  assert.equal(ablauf.length, 10);
  const at = (jahr) => schoolStageAt({ geburt, system: SO, figur, jahr, monat: 10 });
  assert.deepEqual([at(1994).klasse, at(1995).klasse, at(1995).repetition], [3, 3, true]);
  assert.deepEqual([at(1998).stufe, at(1998).klasse], ['primar', 6]);
  assert.deepEqual([at(1999).stufe, at(1999).klasse], ['bez', 1]);
});

test('Wegwechsel Bez → Obergym (nach der 2. Bez) und Untergym → Obergym', () => {
  const geburt = { y: 1986, m: 2, d: 1 }; // Einschulung 1992, Primar bis 1997/98
  const bezGym = (jahr) => schoolStageAt({ geburt, system: SO, figur: { weg: 'bez_gym' }, jahr, monat: 10 });
  assert.deepEqual([bezGym(1999).stufe, bezGym(1999).klasse], ['bez', 2]);
  assert.deepEqual([bezGym(2000).stufe, bezGym(2000).klasse], ['obergym', 1]);
  assert.deepEqual([bezGym(2003).stufe, bezGym(2003).klasse], ['obergym', 4]);
  assert.equal(bezGym(2004).status, 'abgeschlossen');

  const kanti = (jahr) => schoolStageAt({ geburt, system: SO, figur: { weg: 'kanti' }, jahr, monat: 10 });
  assert.deepEqual([kanti(1996).stufe, kanti(1996).klasse], ['primar', 5]);
  assert.deepEqual([kanti(1997).stufe, kanti(1997).klasse], ['untergym', 1]);
  assert.deepEqual([kanti(2000).stufe, kanti(2000).klasse], ['obergym', 1]);
});

test('Editierbare Obergym-Dauer wirkt auf den Abschluss', () => {
  const sys = normalizeSchulsystem({ ...SO, jahre: { ...SO.jahre, obergym: 3 } });
  const r = schoolStageAt({ geburt: { y: 1986, m: 2, d: 1 }, system: sys, figur: { weg: 'bez_gym' }, jahr: 2003, monat: 10 });
  assert.equal(r.status, 'abgeschlossen');
  assert.equal(r.abschluss_jahr, 2003);
});

test('Nur Geburtsjahr: unsicher mit Alternative; Override macht es eindeutig', () => {
  const r = schoolStageAt({ geburt: { y: 1986 }, system: SO, figur: { weg: 'bez' }, jahr: 1998, monat: 10 });
  assert.equal(r.unsicher, true);
  assert.deepEqual([r.stufe, r.klasse], ['primar', 6]);       // Einschulung 1993 (wahrscheinlicher)
  assert.deepEqual([r.alternative.stufe, r.alternative.klasse], ['bez', 1]); // Einschulung 1992
  const o = schoolStageAt({ geburt: { y: 1986 }, system: SO, figur: { weg: 'bez', einschulung_jahr: 1992 }, jahr: 1998, monat: 10 });
  assert.ok(!o.unsicher);
  assert.deepEqual([o.stufe, o.klasse], ['bez', 1]);
});

test('Einschulungs-Override null/leer zaehlt nicht als Jahr 0', () => {
  for (const ej of [null, '', undefined]) {
    const r = schoolStageAt({ geburt: { y: 1986, m: 2, d: 1 }, system: SO, figur: { weg: 'bez', einschulung_jahr: ej }, jahr: 1998, monat: 10 });
    assert.equal(r.einschulung, 1992);
  }
});

test('Ohne Weg gilt der Standardweg; ohne System/Geburt null', () => {
  const r = schoolStageAt({ geburt: { y: 1986, m: 2, d: 1 }, system: SO, figur: { weg: 'gibtsnicht' }, jahr: 1998, monat: 10 });
  assert.equal(r.weg, 'oberstufe_lehre');
  assert.equal(schoolStageAt({ geburt: { y: 1986 }, system: null, jahr: 1998 }), null);
  assert.equal(schoolStageAt({ geburt: null, system: SO, jahr: 1998 }), null);
});

test('Jahr ohne Monat: Fruehjahr und Herbst getrennt, wenn verschieden', () => {
  const r = schoolStagesForYear({ geburt: { y: 1986, m: 2, d: 1 }, system: SO, figur: { weg: 'bez' }, jahr: 1998 });
  assert.deepEqual([r.fruehjahr.stufe, r.fruehjahr.klasse], ['primar', 6]);
  assert.deepEqual([r.herbst.stufe, r.herbst.klasse], ['bez', 1]);
  const gleich = schoolStagesForYear({ geburt: { y: 1986, m: 2, d: 1 }, system: SO, figur: { weg: 'bez' }, jahr: 1994 });
  assert.ok(!gleich.fruehjahr || gleich.fruehjahr.klasse !== gleich.herbst.klasse);
});

test('SO: Bez nach der 2. Klasse und Untergym ab der 5. Primar erreichen das Obergym im selben Jahr', () => {
  const geburt = { y: 1985, m: 2, d: 1 };   // eingeschult Sommer 1991
  const at = (weg, jahr) => {
    const r = schoolStageAt({ geburt, system: SO, figur: { weg }, jahr, monat: 10 });
    return r.status === 'schule' ? [r.stufe, r.klasse] : [r.status, r.abschluss_jahr];
  };
  assert.deepEqual(at('kanti', 1995), ['primar', 5]);
  assert.deepEqual(at('kanti', 1996), ['untergym', 1]);
  assert.deepEqual(at('bez_gym', 1998), ['bez', 2]);
  assert.deepEqual(at('bez_gym', 1999), ['obergym', 1]);
  assert.deepEqual(at('kanti', 1999), ['obergym', 1]);
  assert.deepEqual(at('kanti', 2003), ['abgeschlossen', 2003], 'Matur nach 12 Schuljahren');
  assert.deepEqual(at('bez3_gym', 1999), ['bez', 3]);
  assert.deepEqual(at('bez3_gym', 2000), ['obergym', 1]);
  assert.deepEqual(at('kanti_lehre', 1999), ['lehre', 1]);
  assert.equal(SCHUL_VORLAGEN.ch_so_1990.standardWeg, 'oberstufe_lehre');
});

test('Nur Schweizer Vorlagen', () => {
  assert.deepEqual(Object.keys(SCHUL_VORLAGEN), ['ch_so_1990', 'ch_harmos']);
});

test('HarmoS: Einschulung mit 4 in den Kindergarten', () => {
  const h = schulsystemAusVorlage('ch_harmos');
  const r = schoolStageAt({ geburt: { y: 2010, m: 3, d: 1 }, system: h, jahr: 2014, monat: 9 });
  assert.deepEqual([r.stufe, r.klasse], ['kiga', 1]);
  assert.deepEqual(wegKeys(h), ['sek', 'sek_lehre', 'sek_gym']);
});

test('geburtAusText liest Ziffernformen', () => {
  assert.deepEqual(geburtAusText('12.3.1985'), { y: 1985, m: 3, d: 12 });
  assert.deepEqual(geburtAusText('1985-03-12'), { y: 1985, m: 3, d: 12 });
  assert.deepEqual(geburtAusText('Frühling 1985'), { y: 1985 });
  assert.deepEqual(geburtAusText('', 1990), { y: 1990 });
  assert.equal(geburtAusText(''), null);
});

test('resolveSchulsystem liefert Stufen mit klasseStart', () => {
  const r = resolveSchulsystem(SO);
  assert.equal(r.stufen.primar.klasseStart, 1);
  assert.equal(r.wege.length, SCHUL_VORLAGEN.ch_so_1990.wege.length);
});
