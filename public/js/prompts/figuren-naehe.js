// Nähe-Einschätzung (Job `figuren-naehe`, docs/graph.md «Nähe»): das Modell liest
// bestehende Beziehungen — Typ, Beschreibung, Rollen der beiden Figuren — und
// schätzt, wie nah sich die beiden emotional sind (−2 … +2). Es legt keine neuen
// Beziehungen an und ändert keinen Typ. Dieselbe Skala füllt die Komplettanalyse
// (prompts/komplett/schema-strings.js, Regel `beziehungen.naehe`).

import { _obj, _str, _num } from './schema-utils.js';
import { _jsonOnly } from './state.js';

export const NAEHE_SKALA = `2 = innig: Zuneigung, Vertrauen, Geborgenheit
1 = zugewandt: freundlich, verbunden
0 = sachlich oder neutral, oder der Text sagt nichts darüber
-1 = kühl: entfremdet, gleichgültig, verletzt
-2 = feindselig: verletzend, verachtend, gefährlich`;

export function buildNaeheSystemPrompt() {
  return `Du bist Lektorin und führst die Figurenkartei eines Romans. Deine Aufgabe ist eng: zu jeder vorgelegten Beziehung schätzt du die EMOTIONALE NÄHE der beiden Figuren auf einer Skala von -2 bis 2.

Massgeblich ist, wie die Beziehung im Text GELEBT wird, nicht was ihr Typ nahelegt. Eine Ehe, in der einer den anderen ignoriert, ist -1, nicht 2. Ein Vater, der sein Kind vernachlässigt, ist -1 oder -2. Ein Kollege, der zum Vertrauten wird, ist 1 oder 2. Die Beschreibung ist dein wichtigster Anhaltspunkt; sagt sie nichts über das Gefühl, ist 0 richtig. Du legst keine Beziehungen an, änderst keinen Typ und übergehst keine Beziehung.${_jsonOnly()}`;
}

/**
 * @param {object} p
 * @param {Array}  p.beziehungen [{ key, typ, von, vonRolle, zu, zuRolle, beschreibung }]
 * @param {string} [p.buchKontext]
 */
export function buildNaehePrompt({ beziehungen = [], buchKontext = '' } = {}) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const zeilen = beziehungen.map(b => {
    const rolle = (n, r) => (r ? `${n} (${r})` : n);
    return `- [${b.key}] ${rolle(b.von, b.vonRolle)} → ${rolle(b.zu, b.zuRolle)} | Typ: ${b.typ}${b.beschreibung ? `\n  ${b.beschreibung}` : ''}`;
  }).join('\n');
  return `Schätze für jede Beziehung die emotionale Nähe der beiden Figuren.
${ctxSeg}
SKALA:
${NAEHE_SKALA}

BEZIEHUNGEN (Schlüssel in eckigen Klammern; der Typ beschreibt die Rolle der zweiten Figur):
${zeilen}

Antworte mit diesem JSON-Schema:
{
  "bewertungen": [ { "key": "r1", "naehe": 0 } ]
}

Regeln:
- Für JEDE Beziehung genau einen Eintrag, key exakt wie vorgelegt.
- naehe: ganzzahlig von -2 bis 2, ohne führendes Plus-Zeichen.`;
}

export function buildNaeheSchema() {
  return _obj({ bewertungen: { type: 'array', items: _obj({ key: _str, naehe: _num }) } });
}
