// SSoT des kurzen Anzeigenamens einer Figur (Chips, Filter-Optionen, Graph-Knoten,
// Vorschau-Listen, Plot-Zeitachse).
//
// Der Kurzname ersetzt den Namen nur, wenn der Name aus mehreren Wörtern besteht
// («Anna Berger» → «Anna»). Ein einteiliger Name ist schon kurz; ein Kurzname dort
// verkürzt nichts, sondern ersetzt — und die Analyse füllt `kurzname` gelegentlich
// mit einem Kürzel aus dem Text (Signatur, Album-Titel), das als Anzeigename
// unlesbar ist. Der volle Name bleibt in Tooltip/Vorschau sichtbar.
//
// Nicht hier: Suchtexte (dort zählen Name UND Kurzname) und Prompts (dort steht
// der Kurzname als Variante neben dem Namen).

export function figurAnzeigeName(f) {
  if (!f) return '';
  const name = String(f.name || '').trim();
  const kurz = String(f.kurzname || '').trim();
  if (!kurz) return name;
  if (!name) return kurz;
  return /\s/.test(name) ? kurz : name;
}
