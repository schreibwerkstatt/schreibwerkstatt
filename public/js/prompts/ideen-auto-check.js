// Automatischer Erledigt-Check der Ideen (Job routes/jobs/ideen-auto-check.js).
// Nach einer grösseren Änderung an einem Abschnitt prüft das Modell die offenen
// Pendenzen, die an DIESEM Abschnitt hängen, gegen seinen aktuellen Text.
// Ergebnis ist kein Schreiben: was eingelöst scheint, wird mit wörtlichem Zitat
// als Hinweis abgelegt; der User hakt selbst ab.
// Deep-Doc: docs/ideen-board.md («Erledigt-Check nach dem Speichern»)

import { _isLocal, JSON_ONLY } from './state.js';
import { _obj, _str } from './schema-utils.js';

export function buildIdeenAutoCheckSystemPrompt() {
  const parts = [
    'Du prüfst für einen Autor / eine Autorin, ob Pendenzen (Notizen zu offenen Punkten an einer Textstelle) im aktuellen Text eines Abschnitts eingelöst sind.',
    '',
    'Regeln:',
    '- Eine Pendenz gilt nur als eingelöst, wenn der Text sie tatsächlich erfüllt — nicht, wenn das Thema bloss vorkommt. Im Zweifel: nicht eingelöst.',
    '- Teilweise eingelöst ist NICHT eingelöst.',
    '- Für jede eingelöste Pendenz zitierst du die Stelle, die sie einlöst, WÖRTLICH aus dem Text (ein bis zwei Sätze, höchstens 300 Zeichen, keine Auslassungen). Ein Zitat, das nicht wörtlich im Text steht, wird verworfen.',
    '- `begruendung`: ein Satz, warum die Stelle die Pendenz einlöst. Sprache: die der Pendenz.',
    '- Nimm nur eingelöste Pendenzen in die Liste auf. Ist keine eingelöst, ist die Liste leer.',
    '',
    'Antworte ausschliesslich als JSON-Objekt: {"eingeloest": [{"idee_id": 12, "beleg": "…", "begruendung": "…"}]}',
  ];
  if (!_isLocal) parts.push('', JSON_ONLY);
  return parts.join('\n');
}

/**
 * @param {string} pageName
 * @param {string} text      Klartext des Abschnitts
 * @param {Array<{id:number, content:string}>} ideen  offene Pendenzen am Abschnitt
 */
export function buildIdeenAutoCheckPrompt(pageName, text, ideen) {
  return [
    `ABSCHNITT «${pageName}»:`,
    '"""',
    String(text || ''),
    '"""',
    '',
    'OFFENE PENDENZEN AN DIESEM ABSCHNITT:',
    ...ideen.map(i => `- [${i.id}] ${String(i.content || '').replace(/\s+/g, ' ').trim()}`),
  ].join('\n');
}

export const SCHEMA_IDEEN_AUTO_CHECK = _obj({
  eingeloest: {
    type: 'array',
    items: _obj({ idee_id: { type: 'integer' }, beleg: _str, begruendung: _str }),
  },
});
