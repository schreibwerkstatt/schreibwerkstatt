// Die Leseansicht des Notebook-Editors im DOM — ein Selektor für alle, die sie
// suchen (Diagramme, Legenden-Nummern, Kastenhöhe, Kommentar-Leiste, Todo-Haken).
//
// Gescopt auf `.page-view-wrap` (editor-body-view.html), weil zwei weitere
// `.page-content-view` im Dokument stehen: der Edit-Container
// (`--editing`, früher im DOM, im Read-Modus leer) und der Revisions-Viewer
// (`.revision-viewer__content`). Ein nacktes `.page-content-view` mit
// Ausschluss-Liste hält nur so lange, wie jemand jeden neuen Träger der Klasse
// in jede Liste nachträgt.

export const READ_VIEW_SEL = '.page-view-wrap .page-content-view';

export function notebookReadView() {
  return document.querySelector(READ_VIEW_SEL);
}
