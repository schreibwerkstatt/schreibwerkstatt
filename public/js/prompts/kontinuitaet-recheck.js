// Einzelnes Nachprüfen eines Kontinuitäts-Befunds (Job `kontinuitaet-recheck`).
//
// Der Autor hat einen Befund bearbeitet und will wissen, ob er behoben ist — ohne
// einen ganzen Prüflauf. Das Modell sieht den Befund, den AKTUELLEN Text der beiden
// Stellen und die Abschnitte, die seit dem Befund geändert wurden: die Korrektur
// steht oft an einer dritten Stelle (z. B. eine Geburt in einem früheren Kapitel
// verschoben, damit eine spätere Altersangabe stimmt).
//
// «behoben» braucht einen wörtlichen Beleg aus dem mitgegebenen Text. Der Job prüft
// ihn im Code nach; ein Urteil ohne auffindbaren Beleg erledigt nichts.
//
// Die Rolle (SYSTEM_KONTINUITAET) lebt in prompts/core.js.

import { _obj, _str } from './schema-utils.js';

export const RECHECK_URTEILE = ['behoben', 'teilweise', 'weiterhin'];

/**
 * @param {string} bookName
 * @param {object} issue   { typ, beschreibung, stelle_a, stelle_b, empfehlung }
 * @param {Array<{titel: string, rolle: 'a'|'b'|'geaendert', text: string}>} abschnitte
 * @param {string[]} [figurenInfo]  Kurzzeilen zu beteiligten Figuren (Geburtsjahr …)
 */
export function buildKontinuitaetRecheckPrompt(bookName, issue, abschnitte, figurenInfo = []) {
  const rolleLabel = { a: 'Stelle A des Befunds', b: 'Stelle B des Befunds', geaendert: 'seit dem Befund geändert' };
  const bloecke = abschnitte.map(a =>
    `<abschnitt titel="${String(a.titel || '').replace(/"/g, '\'')}" rolle="${rolleLabel[a.rolle] || a.rolle}">\n${a.text}\n</abschnitt>`,
  ).join('\n\n');
  const figBlock = figurenInfo.length
    ? `\n<figuren>\n${figurenInfo.map(f => `- ${f}`).join('\n')}\n</figuren>\n`
    : '';
  return `<aufgabe>
Im Buch «${bookName}» hat eine frühere Kontinuitätsprüfung den unten stehenden Befund gemeldet. Der Autor hat den Text seither bearbeitet. Prüfe anhand des AKTUELLEN Texts, ob der Widerspruch noch besteht.
</aufgabe>

<befund typ="${issue.typ || 'sonstiges'}">
${issue.beschreibung || ''}
Stelle A: ${issue.stelle_a || '–'}
Stelle B: ${issue.stelle_b || '–'}${issue.empfehlung ? `\nDamalige Empfehlung: ${issue.empfehlung}` : ''}
</befund>
${figBlock}
<aktueller_text>
${bloecke || '(kein Text verfügbar)'}
</aktueller_text>

REGELN FÜR DEIN URTEIL:
- «behoben»: Der Widerspruch besteht im aktuellen Text nicht mehr — weil eine der Stellen geändert, gestrichen oder durch eine Änderung an anderer Stelle stimmig geworden ist.
- «teilweise»: Ein Teil ist gelöst, ein anderer Teil des Widerspruchs besteht weiter, oder die Änderung erzeugt einen neuen, kleineren Widerspruch.
- «weiterhin»: Der Widerspruch besteht unverändert.
- Urteile nur nach dem mitgegebenen Text. Fehlt eine Stelle im Text, weil sie gestrichen wurde, gilt sie als entfernt.
- «beleg»: bei «behoben» und «teilweise» PFLICHT — eine kurze Passage (ein Satz oder Satzteil, höchstens 200 Zeichen), WÖRTLICH und unverändert aus dem aktuellen Text kopiert, die zeigt, woran du die Lösung festmachst. Bei «weiterhin» die Passage, in der der Widerspruch steht. Keine Anführungszeichen hinzufügen, nichts kürzen mit «…».
- «abschnitt»: der Titel des Abschnitts, aus dem der Beleg stammt.
- «begruendung»: ein bis zwei Sätze für den Autor.

<output_format>
Antworte mit diesem JSON-Schema:
{
  "urteil": "behoben|teilweise|weiterhin",
  "begruendung": "…",
  "beleg": "…",
  "abschnitt": "…"
}
</output_format>`;
}

export function buildKontinuitaetRecheckSchema() {
  return _obj({
    urteil: { type: 'string', enum: [...RECHECK_URTEILE] },
    begruendung: _str,
    beleg: _str,
    abschnitt: _str,
  });
}
