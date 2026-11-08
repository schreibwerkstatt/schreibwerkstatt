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

import { _obj, _str } from './schema-utils.js';

// Lesbare Kennzahl-Namen FUER DEN PROMPT. Bewusst hier und nicht in der
// i18n: das sind keine UI-Strings, sondern Prompt-Wortlaut — sie folgen der
// Sprache des Prompts, nicht der des Betrachters. Schluessel = die Metrik-Keys
// aus lib/author-profile.js#AUTHOR_PROFILE_METRICS.
export const AUTORENPROFIL_METRIC_LABELS = {
  satzlaenge: 'Satzlaenge (Woerter je Satz)',
  dialogAnteil: 'Dialoganteil',
  adverbDichte: 'Adverbdichte',
  passivQuote: 'Passivquote',
  fuellwortDichte: 'Fuellwortdichte',
  mattr: 'Wortvielfalt MATTR',
  mtld: 'Wortvielfalt MTLD',
  hapaxRatio: 'Anteil Einmalwoerter',
  yuleK: 'Wiederholungsmass Yule K',
  heapsBeta: 'Wortschatz-Zuwachs Heaps beta',
  lexDichte: 'Lexikalische Dichte',
  lix: 'Lesbarkeit LIX',
  fleschDe: 'Lesbarkeit Flesch',
};

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
    : '(Fuer keines der Buecher liegt ein Stilprofil vor.)';

  const entwicklungOk = entwicklungMoeglich ?? buecher >= 2;
  // Ohne Vergleichsbasis faellt der Entwicklungs-Teil WEG statt leer behauptet zu
  // werden — gleiches Muster wie ein fehlender Weltfakten-Block im Prompt.
  // Mehrsprachig gilt Entwicklung nur INNERHALB einer Sprache: ein Unterschied
  // zwischen einem deutschen und einem englischen Buch ist zuerst ein
  // Sprachunterschied, und der Server verwirft Entwicklung ohne gleichsprachiges Paar.
  let entwicklungsAuftrag;
  if (!entwicklungOk && mehrsprachig) {
    entwicklungsAuftrag = `- "entwicklung": LEERES Array. Die Buecher sind in verschiedenen Sprachen geschrieben, und in keiner Sprache liegen zwei Buecher vor. Ein Unterschied zwischen ihnen waere ein Sprachunterschied, keine Entwicklung. Erfinde keine.`;
  } else if (!entwicklungOk) {
    entwicklungsAuftrag = `- "entwicklung": LEERES Array. Es liegt nur ein Buch vor — es gibt keine Entwicklung, die belegbar waere. Erfinde keine.`;
  } else if (mehrsprachig) {
    entwicklungsAuftrag = `- "entwicklung": was sich ueber die Werk-Reihenfolge VERSCHOBEN hat, ausschliesslich zwischen Buechern DERSELBEN Sprache. Vergleiche nie ein Buch mit einem Buch in anderer Sprache. Jede Angabe braucht einen Beleg aus den Zahlen dieser Sprache oder den Buch-Stilprofilen. Nenne die Richtung sachlich ("knapper", "dialogreicher"), nicht als Fortschritt oder Rueckschritt.`;
  } else {
    entwicklungsAuftrag = `- "entwicklung": was sich ueber die Werk-Reihenfolge VERSCHOBEN hat. Jede Angabe braucht einen Beleg aus den Zahlen oder den Buch-Stilprofilen. Nenne die Richtung sachlich ("knapper", "dialogreicher"), nicht als Fortschritt oder Rueckschritt.`;
  }

  const konstantenAuftrag = mehrsprachig
    ? `- "konstanten": was ueber ALLE Buecher hinweg gleich bleibt — der eigentliche Kern der Handschrift, auch ueber die Sprachgrenze. Sprachuebergreifend stuetzt du dich nur auf die Buch-Stilprofile und den Dialoganteil; die uebrigen Zahlen sind zwischen den Sprachen nicht vergleichbar. Jede Angabe mit knappem Beleg.`
    : `- "konstanten": was ueber ALLE Buecher hinweg gleich bleibt — der eigentliche Kern der Handschrift. Jede Angabe mit knappem Beleg.`;

  return `Du bekommst die Stilprofile mehrerer Buecher EINES Autors sowie gemessene Kennzahlen ueber diese Buecher. Verdichte beides zu einem Autorenprofil.

HARTE REGELN:
- Nenne KEINE anderen Autoren, keine literarischen Schulen, Epochen oder Vergleichsgroessen. Die Einordnung erfolgt ausschliesslich gegen die eigenen Buecher dieses Autors. Ein Vergleich nach aussen waere nicht belegbar.
- WERTE NICHT. Kein "gut", "schwach", "zu viel", "sollte". Die Messwerte sind Beschreibungen, keine Noten.
- Behaupte nichts, was weder in den Stilprofilen noch in den Zahlen steht. Wo die Quellen schweigen, schweige auch.
- Die Zahlen sind ein VORBEFUND: verwende sie, wiederhole sie nicht. "Die Satzlaenge betraegt 10,2" ist keine Erkenntnis — "die Saetze bleiben ueber alle Buecher kurz, und der Dialoganteil waechst" ist eine.

Liefere:
- "autorenprofil": zusammenhaengender Text (Richtwert 150-250 Woerter), der die wiedererkennbare Handschrift dieses Autors beschreibt. Kurze Stichwort-Ueberschriften erlaubt, KEINE Markdown-Tabellen.
${konstantenAuftrag}
${entwicklungsAuftrag}

Antworte mit diesem JSON-Schema:
{
  "autorenprofil": "Fliesstext",
  "konstanten":  [{ "aspekt": "kurz benannt", "beleg": "woraus das folgt" }],
  "entwicklung": [{ "aspekt": "kurz benannt", "richtung": "wohin es sich bewegt", "beleg": "woraus das folgt" }]
}

GEMESSENE KENNZAHLEN (${buecher} Buecher, in Werk-Reihenfolge):
"""
${messung}
"""

STILPROFILE DER EINZELNEN BUECHER:
"""
${profilBlock}
"""`;
}

export const SCHEMA_AUTORENPROFIL = _obj({
  autorenprofil: _str,
  konstanten: {
    type: 'array',
    items: _obj({ aspekt: _str, beleg: _str }),
  },
  entwicklung: {
    type: 'array',
    items: _obj({ aspekt: _str, richtung: _str, beleg: _str }),
  },
});
