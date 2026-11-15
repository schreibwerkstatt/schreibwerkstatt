// Bewertung eines Abschnitts im Lektorat: die Felder «szenen», «stilanalyse» und
// «fazit» — Schema-Texte, Regeln und der eigene Bewertungs-Pass.
//
// Die Felder stehen im Stil-Pass (bzw. Kombi-Call) neben den Einzelbefunden. Wird
// ein langer Abschnitt in Stücken geprüft (routes/jobs/lektorat-split.js), liefern
// die Stück-Pässe nur Befunde, und die Bewertung kommt aus EINEM Pass über den
// ganzen Abschnitt (buildBewertungLektoratPrompt) — eine Szene endet nicht an
// einer Stückgrenze, und Stilanalyse und Fazit gelten dem Abschnitt als Ganzes.

import { _obj, _str } from './schema-utils.js';
import { lektoratProfil, lektoratEinheit, EINHEIT_EINTRAG } from './lektorat-typen.js';
import { _buildFachAbschnittRegelnBlock } from './blocks-fach.js';
import { _buildErzaehlformBlock } from './blocks.js';
import { _buildNachbarBlocks } from './lektorat-nachbar.js';
import { textsorteLabel } from './textsorten.js';

// Titelform aller Einheiten: Stichwort statt Inhaltssatz, damit Listen und Übersichten
// einheitlich lesen (gleiche Vorgabe wie die Szenen der Komplettanalyse).
const TITEL_FORM = 'als Stichwort-Phrase, kein ganzer Satz, kein Schlusspunkt, höchstens 60 Zeichen';

// ── Das «szenen»-Feld, je Bewertungseinheit ───────────────────────────────────
// EIN SSoT für Schema-Felder UND Regelblock. Vorher standen beides als zwei
// getrennte `fach ? … : …`-Ternaries nebeneinander – Schema und Regeln konnten
// also auseinanderlaufen (das Schema hätte «Argumentationsschritt» versprochen,
// während die Regeln noch von Szenen sprachen).
// Why das eine SSoT und nicht drei Blöcke: das Feld ist ein Persistenzformat
// (`page_checks.szenen_json` → drei Spalten titel/wertung/kommentar). Ob der
// Inhalt eine Szene, ein Argumentationsschritt oder ein Tagebucheintrag ist,
// ändert die Form nicht – nur die Frage, die `wertung` beantworten soll. Die
// Fach-Regeltexte bleiben in blocks-fach.js (sie hängen am Profil, nicht an der
// Einheit); dieses Feld entscheidet nur, WELCHE Einheit in einem Lauf gilt.
export const SZENEN_FELD = {
  szene: {
    nomen: 'Szenen',
    titel: `"Knapper Szenentitel ${TITEL_FORM} (z.B. «Blutschwur im Wald»)"`,
    kommentar: '"1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung). KEINE konkreten Fehler aus dem «fehler»-Array wiederholen (keine Wortwahl-, Stil-, Grammatik-, Wiederholungs-, Füllwort-Hinweise zu Einzelstellen). Nur szenen-übergreifende Beobachtungen (Spannungsbogen, Tempo, Konflikt, Figurenentwicklung, Schauplatzwirkung)."',
    regeln: () => `
Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- Wenn der Abschnitt keine erkennbaren Szenen enthält (z.B. rein beschreibender Text, Exposition): «szenen» als leeres Array zurückgeben
- wertung: «stark» = funktioniert gut, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen`,
  },
  teilschritt: {
    nomen: 'Teilabschnitte',
    titel: `"Kurze Bezeichnung des Argumentations-/Darstellungsschritts ${TITEL_FORM}"`,
    kommentar: '"1-2 Sätze: trägt der Schritt, ist er nachvollziehbar belegt, schliesst er an den vorigen an. KEINE konkreten Fehler aus dem «fehler»-Array wiederholen (keine Wortwahl-, Stil-, Grammatik-, Wiederholungs-, Hedging-Hinweise zu Einzelstellen). Nur schritt-übergreifende Beobachtungen (Argumentationsführung, Beleglage, Aufbau, Anschluss)."',
    regeln: (profil) => _buildFachAbschnittRegelnBlock(profil),
  },
  eintrag: {
    nomen: 'Einträge',
    titel: `"Kurze Bezeichnung des Eintrags – Datum oder Thema, ${TITEL_FORM}"`,
    kommentar: '"1-2 Sätze: trägt die Stimme des Eintrags, wie weit der Eintrag über die Notiz hinausgeht, was er bewusst auslässt. KEINE konkreten Fehler aus dem «fehler»-Array wiederholen (keine Wortwahl-, Stil-, Grammatik-, Wiederholungs-, Füllwort-Hinweise zu Einzelstellen). Nur eintrag-übergreifende Beobachtungen (Stimme, Dichte, Verhältnis von Alltagsnotiz und Reflexion)."',
    // Der Tagebucheintrag hat keine Handlung, die über ihn hinausgetragen werden
    // muss. Zu fragen ist nicht Spannung, sondern Dichte – und die genretypische
    // Kürze ist KEIN Mangel: ohne diesen Satz bewertete das Modell «bleibt
    // Notizstenografie ohne Verdichtung» als «mittel» und schlug Szenenfutter vor.
    regeln: () => `
Eintrag-Regeln (Feld «szenen»):
- Ein Eintrag ist hier ein datierter, überschriebener oder thematisch abgeschlossener Tagebucheintrag – KEINE Szene, kein Handlungsabschnitt mit Spannungsbogen, der über den Eintrag hinausgetragen werden müsste.
- Enthält der Abschnitt keinen abgrenzbaren Eintrag (z.B. ein lose notiertes Sammeldatum): «szenen» als leeres Array zurückgeben.
- wertung: «stark» = die Stimme trägt den Eintrag, «mittel» = Eintrag bleibt Notiz, ohne eine eigene Stimme zu entwickeln, «schwach» = der Eintrag sagt nichts Eigenes.
- kommentar: 1-2 Sätze zu Stimme, Dichte und Verhältnis von Beobachtung und Reflexion. KEINE Einzelstellen-Kritik aus dem «fehler»-Array wiederholen.
- Fragmentarische Notizen, Stichworte, Auslassungen, abrupte Registerwechsel und Einträge ohne Reflexion sind genretypisch und KEIN Mangel dieses Feldes. Bewertet wird nur, ob der Eintrag als Eintrag trägt – NICHT, wie viel ein Roman aus ihm gemacht hätte.`,
  },
};

/** Schema-Text des Feldes «stilanalyse» (Fach-Profile: Sprachanalyse). */
export function stilanalyseFeld(fach) {
  return fach
    ? '"4-5 Sätze Sprachanalyse – KEINE konkreten Fehler erwähnen, die bereits im «fehler»-Array stehen, und KEINE Aggregat-Hinweise auf bereits gemeldete Muster («häufige Wiederholungen», «viel Hedging», «oft unbelegt» o.Ä.). Fokus ausschliesslich auf übergreifende Beobachtungen, die NICHT als Einzelfehler erfasst sind: Klarheit über mehrere Absätze, Argumentationsführung, Begriffsschärfe, Informationsdichte, Lesbarkeit für die Fachleserschaft. Erzählerische Mittel NICHT einfordern."'
    : '"4-5 Sätze Stilanalyse – KEINE konkreten Fehler erwähnen, die bereits im «fehler»-Array stehen (weder Rechtschreibung, Grammatik, Stil, Wiederholungen, Füllwörter, schwache Verben, Show-vs-Tell, Passiv, Perspektive, Tempus noch andere Typen). KEINE Aggregat-Hinweise auf bereits gemeldete Muster («häufige Wiederholungen», «viele Füllwörter», «passivlastig», «schwache Verben dominieren» o.Ä.) – diese Muster sind durch die Einzel-Findings abgedeckt. Fokus ausschliesslich auf übergreifende Beobachtungen, die NICHT als Einzelfehler erfasst sind: Rhythmus über mehrere Absätze, Bildsprache, Erzählhaltung, Atmosphäre, Wirkung beim Leser."';
}

/** Schema-Text des Feldes «fazit». */
export function fazitFeld(fach) {
  return fach
    ? '"ein Satz Gesamtfazit zur sprachlichen und argumentativen Qualität – KEINE Fehler aus dem «fehler»-Array wiederholen, zusammenfassen oder als Gruppe charakterisieren. Nur Gesamtwirkung, nicht das Findings-Resultat paraphrasieren."'
    : '"ein Satz Gesamtfazit zur literarischen Qualität – KEINE Fehler aus dem «fehler»-Array wiederholen, zusammenfassen oder als Gruppe charakterisieren («viele Stilbrüche», «zahlreiche Wiederholungen» o.Ä.). Nur Gesamtwirkung, nicht das Findings-Resultat paraphrasieren."';
}

/** JSON-Schema der drei Bewertungsfelder (Stil-/Kombi-Pass und Bewertungs-Pass). */
export function bewertungSchemaFelder() {
  return {
    szenen: {
      type: 'array',
      items: _obj({
        titel: _str,
        wertung: { type: 'string', enum: ['stark', 'mittel', 'schwach'] },
        kommentar: _str,
      }),
    },
    stilanalyse: _str,
    fazit: _str,
  };
}

/** Schema des Bewertungs-Passes: nur die drei Felder, kein «fehler». */
export function buildBewertungLektoratSchema() {
  return _obj(bewertungSchemaFelder());
}

/**
 * Bewertungs-Pass über den ganzen Abschnitt, wenn die Befunde stückweise
 * geprüft werden. Nur Cloud (lokal wird nie in Stücken geprüft). Nimmt dieselben
 * Optionen wie buildStilLektoratPrompt; genutzt werden Verortung, Erzählform,
 * Buchtyp/Textsorte und der Nachbarkontext.
 */
export function buildBewertungLektoratPrompt(text, {
  buchtyp = null, textsorte = null, pageName = null, chapterName = null,
  erzaehlperspektive = null, erzaehlzeit = null,
  previousExcerpt = null, nextExcerpt = null, previousChapter = null, nextChapter = null,
  schreibfront = false,
} = {}) {
  const profil = lektoratProfil(buchtyp);
  const fach = profil !== 'narrativ';
  const einheit = lektoratEinheit(buchtyp);
  const szenen = SZENEN_FELD[einheit];
  const meta = [
    chapterName && `Kapitel: «${chapterName}»`,
    pageName && `Abschnitt: «${pageName}»`,
    profil === 'journalistisch' && textsorte && `Textsorte: «${textsorteLabel(textsorte)}»`,
  ].filter(Boolean);
  const metaBlock = meta.length ? `\nVerortung im Buch: ${meta.join(' · ')}\n` : '';
  const povBlock = fach ? '' : _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'lektorat');
  const { nachbarBlock, schreibfrontBlock } = _buildNachbarBlocks({
    previousExcerpt, nextExcerpt, previousChapter, nextChapter, schreibfront,
    fach, eintrag: einheit === EINHEIT_EINTRAG, local: false,
  });
  return `<aufgabe>
Bewerte den Abschnitt als Ganzes, von Anfang bis Ende: die ${szenen.nomen} (Feld «szenen»), die Sprache über den ganzen Abschnitt («stilanalyse») und die Gesamtwirkung («fazit»).
Einzelbefunde an bestimmten Stellen – Rechtschreibung, Grammatik, Zeichensetzung, Wortwahl, Satzbau, Wiederholungen, Füllwörter und alle übrigen Fehlertypen – liefern SEPARATE Pässe, die den Abschnitt stückweise prüfen. Sie gehören weder einzeln noch als Sammelbefund («viele Füllwörter», «passivlastig» o.Ä.) in diese Antwort. Wo die Feldbeschreibungen unten vom «fehler»-Array sprechen, sind genau diese Einzelbefunde der anderen Pässe gemeint.
</aufgabe>
${metaBlock}${povBlock}
<output_format>
Antworte mit diesem JSON-Schema:
{
  "szenen": [
    {
      "titel": ${szenen.titel},
      "wertung": "stark|mittel|schwach",
      "kommentar": ${szenen.kommentar}
    }
  ],
  "stilanalyse": ${stilanalyseFeld(fach)},
  "fazit": ${fazitFeld(fach)}
}
</output_format>
${szenen.regeln(profil)}
${nachbarBlock}${schreibfrontBlock}
<originaltext label="Text">
${text}
</originaltext>`;
}
