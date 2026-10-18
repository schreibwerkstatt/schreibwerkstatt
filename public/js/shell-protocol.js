// Protokoll-Stand der Web-Shell. Von Hand hochzählen — nicht bei jedem Deploy,
// sondern nur, wenn eine ältere, noch offene Shell gegen den neuen Server
//   a) kaputt geht (geänderter Request-/Antwort-Vertrag, umbenannte Route,
//      neues Pflichtfeld), oder
//   b) Text verlieren oder verfälschen kann — ein Fix am Save- oder Merge-Pfad
//      gegen Datenverlust, den ein Tab mit offenem Editor sonst nie bekäme.
// Komfort-, Darstellungs- und Konflikt-UI-Fixes ohne Datenverlust laufen über
// die normale Update-Politik.
//
// Die Shell trägt ihren Stand mit (diese Datei ist Teil des Shell-Manifests),
// der Server liest DIESELBE Datei (lib/version.js#getShellProtocol) und meldet
// den aktuellen Stand in `/config.shellProtocol`. Liegt die Shell darunter, ist
// das Update Pflicht: es wird eingespielt, sobald nichts Ungespeichertes
// verloren geht (boot/sw-register.js) — auch mitten im Edit- oder Fokusmodus,
// und das Banner lässt sich nicht übergehen.
// **Why b) trotzdem:** die normale Politik wartet, bis niemand mehr editiert;
// wer den Editor den ganzen Tag offen hat, schriebe bis zum Abend mit dem
// fehlerhaften Save-Code weiter. Der Preis ist bewusst in Kauf genommen: der
// Reload nach einem Autosave verwirft den Undo-Verlauf (nur im Speicher),
// beendet den Fokusmodus und trifft auch Tabs, die nur lesen — darum nur für
// echte Datenverlust-Fixes, sonst wird «Pflicht» zur Routine.
export const SHELL_PROTOCOL = 1;
