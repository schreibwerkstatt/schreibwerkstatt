// Plot-Werkstatt (Beat-Board): planende KI-Assistenz für die Handlungsskizze.
// Zwei Job-Typen — beide rein planend/überwachend, NIE generativ in den Text:
//   - Brainstorm:   schlägt Beats (Handlungspunkte) für einen Akt vor.
//   - Consistency:  prüft den geplanten Plot gegen die Buchrealität
//                   (archivierte Akte = abgeschlossen: Kontext, kein Arbeitsziel)
//                   (Kapitel + extrahierte Szenen + Figuren) und meldet
//                   Brüche, Lücken und „geplant vs. schon geschrieben"-Drift.
//
// Aufteilung: Zeilen-Renderer der Kontext-Listen in plot/lines.js, Board-
// Darstellung (Lesereihenfolge, Spannungsverlauf, Vorlauf, Sprache) in
// plot/board.js; hier die beiden Prompts + Schemas.
//
// Severity-Vokabular: kritisch/stark/mittel/schwach/niedrig — matcht
// .severity-tag--* in DESIGN.md (gleiche Skala wie die Figuren-Werkstatt).

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';
import {
  _figurenLinesDetail, _orteLines, _zeitstrahlLines, _kontinuitaetLines, _rechercheLines,
  _werkstattFigurenLines, _kapitelLines, _relationsLines, _szenenLines, _weltgesetzeLines,
  _straengeLines,
} from './plot/lines.js';
import {
  DATEN_REGEL, _boardOutline, _hasArchivedActs, _hasOwnActs, _hasThreadInheritance,
  _reihenfolgeRegel, _spannungLines, _cutNote, _kuerzungsRegel, _deltaBlock, plotSprachRegel,
} from './plot/board.js';

export { plotReadingBlocks, plotSprachRegel } from './plot/board.js';
export { _ideenMarker as ideenMarker } from './plot/lines.js';

const SEVERITY_ENUM = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

// Befund-Typen (Pflicht je Konflikt): die UI gruppiert/filtert danach. Ein Key ist
// eine Persistenz-Konstante (plot_consistency_runs.result_json, i18n) — ergänzen
// ja, umbenennen nein.
export const PLOT_KONFLIKT_TYP_ENUM = [
  'status', 'chronologie', 'kausalitaet', 'setup_payoff', 'strang',
  'figur', 'weltgesetz', 'spannung', 'logik', 'struktur',
];

// Kuratierte Relations-Typen, die eine Befund-Aktion anlegen darf (from = Beat des
// Befunds). Spiegel der kuratierten Frontend-Vorschläge in plot_beat_relations.
export const PLOT_AKTION_REL_TYPES = ['bereitet-vor', 'zahlt-ein', 'fuehrt-zu', 'motiviert', 'blockiert', 'spiegelt'];

// Aktions-Arten im Modell-Output. 'keine' existiert nur im Schema (Constrained
// Decoding verträgt ein immer vorhandenes Objekt besser als null|Objekt); der Job
// normalisiert sie auf `aktion: null`.
const AKTION_ART_ENUM = ['keine', 'status', 'verwerfen', 'relation'];
const STATUS_WERT_ENUM = ['im_buch', 'geplant'];

// ── System-Prompt ────────────────────────────────────────────────────────────
// Self-contained (keine Locale-Config-Abhängigkeit): Rolle + JSON-Only-Pflicht.
// Die Ausgabesprache regelt der User-Prompt (plotSprachRegel, aus der Buch-Locale).

export function buildPlotSystemPrompt() {
  return `Du bist ein erfahrener Dramaturg und Lektor. Du hilfst der Autorin, die HANDLUNG (Plot) ihres Buches zu PLANEN und zu strukturieren — als Beat-Board aus Akten (Spalten) und Beats (einzelnen Handlungspunkten).

WICHTIG: Du planst und prüfst nur die STRUKTUR. Du schreibst NIEMALS Fliesstext, Szenen oder Prosa ins Manuskript. Deine Beats sind kurze, strukturelle Stichpunkte — keine ausformulierten Textpassagen.${_jsonOnly()}`;
}

// Gemeinsame Kontext-Segmente beider Prompts.
function _ctxSegments({ buchKontext, figuren, werkstattFiguren, kapitel, orte, zeitstrahl, kuerzungen, werkstattHint, zeitHint, kapitelLabel }) {
  const k = kuerzungen || {};
  const figLines = _figurenLinesDetail(figuren);
  const wfLines = _werkstattFigurenLines(werkstattFiguren);
  const kapLines = _kapitelLines(kapitel);
  const orteLines = _orteLines(orte);
  const zeitLines = _zeitstrahlLines(zeitstrahl);
  return {
    ctxSeg: (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '',
    figSeg: figLines ? `\nFIGUREN-ENSEMBLE${_cutNote(k, 'figuren')}:\n${figLines}\n` : '',
    wfSeg: wfLines ? `\nFIGUREN-WERKSTATT${_cutNote(k, 'werkstattFiguren')} (${werkstattHint}):\n${wfLines}\n` : '',
    kapSeg: kapLines ? `\n${kapitelLabel} (chronologisch)${_cutNote(k, 'kapitel')}:\n${kapLines}\n` : '',
    orteSeg: orteLines ? `\nSCHAUPLÄTZE (Orte des Buchs)${_cutNote(k, 'orte')}:\n${orteLines}\n` : '',
    zeitSeg: zeitLines ? `\nZEITSTRAHL (${zeitHint})${_cutNote(k, 'zeitstrahl')}:\n${zeitLines}\n` : '',
    zeitLines,
  };
}

// ── Brainstorm ──────────────────────────────────────────────────────────────
// Schlägt 3–7 Beats für einen bestimmten Akt vor. Der Zielakt wird per ID (oder
// als Akt-Objekt) bestimmt — Aktnamen sind nicht eindeutig (jeder Strang mit
// eigener Aktstruktur kann einen eigenen „Akt 1" haben).
//
// opts: { locale, kuerzungen, descMax }

export function buildPlotBrainstormPrompt(target, acts, beats, buchKontext, figuren = [], kapitel = [], werkstattFiguren = [], threads = [], threadInfo = null, orte = [], zeitstrahl = [], recherche = [], opts = {}) {
  const { locale = 'de-CH', kuerzungen = {}, descMax = 200 } = opts || {};
  const act = (target && typeof target === 'object') ? target : (acts || []).find(a => a.id === target);
  if (!act) throw new Error('buildPlotBrainstormPrompt: Zielakt nicht im Board');
  const seg = _ctxSegments({
    buchKontext, figuren, werkstattFiguren, kapitel, orte, zeitstrahl, kuerzungen,
    werkstattHint: 'in Entwicklung, evtl. noch nicht im Manuskript — als Beat-Figuren nutzbar; wo vorhanden mit innerem Konflikt Will/Braucht/Wunde/Lüge + Bogen',
    zeitHint: 'chronologische Ereignisse der Figuren',
    kapitelLabel: 'VORHANDENE KAPITEL',
  });
  const rechLines = _rechercheLines(recherche);
  const rechSeg = rechLines ? `\nVERKNÜPFTE RECHERCHE${_cutNote(kuerzungen, 'recherche')} (vom Autor zu diesem Akt gesammeltes Material — Fakten/Quellen, die die Beats erden sollen; verwende sie als Hintergrund, übernimm sie NICHT als Prosa und zitiere sie nicht):\n${rechLines}\n` : '';
  const strLines = _straengeLines(threads);
  const inheritNote = _hasThreadInheritance(threads)
    ? '\nVERERBUNG: Ein Beat in einem Strang beteiligt IMPLIZIT dessen Hauptfigur; hat er kein eigenes Kapitel, gilt das Kapitel des Strangs. Behandle das als gesetzt, auch wenn es nicht pro Beat wiederholt wird.\n'
    : '';
  const strSeg = strLines ? `\nHANDLUNGSSTRÄNGE (Swimlanes — parallele Erzähllinien, oft je Hauptfigur):\n${strLines}\n${inheritNote}` : '';

  // Zielzelle: bei gesetztem Strang sind „bereits vorhandene Beats" die der Zelle
  // (Akt × Strang); sonst akt-weit.
  const existing = (beats || [])
    .filter(b => b.act_id === act.id)
    .filter(b => !threadInfo || (b.thread_id ?? null) === (threadInfo.id ?? null))
    .map(b => `- ${b.titel}`);
  const existSeg = existing.length
    ? `\nBEREITS VORHANDENE BEATS ${threadInfo ? 'IN DIESER ZELLE' : 'IN DIESEM AKT'} (NICHT wiederholen):\n${existing.join('\n')}\n`
    : '';

  const threadGoal = threadInfo
    ? `\nZIEL-STRANG: "${threadInfo.name}"${threadInfo.figur ? ` (Hauptfigur: ${threadInfo.figur})` : ''}${threadInfo.kapitel ? ` (Kapitel: ${threadInfo.kapitel})` : ''}\nDie Beats sollen GENAU diesen Erzählstrang vorantreiben${threadInfo.figur ? ` und ${threadInfo.figur} ins Zentrum stellen` : ''}${threadInfo.kapitel ? ` (sie spielen im Kapitel „${threadInfo.kapitel}", sofern nicht anders nötig)` : ''} — nicht die anderen Stränge.\n`
    : '';

  // Zielakt eindeutig: Name + Scope (geteilt / eigener Akt eines Strangs).
  const owner = act.thread_id != null ? (threads || []).find(t => t.id === act.thread_id) : null;
  const scope = act.thread_id != null
    ? `eigener Akt von Strang „${owner ? owner.name : `#${act.thread_id}`}"`
    : 'geteilter Akt';
  const aktLabel = `"${act.name}" (${scope})`;
  const orderNote = _hasOwnActs(acts) ? `\nREIHENFOLGE: ${_reihenfolgeRegel(acts)}\n` : '';

  return `Die Autorin skizziert die Handlung ihres Buches als Beat-Board und braucht 3–7 prägnante neue Beats (Handlungspunkte) für den Akt ${aktLabel}${threadInfo ? ` im Strang "${threadInfo.name}"` : ''}.

${DATEN_REGEL}

AKTUELLES BOARD${_cutNote(kuerzungen, 'beats')}:
${_boardOutline(acts, beats, threads, null, { descMax })}
${orderNote}${seg.ctxSeg}${seg.figSeg}${seg.wfSeg}${seg.kapSeg}${seg.orteSeg}${seg.zeitSeg}${rechSeg}${strSeg}${_kuerzungsRegel(kuerzungen)}${threadGoal}${existSeg}
ZIEL-AKT: ${aktLabel}

Liefere 3–7 konkrete, voneinander unterscheidbare Beat-Vorschläge für diesen Akt${threadInfo ? ' + Strang' : ''}. Jeder Beat:
- 3–10 Wörter im Label (kurz, dramaturgisch konkret: Wendepunkt, Konflikt, Entscheidung, Enthüllung — kein vager Themen-Begriff)
- Knappe Begründung (1 Satz), warum der Beat an dieser Stelle die Handlung trägt und zum Ensemble passt
- Baut auf den vorhandenen Beats auf (Beschreibung, Figuren, Motive, Intensität) und treibt die Spannungskurve voran
- Bedient ein Beat eine beteiligte Werkstatt-Figur, soll er ihren inneren Konflikt (Will/Braucht/Wunde/Lüge) oder Bogen vorantreiben — nicht nur äusserlich funktionieren
- Keine Wiederholung bestehender Beats
- Keine ausformulierte Prosa — nur die strukturelle Idee

${plotSprachRegel(locale)}

Antworte mit diesem JSON-Schema:
{
  "vorschlaege": [
    { "label": "kurzer Beat", "begruendung": "1 Satz" }
  ]
}`;
}

export const SCHEMA_PLOT_BRAINSTORM = _obj({
  vorschlaege: {
    type: 'array',
    items: _obj({ label: _str, begruendung: _str }),
  },
});

// ── Consistency-Check ─────────────────────────────────────────────────────────
// Prüft den geplanten Plot gegen die Buchrealität: extrahierte Szenen + Kapitel +
// Figuren. Findet Brüche, Lücken und „geplant vs. schon geschrieben"-Drift.
//
// opts: { locale, kuerzungen, descMax, delta }
//   delta = { datum, konflikte, konflikteTotal, geaendert } aus dem letzten Lauf
//           (routes/jobs/plot/result.js#buildDeltaContext) oder null.

export function buildPlotConsistencyPrompt(acts, beats, kapitel = [], szenen = [], figuren = [], buchKontext = '', werkstattFiguren = [], threads = [], orte = [], zeitstrahl = [], kontinuitaet = [], recherche = [], anchorMap = null, anchorInfo = {}, relations = [], weltgesetze = [], opts = {}) {
  const { locale = 'de-CH', kuerzungen = {}, descMax = 200, delta = null } = opts || {};
  const k = kuerzungen;
  const seg = _ctxSegments({
    buchKontext, figuren, werkstattFiguren, kapitel, orte, zeitstrahl, kuerzungen,
    werkstattHint: 'geplante/in Entwicklung befindliche Figuren — Beats dürfen sie referenzieren, ohne dass sie schon im Manuskript stehen müssen',
    zeitHint: 'chronologische Ereignisse der Figuren, = Buchrealität',
    kapitelLabel: 'KAPITEL DES BUCHS',
  });
  const szLines = _szenenLines(szenen);
  const szSeg = szLines
    ? `\nIM BUCH VORHANDENE SZENEN (aus der Analyse, = „Buchrealität")${_cutNote(k, 'szenen')}:\n${szLines}\n`
    : '\nHINWEIS: Es liegen noch keine analysierten Szenen vor (Komplettanalyse evtl. nicht gelaufen). Prüfe den Plot dann primär gegen die Kapitelstruktur.\n';
  const kontiLines = _kontinuitaetLines(kontinuitaet);
  const kontiSeg = kontiLines ? `\nBEKANNTE KONTINUITÄTS-BEFUNDE (offen, aus dem letzten Continuity-Check — beziehe sie ein, dopple sie aber nicht)${_cutNote(k, 'kontinuitaet')}:\n${kontiLines}\n` : '';
  const rechLines = _rechercheLines(recherche);
  const rechSeg = rechLines ? `\nVERKNÜPFTE RECHERCHE (vom Autor zu Beats/Strängen gesammeltes Material — Fakten/Quellen als Realitätsanker)${_cutNote(k, 'recherche')}:\n${rechLines}\n` : '';
  const strLines = _straengeLines(threads);
  const inheritNote = _hasThreadInheritance(threads)
    ? '\nVERERBUNG: Ein Beat in einem Strang beteiligt IMPLIZIT dessen Hauptfigur; hat er kein eigenes Kapitel, gilt das Kapitel des Strangs (im Board als „(vom Strang)" markiert). Beanstande einen Beat NICHT als „Figur fehlt"/„Kapitel fehlt", wenn der Strang sie liefert.\n'
    : '';
  const strSeg = strLines ? `\nHANDLUNGSSTRÄNGE (Swimlanes — parallele Erzähllinien, oft je Hauptfigur; im Board hinter den Beats als {Strang: …} annotiert):\n${strLines}\n${inheritNote}` : '';
  // Archiv-Regel: ein archivierter Akt ist ABGESCHLOSSEN, nicht ausgemustert. Ein
  // Widerspruch, der IN den offenen Plot hineinreicht, bleibt meldepflichtig.
  const archNote = _hasArchivedActs(acts)
    ? '\nARCHIVIERTE AKTE: Mit „ARCHIVIERT" gekennzeichnete Akte hat die Autorin als abgeschlossen erklärt — ihre Beats sind ins Manuskript eingearbeitet. Behandle sie als Vorgeschichte/Setup-Kontext, nicht als Arbeitsvorrat: melde dort KEINE Status-Pflege, keine fehlenden Beats und keine dramaturgischen Lücken. Melde einen Befund in einem archivierten Akt nur, wenn er in den noch offenen Plot hineinwirkt (Widerspruch zu einem geplanten Beat, unaufgelöstes Setup, gebrochene Kausalkette) — dann nenne ihn ausdrücklich als Rückwirkung.\n'
    : '';
  const hybridNote = _hasOwnActs(acts)
    ? `\nHYBRID-AKTE: Manche Stränge haben eine EIGENE Aktstruktur (im Board als eigener Block „STRANG … — EIGENE AKTSTRUKTUR"), andere teilen sich die geteilten Akte. Ein Strang mit eigenen Akten plant absichtlich unabhängig — beanstande NICHT, dass er die geteilten Akte „überspringt". Prüfe seinen dramaturgischen Bogen INNERHALB seiner eigenen Akte.\n`
    : '';
  const orderSeg = `\nREIHENFOLGE: ${_reihenfolgeRegel(acts)}\n`;
  // Weltgesetz-Segment: fehlt es, wird NICHT behauptet, die Welt habe keine Regeln.
  const weltLines = _weltgesetzeLines(weltgesetze);
  const weltSeg = weltLines
    ? `\nETABLIERTE WELTGESETZE (aus der Buchanalyse extrahierte Regeln + Technik-Stand dieser Welt — was hier GILT, unabhaengig davon, was schon geschrieben ist)${_cutNote(k, 'weltgesetze')}:\n${weltLines}\n`
    : '';
  const weltChecks = weltLines
    ? `
- Verstoss gegen ein Weltgesetz: Setzt ein geplanter Beat etwas voraus, das nach den oben gelisteten Regeln/dem Technik-Stand dieser Welt NICHT moeglich ist (eine Regel wird gebrochen, ohne dass der Beat das als Bruch ausweist)? Nenne die verletzte Regel woertlich im "problem". Ein bewusst gesetzter Regelbruch, den der Beat selbst als Wendepunkt benennt, ist KEIN Fehler — beanstande nur den unbemerkten Widerspruch. Die Regeln sind extrahiert, nicht von der Autorin kuratiert: passt eine Regel erkennbar nicht, urteile nicht dagegen.`
    : '';
  const relLines = _relationsLines(relations);
  const relSeg = relLines
    ? `\nBEAT-BEZIEHUNGEN (vom Autor explizit gezogene Kanten zwischen Beats — Kausalität + Setup/Payoff)${_cutNote(k, 'relationen')}:\n${relLines}\n`
    : '';
  // Textbeleg-Segment: nur bei befülltem Index (sonst hiesse „KEIN Textbeleg" bloss
  // „nie gescannt" → falsche Drift-Flut).
  const anchorSeg = anchorMap ? `
TEXTBELEGE (semantische Suche über das ECHTE Manuskript): Nur "im Buch"-Beats werden gegen den Text abgeglichen; hinter ihnen stehen ⟨…⟩-Marker, die zeigen, ob und wo der Beat tatsächlich im Buchtext auftaucht. Sie sind dein wichtigster Realitätsanker — genauer als der Szenen-Index:
- "im Buch" + „KEIN Textbeleg" → starkes Drift-Signal: der Plan behauptet etwas, das die Textsuche NICHT findet. Priorisiere das und nenne den Beat samt Abschnitt, falls bekannt.
- "im Buch" + Textbeleg → im Text belegt; beanstande ihn NICHT als „fehlt", ausser der Beleg-Ausschnitt passt inhaltlich erkennbar nicht zum Beat.
Der Marker ist Ähnlichkeit, kein Beweis — urteile am Beleg-Ausschnitt, nicht blind. Nenne den belegenden Abschnitt im "problem"/"vorschlag", damit die Autorin ihn anspringen kann.${anchorInfo.stale ? ' HINWEIS: Der Beleg-Index ist evtl. veraltet (Beats seit dem letzten Verankerungs-Lauf geändert) — behandle fehlende Belege bei offensichtlich frisch bearbeiteten Beats mit Vorsicht.' : ''}
` : '';
  const spannLines = _spannungLines(acts, beats, threads);
  const spannSeg = spannLines
    ? `\nSPANNUNGSVERLAUF (Intensität 1–5 je Beat, verworfene ausgenommen; „–" = kein Wert gesetzt):\n${spannLines}\n`
    : '';
  const spannChecks = spannLines
    ? `
- Spannungsbogen: Hängt der Mittelteil flach durch (lange Strecke gleicher/niedriger Intensität)? Liegt der Höhepunkt zu früh (Maximum weit vor dem Ende eines Strangs/Blocks)? Fällt die Intensität nach der Auflösung nicht ab? Urteile nur über gesetzte Werte — ein fehlender Intensitätswert („–") ist optional und KEIN Mangel.`
    : '';
  const zeitChecks = seg.zeitLines
    ? `
- Chronologie gegen Zeitstrahl: Widerspricht die Beat-Reihenfolge der zeitlichen Abfolge der Figuren-Ereignisse (Vorgriffe, Rückblenden ohne Kennzeichnung, unmögliche Gleichzeitigkeit)?`
    : '';
  const strChecks = strLines
    ? `
- Pro Strang ein vollständiger Bogen: Hat jeder Handlungsstrang (besonders je Hauptfigur) Setup, Eskalation und Auflösung — oder bricht eine Erzähllinie ohne Abschluss ab?
- Strang-Balance: Wird ein Strang über lange Strecken (Akte) gar nicht bedient, während ein anderer dominiert? POV-/Aufmerksamkeits-Lücken benennen.
- Verweben: Treffen/kreuzen sich die Stränge an sinnvollen Stellen, oder laufen sie beziehungslos nebeneinander her?`
    : '';
  const rechChecks = rechLines
    ? `
- Recherche-Abgleich: Widerspricht ein Beat dem verknüpften Recherche-Material (Fakten/Quellen)? Oder wurde zu einem Beat/Strang Recherche gesammelt, die der geplante Beat noch gar nicht aufgreift (ungenutztes Material)?`
    : '';
  const ortChecks = (beats || []).some(b => (b.locations || []).length)
    ? `
- Schauplaetze: Passt der Ort eines Beats zu dem, was dort geschieht, und zur etablierten Buchwelt (siehe Orte-Liste)? Faellt auf, dass ein dramaturgisch verwandtes Beat-Paar (Setup/Payoff, Konfrontation und ihr Ursprung) an unverbundenen Orten spielt, obwohl der gemeinsame Ort die Wirkung traegt? Ein Beat OHNE Ort ist kein Fehler — die Angabe ist optional.`
    : '';
  // Die erzählte Zeit wird deterministisch geprüft (lib/plot-time-consistency.js):
  // das Modell soll nicht nachrechnen, sondern die Plausibilität der Sprünge beurteilen.
  const zeitAngabenChecks = (beats || []).some(b => b.zeit)
    ? `
- Zeitspruenge: Passen die Abstaende zwischen datierten Beats zu dem, was dazwischen passieren muss (eine Schwangerschaft, ein Studium, eine Genesung brauchen ihre Zeit — ein Streit nicht zehn Jahre)? Rechne NICHT nach, ob ein Datum zu einem Geburtsjahr passt; das prueft die App selbst.`
    : '';
  const relChecks = relLines
    ? `
- Setup/Payoff: Wird ein „bereitet vor"-Setup nirgends eingelöst (Ziel-Beat verworfen, fehlt, oder steht in der Reihenfolge VOR dem Setup)? Zahlt ein „zahlt ein auf"-Payoff auf einen Setup ein, der fehlt/verworfen ist oder erst später kommt (Tschechows Gewehr, das nicht abgefeuert wird — oder ein Schuss ohne Gewehr)?
- Kausalität: Steht bei „führt zu"/„motiviert" die Wirkung in der Reihenfolge VOR ihrer Ursache? Widerspricht eine „blockiert"-Kante der geplanten Abfolge?
- Status-Abhängigkeit: Baut ein Beat mit Status „im Buch" (als Wirkung/Payoff einer Kante) auf einem Beat auf, der noch „geplant" ist (das Geschriebene setzt etwas voraus, das laut Plan noch gar nicht geschrieben wurde)?`
    : '';
  const deltaFeld = delta ? ', "seit_letztem_lauf": "neu|bestehend"' : '';

  return `Du prüfst die GEPLANTE Handlung (Beat-Board) der Autorin auf Stimmigkeit — in sich und gegen die tatsächliche Buchrealität (Kapitel + analysierte Szenen). Sei schonungslos, aber konstruktiv.

${DATEN_REGEL}

GEPLANTES BEAT-BOARD${_cutNote(k, 'beats')}:
${_boardOutline(acts, beats, threads, anchorMap, { descMax })}
${orderSeg}${anchorSeg}${seg.ctxSeg}${seg.kapSeg}${szSeg}${seg.figSeg}${seg.wfSeg}${seg.orteSeg}${seg.zeitSeg}${weltSeg}${kontiSeg}${rechSeg}${strSeg}${hybridNote}${archNote}${relSeg}${spannSeg}${_kuerzungsRegel(k)}${_deltaBlock(delta)}
Status-Legende der Beats: geplant (Idee, noch nicht eingearbeitet) · im Buch (laut Plan schon geschrieben). Zusätzlich kann ein Beat als "verworfen" markiert sein (ausgemustert, soll nicht mehr ins Buch).

Prüfe auf:
- Beats mit Status "im Buch", für die sich in den Szenen/Kapiteln KEINE Entsprechung finden lässt (Plan behauptet etwas, das nicht im Buch steht)
- Beats, die laut Szenen offenkundig schon geschrieben sind, aber noch auf "geplant" stehen (Status nachziehen)
- Chronologie-Brüche: die Reihenfolge der Beats passt nicht zur Reihenfolge der verknüpften Kapitel
- Logische Brüche / Widersprüche innerhalb der Handlung (Kausalität, Motivation, Figurenlogik)
- Lücken: Kapitel mit Szenen, für die es keinen Beat gibt — oder dramaturgische Leerstellen (fehlender Wendepunkt, fehlende Auflösung eines Konflikts)
- Verworfene Beats, deren Inhalt trotzdem noch im Buch auftaucht${zeitChecks}${zeitAngabenChecks}${ortChecks}${weltChecks}${strChecks}${rechChecks}${relChecks}${spannChecks}

Schwere-Skala:
- "kritisch": logischer Bruch oder Plan-Realität-Widerspruch, der die Handlung zerstört
- "stark":   deutlicher Widerspruch, sollte aufgelöst werden
- "mittel":  Spannung/Drift zwischen Plan und Buch, Klärung empfohlen
- "schwach": leichte Reibung, Hinweis genügt
- "niedrig": kosmetisch / Status-Pflege

Befund-Typ ("typ", Pflicht, genau einer): "status" (Status-Pflege geplant/im Buch, Plan-vs-Buch-Drift) · "chronologie" (Reihenfolge, Zeit) · "kausalitaet" (Ursache/Wirkung) · "setup_payoff" (vorbereitet/eingelöst) · "strang" (Bogen, Balance, Verweben der Stränge) · "figur" (Figurenlogik, Motivation) · "weltgesetz" (Verstoss gegen eine Weltregel) · "spannung" (Spannungsbogen) · "logik" (sonstiger Widerspruch) · "struktur" (Lücken, fehlende Wendepunkte, Aufbau).

Aktion ("aktion", ein Vorschlag, der sich per Klick umsetzen lässt — immer bezogen auf den Beat des Befunds, "beat_id"). Schlage eine Aktion NUR vor, wenn sie eindeutig ist und den Befund mechanisch löst; sonst "art": "keine". Übergreifende Befunde ohne "beat_id" haben immer "keine".
- "status": Status des Beats umstellen, "wert": "im_buch" oder "geplant" (nur wenn der Befund eindeutig zeigt, dass der Status falsch ist; nie für verworfene Beats)
- "verwerfen": den Beat als verworfen markieren (nur, wenn er erkennbar überflüssig/dublett ist oder dem Buch unauflösbar widerspricht)
- "relation": eine fehlende Kante ziehen, gerichtet VOM Beat des Befunds ZUM Beat "ziel_beat_id" (Zahl aus dessen [#…]-Marker, nicht derselbe Beat), "typ": einer von ${PLOT_AKTION_REL_TYPES.join(', ')}
Nicht benutzte Felder setzt du auf null.

Nenne im Feld "beat" den Titel des betroffenen Beats — oder "—" für übergreifende Befunde (Lücken, fehlende Wendepunkte). Gib zusätzlich im Feld "beat_id" die Zahl aus dem [#…]-Marker des betroffenen Beats an (z.B. [#42] → 42); für übergreifende Befunde ("—") setze "beat_id" auf null. Wenn alles stimmig ist, gib ein leeres "konflikte"-Array zurück und schreibe ein bestätigendes Fazit. "erledigt" bleibt ein leeres Array, wenn kein Vorlauf angegeben ist.

Priorisiere nach Schwere und melde die wichtigsten Befunde (höchstens ~25) — keine redundanten oder rein kosmetischen Dopplungen. Halte "problem" und "vorschlag" knapp (je 1–2 Sätze).

${plotSprachRegel(locale)}

Antworte mit diesem JSON-Schema:
{
  "konflikte": [
    { "beat": "Titel des Beats oder —", "beat_id": 42, "schwere": "kritisch|stark|mittel|schwach|niedrig", "typ": "${PLOT_KONFLIKT_TYP_ENUM.join('|')}", "problem": "kurze Beschreibung", "vorschlag": "konkreter Lösungsvorschlag", "aktion": { "art": "keine|status|verwerfen|relation", "wert": "im_buch|geplant|null", "typ": "Relations-Typ oder null", "ziel_beat_id": 17 }${deltaFeld} }
  ],
  "erledigt": ["kurzer Satz je behobenem Befund des Vorlaufs"],
  "fazit": "1–3 Sätze Gesamteinschätzung"
}`;
}

// Schema pro Call: `seit_letztem_lauf` nur, wenn ein Vorlauf vorliegt (sonst gäbe es
// nichts zu vergleichen, und Constrained Decoding würde einen Wert erzwingen).
export function buildPlotConsistencySchema({ delta = false } = {}) {
  const item = {
    beat: _str,
    // Stabile Beat-ID (aus dem [#…]-Board-Marker) — überlebt Umbenennungen. null
    // bei übergreifenden Befunden ("—", kein einzelner Beat).
    beat_id: { type: ['integer', 'null'] },
    schwere: { type: 'string', enum: SEVERITY_ENUM },
    typ: { type: 'string', enum: PLOT_KONFLIKT_TYP_ENUM },
    problem: _str,
    vorschlag: _str,
    aktion: _obj({
      art: { type: 'string', enum: AKTION_ART_ENUM },
      wert: { type: ['string', 'null'], enum: [...STATUS_WERT_ENUM, null] },
      typ: { type: ['string', 'null'], enum: [...PLOT_AKTION_REL_TYPES, null] },
      ziel_beat_id: { type: ['integer', 'null'] },
    }),
  };
  if (delta) item.seit_letztem_lauf = { type: 'string', enum: ['neu', 'bestehend'] };
  return _obj({
    konflikte: { type: 'array', items: _obj(item) },
    erledigt: { type: 'array', items: _str },
    fazit: _str,
  });
}

export const SCHEMA_PLOT_CONSISTENCY = buildPlotConsistencySchema();

export const PLOT_SEVERITY_ENUM = SEVERITY_ENUM;
