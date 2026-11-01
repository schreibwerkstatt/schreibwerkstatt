// Tests fuer die pure VAD-/Insert-Compute-Helpers in
// editor/notebook/stt-dictation.js (RMS, Segment-Schnitt-Entscheidung,
// Mime-Wahl, Leerzeichen-Heuristik). DOM-/MediaRecorder-Pfade decken die
// E2E-Tests ab.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { sttDictationMethods: m } = await import('../../public/js/editor/notebook/stt-dictation.js');

// --- _computeRms ------------------------------------------------------------

test('_computeRms: Stille (alle 128) -> 0', () => {
  const buf = new Uint8Array(256).fill(128);
  assert.equal(m._computeRms(buf), 0);
});

test('_computeRms: Vollausschlag -> ~1', () => {
  const buf = new Uint8Array(256).fill(255);
  assert.ok(m._computeRms(buf) > 0.99);
});

test('_computeRms: leeres/fehlendes Sample -> 0', () => {
  assert.equal(m._computeRms(new Uint8Array(0)), 0);
  assert.equal(m._computeRms(null), 0);
});

// --- _computeVadCut ---------------------------------------------------------

const VAD = { threshold: 0.02, silenceMs: 800, maxSegmentS: 30 };

test('_computeVadCut: Sprache erkannt -> voiced, kein Cut', () => {
  const d = m._computeVadCut({
    rms: 0.1, ...VAD, now: 1000, segmentStart: 0, lastVoiceTs: 0, hasVoice: false,
  });
  assert.equal(d.voiced, true);
  assert.equal(d.cut, false);
});

test('_computeVadCut: Stille < silenceMs nach Sprache -> kein Cut', () => {
  const d = m._computeVadCut({
    rms: 0.001, ...VAD, now: 1500, segmentStart: 0, lastVoiceTs: 1000, hasVoice: true,
  });
  assert.equal(d.cut, false);
});

test('_computeVadCut: Stille >= silenceMs nach Sprache -> Cut (silence)', () => {
  const d = m._computeVadCut({
    rms: 0.001, ...VAD, now: 1900, segmentStart: 0, lastVoiceTs: 1000, hasVoice: true,
  });
  assert.equal(d.cut, true);
  assert.equal(d.reason, 'silence');
});

test('_computeVadCut: ohne erkannte Sprache nie Cut (reines Stille-Segment)', () => {
  const d = m._computeVadCut({
    rms: 0.001, ...VAD, now: 99999, segmentStart: 0, lastVoiceTs: 0, hasVoice: false,
  });
  assert.equal(d.cut, false);
});

test('_computeVadCut: Segment > maxSegmentS bei laufender Sprache -> Cut (max)', () => {
  const d = m._computeVadCut({
    rms: 0.1, ...VAD, now: 31000, segmentStart: 0, lastVoiceTs: 30000, hasVoice: true,
  });
  assert.equal(d.cut, true);
  assert.equal(d.reason, 'max');
});

// --- _computeSttMime --------------------------------------------------------

test('_computeSttMime: bevorzugt webm/opus', () => {
  assert.equal(m._computeSttMime(() => true), 'audio/webm;codecs=opus');
});

test('_computeSttMime: faellt auf mp4 wenn nur das unterstuetzt wird', () => {
  const mime = m._computeSttMime((c) => c === 'audio/mp4');
  assert.equal(mime, 'audio/mp4');
});

test('_computeSttMime: nichts unterstuetzt -> leerer String', () => {
  assert.equal(m._computeSttMime(() => false), '');
});

// --- _computeSpacedInsert ---------------------------------------------------

test('_computeSpacedInsert: fuegt Leerzeichen nach Wortzeichen ein', () => {
  assert.equal(m._computeSpacedInsert('t', 'Hallo'), ' Hallo');
});

test('_computeSpacedInsert: kein Leerzeichen nach Whitespace', () => {
  assert.equal(m._computeSpacedInsert(' ', 'Hallo'), 'Hallo');
});

test('_computeSpacedInsert: kein Leerzeichen wenn Text mit Satzzeichen beginnt', () => {
  assert.equal(m._computeSpacedInsert('t', ', dann'), ', dann');
  assert.equal(m._computeSpacedInsert('t', '. Punkt'), '. Punkt');
});

test('_computeSpacedInsert: kein prevChar (Zeilenanfang) -> kein Leerzeichen', () => {
  assert.equal(m._computeSpacedInsert('', 'Hallo'), 'Hallo');
});

test('_computeSpacedInsert: trimmt und liefert leer bei Whitespace-only', () => {
  assert.equal(m._computeSpacedInsert('t', '   '), '');
  assert.equal(m._computeSpacedInsert('t', '  Welt  '), ' Welt');
});

test('_computeSpacedInsert: Atempause ohne Modell-Satzzeichen -> kein Punkt, klein', () => {
  // Eine blosse Sprechpause ist kein Satzende: nur Leerzeichen, keine
  // Grossschreibung, kein injizierter Punkt — Whisper punktiert selbst.
  assert.equal(m._computeSpacedInsert('ging sie', 'zum markt'), ' zum markt');
  assert.equal(m._computeSpacedInsert('nach Hause', 'dann'), ' dann');
});

test('_computeSpacedInsert: nach vorhandenem Satzendezeichen -> Leerzeichen + gross', () => {
  assert.equal(m._computeSpacedInsert('.', 'das', true), ' Das');
  assert.equal(m._computeSpacedInsert('!', 'das', true), ' Das');
  assert.equal(m._computeSpacedInsert('?', 'das', true), ' Das');
});

test('_computeSpacedInsert: Text beginnt mit Satzzeichen -> kein Leerzeichen', () => {
  assert.equal(m._computeSpacedInsert('t', ', dann'), ', dann');
});

test('_computeSpacedInsert: nach Whitespace -> unveraendert', () => {
  assert.equal(m._computeSpacedInsert(' ', 'Das'), 'Das');
});

test('_computeSpacedInsert: Modell-Satzzeichen hinter schliessender Anfuehrung -> kein eigener Punkt', () => {
  // Dialog endet mit Punkt + schliessendem Guillemet/Quote: nur Leerzeichen,
  // neuer Satz wird grossgeschrieben, KEIN zusaetzlicher Punkt.
  assert.equal(m._computeSpacedInsert('»Komm her.«', 'Dann ging er'), ' Dann ging er');
  assert.equal(m._computeSpacedInsert('"Wirklich?"', 'sie nickte'), ' Sie nickte');
  assert.equal(m._computeSpacedInsert('…sagte er.”', 'stille'), ' Stille');
});

// --- _isLikelyHallucination -------------------------------------------------

test('_isLikelyHallucination: Whole-Segment-Floskeln', () => {
  assert.equal(m._isLikelyHallucination('Vielen Dank.'), true);
  assert.equal(m._isLikelyHallucination('  vielen dank  '), true);
  assert.equal(m._isLikelyHallucination('Tschüss!'), true);
  assert.equal(m._isLikelyHallucination('Untertitel'), true);
});

test('_isLikelyHallucination: Untertitel-/Sender-Marker', () => {
  assert.equal(m._isLikelyHallucination('Untertitel des ZDF, 2017'), true);
  assert.equal(m._isLikelyHallucination('Untertitelung im Auftrag des ZDF'), true);
  assert.equal(m._isLikelyHallucination('Untertitel der Amara.org-Community'), true);
});

test('_isLikelyHallucination: legitimer Prosatext bleibt', () => {
  assert.equal(m._isLikelyHallucination('Vielen Dank, sagte er und ging.'), false);
  assert.equal(m._isLikelyHallucination('Sie schaute aus dem Fenster.'), false);
  assert.equal(m._isLikelyHallucination(''), false);
});

// --- _endsSentence ----------------------------------------------------------

test('_endsSentence: nacktes Satzendezeichen', () => {
  assert.equal(m._endsSentence('.'), true);
  assert.equal(m._endsSentence('Wirklich?'), true);
  assert.equal(m._endsSentence('Halt!'), true);
  assert.equal(m._endsSentence('…'), true);
});

test('_endsSentence: Satzendezeichen hinter schliessender Anfuehrung/Klammer', () => {
  assert.equal(m._endsSentence('her.«'), true);
  assert.equal(m._endsSentence('?"'), true);
  assert.equal(m._endsSentence('(ja.)'), true);
});

test('_endsSentence: kein Satzende', () => {
  assert.equal(m._endsSentence('Wort'), false);
  assert.equal(m._endsSentence('her«'), false);
  assert.equal(m._endsSentence(''), false);
  assert.equal(m._endsSentence(','), false);
});

// --- _normalizeTranscript ---------------------------------------------------

test('_normalizeTranscript: kollabiert interne Mehrfach-Whitespace', () => {
  assert.equal(m._normalizeTranscript('Hallo   Welt'), 'Hallo Welt');
  assert.equal(m._normalizeTranscript('Hallo\n\tWelt'), 'Hallo Welt');
});

test('_normalizeTranscript: tilgt Leerzeichen vor Satzzeichen', () => {
  assert.equal(m._normalizeTranscript('Hallo , Welt .'), 'Hallo, Welt.');
  assert.equal(m._normalizeTranscript('Wirklich ?'), 'Wirklich?');
});

test('_normalizeTranscript: trimmt aussen', () => {
  assert.equal(m._normalizeTranscript('  Hallo Welt  '), 'Hallo Welt');
  assert.equal(m._normalizeTranscript('   '), '');
});

test('_computeSpacedInsert: kollabiert interne Doppel-Leerzeichen mit', () => {
  assert.equal(m._computeSpacedInsert('t', 'Hallo   Welt'), ' Hallo Welt');
});

// --- _capitalizeSentenceStart + Satzanfang-Gross --------------------------

test('_capitalizeSentenceStart: erster Buchstabe wird gross', () => {
  assert.equal(m._capitalizeSentenceStart('hallo welt'), 'Hallo welt');
});

test('_capitalizeSentenceStart: nach oeffnendem Zeichen', () => {
  assert.equal(m._capitalizeSentenceStart('"hallo"'), '"Hallo"');
  assert.equal(m._capitalizeSentenceStart('„guten tag'), '„Guten tag');
});

test('_capitalizeSentenceStart: Ziffer/Satzzeichen am Anfang -> unveraendert', () => {
  assert.equal(m._capitalizeSentenceStart('3 Aepfel'), '3 Aepfel');
  assert.equal(m._capitalizeSentenceStart(', dann'), ', dann');
});

test('_computeSpacedInsert: Satzanfang nach Punkt wird grossgeschrieben', () => {
  assert.equal(m._computeSpacedInsert('.', 'das war gut', true), ' Das war gut');
});

test('_computeSpacedInsert: Doc-Anfang wird grossgeschrieben', () => {
  assert.equal(m._computeSpacedInsert('', 'guten morgen'), 'Guten morgen');
});

test('_computeSpacedInsert: Satzmitte bleibt klein', () => {
  assert.equal(m._computeSpacedInsert('t', 'und weiter'), ' und weiter');
});

// --- _computeNoiseThreshold -------------------------------------------------

test('_computeNoiseThreshold: stille Umgebung -> Admin-Wert bleibt Untergrenze', () => {
  assert.equal(m._computeNoiseThreshold(0, 0.02), 0.02);
});

test('_computeNoiseThreshold: laute Umgebung hebt den Threshold an', () => {
  const t = m._computeNoiseThreshold(0.02, 0.02);
  assert.ok(t > 0.02, `erwartet > 0.02, war ${t}`);
});

test('_computeNoiseThreshold: gedeckelt auf 5x Admin-Wert (bzw. 0.08)', () => {
  const t = m._computeNoiseThreshold(1, 0.02);
  assert.ok(t <= Math.max(0.02 * 5, 0.08) + 1e-9, `erwartet <= 0.1, war ${t}`);
});

// --- _computeEatPrevSpace ---------------------------------------------------

test('_computeEatPrevSpace: Leerzeichen vor Satzzeichen -> true', () => {
  assert.equal(m._computeEatPrevSpace(' ', ', dann'), true);
  assert.equal(m._computeEatPrevSpace(' ', '. Punkt'), true);
});

test('_computeEatPrevSpace: kein Whitespace davor -> false', () => {
  assert.equal(m._computeEatPrevSpace('t', ', dann'), false);
});

test('_computeEatPrevSpace: Text beginnt mit Wort -> false', () => {
  assert.equal(m._computeEatPrevSpace(' ', 'dann'), false);
});

// --- Hoechstdauer ab erstem Sprechen + trim-Schnitt -------------------------

test('_computeVadCut: lange Denkpause vor dem Sprechen loest keinen max-Cut aus', () => {
  // 35 s Stille im Segment, dann 200 ms Sprache: die Hoechstdauer zaehlt ab
  // dem ersten Sprechen, nicht ab Segmentbeginn — kein Schnitt mitten im Wort.
  const d = m._computeVadCut({
    rms: 0.1, ...VAD, now: 35200, segmentStart: 0, voiceStart: 35000, lastVoiceTs: 35100, hasVoice: true,
  });
  assert.equal(d.cut, false);
});

test('_computeVadCut: Hoechstdauer ab erstem Sprechen -> Cut (max)', () => {
  const d = m._computeVadCut({
    rms: 0.1, ...VAD, now: 40000, segmentStart: 0, voiceStart: 10000, lastVoiceTs: 39900, hasVoice: true,
  });
  assert.equal(d.reason, 'max');
});

test('_computeVadCut: Stille vor dem Sprechen ab trimSilenceMs -> Cut (trim)', () => {
  const base = { rms: 0.001, ...VAD, segmentStart: 0, lastVoiceTs: 0, hasVoice: false, trimSilenceMs: 6000 };
  assert.equal(m._computeVadCut({ ...base, now: 5900 }).cut, false);
  const d = m._computeVadCut({ ...base, now: 6000 });
  assert.equal(d.cut, true);
  assert.equal(d.reason, 'trim');
  // Sprache im selben Tick: kein trim (der Sprechbeginn gehoert ins Segment).
  assert.equal(m._computeVadCut({ ...base, rms: 0.1, now: 6000 }).cut, false);
});

// --- _computeMidCutText -----------------------------------------------------

test('_computeMidCutText: Whispers Schlusspunkt nach max-Cut faellt weg', () => {
  assert.equal(m._computeMidCutText('und dann ging er nach.'), 'und dann ging er nach');
  assert.equal(m._computeMidCutText('und dann…'), 'und dann…');
  assert.equal(m._computeMidCutText('und dann...'), 'und dann...');
  assert.equal(m._computeMidCutText('Wirklich?'), 'Wirklich?');
  assert.equal(m._computeMidCutText('»Komm her.«'), '»Komm her.«');
});

// --- Anfuehrung / Strich am Segmentanfang -----------------------------------

test('_computeSpacedInsert: oeffnende Anfuehrung bekommt ein Leerzeichen', () => {
  assert.equal(m._computeSpacedInsert('Er sagte:', '"Komm her," rief sie.'), ' "Komm her," rief sie.');
  assert.equal(m._computeSpacedInsert('Er sagte:', '»Komm her«'), ' »Komm her«');
  assert.equal(m._computeSpacedInsert('Er sagte:', '„Komm her“'), ' „Komm her“');
});

test('_computeSpacedInsert: schliessende Anfuehrung haengt direkt an', () => {
  assert.equal(m._computeSpacedInsert('Komm her', '" rief sie.'), '" rief sie.');
  assert.equal(m._computeSpacedInsert('Komm her', '«, rief sie.'), '«, rief sie.');
  assert.equal(m._computeSpacedInsert('Komm her', '"'), '"');
});

test('_computeSpacedInsert: Gedankenstrich am Segmentanfang bekommt ein Leerzeichen', () => {
  assert.equal(m._computeSpacedInsert('und dann', '- also gut'), ' - also gut');
});

// --- Auslassungspunkte ------------------------------------------------------

test('_normalizeTranscript: Leerzeichen vor Auslassungspunkten bleibt', () => {
  assert.equal(m._normalizeTranscript('Und dann … nichts'), 'Und dann … nichts');
  assert.equal(m._normalizeTranscript('Und dann…'), 'Und dann…');
});

// --- Halluzinations-Filter: Prosa und Konfidenz -----------------------------

test('_isLikelyHallucination: Sender, Funk, Untertitel, Copyright in Prosa bleiben', () => {
  assert.equal(m._isLikelyHallucination('Sie arbeitete zwanzig Jahre beim SRF.'), false);
  assert.equal(m._isLikelyHallucination('Der Funk fiel im Winter 1943 aus.'), false);
  assert.equal(m._isLikelyHallucination('Die Untertitel liefen bis 2003 mit.'), false);
  assert.equal(m._isLikelyHallucination('Untertitel waren damals selten.'), false);
  assert.equal(m._isLikelyHallucination('Copyright war ihr egal.'), false);
});

test('_isLikelyHallucination: Boilerplate als ganzes Segment', () => {
  assert.equal(m._isLikelyHallucination('ZDF, 2021'), true);
  assert.equal(m._isLikelyHallucination('SRF'), true);
  assert.equal(m._isLikelyHallucination('Copyright 2019 WDR'), true);
  assert.equal(m._isLikelyHallucination('© 2020'), true);
  assert.equal(m._isLikelyHallucination('Untertitel im Auftrag des ZDF für funk, 2017'), true);
  assert.equal(m._isLikelyHallucination('Untertitelung des NDR, 2020'), true);
});

test('_isLikelyHallucination: Modell sicher -> nie verworfen, unsicher -> Liste greift', () => {
  assert.equal(m._isLikelyHallucination('Tschüss.', false), false);
  assert.equal(m._isLikelyHallucination('Vielen Dank.', false), false);
  assert.equal(m._isLikelyHallucination('Tschüss.', true), true);
  assert.equal(m._isLikelyHallucination('Tschüss.', null), true);
  assert.equal(m._isLikelyHallucination('Sie lachte.', true), false);
});
