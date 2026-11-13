// Befund-Schwere → visuelle Klasse. EINE Zuordnung für jede Befund-Liste
// (Plot-Konsistenz + Zeit-Messung, Motiv-Messung, Figuren-Werkstatt-Konflikte
// und Bogen-Messung).
//
// Warum nicht einfach `severity-tag--<schwere>`: die geteilte Palette in
// entities/entity-list.css kodiert unter `stark`/`schwach` die STÄRKE einer
// Szene (stark = gut = grün, schwach = rot). Auf der Befund-Skala
// `kritisch > stark > mittel > schwach > niedrig` heisst `stark` aber
// „schwerwiegend" — ungemappt wäre der zweitschwerste Befund grün und der
// zweitleichteste rot. Darum hier drei Stufen absteigender Warnfarbe:
// schwerwiegend → rot, mittel → amber, leicht → neutral.

const TONE = {
  kritisch: 'kritisch',
  stark: 'kritisch',
  mittel: 'mittel',
  schwach: 'niedrig',
  niedrig: 'niedrig',
};

/** Ton-Stufe (`kritisch`|`mittel`|`niedrig`) einer Befund-Schwere. Unbekannt → `niedrig`. */
export function befundSeverityTone(schwere) {
  return TONE[schwere] || 'niedrig';
}

/** `.severity-tag--*`-Klasse für eine Befund-Schwere. */
export function befundSeverityClass(schwere) {
  return 'severity-tag--' + befundSeverityTone(schwere);
}

// In Alpine-Methods-Objekte spreadbar (Templates rufen die Methoden direkt).
export const befundSeverityMethods = {
  befundSeverityClass(schwere) { return befundSeverityClass(schwere); },
  befundSeverityTone(schwere) { return befundSeverityTone(schwere); },
};
