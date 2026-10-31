// Synonym-Suche (Kontextmenü im Editor). System-Prompt-Bau lebt in core.js
// (buildSystemSynonym), hier nur User-Prompt-Builder + Schema.

import { _obj, _str } from './schema-utils.js';
import { windowAround } from '../editor/shared/synonym-text.js';

// Deckel für den Satz-Kontext. Der Editor schickt höchstens SENTENCE_MAX
// (600) Zeichen; der Server deckelt zusätzlich, weil ältere oder fremde
// Clients ganze Absätze schicken können.
export const SYNONYM_SATZ_MAX = 1000;

// Steigt bei jeder Änderung an buildSynonymPrompt — der Prompt-Body hängt an
// Call-Argumenten und fliesst nicht in PROMPTS_VERSION, ohne diese Zahl
// lieferte der synonym_cache weiter Antworten des alten Prompts.
export const SYNONYM_PROMPT_REV = 2;

const MARK_OPEN = '⟦';
const MARK_CLOSE = '⟧';

/** Satz für den Prompt: auf SYNONYM_SATZ_MAX gekürzt und das gesuchte Wort
 *  an seinem ersten Vorkommen mit ⟦…⟧ markiert, damit das Modell bei
 *  mehrfachem Vorkommen weiss, welche Stelle gemeint ist. */
export function prepareSynonymSatz(wort, satz) {
  const clean = String(satz || '').replace(/[⟦⟧]/g, '').replace(/\s+/g, ' ').trim();
  const w = String(wort || '').trim();
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}\\p{N}])`, 'u');
  const m = w ? re.exec(clean) : null;
  const idx = m ? m.index + m[1].length : -1;
  const cut = windowAround(clean, Math.max(idx, 0), idx < 0 ? 0 : w.length, SYNONYM_SATZ_MAX);
  if (idx < 0) return cut;
  const m2 = re.exec(cut);
  if (!m2) return cut;
  const at = m2.index + m2[1].length;
  return cut.slice(0, at) + MARK_OPEN + m2[2] + MARK_CLOSE + cut.slice(at + m2[2].length);
}

const TEXT = {
  de: (wort, satz) => `Schlage bis zu 10 Synonyme für das Wort «${wort}» vor, die im gegebenen Satzkontext passen. Nur einzelne Ersatzwörter, keine Umschreibungen oder Satzumbauten.

Regeln:
- Gemeint ist die Stelle im Satz, die mit ${MARK_OPEN}…${MARK_CLOSE} markiert ist
- Exakt gleiche Wortart und grammatische Form (Kasus, Numerus, Tempus, Geschlecht) wie das Originalwort im Satz
- Bedeutung im Kontext muss erhalten bleiben
- Stil, Ton und Register des Autors berücksichtigen
- Keine offensichtlich unpassenden oder weit entfernten Begriffe
- Duplikate und das Originalwort selbst vermeiden

Antworte mit diesem JSON-Schema:
{
  "synonyme": [
    { "wort": "das Ersatzwort", "hinweis": "kurze Note zu Register/Konnotation, z.B. «gehoben», «umgangssprachlich», «stärker» – darf leer sein" }
  ]
}

Satz: ${satz}
Wort: ${wort}`,
  en: (wort, satz) => `Suggest up to 10 synonyms for the word "${wort}" that fit the given sentence context. Single replacement words only, no paraphrases or restructured sentences.

Rules:
- The occurrence meant is the one marked with ${MARK_OPEN}…${MARK_CLOSE} in the sentence
- Exactly the same part of speech and grammatical form (number, tense, person) as the original word in the sentence
- The meaning in context must be preserved
- Respect the author's style, tone and register
- No obviously unsuitable or far-fetched terms
- Avoid duplicates and the original word itself

Reply with this JSON schema:
{
  "synonyme": [
    { "wort": "the replacement word", "hinweis": "short note on register/connotation, e.g. \\"formal\\", \\"colloquial\\", \\"stronger\\" – may be empty" }
  ]
}

Sentence: ${satz}
Word: ${wort}`,
};

/** `lang` = Buchsprache ('de', 'en', …); unbekannt → Deutsch. `satz` kommt
 *  bereits durch prepareSynonymSatz. */
export function buildSynonymPrompt(wort, satz, lang = 'de') {
  const key = String(lang || '').toLowerCase().startsWith('en') ? 'en' : 'de';
  return TEXT[key](wort, satz);
}

export const SCHEMA_SYNONYM = _obj({
  synonyme: {
    type: 'array',
    items: _obj({ wort: _str, hinweis: _str }),
  },
});
