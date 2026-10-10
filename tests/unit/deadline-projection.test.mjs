// Tests fuer die pure Deadline-Projektion (Schreibziel pro Buch).
// Quelle ist der book_stats_history-Snapshot-Verlauf + Live-Zeichenstand.
import test from 'node:test';
import assert from 'node:assert/strict';

// utils/date.js liest window.__app fuer die Timezone — minimal stubben.
globalThis.window = { __app: { uiLocale: 'de' } };

const { computeDeadlineProjection } =
  await import('../../public/js/book-overview/projection.js');

// Lokaler Spiegel der internen isoAddDays-Arithmetik fuer Erwartungswerte.
function isoAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Fester Stichtag (lokaler Mittag) — deterministische Tagesarithmetik.
const TODAY = new Date('2026-06-20T12:00:00');
const ISO_TODAY = '2026-06-20';

test('computeDeadlineProjection: ohne Ziel → active false', () => {
  assert.equal(computeDeadlineProjection([], 0, { targetChars: 0 }).active, false);
  assert.equal(computeDeadlineProjection([], 0, { targetChars: null }).active, false);
});

test('computeDeadlineProjection: Schnitt aus 30-Tage-Fenster + Fertigdatum', () => {
  const stats = [
    { recorded_at: '2026-05-21', chars: 10000 }, // Basis (heute − 30 T)
    { recorded_at: ISO_TODAY,    chars: 40000 }, // aktuell
  ];
  const r = computeDeadlineProjection(stats, 0, { targetChars: 100000, todayLocal: TODAY });
  assert.equal(r.active, true);
  assert.equal(r.currentChars, 40000);
  assert.equal(r.remainingChars, 60000);
  assert.equal(r.pace, 1000, '(40000-10000)/30 Tage');
  assert.equal(r.daysNeeded, 60, 'ceil(60000/1000)');
  assert.equal(r.projectedFinishIso, isoAddDays(ISO_TODAY, 60));
  assert.equal(r.stalled, false);
  assert.equal(r.progressPct, 40);
});

test('computeDeadlineProjection: Live-Zeichen ueberschreiben den Snapshot', () => {
  const stats = [
    { recorded_at: '2026-05-21', chars: 10000 },
    { recorded_at: ISO_TODAY,    chars: 40000 },
  ];
  const r = computeDeadlineProjection(stats, 50000, { targetChars: 100000, todayLocal: TODAY });
  assert.equal(r.currentChars, 50000, 'liveChars schlaegt den letzten Snapshot');
  assert.equal(r.pace, Math.round((50000 - 10000) / 30));
});

test('computeDeadlineProjection: Ziel erreicht → reached, Finish heute', () => {
  const stats = [
    { recorded_at: '2026-05-21', chars: 90000 },
    { recorded_at: ISO_TODAY,    chars: 120000 },
  ];
  const r = computeDeadlineProjection(stats, 0, { targetChars: 100000, deadlineIso: '2026-12-31', todayLocal: TODAY });
  assert.equal(r.reached, true);
  assert.equal(r.progressPct, 100, 'gedeckelt');
  assert.equal(r.projectedFinishIso, ISO_TODAY);
  assert.equal(r.onTrack, true);
});

test('computeDeadlineProjection: kein Fortschritt → stalled, keine Projektion', () => {
  const stats = [
    { recorded_at: '2026-05-21', chars: 40000 },
    { recorded_at: ISO_TODAY,    chars: 40000 }, // identisch → pace 0
  ];
  const r = computeDeadlineProjection(stats, 0, { targetChars: 100000, deadlineIso: '2026-12-31', todayLocal: TODAY });
  assert.equal(r.stalled, true);
  assert.equal(r.pace, 0);
  assert.equal(r.projectedFinishIso, null);
  assert.equal(r.onTrack, false, 'ohne Fortschritt unerreichbar');
});

test('computeDeadlineProjection: Deadline mit Puffer → onTrack', () => {
  const stats = [
    { recorded_at: '2026-05-21', chars: 10000 },
    { recorded_at: ISO_TODAY,    chars: 40000 },
  ];
  // Finish ~2026-08-19; Deadline weit danach → Puffer positiv.
  const r = computeDeadlineProjection(stats, 0, { targetChars: 100000, deadlineIso: '2026-12-31', todayLocal: TODAY });
  assert.equal(r.onTrack, true);
  assert.ok(r.daysBuffer > 0);
  assert.ok(r.requiredPace < r.pace, 'noetiger Schnitt unter dem aktuellen');
});

test('computeDeadlineProjection: Deadline zu knapp → behind', () => {
  const stats = [
    { recorded_at: '2026-05-21', chars: 10000 },
    { recorded_at: ISO_TODAY,    chars: 40000 },
  ];
  // Finish ~2026-08-19; Deadline vorher → Puffer negativ.
  const r = computeDeadlineProjection(stats, 0, { targetChars: 100000, deadlineIso: '2026-07-01', todayLocal: TODAY });
  assert.equal(r.onTrack, false);
  assert.ok(r.daysBuffer < 0);
  assert.equal(r.daysUntilDeadline, 11);
  assert.ok(r.requiredPace > r.pace, 'mehr Tempo noetig als aktuell');
});

test('computeDeadlineProjection: Buch juenger als 30 Tage → aeltester Snapshot als Basis', () => {
  const stats = [
    { recorded_at: '2026-06-10', chars: 5000 },  // erst 10 Tage alt
    { recorded_at: ISO_TODAY,    chars: 20000 },
  ];
  const r = computeDeadlineProjection(stats, 0, { targetChars: 100000, todayLocal: TODAY });
  // Spanne 10 Tage: (20000-5000)/10 = 1500
  assert.equal(r.pace, 1500);
});

test('computeDeadlineProjection: Import-Sprung zaehlt nicht als Schreibtempo', () => {
  const stats = [
    { recorded_at: '2026-06-14', chars: 0 },
    { recorded_at: '2026-06-15', chars: 250000 }, // Import an einem Tag
  ];
  const r = computeDeadlineProjection(stats, 255000, { targetChars: 300000, todayLocal: TODAY });
  assert.equal(r.jumpsExcluded, 1);
  // Nur die 5000 Zeichen nach dem Import zaehlen, verteilt auf 6 Tage Verlauf.
  assert.equal(r.pace, Math.round(5000 / 6));
  assert.equal(r.daysNeeded, Math.ceil(45000 / Math.round(5000 / 6)));
});

test('computeDeadlineProjection: grosse Loeschung (Kapitel verschoben) kippt den Schnitt nicht ins Minus', () => {
  const stats = [
    { recorded_at: '2026-05-21', chars: 200000 },
    { recorded_at: '2026-06-01', chars: 211000 },
    { recorded_at: '2026-06-02', chars: 120000 }, // Kapitel in anderes Buch
  ];
  const r = computeDeadlineProjection(stats, 129000, { targetChars: 300000, todayLocal: TODAY });
  assert.equal(r.jumpsExcluded, 1);
  assert.equal(r.pace, Math.round(20000 / 30));
  assert.equal(r.stalled, false);
});

test('computeDeadlineProjection: zu wenig Verlauf → kein „kein Fortschritt"-Urteil', () => {
  const stats = [{ recorded_at: ISO_TODAY, chars: 10000 }];
  const r = computeDeadlineProjection(stats, 10000, { targetChars: 300000, deadlineIso: '2026-12-31', todayLocal: TODAY });
  assert.equal(r.pace, 0);
  assert.equal(r.stalled, false);
  assert.equal(r.insufficientHistory, true);
  assert.equal(r.onTrack, null, 'Deadline-Urteil bleibt offen');
  assert.equal(r.projectedFinishIso, null);
});

test('computeDeadlineProjection: stalledDays folgt der tatsaechlichen Spanne', () => {
  const stats = [
    { recorded_at: '2026-06-10', chars: 40000 },
    { recorded_at: ISO_TODAY,    chars: 40000 },
  ];
  const r = computeDeadlineProjection(stats, 0, { targetChars: 100000, todayLocal: TODAY });
  assert.equal(r.stalled, true);
  assert.equal(r.stalledDays, 10);
});

test('computeDeadlineProjection: Deadline in der Vergangenheit → deadlinePassed', () => {
  const stats = [
    { recorded_at: '2026-05-21', chars: 10000 },
    { recorded_at: ISO_TODAY,    chars: 40000 },
  ];
  const r = computeDeadlineProjection(stats, 0, { targetChars: 100000, deadlineIso: '2026-06-01', todayIso: ISO_TODAY });
  assert.equal(r.deadlinePassed, true);
  assert.equal(r.daysUntilDeadline, -19);
  assert.equal(r.requiredPace, null);
  // Erreicht → kein „überschritten", auch wenn die Deadline vorbei ist.
  const done = computeDeadlineProjection(stats, 0, { targetChars: 30000, deadlineIso: '2026-06-01', todayIso: ISO_TODAY });
  assert.equal(done.deadlinePassed, false);
  // Deadline heute ist noch nicht überschritten.
  const today = computeDeadlineProjection(stats, 0, { targetChars: 100000, deadlineIso: ISO_TODAY, todayIso: ISO_TODAY });
  assert.equal(today.deadlinePassed, false);
});

test('computeDeadlineProjection: todayIso hat Vorrang vor todayLocal', () => {
  // Kalendertag kommt aus appTimezone (localIsoDate), nicht aus dem Browser-
  // Kalender — der Aufrufer reicht ihn als ISO-String durch.
  const stats = [{ recorded_at: '2026-05-21', chars: 10000 }];
  const r = computeDeadlineProjection(stats, 40000, { targetChars: 100000, todayIso: '2026-06-21', todayLocal: TODAY });
  assert.equal(r.historyDays, 31);
});
