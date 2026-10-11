// Bearbeitungsstand-Stufen — ESM-SSoT fuer alles, was im Browser laeuft.
// Fachdoku: docs/bearbeitungsstand.md.
//
// Zwei Ketten, eine je Buchart: journalistische Buecher fuehren den Beitrag
// durch die Redaktion (roh → … → freigegeben), alle anderen das Manuskript durch
// die Ueberarbeitung (rohfassung → … → final). Welche gilt, entscheidet der
// Buchtyp (`statusChain`); gespeichert werden beide in derselben Tabelle.
//
// Jede Kette ist GEORDNET: sie ist ein Weg, nicht bloss eine Menge erlaubter
// Werte. Daraus leiten sich Anzeige-Reihenfolge, Fortschritt und der Vergleich
// „weiter als" ab. Beide Ketten sind gleich lang, `statusRank` ist darum ueber
// beide hinweg vergleichbar.
//
// CJS-Spiegel: db/redaktion.js (die Schreibpfade validieren synchron und
// koennen kein ESM importieren) und der CHECK-Constraint von
// `page_editorial_status.status` (Vereinigung beider Ketten). Drift ist durch
// tests/unit/redaktion-status.test.mjs gegated — neue Stufe heisst: hier, dort,
// im CHECK und in beiden Locale-Dateien (`redaktion.status.<key>`).

export const REDAKTION_STATUS = ['roh', 'gegengelesen', 'schlussredigiert', 'freigegeben'];
export const MANUSKRIPT_STATUS = ['rohfassung', 'ueberarbeitet', 'redigiert', 'final'];

/** Stufe, ab der ein Beitrag bzw. ein Abschnitt fertig ist. */
export const REDAKTION_STATUS_DONE = 'freigegeben';
export const MANUSKRIPT_STATUS_DONE = 'final';

/** Kette des Buchs. `journalistic` = isJournalisticBuchtyp(buchtyp). */
export function statusChain(journalistic) {
  return journalistic ? REDAKTION_STATUS : MANUSKRIPT_STATUS;
}

/** Position in ihrer Kette (0-basiert), -1 fuer unbekannt/ungesetzt. */
export function statusRank(v) {
  const r = REDAKTION_STATUS.indexOf(v);
  return r >= 0 ? r : MANUSKRIPT_STATUS.indexOf(v);
}

/**
 * i18n-Key des Stufen-Labels. Eigener Helper statt eines Template-Literals an
 * fuenf Stellen — der Praefix ist damit genau einmal geschrieben.
 */
export function statusLabelKey(v) {
  return `redaktion.status.${v}`;
}

/**
 * Stand eines Kapitels: die SCHWAECHSTE Stufe seiner Abschnitte. Ein Kapitel ist
 * so weit wie sein schlechtester Abschnitt — ein eigener Kapitel-Status wuerde
 * neben den Abschnitten driften. Ein Abschnitt ohne Stufe zieht das Kapitel auf
 * „ohne" (null); ohne Abschnitte gibt es keinen Stand (null).
 *
 * `stale` (irgendein Abschnitt seit dem Setzen geaendert) wandert mit hoch, damit
 * ein „final" im Kapitelkopf nicht verschweigt, dass darunter wieder gearbeitet
 * wurde.
 *
 * @param {Array<{status?:string, stale?:boolean}|null>} entries je Abschnitt
 * @returns {{status: string|null, stale: boolean, set: number, total: number}|null}
 */
export function weakestStatus(entries) {
  const list = entries || [];
  if (!list.length) return null;
  let min = Infinity;
  let minStatus = null;
  let stale = false;
  let set = 0;
  for (const e of list) {
    const rank = statusRank(e?.status);
    if (rank < 0) { min = -1; minStatus = null; continue; }
    set++;
    if (e.stale) stale = true;
    if (rank < min) { min = rank; minStatus = e.status; }
  }
  return { status: min < 0 ? null : minStatus, stale, set, total: list.length };
}

/**
 * Verteilung ueber die Stufen einer Kette: { <stufe>: n, …, ohne: n, stale: n }.
 * `ohne` zaehlt die Abschnitte ohne Stufe — ohne die Zahl liest sich eine
 * Verteilung als „alles erfasst", obwohl die Haelfte nie angefasst wurde.
 * `stale` zaehlt quer dazu die seit dem Setzen geaenderten.
 *
 * @param {Array<string|number>} pageIds Abschnitte im Scope
 * @param {Record<string, {status:string, stale?:boolean}>} byPage Stufen-Map
 * @param {string[]} chain Kette des Buchs
 */
export function statusDistribution(pageIds, byPage, chain) {
  const counts = Object.fromEntries(chain.map(s => [s, 0]));
  counts.ohne = 0;
  counts.stale = 0;
  for (const id of pageIds || []) {
    const e = byPage?.[String(id)];
    if (e && e.status in counts) {
      counts[e.status]++;
      if (e.stale) counts.stale++;
    } else {
      counts.ohne++;
    }
  }
  return counts;
}
