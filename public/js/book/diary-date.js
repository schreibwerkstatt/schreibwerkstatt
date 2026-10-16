// Tagesdatum eines Tagebuch-Eintrags aus dem Abschnittsnamen (`YYYY-MM-DD`,
// optional mit Thema dahinter). SSoT aller tagesgenauen Tagebuch-Ansichten im
// Browser: Sidebar-Kalender, Eintrag-Navigation, «An diesem Tag», Zeitraum-Suche
// und die Overview-Kacheln «Lücken & Konsistenz» / «Wochentag-Rhythmus».
//
// Bewusst strenger als der serverseitige `parseDatum` (Rückblick + Coverage):
// diese Ansichten brauchen einen Kalendertag, ein «2020-03 Thema» hat keinen.
// Neue Einträge (Kalender, Kontextmenü, Ordner-Import) tragen immer diese Form.

const DIARY_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})\b/;

/** 'YYYY-MM-DD' oder null. */
export function diaryDayKey(name) {
  const m = DIARY_DATE_RE.exec(name || '');
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
