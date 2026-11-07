// Alter einer Figur zu einem Zeitpunkt — EINE Rechnung für Browser und Server:
// der Stichtag im Reiter «Alter» der Figuren-Karte (book/figuren-alter.js) und das
// Buch-Chat-Werkzeug `get_figure_age` (routes/jobs/chat-tools/tools-timeline.js,
// via lib/esm-bridge). Liefen beide auseinander, nennte der Chat ein anderes Alter
// als die Tabelle.

/** Alter zum Zeitpunkt `at` bei Geburt `birth` (je {y, m?, d?}). Mit Monat (+Tag) auf
 *  beiden Seiten exakt, sonst als Spanne [n−1, n] — ohne Geburtstag im Jahr ist nicht
 *  entscheidbar, ob er schon war. `vor_geburt`, wenn der Zeitpunkt sicher davor liegt. */
export function ageAt(birth, at) {
  if (!Number.isInteger(birth?.y) || !Number.isInteger(at?.y)) return null;
  const n = at.y - birth.y;
  let von = n - 1, bis = n;
  if (birth.m && at.m) {
    if (at.m > birth.m) von = bis = n;
    else if (at.m < birth.m) von = bis = n - 1;
    else if (birth.d && at.d) von = bis = (at.d >= birth.d ? n : n - 1);
  }
  const out = von === bis ? { alter: bis, exakt: true } : { alter_von: von, alter_bis: bis, exakt: false };
  if (bis < 0) out.vor_geburt = true;
  return out;
}
