'use strict';
// Nachrichtenverlauf in den Textwegen (Markdown, Substack, TXT): eine
// gemeinsame Zeilenkonvention, das Zielformat liefert nur die Auszeichnung.
//
//   Absender      → `name(t)`  (Markdown/Substack fett, TXT „Lena:")
//   Hinweis       → `meta(t)`  (Markdown/Substack kursiv, TXT „[14:32]")
//   eingehend     → Text
//   ausgehend     → „→ " + Text
//
// Ein Umbruch (`<br>`) in einer Nachricht bleibt ein Umbruch. Die Folgezeilen
// JEDER Nachricht rücken um die Breite von „→ " ein (`indent`, je Format ein
// Zwischenraum, der dort nicht kollabiert): ausgehend stehen sie so unter dem
// Text, eingehend sind sie von einer neuen Nachricht zu unterscheiden — ohne
// Einzug läse sich eine zweizeilige Nachricht als zwei. Absender und Hinweis
// sind Etiketten: ein Umbruch darin wird ein Leerzeichen.
//
// Die Auszeichnung des Etiketts selbst (fett bzw. kursiv) wird aus den Runs
// genommen, bevor `name`/`meta` umhüllt — sonst stünde der Name doppelt fett
// (`****Lena**:**`) und eine kursive Zeit kippte zurück (`**14:32**`).

const ARROW = '→ ';

function _labelRuns(runs, drop) {
  return (runs || []).map((r) => (r.text === '\n' ? { ...r, text: ' ' } : { ...r, [drop]: false }));
}

function _splitAtBreaks(runs) {
  const parts = [[]];
  for (const r of runs || []) {
    if (r.text === '\n') parts.push([]);
    else parts[parts.length - 1].push(r);
  }
  return parts;
}

/**
 * @param {{ kind: string, runs: object[] }[]} lines  Walker-Zeilen
 * @param {{ runs: (runs: object[]) => string, name: (t: string) => string,
 *   meta: (t: string) => string, indent: string, line?: (t: string) => string }} fmt
 *   `line` bearbeitet jede Textzeile einer Nachricht (z.B. Markdown-Escape
 *   des Zeilenanfangs), bevor Pfeil oder Einzug davorkommen.
 * @returns {string[]} physische Zeilen in Reihenfolge
 */
function msgTextRows(lines, fmt) {
  const lineFn = fmt.line || ((t) => t);
  const rows = [];
  for (const l of lines || []) {
    if (l.kind === 'name' || l.kind === 'meta') {
      const t = fmt.runs(_labelRuns(l.runs, l.kind === 'name' ? 'bold' : 'italic')).trim();
      if (t) rows.push(l.kind === 'name' ? fmt.name(t) : fmt.meta(t));
      continue;
    }
    const subs = _splitAtBreaks(l.runs).map((rs) => fmt.runs(rs).trim()).filter(Boolean).map(lineFn);
    if (!subs.length) continue;
    const lead = l.kind === 'out' ? ARROW : '';
    subs.forEach((t, i) => rows.push(i === 0 ? lead + t : fmt.indent + t));
  }
  return rows;
}

module.exports = { msgTextRows };
