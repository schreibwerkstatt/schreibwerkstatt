// Lesekontext des Abschnitts-Lektorats: Nachbarauszüge und Schreibstelle.
//
// Aus prompts/lektorat.js ausgelagert (LOC-Cap). Pure: alle Eingaben kommen als
// Argument, auch das Provider-Flag — die Blöcke sind lokal gedroppt.

/**
 * @param {object} o
 * @param {string|null} o.previousExcerpt  letzter Absatz des vorherigen Abschnitts
 * @param {string|null} o.nextExcerpt      erster Absatz des nächsten Abschnitts
 * @param {string|null} o.previousChapter  Kapitelname, wenn der vorherige Auszug aus
 *   einem ANDEREN Kapitel stammt ('' = Name unbekannt); null = gleiches Kapitel
 * @param {string|null} o.nextChapter      dito für den nächsten Auszug
 * @param {boolean} o.schreibfront  Werk nicht abgeschlossen, danach folgt kein Text
 * @param {boolean} o.fach     Fach-Profil (Gedankengang statt Szene)
 * @param {boolean} o.eintrag  Bewertungseinheit Tagebucheintrag
 * @param {boolean} o.local    lokaler Provider
 * @returns {{ nachbarBlock: string, schreibfrontBlock: string }}
 */
export function _buildNachbarBlocks({
  previousExcerpt = null, nextExcerpt = null, previousChapter = null, nextChapter = null,
  schreibfront = false, fach = false, eintrag = false, local = false,
} = {}) {
  // Nachbarseiten-Auszüge: reiner Lesekontext für Übergänge und die Stil-/
  // Szenenbewertung – lokal gedroppt (kleine Modelle prüfen solche Fragmente
  // trotz Verbot mit). Der Server verwirft zusätzlich Findings, deren «original»
  // nur in einem Auszug steht (routes/jobs/lektorat-context.js#dropNeighbourFindings).
  const fortsetzung = !nextExcerpt
    ? 'z.B. ob der Abschnittsanfang sauber an das Vorherige anschliesst.'
    : fach
    ? 'z.B. ob ein Gedankengang im nächsten Abschnitt weitergeht. Einen Gedankengang, der erkennbar fortgesetzt wird, nicht als unvollständig oder abgebrochen bewerten.'
    : eintrag
    ? 'z.B. ob ein Datum oder ein Thema abgerissen ist. Ein Eintrag, der mitten im Satz abbricht, ist ein Befund – ein Eintrag, der ohne Überleitung zum nächsten weitergeht, nicht: das ist im Tagebuch der Normalfall.'
    : 'z.B. ob eine Szene im nächsten Abschnitt weitergeht oder ein scheinbar abrupter Schluss bewusst offen bleibt. Eine Szene, die erkennbar fortgesetzt wird, nicht als unvollständig oder abgebrochen bewerten.';
  const prevLabel = previousChapter != null
    ? `Letzter Absatz des vorherigen Kapitels${previousChapter ? ` «${previousChapter}»` : ''} (Kapitelwechsel)`
    : 'Letzter Absatz des vorherigen Abschnitts';
  const nextLabel = nextChapter != null
    ? `Erster Absatz des nächsten Kapitels${nextChapter ? ` «${nextChapter}»` : ''} (Kapitelwechsel)`
    : 'Erster Absatz des nächsten Abschnitts';
  const kapitelwechsel = (previousChapter != null || nextChapter != null)
    ? 'Ein mit «Kapitelwechsel» bezeichneter Auszug stammt aus einem anderen Kapitel: ein Schnitt in Ort, Zeit oder Perspektive ist an dieser Grenze normal und kein Bruch.\n'
    : '';
  const nachbarBlock = (local || (!previousExcerpt && !nextExcerpt)) ? '' : `
<nachbarkontext>
Die folgenden Auszüge gehören NICHT zum geprüften Abschnitt. Sie zeigen nur, wie der Text ${[previousExcerpt && 'davor endet', nextExcerpt && 'danach weitergeht'].filter(Boolean).join(' und ')} – als Lesekontext für Übergänge (Tempus, Perspektive, Pronomen, Anschluss) und für «stilanalyse»${fach ? '' : '/«szenen»'}: ${fortsetzung}
PFLICHT: Nichts aus diesen Auszügen bewerten oder in «fehler» aufnehmen – jedes «original» stammt ausschliesslich aus <originaltext>. Den Inhalt der Auszüge in «stilanalyse»/«fazit» nicht nacherzählen.
${kapitelwechsel}${previousExcerpt ? `<vorherige_seite label="${prevLabel}">\n${previousExcerpt}\n</vorherige_seite>\n` : ''}${nextExcerpt ? `<naechste_seite label="${nextLabel}">\n${nextExcerpt}\n</naechste_seite>\n` : ''}</nachbarkontext>
`;

  // Schreibfront: hinter dem Abschnitt folgt im unfertigen Werk kein Text mehr.
  // Why: wer mitten in einer Szene prüft, bekam die angefangene Szene als
  // «unvollständig/abgebrochen» gewertet — für etwas, das erst geschrieben wird.
  // Lokal gedroppt wie das «szenen»-Feld selbst.
  const letzteEinheit = eintrag ? 'der letzte Eintrag'
    : fach ? 'der letzte Gedankengang' : 'die letzte Szene';
  const schreibfrontBlock = (local || !schreibfront) ? '' : `
SCHREIBSTELLE: Das Werk ist nicht abgeschlossen, und auf diesen Abschnitt folgt noch kein Text — hier wird gerade geschrieben.
Endet ${letzteEinheit} mitten im Geschehen oder mitten im Satz, ist das der Schreibstand und KEIN Befund: nicht als unvollständig, abgebrochen oder abrupt werten, weder in «fehler»${fach ? '' : ' noch in «szenen»'} noch in «stilanalyse»/«fazit». Bewertet wird, was dasteht.
`;

  return { nachbarBlock, schreibfrontBlock };
}
