// Schreibziel-Deadline-Projektion (per Buch): Zielzeichenzahl + optionales
// Abgabedatum → "bei deinem Schnitt fertig am ...". Reine Compute-Funktion
// (frei von Alpine/DOM) → unit-testbar (tests/unit/deadline-projection.test.mjs).
// Quelle ist der book_stats_history-Snapshot-Verlauf (overviewStats) plus der
// Live-Zeichenstand aus tokEsts. Schnitt = Zeichen-Zuwachs der letzten 30 Tage
// geteilt durch die tatsaechliche Snapshot-Spanne, ohne Struktur-Spruenge.
import { localIsoDate } from '../utils.js';
import { isoAddDays, isoDaysBetween } from './iso-day.js';

const PACE_WINDOW_DAYS = 30;

// Ab dieser Tagesrate (Zeichen/Tag, in beide Richtungen) gilt ein Abschnitt
// zwischen zwei Snapshots als Struktur-Sprung — Import, eingefuegtes Kapitel,
// Seiten in ein anderes Buch verschoben — und nicht als Schreibtempo. Rund
// 17 Normseiten am Tag schreibt niemand von Hand; ein einziger Import ueber
// 250'000 Zeichen machte aus dem Schnitt sonst „fertig in zwei Tagen".
export const JUMP_CHARS_PER_DAY = 30000;

// Mindest-Verlauf fuer das Urteil „kein Fortschritt". Darunter ist ein Schnitt
// von 0 keine Aussage (frisches Buch, Ziel eben gesetzt), sondern Datenmangel.
export const MIN_HISTORY_DAYS = 7;

/**
 * Deadline-Projektion fuer ein Buch.
 * @param {Array} stats   book_stats_history-Rows { recorded_at (YYYY-MM-DD), chars } aufsteigend.
 * @param {number|null} liveChars  Vollständiger Live-Stand (aus tokEsts); null/0 = unbekannt → Fallback Snapshot.
 * @param {{targetChars:number, deadlineIso?:string, todayIso?:string, todayLocal?:Date}} opts
 *   `todayIso` (appTimezone-Kalendertag) hat Vorrang; `todayLocal` wird nur
 *   per localIsoDate() auf einen Kalendertag abgebildet.
 * @returns {object} { active, ... } — bei fehlendem Ziel { active:false }.
 */
export function computeDeadlineProjection(stats, liveChars, { targetChars, deadlineIso = null, todayIso = null, todayLocal = new Date() } = {}) {
  const target = Math.round(Number(targetChars) || 0);
  if (!target || target <= 0) return { active: false };

  const rows = Array.isArray(stats) ? stats : [];
  const latestSnap = rows.length ? (Number(rows[rows.length - 1].chars) || 0) : 0;
  const current = (Number(liveChars) || 0) > 0 ? Math.round(Number(liveChars)) : latestSnap;

  const isoToday = todayIso || localIsoDate(new Date(todayLocal));

  // Basis-Snapshot fuer den Schnitt: letzter Snapshot am/vor (heute − 30 Tage).
  // Fehlt einer (Buch juenger als 30 Tage), nimm den aeltesten Snapshot.
  const cutoffIso = isoAddDays(isoToday, -PACE_WINDOW_DAYS);
  const dated = rows.filter(s => s.recorded_at && s.recorded_at <= isoToday);
  let baseIdx = -1;
  for (let i = 0; i < dated.length; i++) {
    if (dated[i].recorded_at <= cutoffIso) baseIdx = i;
  }
  if (baseIdx < 0 && dated.length) baseIdx = 0;
  const baseIso = baseIdx >= 0 ? dated[baseIdx].recorded_at : null;
  const historyDays = baseIso != null ? isoDaysBetween(baseIso, isoToday) : 0;

  // Zuwachs abschnittsweise summieren (Basis → Snapshots → Live-Stand heute),
  // Struktur-Spruenge (siehe JUMP_CHARS_PER_DAY) fallen heraus. Die Zeit, die
  // sie umspannen, bleibt im Nenner: geschrieben wurde in ihr ja trotzdem nicht.
  let pace = 0; // Zeichen/Tag
  let jumpsExcluded = 0;
  if (baseIso != null) {
    const points = dated.slice(baseIdx).map(s => ({ iso: s.recorded_at, chars: Number(s.chars) || 0 }));
    points.push({ iso: isoToday, chars: current });
    let gained = 0;
    for (let i = 1; i < points.length; i++) {
      const delta = points[i].chars - points[i - 1].chars;
      const days = Math.max(1, isoDaysBetween(points[i - 1].iso, points[i].iso));
      if (Math.abs(delta) / days > JUMP_CHARS_PER_DAY) { jumpsExcluded++; continue; }
      gained += delta;
    }
    pace = gained / Math.max(1, historyDays);
  }
  pace = Math.round(pace);
  const insufficientHistory = baseIso == null || historyDays < MIN_HISTORY_DAYS;

  const remaining = Math.max(0, target - current);
  const progressPct = Math.min(100, Math.round((current / target) * 100));
  const reached = current >= target;

  const result = {
    active: true,
    targetChars: target,
    currentChars: current,
    remainingChars: remaining,
    progressPct,
    reached,
    pace,                          // juengster Schnitt, Zeichen/Tag (kann 0/negativ)
    jumpsExcluded,                 // aus dem Schnitt genommene Struktur-Spruenge
    historyDays,                   // Tage Verlauf, auf denen der Schnitt beruht
    // Zu wenig Verlauf UND kein messbarer Zuwachs → keine Prognose, aber auch
    // kein „kein Fortschritt"-Urteil.
    insufficientHistory: !reached && pace <= 0 && insufficientHistory,
    stalled: !reached && pace <= 0 && !insufficientHistory,
    stalledDays: Math.min(PACE_WINDOW_DAYS, historyDays),
    deadlineIso: deadlineIso || null,
    // Deadline liegt vor heute (und Ziel nicht erreicht): eigener Zustand
    // „überschritten seit …" statt Puffer-/Verzug-Prognose.
    deadlinePassed: false,
    daysNeeded: null,
    projectedFinishIso: null,
    daysUntilDeadline: null,
    requiredPace: null,
    daysBuffer: null,
    onTrack: null,
  };

  if (reached) {
    result.projectedFinishIso = isoToday;
    result.onTrack = true;
    result.daysNeeded = 0;
  } else if (pace > 0) {
    const daysNeeded = Math.ceil(remaining / pace);
    result.daysNeeded = daysNeeded;
    result.projectedFinishIso = isoAddDays(isoToday, daysNeeded);
  }

  if (deadlineIso) {
    const daysUntilDeadline = isoDaysBetween(isoToday, deadlineIso);
    result.daysUntilDeadline = daysUntilDeadline;
    result.deadlinePassed = !reached && daysUntilDeadline < 0;
    // Noetiger Schnitt, um die Deadline zu treffen (Restzeichen / Resttage).
    result.requiredPace = (!reached && daysUntilDeadline > 0) ? Math.ceil(remaining / daysUntilDeadline) : null;
    if (result.projectedFinishIso) {
      // Puffer = Deadline − projiziertes Fertigdatum (positiv = vor der Deadline).
      result.daysBuffer = isoDaysBetween(result.projectedFinishIso, deadlineIso);
      result.onTrack = result.daysBuffer >= 0;
    } else {
      // Kein Fortschritt → Deadline unerreichbar; bei zu wenig Verlauf offen.
      result.onTrack = result.insufficientHistory ? null : false;
    }
  }

  return result;
}

export const projectionMethods = {
  // Card-Wrapper: liest overviewStats + Live-tokEsts + Buch-Ziel/Deadline.
  overviewGoalProjection() {
    const stats = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    const target = this.overviewGoalTargetChars;
    const deadline = this.overviewGoalDeadline;
    const pages = Alpine.store('nav').pages || [];
    const todayIso = this._todayIso();
    return this._memo('goalProjection', [stats, tokEsts, pages, target, deadline, todayIso], () => {
      const live = this._liveTotals();
      return computeDeadlineProjection(stats, live ? live.chars : null, { targetChars: target, deadlineIso: deadline, todayIso });
    });
  },

  // Methode (kein Getter): bookOverviewMethods wird gespreadet — ein Getter
  // wuerde beim Spread evaluiert statt durchgereicht (window noch undefiniert).
  overviewHasGoal() {
    return this.overviewGoalProjection().active;
  },

  // Projiziertes Fertigdatum / Deadline lesbar formatieren — ein Kalendertag,
  // darum über _isoDayLabel (UTC-Mittag + timeZone UTC, siehe stats.js).
  overviewGoalDateLabel(iso) {
    return iso ? this._isoDayLabel(iso) : '';
  },
};
