// Protokoll-Stand der Web-Shell. Von Hand hochzählen, wenn eine Server-Änderung
// eine ältere, noch offene Shell kaputt macht (geänderter Request-/Antwort-
// Vertrag, umbenannte Route, neues Pflichtfeld) — nicht bei jedem Deploy.
//
// Die Shell trägt ihren Stand mit (diese Datei ist Teil des Shell-Manifests),
// der Server liest DIESELBE Datei (lib/version.js#getShellProtocol) und meldet
// den aktuellen Stand in `/config.shellProtocol`. Liegt die Shell darunter, ist
// das Update Pflicht: es wird eingespielt, sobald nichts Ungespeichertes
// verloren geht (boot/sw-register.js), und das Banner lässt sich nicht
// übergehen. Gewöhnliche Deploys laufen über die normale Update-Politik.
export const SHELL_PROTOCOL = 1;
