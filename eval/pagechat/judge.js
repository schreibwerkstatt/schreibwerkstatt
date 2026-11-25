'use strict';
// Blinder Paarvergleich zweier Eval-Läufe desselben Falls. Der Bewerter sieht
// Abschnitt (Stand zur Fragezeit), Verlauf, Frage und beide Antworten — und als
// Referenz IMMER die Volldossiers der Kapitelfiguren, damit er erkennt, wenn eine
// schlankere Variante Figurenwissen verliert oder erfindet. Die Reihenfolge A/B ist
// je Fall fest aus der Fall-ID abgeleitet (reproduzierbar, im Mittel ausgeglichen).

const crypto = require('crypto');

const JUDGE_RULES = `Du vergleichst zwei Antworten eines KI-Schreibassistenten auf dieselbe Frage einer Autorin oder eines Autors zu einem Abschnitt ihres Buchs. Beurteile, welche Antwort der Person beim Schreiben mehr hilft.

Kriterien, in dieser Reihenfolge:
1. Trifft die Antwort die Frage? Eine Antwort, die an der Frage vorbeigeht, verliert, auch wenn sie sonst gut ist.
2. Stimmt sie mit dem Abschnitt und der Figuren-Referenz überein? Erfundene oder falsche Angaben zu Figuren, Handlung oder Text wiegen schwer. Die Figuren-Referenz ist vollständig; die Antworten können weniger davon gesehen haben.
3. Sind die Textvorschläge (Original → Ersatz) konkret, treffen sie eine echte Schwäche und halten sie den Ton des Textes?
4. Ist die Antwort so knapp, wie die Frage es erlaubt?

Antworte «gleich», wenn sich die beiden in diesen Punkten nicht relevant unterscheiden; erzwinge keinen Sieger. Nenne die Mängel jeder Antwort einzeln und knapp, mit dem konkreten Fehler.`;

const SCHEMA = {
  type: 'object',
  properties: {
    begruendung: { type: 'string' },
    maengel_a: { type: 'array', items: { type: 'string' } },
    maengel_b: { type: 'array', items: { type: 'string' } },
    besser: { type: 'string', enum: ['A', 'B', 'gleich'] },
  },
  required: ['begruendung', 'maengel_a', 'maengel_b', 'besser'],
  additionalProperties: false,
};

function _swap(caseId) {
  return crypto.createHash('sha1').update(String(caseId)).digest()[0] % 2 === 1;
}

function _render(r) {
  const parts = [`Antworttext:\n${r.antwort || '(leer)'}`];
  if (r.vorschlaege?.length) {
    parts.push('Textvorschläge:\n' + r.vorschlaege.map((v, i) =>
      `${i + 1}. «${v.original}» → «${v.ersatz}» (${v.typ || '-'}; ${v.begruendung || ''})${v.match ? ` [Stelle ${v.match === 'not_found' ? 'nicht gefunden' : 'mehrdeutig'}]` : ''}`).join('\n'));
  }
  if (r.ideen?.length) parts.push('Ideen-Vorschläge:\n' + r.ideen.map(p => `- ${p.inhalt || ''}${p.status ? ` [${p.status}]` : ''}`).join('\n'));
  if (r.titel_varianten?.length) parts.push('Titelvarianten: ' + r.titel_varianten.join(' | '));
  return parts.join('\n\n');
}

async function judgePair(a, b, ref, { callAI, parseJSON, jsonOnly }) {
  const swap = _swap(a.id);
  const [first, second] = swap ? [b, a] : [a, b];
  const system = [
    { text: `${JUDGE_RULES}\n\n${jsonOnly}` },
    { text: `=== FIGUREN-REFERENZ (vollständig) ===\n${ref || '(keine Figuren erfasst)'}` },
  ];
  const prompt = [
    '=== ABSCHNITT (Stand zur Zeit der Frage) ===', a.abschnitt || '', '',
    ...(a.verlauf ? ['=== BISHERIGES GESPRÄCH ===', a.verlauf, ''] : []),
    '=== FRAGE ===', a.frage || '', '',
    '=== ANTWORT A ===', _render(first), '',
    '=== ANTWORT B ===', _render(second),
  ].join('\n');
  const res = await callAI(prompt, system, null, 8000, null, 'claude', SCHEMA);
  if (res.truncated) throw new Error('Bewertung abgeschnitten (Ausgabe-Deckel)');
  const out = typeof res.text === 'string' ? parseJSON(res.text) : res.text;
  if (!out || !['A', 'B', 'gleich'].includes(out.besser)) throw new Error('Bewertung ohne Feld «besser»');
  // Zurück auf die Lauf-Namen: «a» = erster Lauf des Vergleichs, «b» = zweiter.
  const winner = out.besser === 'gleich' ? 'gleich' : ((out.besser === 'A') !== swap ? 'a' : 'b');
  return {
    winner,
    begruendung: out.begruendung,
    maengel_a: swap ? out.maengel_b : out.maengel_a,
    maengel_b: swap ? out.maengel_a : out.maengel_b,
    usage: { tokensIn: res.tokensIn || 0, tokensOut: res.tokensOut || 0, cacheRead: res.cacheReadIn || 0 },
  };
}

module.exports = { judgePair, JUDGE_SCHEMA: SCHEMA };
