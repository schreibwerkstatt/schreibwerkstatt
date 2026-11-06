// Maschinelle Verlaufs-Anhänge des Chats (lib/chat-history-note.js):
//  - Format der Anhänge (Belege des Buch-Chats, Vorschläge/Ideen des Abschnitts-Chats),
//  - jeder ist als Verlaufs-Notiz markiert (das Modell soll ihn nicht als
//    Antwortformat übernehmen — sonst schreibt es die Liste in die Antwort),
//  - das Echo in der Antwort wird entfernt (neue und alte Form),
//  - eine echte Antwort bleibt unangetastet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatCitationNote, formatProposalNote, formatIdeenNote, stripHistoryNote } =
  require('../../lib/chat-history-note.js');

const CITES = [
  { n: 1, page_id: 1005667, page_name: 'Die Schwangerschaft', quote: 'Er trat nämlich der städtischen FDP bei.', valid: true },
  { n: 2, page_id: 1005668, page_name: 'Der Vater', quote: 'Sein berühmter Familienname.', valid: true },
];
const VORSCHLAEGE = [
  { original: 'bellt laut', ersatz: 'bellt leise', applied: true },
  { original: 'Die Katze', ersatz: 'Die alte Katze', status: 'discarded' },
  { original: 'schläft', ersatz: 'döst' },
];

test('Belege-Anhang nennt die gültigen Belege (Abschnitt, page_id, Zitat)', () => {
  const note = formatCitationNote(CITES);
  assert.match(note, /^\[Belege/);
  assert.match(note, /Abschnitt «Die Schwangerschaft» \(page_id 1005667\)/);
  assert.match(note, /«Er trat nämlich der städtischen FDP bei\.»/);
  assert.match(note, /Abschnitt «Der Vater» \(page_id 1005668\)/);
});

test('Vorschlags-Anhang nennt die Vorschläge mit Status', () => {
  const note = formatProposalNote(VORSCHLAEGE);
  assert.match(note, /\[übernommen\] «bellt laut» → «bellt leise»/);
  assert.match(note, /\[verworfen\] «Die Katze» → «Die alte Katze»/);
  assert.match(note, /\[offen\] «schläft» → «döst»/);
});

test('Ideen-Anhang nennt die Ideen mit Status', () => {
  const note = formatIdeenNote([
    { type: 'idee_create', fields: { content: 'Alter prüfen' } },
    { type: 'idee_create', fields: { content: 'Ort prüfen' }, applied_at: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.match(note, /\[offen\] Alter prüfen/);
  assert.match(note, /\[als Idee erfasst\] Ort prüfen/);
});

test('jeder Anhang ist als Verlaufs-Notiz markiert, nicht als Antwortformat', () => {
  for (const note of [formatCitationNote(CITES), formatProposalNote(VORSCHLAEGE),
    formatIdeenNote([{ type: 'idee_create', fields: { content: 'X' } }])]) {
    assert.match(note, /nicht in der Antwort wiedergeben/);
  }
});

test('ohne gültige Belege/Vorschläge/Ideen gibt es keinen Anhang', () => {
  assert.equal(formatCitationNote([]), '');
  assert.equal(formatCitationNote(null), '');
  assert.equal(formatCitationNote(undefined), '');
  assert.equal(formatCitationNote([{ n: 1, quote: 'x', valid: false }]), '');
  assert.equal(formatProposalNote([]), '');
  assert.equal(formatProposalNote(undefined), '');
  assert.equal(formatIdeenNote([]), '');
  assert.equal(formatIdeenNote(undefined), '');
  assert.equal(formatIdeenNote([{ type: 'other' }]), '');
});

test('Belege-Anhang ist gedeckelt (6 Belege, 160 Zeichen je Zitat)', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    n: i + 1, page_id: i + 1, page_name: `S${i}`, quote: 'q'.repeat(300), valid: true,
  }));
  const note = formatCitationNote(many);
  assert.equal((note.match(/\(\d+\) /g) || []).length, 6);
  assert.ok(!note.includes('q'.repeat(200)), 'Zitat wird gekürzt');
});

test('Echo des Anhangs am Antwortende wird entfernt (Drift-Gate Format ↔ Strip)', () => {
  for (const note of [formatCitationNote(CITES), formatProposalNote(VORSCHLAEGE),
    formatIdeenNote([{ type: 'idee_create', fields: { content: 'X' } }])]) {
    assert.equal(stripHistoryNote(`Antwort im Ton Ihres Textes.\n\n${note}`), 'Antwort im Ton Ihres Textes.');
    assert.equal(stripHistoryNote(note), '');
  }
});

test('die alten Anhangsformen werden ebenfalls entfernt (Antworten vor dem Fix)', () => {
  const altBelege = '[Belege dieser Antwort: (1) Abschnitt «Die Schwangerschaft» (page_id 1005667): «Er trat nämlich …»]';
  assert.equal(stripHistoryNote(`Antwort.\n\n${altBelege}`), 'Antwort.');
  const altVorschlaege = '[Deine Änderungsvorschläge in dieser Antwort, Status beim Autor:\n1. [offen] «a» → «b»\n]';
  assert.equal(stripHistoryNote(`Antwort.\n\n${altVorschlaege}`), 'Antwort.');
  const altIdeen = '[Deine Ideen-Vorschläge in dieser Antwort, Status beim Autor:\n1. [offen] X\n]';
  assert.equal(stripHistoryNote(`Antwort.\n\n${altIdeen}`), 'Antwort.');
});

test('eine echte Antwort bleibt unangetastet', () => {
  const prose = 'Er trat der FDP bei. Die Belege stehen unter der Antwort.';
  assert.equal(stripHistoryNote(prose), prose);
  const mitten = 'Mehr dazu im [Belege]-Abschnitt.';
  assert.equal(stripHistoryNote(mitten), mitten);
  const vorschlaegeImText = 'Ich würde «bellt laut» zu «bellt leise» ändern.';
  assert.equal(stripHistoryNote(vorschlaegeImText), vorschlaegeImText);
  assert.equal(stripHistoryNote(''), '');
  assert.equal(stripHistoryNote(undefined), undefined);
});

test('ohne Echo bleibt der Text unangetastet (kein Blatt von einem fremden Abschnitt)', () => {
  const antwort = 'Er trat der FDP bei.\n\n**Vorschlag:** «Er war 1996 der städtischen FDP beigetreten …»';
  assert.equal(stripHistoryNote(antwort), antwort);
});

test('ein «[Belege …» am Zeilenanfang löscht nicht die Antwort bis zur letzten «]»', () => {
  const antwort = '[Belege] sind in diesem Kapitel wichtig.\nDer Rest der Antwort, Fussnote [1]';
  assert.equal(stripHistoryNote(antwort), antwort);
  const mitListe = '[Deine Änderungsvorschläge sind gut]: so weit.\n\nAber hier [2]';
  assert.equal(stripHistoryNote(mitListe), mitListe);
});

test('mehrere Anhänge hintereinander werden zusammen entfernt', () => {
  const v = formatProposalNote(VORSCHLAEGE);
  const i = formatIdeenNote([{ type: 'idee_create', fields: { content: 'Idee' } }]);
  assert.equal(stripHistoryNote(`Antwort.\n\n${v}\n\n${i}`), 'Antwort.');
});
