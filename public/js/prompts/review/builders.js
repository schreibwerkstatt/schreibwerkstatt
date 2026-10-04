// Die fünf Prompt-Builder der Bewertung.
//
// Jeder setzt dieselbe Kette zusammen: Aufgabe → Achsen → Notenanker →
// Empfehlungs-/Zitat-Regeln → Kontext-Blöcke → Antwort-Template → Inhalt.
// Was davon wie aussieht, entscheidet das Bewertungsprofil des Buchtyps
// (prompts/review-typen.js).

import { _buildErzaehlformBlock } from '../blocks.js';
import {
  bookReviewAxes, chapterReviewAxes, chapterAnalysisFelder,
  reviewGewichtung, empfehlungKategorien, notenTiers, werkPhrase,
} from '../review-typen.js';
import {
  _buildAchsenBlock, _buildNotenskala, _buildEmpfehlungenBlock,
  _buildOutputFormat, _buildKapitelanalyseFormat,
} from './format.js';
import {
  _buildReviewSchwerpunktBlock, _buildChapterPositionBlock,
  _buildKomplettContextBlock, _buildMotivContextBlock,
  _buildStrukturContextBlock, _strukturAchse,
  _buildWeltContextBlock, _weltAchse,
  _buildPlanContextBlock, _planAchse, _buildIdeenContextBlock,
} from './context.js';

export function buildBookReviewSinglePassPrompt(bookName, pageCount, bookText, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null, reviewSchwerpunkt = '', komplettContext = null, motivContext = null, strukturContext = null, weltContext = null } = {}) {
  const axes = bookReviewAxes(buchtyp);
  const kategorien = empfehlungKategorien(buchtyp, 'book');
  const werk = werkPhrase(buchtyp);
  const werkAkk = werkPhrase(buchtyp, 'akk');
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const schwerpunktBlock = _buildReviewSchwerpunktBlock(reviewSchwerpunkt);
  const kontextBlock = _buildKomplettContextBlock(komplettContext);
  const motivBlock = _buildMotivContextBlock(motivContext);
  const strukturBlock = _buildStrukturContextBlock(strukturContext, { achse: _strukturAchse(axes) });
  const weltBlock = _buildWeltContextBlock(weltContext, { achse: _weltAchse(axes) });
  return `<aufgabe>
Bewerte ${werkAkk} «${bookName}» kritisch und umfassend.
</aufgabe>
${_buildAchsenBlock(axes, reviewGewichtung(buchtyp, 'book'))}
${_buildNotenskala(axes, notenTiers(buchtyp, 'book'), { scope: 'book', werk })}
${_buildEmpfehlungenBlock({ kategorien, scope: 'book', werk, quelle: 'Text' })}
${schwerpunktBlock}${povBlock}${kontextBlock}${motivBlock}${strukturBlock}${weltBlock}
${_buildOutputFormat(axes, { scope: 'book', kategorien, zitatQuelle: 'dem Text' })}
<buchinhalt seiten="${pageCount}">
${bookText}
</buchinhalt>`;
}

// `teil` ({ nr, von }) markiert einen Teil-Abschnitt eines Kapitels, das fürs
// Input-Budget zerlegt wurde. Ohne die Angabe hielte das Modell den Ausschnitt
// für das ganze Kapitel und beurteilte dessen Funktion und Bogen falsch.
export function buildChapterAnalysisPrompt(chapterName, bookName, pageCount, chText, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null, teil = null } = {}) {
  const felder = chapterAnalysisFelder(buchtyp);
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const feldKeys = ['funktion_kurz', ...felder.map(f => f.key)].join(', ');
  const gegenstand = teil
    ? `Teil ${teil.nr} von ${teil.von} des Kapitels «${chapterName}» aus dem Werk «${bookName}».
Der Text unten ist NICHT das ganze Kapitel, sondern ein zusammenhängender Ausschnitt davon:
beschreibe in funktion_kurz, was DIESER Teil leistet, und urteile nicht über Anfang oder
Ende des Kapitels, die du nicht siehst.`
    : `«${chapterName}» aus dem Werk «${bookName}».`;
  return `<aufgabe>
Analysiere ${gegenstand}
Lies den vorliegenden Text vollständig und gib eine kompakte Analyse als JSON zurück.
Die Ausgabe dient als Eingabe für eine Synthese auf der Ebene des ganzen Werks –
sie MUSS deshalb auch ${feldKeys} knapp benennen (nicht nur Themen/Stil).
Was du hier weglässt, fehlt der Gesamtbewertung ersatzlos: sie sieht diesen Text nicht mehr.
</aufgabe>
${_buildKapitelanalyseFormat(felder)}
${povBlock}
<output_format>
Antworte mit diesem JSON-Schema:
{
  "themen": "Hauptthemen und Inhalte in 1-2 Sätzen",
  "stil": "Sprachbeobachtungen: Wortwahl, Satzbau, Ton in 1-2 Sätzen – falls eine Erzählform vorgegeben ist, kurz beurteilen, ob das Kapitel bzw. der Kapitelteil diese konsistent einhält",
  "funktion_kurz": "Funktion im Ganzen: was leistet dieses Kapitel bzw. dieser Kapitelteil, wie schliesst es nach vorn und hinten an (1-2 Sätze)",
${felder.map(f => `  "${f.key}": "${f.hint}"`).join(',\n')},
  "staerken": ["konkrete Stärke 1", "konkrete Stärke 2"],
  "schwaechen": ["konkrete Schwäche 1", "konkrete Schwäche 2"],
  "zitate": [
    { "kind": "staerke|schwaeche", "zitat": "wörtlich aus diesem Kapitel bzw. Kapitelteil", "kommentar": "was diese Stelle zeigt" }
  ]
}
</output_format>
<kapitelinhalt seiten="${pageCount}">
${chText}
</kapitelinhalt>`;
}

// Kapitel-Review: makro-kritische Bewertung eines einzelnen Kapitels.
// Fokus: die seitenübergreifenden Achsen des Profils – Dinge, die beim
// Seiten-Lektorat (Mikro-Fehler) und bei der Buchbewertung (Gesamtnote)
// naturgemäss nicht erfasst werden.
export function buildChapterReviewPrompt(chapterName, bookName, pageCount, chText, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null, reviewSchwerpunkt = '', komplettContext = null, position = null, strukturContext = null, planContext = null, ideenContext = null } = {}) {
  const axes = chapterReviewAxes(buchtyp);
  const kategorien = empfehlungKategorien(buchtyp, 'chapter');
  const werk = werkPhrase(buchtyp);
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const schwerpunktBlock = _buildReviewSchwerpunktBlock(reviewSchwerpunkt);
  const positionBlock = _buildChapterPositionBlock(position);
  const kontextBlock = _buildKomplettContextBlock(komplettContext);
  const strukturBlock = _buildStrukturContextBlock(strukturContext, { achse: _strukturAchse(axes) });
  const planBlock = _buildPlanContextBlock(planContext, { achse: _planAchse(axes) });
  const ideenBlock = _buildIdeenContextBlock(ideenContext);
  return `<aufgabe>
Bewerte das Kapitel «${chapterName}» aus dem Werk «${bookName}» kritisch und umfassend.
Der Fokus liegt auf abschnittsübergreifenden Qualitäten – nicht auf Mikro-Fehlern (dafür gibt es das Abschnitts-Lektorat).
</aufgabe>
${_buildAchsenBlock(axes, reviewGewichtung(buchtyp, 'chapter'))}
${_buildNotenskala(axes, notenTiers(buchtyp, 'chapter'), { scope: 'chapter', werk })}
${_buildEmpfehlungenBlock({ kategorien, scope: 'chapter', werk, quelle: 'Kapiteltext' })}
${positionBlock}${schwerpunktBlock}${povBlock}${kontextBlock}${strukturBlock}${planBlock}${ideenBlock}
${_buildOutputFormat(axes, { scope: 'chapter', kategorien, zitatQuelle: 'dem Kapitel' })}
<kapitelinhalt seiten="${pageCount}">
${chText}
</kapitelinhalt>`;
}

export function buildBookReviewMultiPassPrompt(bookName, chapterAnalyses, totalPageCount, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null, reviewSchwerpunkt = '', komplettContext = null, motivContext = null, strukturContext = null, weltContext = null } = {}) {
  const axes = bookReviewAxes(buchtyp);
  const kategorien = empfehlungKategorien(buchtyp, 'book');
  const werk = werkPhrase(buchtyp);
  const werkAkk = werkPhrase(buchtyp, 'akk');
  const felder = chapterAnalysisFelder(buchtyp);
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const schwerpunktBlock = _buildReviewSchwerpunktBlock(reviewSchwerpunkt);
  const kontextBlock = _buildKomplettContextBlock(komplettContext);
  const motivBlock = _buildMotivContextBlock(motivContext);
  const strukturBlock = _buildStrukturContextBlock(strukturContext, { achse: _strukturAchse(axes) });
  const weltBlock = _buildWeltContextBlock(weltContext, { achse: _weltAchse(axes) });
  // Ein zu langes Kapitel kommt als mehrere Teil-Analysen an (`kapitelNr` gleich,
  // `teil` gesetzt). Gezählt und nummeriert wird nach Kapiteln, nicht nach Analysen —
  // sonst hielte das Modell die Teile für eigenständige Kapitel gleichen Namens.
  const kapitelNr = (ca, i) => ca.kapitelNr ?? i + 1;
  const kapitelCount = new Set(chapterAnalyses.map(kapitelNr)).size;
  const geteilt = chapterAnalyses.length > kapitelCount;
  const synthIn = chapterAnalyses.map((ca, i) => {
    const teil = ca.teil ? `, Teil ${ca.teil.nr}/${ca.teil.von}` : '';
    return _analyseBlock(ca, felder, `## Kapitel ${kapitelNr(ca, i)}: ${ca.name}${teil} (${ca.pageCount} Abschnitte)`);
  }).join('\n\n');
  const grundlage = geteilt
    ? `Grundlage sind ${chapterAnalyses.length} Analysen zu ${kapitelCount} Kapiteln (insgesamt ${totalPageCount} Abschnitte).
Lange Kapitel wurden in Teile zerlegt und je Teil analysiert ("Teil n/m" im Kopf): lies
diese Teile als EIN Kapitel, nicht als eigenständige Kapitel.`
    : `Grundlage sind die Analysen aller ${kapitelCount} Kapitel (insgesamt ${totalPageCount} Abschnitte).`;
  return `<aufgabe>
Bewerte ${werkAkk} «${bookName}» kritisch und umfassend.
${grundlage}
Leite alle ${axes.length} Achsen aus der Abfolge der Kapitelanalysen ab – auch wenn die
einzelnen Kapitelausgaben kompakt sind, MUSS die Ebene des Ganzen jede Achse benennen.
Wo eine Achse aus den Kapitelanalysen nicht ableitbar ist, dies offen benennen
("aus den Kapitelanalysen nicht eindeutig …") statt zu raten.
</aufgabe>
${_buildAchsenBlock(axes, reviewGewichtung(buchtyp, 'book'))}
${_buildNotenskala(axes, notenTiers(buchtyp, 'book'), { scope: 'book', werk })}
${_buildEmpfehlungenBlock({ kategorien, scope: 'book', werk, quelle: 'Text' })}
HINWEIS: Für "beispielzitate" stehen im Multi-Pass keine Volltexte zur Verfügung.
Nutze ausschliesslich die je Kapitel gelieferten "Belegzitate" und übernimm sie
wörtlich. Liefern die Analysen keine, setze "beispielzitate" auf [] statt zu raten.
${schwerpunktBlock}${povBlock}${kontextBlock}${motivBlock}${strukturBlock}${weltBlock}
<kapitelanalysen kapitel="${kapitelCount}" analysen="${chapterAnalyses.length}" seiten="${totalPageCount}">
${synthIn}
</kapitelanalysen>
${_buildOutputFormat(axes, { scope: 'book', kategorien, zitatQuelle: 'einem Belegzitat oben' })}`;
}

// Multi-Pass-Variante der Kapitelbewertung: wird verwendet, wenn ein einzelnes
// Kapitel das Input-Budget des Modells sprengt. Sub-Chunks wurden zuvor mit
// `buildChapterAnalysisPrompt` analysiert und werden hier zu einer
// Kapitelbewertung zusammengeführt.
export function buildChapterReviewMultiPassPrompt(chapterName, bookName, subAnalyses, totalPageCount, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null, reviewSchwerpunkt = '', komplettContext = null, position = null, strukturContext = null, planContext = null, ideenContext = null } = {}) {
  const axes = chapterReviewAxes(buchtyp);
  const kategorien = empfehlungKategorien(buchtyp, 'chapter');
  const werk = werkPhrase(buchtyp);
  const felder = chapterAnalysisFelder(buchtyp);
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const schwerpunktBlock = _buildReviewSchwerpunktBlock(reviewSchwerpunkt);
  const positionBlock = _buildChapterPositionBlock(position);
  const kontextBlock = _buildKomplettContextBlock(komplettContext);
  const strukturBlock = _buildStrukturContextBlock(strukturContext, { achse: _strukturAchse(axes) });
  const planBlock = _buildPlanContextBlock(planContext, { achse: _planAchse(axes) });
  const ideenBlock = _buildIdeenContextBlock(ideenContext);
  const synthIn = subAnalyses.map((ca, i) => _analyseBlock(ca, felder, `## Teil ${i + 1} (${ca.pageCount} Abschnitte)`)).join('\n\n');
  return `<aufgabe>
Bewerte das Kapitel «${chapterName}» aus dem Werk «${bookName}» kritisch und umfassend.
Grundlage sind die Analysen von ${subAnalyses.length} Teilen des Kapitels (insgesamt ${totalPageCount} Abschnitte).
Leite alle ${axes.length} Achsen aus der Abfolge der Teil-Analysen ab – auch wenn die einzelnen
Ausgaben kompakt sind, MUSS die Kapitelbewertung jede Achse benennen. Wo eine Achse aus
den Teil-Analysen nicht ableitbar ist, dies offen benennen
("aus den Teil-Analysen nicht eindeutig …") statt zu raten.
</aufgabe>
${_buildAchsenBlock(axes, reviewGewichtung(buchtyp, 'chapter'))}
${_buildNotenskala(axes, notenTiers(buchtyp, 'chapter'), { scope: 'chapter', werk })}
${_buildEmpfehlungenBlock({ kategorien, scope: 'chapter', werk, quelle: 'Kapiteltext' })}
HINWEIS: Für "beispielzitate" nutze ausschliesslich die je Teil gelieferten
"Belegzitate" – übernimm sie wörtlich, wähle 2–4 aussagekräftige aus (mind. eine
staerke und eine schwaeche, sofern vorhanden). Erfinde keine neuen Zitate; liefern
die Teile gar keine, setze "beispielzitate" auf [].
${positionBlock}${schwerpunktBlock}${povBlock}${kontextBlock}${strukturBlock}${planBlock}${ideenBlock}
<teil_analysen abschnitte="${subAnalyses.length}" seiten="${totalPageCount}">
${synthIn}
</teil_analysen>
${_buildOutputFormat(axes, { scope: 'chapter', kategorien, zitatQuelle: 'einem Belegzitat oben' })}`;
}

/** Eine Analyse-Ausgabe als Synthese-Eingabeblock (profilabhängige Felder). */
function _analyseBlock(ca, felder, header) {
  const zitate = (ca.zitate || [])
    .map(z => `  [${z.kind === 'staerke' ? 'staerke' : 'schwaeche'}] «${z.zitat}» – ${z.kommentar || ''}`)
    .join('\n');
  const lines = [
    header,
    `Themen: ${ca.themen || '–'}`,
    `Stil: ${ca.stil || '–'}`,
    `Funktion im Ganzen: ${ca.funktion_kurz || '–'}`,
    ...felder.map(f => `${f.label}: ${ca[f.key] || '–'}`),
    `Stärken: ${(ca.staerken || []).join(' | ') || '–'}`,
    `Schwächen: ${(ca.schwaechen || []).join(' | ') || '–'}`,
    `Belegzitate:${zitate ? '\n' + zitate : ' –'}`,
  ];
  return lines.join('\n');
}
