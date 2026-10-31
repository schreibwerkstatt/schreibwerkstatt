// Besitz des globalen `editSaving`-Flags im Notebook-Editor (Pflicht-Invariante
// #6, docs/notebook-editor.md).
//
// `editSaving` ist EIN Root-Flag für die gerade offene Seite. Ein Save, der über
// einen Seitenwechsel läuft, darf es in seinem `finally` nicht zurücksetzen:
// `resetPage` hat es beim Wechsel schon geräumt, und inzwischen kann der Save
// der NEUEN Seite es gesetzt haben — ein Reset von aussen öffnete dort die Tür
// für einen parallelen Autosave-PUT (409 gegen den eigenen Schreibvorgang).
//
//   app.editSaving = true;
//   const owner = claimSaveOwner();
//   try { … } finally { if (ownsSave(owner)) app.editSaving = false; }
//
// Gilt für saveEdit, quickSave und «Abschnitt hier teilen» (edit/split.js).

let _owner = null;

/** Markiert den aufrufenden Vorgang als aktuellen Besitzer von `editSaving`. */
export function claimSaveOwner() {
  const token = {};
  _owner = token;
  return token;
}

/** true, wenn `token` noch der jüngste Besitzer ist (dann darf er räumen). */
export function ownsSave(token) {
  if (_owner !== token) return false;
  _owner = null;
  return true;
}
