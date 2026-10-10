// «Aktive Figur» — SSoT fuer jeden Loader, der Figuren in einen KI-Kontext reicht
// (Abschnitts-/Buch-/Plot-Chat, Rueckblick, Kontinuitaetspruefung, Figuren-
// Werkstatt, Recherche-Verknuepfung).
//
// Aktiv heisst `stale = 0`: die letzte Komplettanalyse hat die Figur im Text
// wiedergefunden. Eine ausgemusterte Figur («nicht mehr im Text») bleibt im
// Katalog stehen, damit der Autor sie zusammenfuehren oder loeschen kann — als
// Figur des Buchs darf sie keinem Modell vorgelegt werden, sonst argumentiert es
// mit Personen, die es im Manuskript nicht mehr gibt. Das gilt auch fuer die
// Kanten: eine Beziehung, ein Ereignis, ein Schauplatz oder eine Szene einer
// ausgemusterten Figur faellt mit ihr.
//
// Bewusst NICHT gefiltert wird in Pfaden, die eine Figur aufloesen statt
// vorlegen (Namens-/ID-Lookups von Strang-Hauptfiguren, Merge, Katalog-GET).

/** WHERE-Fragment «Figur ist aktiv» fuer den Tabellen-Alias `alias`. */
function activeFigureSql(alias = 'f') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`activeFigureSql: ungueltiger Alias «${alias}»`);
  return `${alias}.stale = 0`;
}

/** Anzahl aktiver Figuren eines Buchs/Users. */
function countActiveFigures(bookId, userEmail) {
  // Lazy: das Modul bleibt fuer reine SQL-Fragment-Nutzer frei von der DB-Verbindung.
  const { db } = require('../connection');
  return db.prepare(
    `SELECT COUNT(*) AS n FROM figures f WHERE f.book_id = ? AND f.user_email IS ? AND ${activeFigureSql('f')}`
  ).get(bookId, userEmail || null).n;
}

module.exports = { activeFigureSql, countActiveFigures };
