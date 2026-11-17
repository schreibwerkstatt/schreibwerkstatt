// Autorenprofil-Deutung: verdichtet die BUCH-Stilprofile und die gemessenen
// Kennzahlen zu einer Aussage ueber den Autor — was ueber die Buecher hinweg
// haelt, und was sich verschoben hat. Persona lebt in core.js
// (SYSTEM_AUTORENPROFIL), hier nur User-Prompt-Builder + Schema.
//
// Der Lauf liest KEINEN Buchtext. Die Destillate stehen schon
// (`book_settings.stilprofil`, Job `stilprofil`), und die Zahlen kommen aus
// lib/author-profile.js. Das haelt den Call klein genug fuer ein Werk aus
// mehreren langen Buechern — ein Volltext-Pass ueber vier Romane passt in kein
// Kontextfenster, ein Pass ueber vier Profiltexte in jedes.
//
// Zwei Verbote tragen das Feature:
//   • KEINE Autorennamen, keine Einordnung in den Kanon. Danach gefragt liefert
//     ein Sprachmodell zuverlaessig schmeichelhaftes, unbelegbares Namedropping
//     („erinnert an Sebald") — dieselbe Klasse von Aussage, die in der
//     Quellen-Erkennung kein `doi` erfinden darf und in der Alters-Analyse nicht
//     gerechnet werden darf. Die Einordnung geht gegen die eigenen Buecher.
//   • KEINE Wertung. Die Messwerte sind Zahlen, keine Noten; „zu viele
//     Adverbien" ist eine Aussage, die dieser Lauf nicht treffen soll.

import { _obj, _str, _nullableEnum } from './schema-utils.js';

// Lesbare Kennzahl-Namen FUER DEN PROMPT. Bewusst hier und nicht in der
// i18n: das sind keine UI-Strings, sondern Prompt-Wortlaut — sie folgen der
// Sprache des Prompts, nicht der des Betrachters. Schluessel = die Metrik-Keys
// aus lib/author-profile.js#AUTHOR_PROFILE_METRICS.
export const AUTORENPROFIL_METRIC_LABELS = {
  satzlaenge: 'Satzlänge (Wörter je Satz)',
  dialogAnteil: 'Dialoganteil',
  adverbDichte: 'Adverbdichte',
  passivQuote: 'Passivquote',
  fuellwortDichte: 'Füllwortdichte',
  mattr: 'Wortvielfalt MATTR',
  mtld: 'Wortvielfalt MTLD',
  hapaxRatio: 'Anteil Einmalwörter',
  yuleK: 'Wiederholungsmass Yule K',
  heapsBeta: 'Wortschatz-Zuwachs Heaps beta',
  lexDichte: 'Lexikalische Dichte',
  lix: 'Lesbarkeit LIX',
  fleschDe: 'Lesbarkeit Flesch',
};

// Erlaubte Werte für `kennzahl` eines Befunds. Der Server prüft eine
// Entwicklung mit Kennzahl + Tendenz gegen die Messung
// (lib/author-profile.js#checkProfileFindings), die Karte verknüpft den Befund
// mit seiner Tabellenzeile.
const KENNZAHL_KEYS = Object.keys(AUTORENPROFIL_METRIC_LABELS);

// Sprachnamen FUER DEN PROMPT (gleiche Begruendung wie die Kennzahl-Namen).
// Schluessel = Messsprache aus lib/style-lang.js#styleLanguage.
export const AUTORENPROFIL_LANGUAGE_LABELS = {
  de: 'Deutsch',
  en: 'Englisch',
};

/**
 * @param {object} input
 *   input.messung              vorgerenderte Kennzahlen-Tabelle (Text)
 *   input.profile              [{ titel, stilprofil }] — die Buch-Stilprofile, in Werk-Reihenfolge
 *   input.buecher              Anzahl gemessener Buecher
 *   input.mehrsprachig         Buecher in mehr als einer Sprache
 *   input.entwicklungMoeglich  mindestens zwei Buecher in derselben Sprache
 *                              (lib/author-profile.js#developmentAvailable);
 *                              fehlt es, gilt `buecher >= 2`
 */
export function buildAutorenprofilPrompt({ messung, profile, buecher, mehrsprachig = false, entwicklungMoeglich }) {
  const profilBlock = (profile || []).length
    ? profile.map((p, i) => `--- Buch ${i + 1}: ${p.titel} ---\n${p.stilprofil}`).join('\n\n')
    : '(Für keines der Bücher liegt ein Stilprofil vor.)';

  const entwicklungOk = entwicklungMoeglich ?? buecher >= 2;
  // Ohne Vergleichsbasis faellt der Entwicklungs-Teil WEG statt leer behauptet zu
  // werden — gleiches Muster wie ein fehlender Weltfakten-Block im Prompt.
  // Mehrsprachig gilt Entwicklung nur INNERHALB einer Sprache: ein Unterschied
  // zwischen einem deutschen und einem englischen Buch ist zuerst ein
  // Sprachunterschied, und der Server verwirft Entwicklung ohne gleichsprachiges Paar.
  let entwicklungsAuftrag;
  if (!entwicklungOk && mehrsprachig) {
    entwicklungsAuftrag = `- "entwicklung": LEERES Array. Die Bücher sind in verschiedenen Sprachen geschrieben, und in keiner Sprache liegen zwei Bücher vor. Ein Unterschied zwischen ihnen wäre ein Sprachunterschied, keine Entwicklung. Erfinde keine.`;
  } else if (!entwicklungOk) {
    entwicklungsAuftrag = `- "entwicklung": LEERES Array. Es liegt nur ein Buch vor — es gibt keine Entwicklung, die belegbar wäre. Erfinde keine.`;
  } else if (mehrsprachig) {
    entwicklungsAuftrag = `- "entwicklung": was sich über die Werk-Reihenfolge VERSCHOBEN hat, ausschliesslich zwischen Büchern DERSELBEN Sprache. Vergleiche nie ein Buch mit einem Buch in anderer Sprache. Jede Angabe braucht einen Beleg aus den Zahlen dieser Sprache oder den Buch-Stilprofilen. Nenne die Richtung sachlich ("knapper", "dialogreicher"), nicht als Fortschritt oder Rückschritt.`;
  } else {
    entwicklungsAuftrag = `- "entwicklung": was sich über die Werk-Reihenfolge VERSCHOBEN hat. Jede Angabe braucht einen Beleg aus den Zahlen oder den Buch-Stilprofilen. Nenne die Richtung sachlich ("knapper", "dialogreicher"), nicht als Fortschritt oder Rückschritt.`;
  }

  const konstantenAuftrag = mehrsprachig
    ? `- "konstanten": was über ALLE Bücher hinweg gleich bleibt — der eigentliche Kern der Handschrift, auch über die Sprachgrenze. Sprachübergreifend stützt du dich nur auf die Buch-Stilprofile und den Dialoganteil; die übrigen Zahlen sind zwischen den Sprachen nicht vergleichbar. Jede Angabe mit knappem Beleg.`
    : `- "konstanten": was über ALLE Bücher hinweg gleich bleibt — der eigentliche Kern der Handschrift. Jede Angabe mit knappem Beleg.`;

  return `Du bekommst die Stilprofile mehrerer Bücher EINES Autors sowie gemessene Kennzahlen über diese Bücher. Verdichte beides zu einem Autorenprofil.

HARTE REGELN:
- Nenne KEINE anderen Autoren, keine literarischen Schulen, Epochen oder Vergleichsgrössen. Die Einordnung erfolgt ausschliesslich gegen die eigenen Bücher dieses Autors. Ein Vergleich nach aussen wäre nicht belegbar.
- WERTE NICHT. Kein "gut", "schwach", "zu viel", "sollte". Die Messwerte sind Beschreibungen, keine Noten.
- Behaupte nichts, was weder in den Stilprofilen noch in den Zahlen steht. Wo die Quellen schweigen, schweige auch.
- Die Zahlen sind ein VORBEFUND: verwende sie, wiederhole sie nicht. "Die Satzlänge beträgt 10,2" ist keine Erkenntnis — "die Sätze bleiben über alle Bücher kurz, und der Dialoganteil wächst" ist eine.

Schreibe in korrekter Rechtschreibung mit echten Umlauten (ä, ö, ü), nie als ae/oe/ue umschrieben.

Liefere:
- "autorenprofil": zusammenhängender Text (Richtwert 150-250 Wörter), der die wiedererkennbare Handschrift dieses Autors beschreibt. Kurze Stichwort-Überschriften erlaubt, KEINE Markdown-Tabellen.
${konstantenAuftrag}
${entwicklungsAuftrag}
- "kennzahl" (in "konstanten" und "entwicklung"): stützt sich ein Befund auf genau eine der gemessenen Kennzahlen, deren Schlüssel aus dieser Liste: ${KENNZAHL_KEYS.map(k => `${k} = ${AUTORENPROFIL_METRIC_LABELS[k]}`).join('; ')}. Sonst null (etwa wenn der Befund aus den Stilprofilen folgt).
- "tendenz" (nur in "entwicklung"): "steigt" oder "sinkt" — wie sich der gemessene Wert der genannten Kennzahl über die Werk-Reihenfolge bewegt, abzulesen an den Zahlen und der angegebenen Richtung. Ohne Kennzahl null. Prüfe die Zahlen: ein Wert, der von 155 auf 159 geht, steigt.

Antworte mit diesem JSON-Schema:
{
  "autorenprofil": "Fliesstext",
  "konstanten":  [{ "aspekt": "kurz benannt", "beleg": "woraus das folgt", "kennzahl": "Schlüssel oder null" }],
  "entwicklung": [{ "aspekt": "kurz benannt", "richtung": "wohin es sich bewegt", "beleg": "woraus das folgt", "kennzahl": "Schlüssel oder null", "tendenz": "steigt | sinkt | null" }]
}

GEMESSENE KENNZAHLEN (${buecher} Bücher, in Werk-Reihenfolge):
"""
${messung}
"""

STILPROFILE DER EINZELNEN BÜCHER:
"""
${profilBlock}
"""`;
}

export const SCHEMA_AUTORENPROFIL = _obj({
  autorenprofil: _str,
  konstanten: {
    type: 'array',
    items: _obj({ aspekt: _str, beleg: _str, kennzahl: _nullableEnum(KENNZAHL_KEYS) }),
  },
  entwicklung: {
    type: 'array',
    items: _obj({
      aspekt: _str, richtung: _str, beleg: _str,
      kennzahl: _nullableEnum(KENNZAHL_KEYS), tendenz: _nullableEnum(['steigt', 'sinkt']),
    }),
  },
});
