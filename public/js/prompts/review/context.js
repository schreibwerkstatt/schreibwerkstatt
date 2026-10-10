// Kontext-Blöcke der Bewertung: was die Bewertung ausser dem Text noch weiss.
//
// Vier Quellen, drei Wahrheitsgrade — die Rahmung im jeweiligen Block ist das
// Wesentliche daran:
//   · Komplettanalyse (Figuren/Beziehungen/Kontinuität/Zeitstrahl) = Kartei-Wahrheit,
//   · Motiv-Werkstatt = Absicht des Autors (Soll), keine Textwahrheit,
//   · Struktur-Check = Messung am Text (Ist),
//   · Genre-Schwerpunkt + Kapitel-Position + Werkstand = Rahmen, kein Befund.

import { textsorte, textsorteLabel } from '../textsorten.js';

/**
 * Erzeugt den Buchtyp-Schwerpunkt-Block für Buchreview- und Kapitelreview-Prompts.
 * Übersteuert nicht die ACHSEN, sondern schärft, worauf das Modell je nach Genre
 * zusätzlich achten soll (z.B. Krimi: Logik der Auflösung).
 *
 * @param {string} schwerpunkt Text aus prompt-config.json buchtypen[lang][key].reviewSchwerpunkt
 * @returns {string} Block oder '' (wenn schwerpunkt leer)
 */
function _buildReviewSchwerpunktBlock(schwerpunkt) {
  const t = (schwerpunkt || '').trim();
  if (!t) return '';
  return `\nGenre-Schwerpunkt (zusätzlich zu den Achsen, nicht statt ihnen):\n${t}\n`;
}

/**
 * Positioniert das Kapitel im Buch und weist das Modell an, die zeitlichen Achsen
 * relativ zur Funktion des Kapitels zu bewerten (Aufbau-/Ruhekapitel vs.
 * Wende-/Schlusskapitel) statt absolut.
 *
 * @param {{index:number,total:number,prevName?:string,nextName?:string}|null} position
 * @returns {string} Block oder '' (wenn keine Position bekannt)
 */
function _buildChapterPositionBlock(position, werkstand = null) {
  if (!position || !position.total) return '';
  const nachbarn = [];
  if (position.prevName) nachbarn.push(`Vorheriges Kapitel: «${position.prevName}».`);
  if (position.nextName) nachbarn.push(`Nächstes Kapitel: «${position.nextName}».`);
  const inArbeit = !!werkstand?.inArbeit;
  // Im unfertigen Werk ist das Kapitel, hinter dem kein Text mehr folgt, die
  // Schreibfront, kein Schluss: ohne diesen Satz las das Modell «Kapitel 1 von 1»
  // als Schlusskapitel, das einlösen muss — und benotete den fehlenden Schluss.
  // `position.front` misst der Job am Text (leere Folgekapitel zählen nicht);
  // fehlt die Messung, gilt das letzte Kapitel im Baum.
  const istFront = inArbeit && (position.front ?? position.index === position.total);
  const ung = position.ungeschrieben;
  const huellen = istFront && ung?.namen?.length
    ? `\nDanach sind ${ung.gesamt} Kapitel angelegt, aber noch ungeschrieben: ${ung.namen.map(n => `«${n}»`).join(', ')}${ung.gesamt > ung.namen.length ? ' …' : ''}. Sie sind geplant, nicht leer gelassen — ihr Fehlen ist kein Befund.`
    : '';
  const front = istFront
    ? `\nDas Werk ist NICHT abgeschlossen: dies ist das bisher letzte geschriebene Kapitel, KEIN Schlusskapitel. Bewerte nicht, ob es den Bogen einlöst. Das Kapitel selbst kann noch unfertig sein — bricht es mitten in einer Szene, einem Bogen oder einem Gedankengang ab, ist das der Schreibstand und kein Mangel; bewertet wird, was geschrieben ist.${huellen}`
    : '';
  return `
Position im Buch: Kapitel ${position.index} von ${inArbeit ? 'bisher ' : ''}${position.total}.${nachbarn.length ? '\n' + nachbarn.join(' ') : ''}
Bewerte den Bogen dieses Kapitels relativ zu seiner FUNKTION im Ganzen, nicht absolut: ein frühes Aufbau-/Ruhekapitel darf bewusst langsamer sein, ein Wende- oder Schlusskapitel muss einlösen. Ein ruhiges Kapitel an der richtigen Stelle ist kein Mangel.${front}
`;
}

/**
 * Werkstand für die BUCHbewertung: das Werk ist nicht als abgeschlossen markiert.
 *
 * Why: die Achsen fragen nach dem Bogen über das Ganze (Spannungskurve,
 * Mittelteil, Schluss). Ohne Hinweis bewertet das Modell den bisher geschriebenen
 * Anfang als vollständiges Werk und benotet fehlende Teile als Mängel.
 *
 * `is_finished = 0` ist aber auch der Default jedes nie markierten, fertigen
 * Buchs — darum ohne Zielumfang nur bedingt formuliert («endet der Text offen …»).
 * Erst ein Zielumfang, der deutlich unterschritten ist, macht die Aussage hart.
 *
 * @param {{inArbeit:boolean, zielProzent?:number|null}|null} werkstand
 * @returns {string} Block oder '' (abgeschlossen / unbekannt)
 */
function _buildWerkstandBlock(werkstand) {
  if (!werkstand?.inArbeit) return '';
  const p = werkstand.zielProzent;
  const sicher = p != null && p < 90;
  const ziel = p != null
    ? ` Gemessen am Zielumfang des Autors ist es bisher zu etwa ${p} % geschrieben.`
    : '';
  const lage = sicher
    ? 'Der vorliegende Text ist der bisher geschriebene Teil, NICHT das ganze Werk.'
    : 'Der vorliegende Text kann darum der bisher geschriebene Teil sein statt des ganzen Werks.';
  const ausnahme = sicher
    ? ''
    : '\n· Liest sich der Text erkennbar als abgeschlossenes Ganzes, bewerte ihn als solches.';
  const ung = werkstand.ungeschrieben;
  const huellen = ung?.namen?.length
    ? `\nNoch angelegt, aber ungeschrieben (${ung.gesamt} Kapitel nach dem bisherigen Text): ${ung.namen.map(n => `«${n}»`).join(', ')}${ung.gesamt > ung.namen.length ? ' …' : ''}.`
    : '';
  return `
=== WERKSTAND: IN ARBEIT ===
Der Autor hat das Werk NICHT als abgeschlossen markiert.${ziel}
${lage}
· Endet der Text offen – ohne Auflösung, mitten in einem Bogen, einer Szene oder einem Gedankengang –, ist das der
  Schreibstand und KEIN Mangel. Bewerte die Achsen, die den Verlauf über das Ganze betreffen,
  an dem, was der bisherige Text aufbaut und verspricht (Exposition, gesetzte Konflikte und
  Fragen, Fallhöhe, Sog). Fehlender Höhepunkt, fehlender Mittelteil oder fehlender Schluss
  sind keine Befunde und drücken die Note nicht.
· Das gilt nur für das FEHLEN von Teilen: was geschrieben ist, bewertest du mit vollem Massstab.
· Empfehlungen dürfen sich auf den weiteren Verlauf richten (was der bisherige Text einlösen
  muss), statt einen Schluss einzufordern.${ausnahme}${huellen}${_geplantTeil(werkstand.geplant)}
=== ENDE WERKSTAND ===
`;
}

/**
 * Noch geplante Beats im Werkstand-Block. Wie der Plan-Block der Kapitelbewertung
 * AUTOR-ABSICHT, keine Textwahrheit: das Modell soll den bisherigen Text daran
 * lesen, wohin er führen soll (trägt die Exposition das Geplante?), nicht den
 * Plan bewerten oder ihn als geschrieben behandeln.
 */
function _geplantTeil(ctx) {
  if (!ctx?.beats?.length) return '';
  const lines = ctx.beats.map(b => {
    const ort = [b.kapitel && `Kapitel: ${b.kapitel}`, b.akt && `Akt: ${b.akt}`, b.strang && `Strang: ${b.strang}`].filter(Boolean).join(' · ');
    const meta = [
      b.intensitaet ? `Spannung ${b.intensitaet}/5` : '',
      b.im_text == null ? '' : `im Text wiedergefunden: ${b.im_text}×`,
    ].filter(Boolean).join(' · ');
    return `- «${b.titel}»${ort ? ` [${ort}]` : ''}${b.beschreibung ? ` – ${b.beschreibung}` : ''}${meta ? `\n    ${meta}` : ''}`;
  });
  const gekappt = ctx.gesamt > ctx.beats.length ? `\n(${ctx.gesamt - ctx.beats.length} weitere nicht gelistet.)` : '';
  const ist = ctx.verankert
    ? '«im Text wiedergefunden» ist eine semantische Suche, kein Beweis: ein Beat mit Treffern ist offenbar schon geschrieben, nur nicht als eingearbeitet markiert.'
    : 'Ob einzelne davon schon im Text stehen, ist nicht abgeglichen — entscheide es am Text.';
  return `

NOCH GEPLANT (Plot-Werkstatt, Absicht des Autors, KEINE Textwahrheit), in Lesereihenfolge des Plans:
Lies den bisherigen Text daran, wohin er führen soll: Legt er an, was das Geplante braucht (Figuren,
Konflikte, Fragen, Fallhöhe)? Bewerte NICHT den Plan, erfinde nichts daraus in den Text hinein, und
behandle Geplantes nicht als geschrieben. Ein bewusstes Abweichen vom Plan ist kein Fehler.
${ist}
${lines.join('\n')}${gekappt}`;
}

/**
 * Baut den Strukturdaten-Block aus Komplettanalyse-Daten.
 * Erscheint nur, wenn mindestens eine Quelle Daten liefert.
 *
 * Wichtig: die Daten gelten als Wahrheit. Modell darf sich darauf beziehen
 * (z.B. "die Figurenkartei nennt Anna als Lehrerin – im Kap. 5 wird sie
 * Ärztin genannt"). Bei leeren Quellen wird der jeweilige Abschnitt weggelassen –
 * keine erfundenen Befunde.
 *
 * @param {{figuren:Array, beziehungen:Array, continuityIssues:Array, zeitstrahl:Array}} ctx
 * @returns {string} Block oder '' (wenn alle Buckets leer)
 */
function _buildKomplettContextBlock(ctx) {
  if (!ctx) return '';
  const parts = [];

  if (ctx.figuren?.length) {
    const lines = ctx.figuren.map(f => {
      const head = [f.name, f.kurzname && f.kurzname !== f.name ? `«${f.kurzname}»` : null].filter(Boolean).join(' ');
      const attrs = [f.typ, f.geschlecht, f.beruf].filter(Boolean).join(', ');
      const desc = f.beschreibung ? ` – ${f.beschreibung}` : '';
      return `- ${head}${attrs ? ` (${attrs})` : ''}${desc}`;
    });
    parts.push(`Figurenkartei (Stamm, verbindliche Wahrheit über das Buch):\n${lines.join('\n')}`);
  }

  if (ctx.beziehungen?.length) {
    const lines = ctx.beziehungen.map(b => {
      const desc = b.beschreibung ? ` – ${b.beschreibung}` : '';
      return `- ${b.von} → ${b.zu}: ${b.typ}${desc}`;
    });
    parts.push(`Soziogramm (Figurenbeziehungen):\n${lines.join('\n')}`);
  }

  if (ctx.continuityIssues?.length) {
    const lines = ctx.continuityIssues.map(i => {
      const kap = i.kapitel?.length ? ` [${i.kapitel.join(' / ')}]` : '';
      const fig = i.figuren?.length ? ` (Figuren: ${i.figuren.join(', ')})` : '';
      return `- ${i.schwere || '–'} | ${i.typ || '–'}${kap}: ${i.beschreibung}${fig}`;
    });
    parts.push(`Kontinuitäts-Befunde aus der letzten Komplettanalyse (Plot-Logik nicht ignorieren):\n${lines.join('\n')}`);
  }

  if (ctx.zeitstrahl?.length) {
    const lines = ctx.zeitstrahl.map(e => {
      const kap = e.kapitel ? ` [${e.kapitel}]` : '';
      const typ = e.typ ? ` (${e.typ})` : '';
      return `- ${e.datum || '?'}${typ}${kap}: ${e.ereignis}`;
    });
    parts.push(`Globaler Zeitstrahl (Reihenfolge der wichtigen Ereignisse):\n${lines.join('\n')}`);
  }

  if (!parts.length) return '';
  return `
=== STRUKTURDATEN AUS DER KOMPLETTANALYSE (verbindlich) ===
Wo Aussagen im Buchtext den folgenden Strukturdaten widersprechen, beziehe dich in
der passenden Achse konkret auf die widersprüchliche Stelle und nenne die
Kartei-Wahrheit. Wo die Strukturdaten schweigen, NICHT raten.

${parts.join('\n\n')}
=== ENDE STRUKTURDATEN ===
`;
}

/**
 * Auf welche Achse der Form-Befund zielt. `textsortentreue` gibt es nur im
 * journalistischen Profil; sonst ist der Aufbau die nächstliegende Achse.
 */
function _strukturAchse(axes) {
  const keys = axes.map(a => a.key);
  return ['textsortentreue', 'struktur', 'kohaerenz'].find(k => keys.includes(k)) || keys[0];
}

/**
 * Baut den Block „Form-Befunde des Struktur-Checks".
 *
 * Der einzige Kontextblock, der eine MESSUNG einbringt statt Kartei-Wahrheit
 * (Komplettanalyse) oder Autor-Absicht (Motive): ein regelbasierter Check hat
 * jeden Beitrag gegen den Soll-Katalog seiner Textsorte geprüft. Ohne ihn
 * schätzt das Modell die Formtreue, obwohl sie vorliegt.
 *
 * Drei Rahmungen, die der Block leisten muss:
 *  · Ungeprüfte Beiträge sind UNBEKANNT, nicht in Ordnung — sonst liest das
 *    Modell eine Teilprüfung als Freibrief für den Rest.
 *  · Die Bewertung soll den Befund verwenden, nicht nacherzählen: ihre Aufgabe
 *    ist das Ganze (Auswahl, Bandbreite, Niveau über die Sammlung).
 *  · Was der Deckel geschluckt hat, wird ausgewiesen.
 *
 * @param {object|null} ctx  Ausgabe von lib/struktur-summary.js
 * @param {{achse:string}} opts Achse dieses Profils, auf die der Befund zielt
 */
function _buildStrukturContextBlock(ctx, { achse = 'struktur' } = {}) {
  if (!ctx || !ctx.geprueft) return '';
  const parts = [];
  const u = ctx.urteile || {};
  parts.push(`Gesamturteile: ${u.traegt || 0}× trägt · ${u.lueckenhaft || 0}× lückenhaft · ${u.verfehlt || 0}× verfehlt`);

  if (ctx.proTextsorte?.length) {
    const lines = ctx.proTextsorte.map(t =>
      `- ${textsorteLabel(t.textsorte)} (${t.anzahl}): ${t.traegt} trägt, ${t.lueckenhaft} lückenhaft, ${t.verfehlt} verfehlt`);
    parts.push(`Nach Textsorte:\n${lines.join('\n')}`);
  }

  if (ctx.luecken?.length) {
    const lines = ctx.luecken.map(l => {
      const regel = textsorte(l.textsorte)?.regeln?.[l.nr - 1] || '';
      const kurz = regel ? regel.replace(/\s+/g, ' ').slice(0, 90).trim() + (regel.length > 90 ? '…' : '') : `Regel ${l.nr}`;
      const zaehler = [l.fehlt ? `${l.fehlt}× fehlt` : null, l.teilweise ? `${l.teilweise}× teilweise` : null].filter(Boolean).join(', ');
      return `- ${textsorteLabel(l.textsorte)}, Regel ${l.nr} (${kurz}): ${zaehler}`;
    });
    parts.push(`Häufigste Formlücken:\n${lines.join('\n')}`);
  }

  if (ctx.wFragen?.length) {
    parts.push(`Im Lead unbeantwortete W-Fragen: ${ctx.wFragen.map(w => `${w.frage} (${w.anzahl}×)`).join(', ')}`);
  }

  if (ctx.seiten?.length) {
    const lines = ctx.seiten.map(s => {
      const m = s.maengel?.length ? `\n    ${s.maengel.map(x => `Regel ${x.nr} ${x.status}: ${x.befund}`).join('\n    ')}` : '';
      return `- «${s.titel}» (${textsorteLabel(s.textsorte)}, ${s.urteil})${m}`;
    });
    const rest = ctx.seitenGekuerzt ? `\n(${ctx.seitenGekuerzt} weitere auffällige Beiträge hier nicht gelistet.)` : '';
    parts.push(`Auffällige Beiträge:\n${lines.join('\n')}${rest}`);
  }

  return `
=== FORM-BEFUNDE DES STRUKTUR-CHECKS (gemessen, keine Schätzung) ===
Ein regelbasierter Check hat ${ctx.geprueft} von ${ctx.gesamt} Beiträgen gegen den
Soll-Katalog ihrer Textsorte geprüft. Stütze die Achse "${achse}" auf diese Befunde,
statt die Formtreue zu schätzen. Die ${ctx.gesamt - ctx.geprueft} ungeprüften Beiträge sind
UNBEKANNT, nicht in Ordnung — zähle sie weder als erfüllt noch als mangelhaft.
Verwende den Befund, zähle ihn nicht noch einmal auf: deine Aufgabe bleibt das Ganze
(Auswahl, Bandbreite, Niveau und Komposition über die Sammlung), nicht die Formkritik
am Einzelbeitrag — die steht bereits hier.

${parts.join('\n\n')}
=== ENDE FORM-BEFUNDE ===
`;
}

/**
 * Baut den Block „Themen & Motive aus der Motiv-Werkstatt" für die BUCHbewertung.
 * Nur buchweit gedacht (nicht für die Kapitelbewertung).
 *
 * Wichtiger Unterschied zu _buildKomplettContextBlock: diese Daten sind teils
 * AUTOR-ABSICHT (das geplante Soll), keine aus dem Text extrahierte Wahrheit.
 * Der Block ist entsprechend gerahmt — das Modell soll die Umsetzung und
 * thematische Kohärenz beurteilen (v.a. auf der Achse "thema"), aber eine
 * bewusste Abweichung vom Plan NICHT als Fehler werten. Pro Motiv steht das
 * Soll (verankerte Figuren/Kapitel/Beats/Seiten) neben dem Ist (Fundstellen der
 * Motiverkennung). Erscheint nur, wenn mindestens ein Motiv existiert.
 *
 * @param {{themen:Array, motive:Array}} ctx
 * @returns {string} Block oder '' (wenn keine Motive)
 */
function _buildMotivContextBlock(ctx) {
  if (!ctx || !ctx.motive?.length) return '';
  const parts = [];

  if (ctx.themen?.length) {
    const lines = ctx.themen.map(t => `- ${t.name}${t.beschreibung ? ` – ${t.beschreibung}` : ''}`);
    parts.push(`Themen (abstrakte Klammern):\n${lines.join('\n')}`);
  }

  const motifLines = ctx.motive.map(m => {
    const thema = m.thema ? ` [Thema: ${m.thema}]` : '';
    const desc = m.beschreibung ? ` – ${m.beschreibung}` : '';
    const soll = [];
    if (m.sollFiguren?.length) soll.push(`Figuren: ${m.sollFiguren.join(', ')}`);
    if (m.sollKapitel?.length) soll.push(`Kapitel: ${m.sollKapitel.join(', ')}`);
    if (m.sollBeats)  soll.push(`${m.sollBeats} Beat(s)`);
    if (m.sollSeiten) soll.push(`${m.sollSeiten} Abschnitt(e)`);
    const sollStr = soll.length ? `geplant verankert an ${soll.join('; ')}` : 'keine konkrete Verankerung geplant';
    return `- «${m.name}»${thema}${desc}\n    Soll: ${sollStr} · Ist: ${m.istFunde} Fundstelle(n) im Text`;
  });
  parts.push(`Motive (Soll = Plan des Autors, Ist = automatisch im Text gefunden):\n${motifLines.join('\n')}`);

  return `
=== THEMEN & MOTIVE AUS DER MOTIV-WERKSTATT (Absicht des Autors, KEINE Textwahrheit) ===
Das Folgende ist die vom Autor GEPLANTE thematische Ebene, nicht aus dem Text
extrahiert. Nutze es, um auf der Achse "thema" (roter Faden) die inhaltliche
Kohärenz und die Umsetzung der Motive zu beurteilen: Wird ein zentrales Motiv
tatsächlich getragen (hohes Ist), oder ist es nur geplant und im Text kaum
präsent (Soll vorhanden, Ist niedrig/0)? Ein solcher Soll/Ist-Bruch ist ein
möglicher Hinweis auf ein unterentwickeltes Motiv. ABER: Weiche der Autor
bewusst von seinem Plan ab, ist das kein Fehler — bewerte die Wirkung des
tatsächlichen Textes, nicht die Treue zum Plan. Wo diese Daten schweigen, NICHT raten.

${parts.join('\n\n')}
=== ENDE THEMEN & MOTIVE ===
`;
}

/** Achse, auf die die Plot-Planung zielt — wie _strukturAchse eine bestehende
 *  Achse des Profils, keine neue (ein Achsen-Key ist eine Persistenz-Konstante). */
function _planAchse(axes) {
  const keys = axes.map(a => a.key);
  return ['dramaturgie', 'kohaerenz', 'argumentation', 'komposition'].find(k => keys.includes(k)) || keys[0];
}

/**
 * Baut den Block „Geplante Handlung" fuer die KAPITELbewertung: die Beats der
 * Plot-Werkstatt, die auf dieses Kapitel zielen.
 *
 * Wie der Motiv-Block ist das AUTOR-ABSICHT, keine Textwahrheit. Drei Rahmungen
 * sind Pflicht:
 *  · Abweichung vom Plan ist kein Fehler — bewertet wird die Wirkung des Textes.
 *  · Der Ist-Befund der Verankerung ist eine Suche, kein Beweis: „0 Fundstellen"
 *    heisst „nicht wiedergefunden", nicht „fehlt sicher".
 *  · Ohne Verankerungslauf ist das Ist UNBEKANNT — dann nichts daraus ableiten.
 */
function _buildPlanContextBlock(ctx, { achse } = {}) {
  if (!ctx || !ctx.beats?.length) return '';
  const lines = ctx.beats.map(b => {
    const ort = [b.akt && `Akt: ${b.akt}`, b.strang && `Strang: ${b.strang}`].filter(Boolean).join(' · ');
    const meta = [
      b.status === 'im_buch' ? 'als eingearbeitet markiert' : 'noch geplant',
      b.figuren?.length ? `Figuren: ${b.figuren.join(', ')}` : '',
      b.orte?.length ? `Orte: ${b.orte.join(', ')}` : '',
      b.intensitaet ? `Spannung ${b.intensitaet}/5` : '',
      b.im_text == null ? '' : `im Text wiedergefunden: ${b.im_text}×`,
    ].filter(Boolean).join(' · ');
    return `- «${b.titel}»${ort ? ` [${ort}]` : ''}${b.beschreibung ? ` – ${b.beschreibung}` : ''}\n    ${meta}`;
  });
  const gekappt = ctx.gesamt > ctx.beats.length ? `\n(${ctx.gesamt - ctx.beats.length} weitere Beats nicht gelistet.)` : '';
  const ist = ctx.verankert
    ? `"im Text wiedergefunden" ist eine semantische Suche nach dem Beat im Buchtext, kein Beweis:
0× heisst "nicht wiedergefunden", nicht "fehlt sicher". Ein als eingearbeitet markierter Beat mit 0×
ist ein Hinweis, den Text darauf zu prüfen; ein noch geplanter Beat mit Treffern ist offenbar schon geschrieben.`
    : `Für diese Beats liegt kein Abgleich mit dem Text vor — ob sie umgesetzt sind, ist UNBEKANNT.
Leite es ausschliesslich aus dem Kapiteltext ab.`;
  return `
=== GEPLANTE HANDLUNG AUS DER PLOT-WERKSTATT (Absicht des Autors, KEINE Textwahrheit) ===
Das Folgende sind die Handlungspunkte (Beats), die der Autor für dieses Kapitel GEPLANT hat,
in Lesereihenfolge des Plans. Nutze sie auf der Achse "${achse}": Löst das Kapitel ein, was es
laut Plan leisten soll, und trägt es die geplanten Wendungen dramaturgisch? Weicht der Text
bewusst vom Plan ab, ist das KEIN Fehler — bewerte die Wirkung des tatsächlichen Textes, nicht
die Treue zum Plan. Erfinde keine Inhalte aus dem Plan in den Text hinein.
${ist}

${lines.join('\n')}${gekappt}
=== ENDE GEPLANTE HANDLUNG ===
`;
}

/**
 * Baut den Block „Offene Pendenzen des Autors" fuer die KAPITELbewertung.
 *
 * Die Pendenzen sind dem Autor BEKANNT. Eine Empfehlung, die eine davon nur
 * wiederholt, ist Rauschen; bestaetigen oder schaerfen darf die Bewertung sie.
 * Sie sind keine Textwahrheit und kein Massstab fuer die Note.
 */
function _buildIdeenContextBlock(ctx) {
  if (!ctx || !ctx.ideen?.length) return '';
  const lines = ctx.ideen.map(i => `- [${i.ort}] «${i.content}»`);
  const gekappt = ctx.gesamt > ctx.ideen.length ? `\n(${ctx.gesamt - ctx.ideen.length} weitere nicht gelistet.)` : '';
  return `
=== OFFENE PENDENZEN DES AUTORS ZU DIESEM KAPITEL (ihm bekannt, KEINE Textwahrheit) ===
Diese Punkte hat der Autor selbst als noch offen notiert. Wiederhole sie NICHT als neue
Empfehlung. Trifft deine Beobachtung eine davon, darfst du sie bestätigen oder präzisieren
und das kenntlich machen ("wie bereits notiert: …"). Beeinflussen sie die Note nicht — bewertet
wird der Text.

${lines.join('\n')}${gekappt}
=== ENDE PENDENZEN ===
`;
}

/** Achse, auf die die Weltaufbau-Messung zielt. Wie _strukturAchse: der Befund
 *  bekommt die Achse des Profils, die inhaltliche Stimmigkeit fuehrt — nicht eine
 *  neue Achse. Ein zusaetzlicher Achsen-Key waere eine Persistenz-Konstante und
 *  wuerde jedes bestehende Bewertungs-JSON um ein Pflichtfeld aermer machen. */
function _weltAchse(axes) {
  const keys = axes.map(a => a.key);
  return ['thema', 'kohaerenz', 'struktur'].find(k => keys.includes(k)) || keys[0];
}

/**
 * Baut den Block „Weltaufbau-Befunde" fuer die BUCHbewertung.
 *
 * Zweiter MESSENDER Block neben dem Struktur-Check: gezaehlt wird der Welt-Fakten-
 * Index (`world_facts`) — Kategorien, Naben, Verteilung ueber den Buchbogen,
 * Kapitel ohne einen einzigen etablierten Fakt. Im Multi-Pass ist das die einzige
 * Aussage zum Weltaufbau, die nicht durch eine Zusammenfassung gegangen ist.
 *
 * Drei Rahmungen sind Pflicht — jede fangt eine Fehllesung ab, die teurer waere
 * als der Block wert ist:
 *  · Die Fakten sind KI-EXTRAHIERT, kein von der Autorin kuratierter Kanon. Eine
 *    Luecke kann eine Luecke der Extraktion sein.
 *  · Ein Kapitel ohne Fakt ist NICHT automatisch weltarm — Szenen brauchen keine
 *    neuen Weltaussagen. Es ist ein Hinweis, kein Befund.
 *  · Wenig Fakten sind kein Mangel: ein Kammerspiel etabliert wenig Welt, und das
 *    ist eine Form, keine Schwaeche.
 *
 * @param {object|null} ctx  Ausgabe von lib/welt-summary.js
 * @param {{achse:string}} opts Achse dieses Profils, auf die der Befund zielt
 * @returns {string} Block oder '' (nicht erhoben / leer)
 */
function _buildWeltContextBlock(ctx, { achse = 'thema' } = {}) {
  if (!ctx || !ctx.gesamt) return '';
  const parts = [];
  parts.push(`Etablierte Welt-Fakten: ${ctx.gesamt}`);

  if (ctx.proKategorie?.length) {
    parts.push(`Nach Kategorie: ${ctx.proKategorie.map(k => `${k.kategorie} (${k.anzahl})`).join(', ')}`);
  }

  const b = ctx.bogen || {};
  parts.push(`Verteilung über den Buchbogen: Anfang ${b.anfang || 0} · Mitte ${b.mitte || 0} · Schluss ${b.schluss || 0}`
    + (ctx.ohneKapitelBezug ? ` (${ctx.ohneKapitelBezug} Fakten ohne Kapitelbezug, im Bogen nicht enthalten)` : ''));

  const ka = ctx.kapitelAbdeckung || {};
  if (ka.gesamt) {
    const rest = ka.ohneFaktenGekuerzt ? ` … und ${ka.ohneFaktenGekuerzt} weitere` : '';
    const liste = ka.ohneFakten?.length ? `: ${ka.ohneFakten.join(', ')}${rest}` : '';
    parts.push(`Kapitel mit mindestens einem etablierten Fakt: ${ka.mitFakten} von ${ka.gesamt}`
      + (ka.ohneFakten?.length ? `\nOhne etablierten Fakt${liste}` : ''));
  }

  if (ctx.topSubjekte?.length) {
    parts.push(`Naben der Welt (Subjekte mit mehreren Fakten): ${ctx.topSubjekte.map(s => `${s.subjekt} (${s.anzahl})`).join(', ')}`);
  }

  if (ctx.beispiele?.length) {
    const lines = ctx.beispiele.map(x => `- [${x.kategorie}] ${x.subjekt ? `${x.subjekt}: ` : ''}${x.fakt}`);
    parts.push(`Beispiele (über die Kategorien gestreut):\n${lines.join('\n')}`);
  }

  return `
=== WELTAUFBAU-BEFUNDE (gemessen am Fakten-Index, keine Schätzung) ===
Die Buchanalyse hat ${ctx.gesamt} etablierte Welt-Fakten extrahiert (Weltregeln, Orte,
Technik, Kultur, Historie …). Nutze die Zahlen für die Achse "${achse}", statt die
Dichte des Weltaufbaus zu schätzen — im Mehrfach-Pass ist das die einzige Angabe
dazu, die nicht durch eine Zusammenfassung gegangen ist.
DREI EINSCHRÄNKUNGEN, die du mitdenken MUSST:
· Die Fakten sind automatisch EXTRAHIERT, kein von der Autorin kuratierter Kanon —
  eine Lücke kann eine Lücke der Extraktion sein, nicht des Buchs.
· Ein Kapitel ohne etablierten Fakt ist NICHT weltarm: eine Szene, die auf bereits
  Etabliertem spielt, braucht keine neue Weltaussage. Behandle es als Hinweis auf
  eine mögliche Leerstelle, nicht als Befund.
· Wenige Fakten sind kein Mangel. Ein Kammerspiel etabliert wenig Welt — das ist
  eine Form, keine Schwäche. Beurteile die WIRKUNG, nicht die Zahl.
Verwende den Befund, zähle ihn nicht noch einmal auf.

${parts.join('\n\n')}
=== ENDE WELTAUFBAU-BEFUNDE ===
`;
}

export {
  _buildReviewSchwerpunktBlock, _buildChapterPositionBlock, _buildWerkstandBlock,
  _buildKomplettContextBlock, _strukturAchse, _buildStrukturContextBlock,
  _buildMotivContextBlock, _weltAchse, _buildWeltContextBlock,
  _planAchse, _buildPlanContextBlock, _buildIdeenContextBlock,
};
