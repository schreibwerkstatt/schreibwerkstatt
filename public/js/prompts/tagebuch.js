// Tagebuch-Rückblick-Prompts + Schema. Rückwärtsgewandte Verdichtung datierter
// Einträge eines Zeitraums (Monat 'YYYY-MM' oder Jahr 'YYYY'): häufige Themen,
// wiederkehrende Personen/Orte, bemerkenswerte Tage, Fliesstext-Zusammenfassung.
// Zählen, Zusammenführen von Schreibvarianten und die Textsuche nach Personen/
// Orten macht der Server (routes/jobs/rueckblick-facets.js) — das Modell liefert
// nur Namen, Aliase und die Belege, die es selbst gesehen hat.
//
// App-Philosophie: KI ist rückwärtsgewandt und schreibt NIE in den Buchtext.
// Harter Halluzinations-Constraint: nur belegte Aussagen, jedes Thema/jeder Tag
// mit Datums-Beleg aus dem vorliegenden Material; keine erfundenen Ereignisse.

import { _obj, _str } from './schema-utils.js';

// Höchstzahl Themen — gleiche Zahl wie THEMEN_MAX in routes/jobs/rueckblick-facets.js
// (der Server kappt, der Prompt soll gar nicht mehr liefern).
const THEMEN_MAX = 8;
import { _jsonOnly } from './state.js';

// Gemeinsamer Constraint-Block für Single-Pass und Reduce — hält die
// Halluzinations-Regeln an einer Stelle.
const RUECKBLICK_CONSTRAINT = `
Strenge Regeln (verbindlich):
- Stütze JEDE Aussage ausschliesslich auf die vorgelegten Einträge. Erfinde nichts.
- Jedes Thema, jede Person, jeder Ort und jeder bemerkenswerte Tag MUSS mit mindestens einem Eintragsdatum (YYYY-MM-DD) belegt sein, das im Material vorkommt.
- "belege" listet ALLE Eintragsdaten (YYYY-MM-DD), in denen das Thema / die Person / der Ort vorkommt — aufsteigend, nur tatsächlich vorhandene Daten.
- Höchstens ${THEMEN_MAX} Themen: die prägendsten des Zeitraums, kurze und stabile Labels. Setzt sich ein Thema aus dem vorherigen Rückblick fort, übernimm dessen Label wörtlich.
- Personen und Orte nur nennen, wenn sie im Text tatsächlich erwähnt werden. Keine Auflösung von Pronomen zu erfundenen Namen.
- Jede Person / jeden Ort genau EINMAL: "name" ist die gebräuchlichste Schreibweise, ohne Klammerzusatz und ohne Schrägstrich. Andere Schreibweisen derselben Person bzw. desselben Orts im Text (Spitzname, Kurzform, voller Name, Nachname) gehören in "aliase" — nur Formen, die wörtlich im Text stehen. Rollen oder Erklärungen gehören weder in "name" noch in "aliase".
- Schreibe NICHT in den Tagebuchtext, schlage keine neuen Einträge vor. Du verdichtest nur das Geschriebene.
- "zusammenfassung" ist ein beobachtender Rückblick (2–4 Absätze) über den Zeitraum, kein Ratgeber und keine Fortsetzung.`;

// Format des Ausgabe-Schemas als Prompt-Text (für Claude; lokale Provider nutzen
// zusätzlich SCHEMA_RUECKBLICK grammar-constrained).
const RUECKBLICK_OUTPUT = `
<output_format>
Antworte mit diesem JSON-Schema:
{
  "themen": [
    { "label": "kurzes Themen-Label", "belege": ["2024-03-04", "2024-03-12"] }
  ],
  "personen": [ { "name": "im Text genannter Name", "aliase": ["weitere Schreibweise im Text"], "belege": ["2024-03-04", "2024-03-12"] } ],
  "orte":     [ { "name": "im Text genannter Ort", "aliase": [], "belege": ["2024-03-04"] } ],
  "bemerkenswerteTage": [ { "datum": "2024-03-15", "begruendung": "ein Satz, warum dieser Tag heraussticht" } ],
  "zusammenfassung": "2–4 Absätze Fliesstext: zentrale Stimmungen, Entwicklungen und roter Faden des Zeitraums – nur belegt"
}
</output_format>`;

// Reduzierte Ausgabe des Reduce-Passes: Themen/Personen/Orte werden deterministisch
// im Code zusammengeführt (mergeRueckblickFacets), das Modell liefert nur noch die
// synthetisierenden Teile — die über den ganzen Zeitraum bemerkenswertesten Tage
// und die Fliesstext-Betrachtung.
const RUECKBLICK_SYNTH_OUTPUT = `
<output_format>
Antworte mit diesem JSON-Schema:
{
  "bemerkenswerteTage": [ { "datum": "2024-03-15", "begruendung": "ein Satz, warum dieser Tag heraussticht" } ],
  "zusammenfassung": "2–4 Absätze Fliesstext: zentrale Stimmungen, Entwicklungen und roter Faden des Zeitraums – nur belegt"
}
</output_format>`;

// Formatiert die gefilterten Einträge für den Single-Pass-Call: ein Block pro
// Tag mit Datum-Header, damit das Modell Belege zeichengenau zuordnen kann.
function _formatEntries(entries) {
  return entries
    .map(e => `### ${e.datum}${e.titel && e.titel !== e.datum ? ` – ${e.titel}` : ''}\n${e.text}`)
    .join('\n\n---\n\n');
}

// Eine Entitäts-Zeile: akzeptiert nackten Namen (String) oder ein Objekt
// { name, info } — info trägt Rolle/Beruf/Alias bzw. Land/Typ, nach einem
// Gedankenstrich. Bewusst keine Klammer: das Modell übernahm das Muster
// «Name (Info)» sonst in seine eigenen Namen.
function _entityLine(item) {
  if (typeof item === 'string') return item.trim();
  if (!item || !item.name) return '';
  const info = (item.info || '').trim();
  return info ? `${item.name} — ${info}` : item.name;
}

function _entityList(items) {
  return (items || []).map(_entityLine).filter(Boolean).map(l => `- ${l}`).join('\n');
}

function _kontextBlock(figuren, orte) {
  const parts = [];
  const figLines = _entityList(figuren);
  if (figLines) {
    parts.push(`Bekannte Figuren dieses Buchs (kanonische Schreibweise vor dem Gedankenstrich; nutze sie als "name", wenn diese Person gemeint ist):\n${figLines}`);
  }
  const ortLines = _entityList(orte);
  if (ortLines) {
    parts.push(`Bekannte Orte dieses Buchs:\n${ortLines}`);
  }
  if (!parts.length) return '';
  return `\n<kontext>\n${parts.join('\n')}\n</kontext>`;
}

// Verdichteter Rückblick des vorangegangenen Zeitraums. Dient NUR der Einordnung
// von Entwicklungen über die Zeit — Belege/Fakten dürfen NICHT übernommen werden.
function _vorblickBlock(vorblick) {
  if (!vorblick || !vorblick.result) return '';
  const r = vorblick.result;
  const themen   = (r.themen   || []).slice(0, THEMEN_MAX).map(t => t.label).filter(Boolean).join(', ');
  const personen = (r.personen || []).slice(0, 12).map(p => p.name).filter(Boolean).join(', ');
  const orte     = (r.orte     || []).slice(0, 12).map(o => o.name).filter(Boolean).join(', ');
  const zus      = (r.zusammenfassung || '').trim();
  const lines = [];
  if (themen)   lines.push(`Themen: ${themen}`);
  if (personen) lines.push(`Personen: ${personen}`);
  if (orte)     lines.push(`Orte: ${orte}`);
  if (zus)      lines.push(`Zusammenfassung: ${zus}`);
  if (!lines.length) return '';
  return `\n<vorheriger_rueckblick zeitraum="${vorblick.zeitraum}">
Verdichteter Rückblick des unmittelbar vorangegangenen Zeitraums. Nutze ihn AUSSCHLIESSLICH, um
Entwicklungen über die Zeit zu benennen (z.B. fortgesetzt, neu hinzugekommen, nicht mehr erwähnt).
Übernimm KEINE Belege, Daten oder Fakten daraus — jeder Beleg im neuen Rückblick muss aus den
aktuellen Einträgen stammen.
${lines.join('\n')}
</vorheriger_rueckblick>`;
}

/**
 * Single-Pass-Rückblick über alle gefilterten Einträge eines Zeitraums.
 * @param {Array<{datum:string, titel:string, text:string}>} entries
 * @param {{ zeitraum:string, figuren?:Array, orte?:Array, vorblick?:{zeitraum:string, result:object} }} opts
 *   figuren/orte: Namen (String) oder { name, info } (info = Rolle/Beruf/Alias bzw. Land/Typ).
 */
export function buildRueckblickPrompt(entries, { zeitraum, figuren = [], orte = [], vorblick = null } = {}) {
  return `<aufgabe>
Erstelle einen rückwärtsgewandten Rückblick über die Tagebuch-Einträge des Zeitraums «${zeitraum}».
Verdichte das Geschriebene zu wiederkehrenden Themen, Personen, Orten und bemerkenswerten Tagen
sowie einer zusammenfassenden Betrachtung. Du bewertest nicht und schreibst nicht weiter.
</aufgabe>
${RUECKBLICK_CONSTRAINT}${_kontextBlock(figuren, orte)}${_vorblickBlock(vorblick)}
${RUECKBLICK_OUTPUT}
<eintraege zeitraum="${zeitraum}" anzahl="${entries.length}">
${_formatEntries(entries)}
</eintraege>${_jsonOnly()}`;
}

// Kompakte Darstellung der bereits verdichteten Facetten für den Reduce-Prompt.
function _formatMergedFacets(merged) {
  const line = (arr, key) => (arr || []).slice(0, 40).map(x => `${x[key]} (${x.haeufigkeit}×)`).join(', ') || '–';
  return `Themen: ${line(merged.themen, 'label')}\nPersonen: ${line(merged.personen, 'name')}\nOrte: ${line(merged.orte, 'name')}`;
}

// Bemerkenswerte-Tage-Kandidaten + Zusammenfassungen je Teil (fürs Synthese-Urteil).
function _formatMonthSummaries(partResults) {
  return (partResults || []).map(m => {
    const tage = (m.bemerkenswerteTage || []).map(t => `${t.datum}: ${t.begruendung}`).join(' | ') || '–';
    return `## ${m.monat}\nBemerkenswerte Tage: ${tage}\nZusammenfassung: ${m.zusammenfassung || '–'}`;
  }).join('\n\n');
}

/**
 * Reduce-/Synthese-Pass: die Facetten (Themen/Personen/Orte) sind bereits
 * deterministisch gemergt (routes/jobs/rueckblick-facets.js#mergeRueckblickFacets);
 * dieser Call liefert nur noch
 * die synthetisierenden Teile — die über den ganzen Zeitraum bemerkenswertesten
 * Tage und die Fliesstext-Betrachtung. Nutzt NUR die Teilrückblicke; nichts Neues.
 * @param {Array<object>} partResults  je Teil ein SCHEMA_RUECKBLICK-Objekt + `monat` (Label)
 * @param {{ zeitraum:string, vorblick?:object, merged:object }} opts  merged = gemergte Facetten mit haeufigkeit
 */
export function buildRueckblickReducePrompt(partResults, { zeitraum, vorblick = null, merged = null } = {}) {
  const facets = merged || { themen: [], personen: [], orte: [] };
  return `<aufgabe>
Aus den folgenden Teil-Rückblicken eines Zeitraums «${zeitraum}» sind die wiederkehrenden Themen,
Personen und Orte bereits final zusammengeführt (siehe <verdichtete_facetten>). Deine Aufgabe:
1. Wähle die über den GANZEN Zeitraum bemerkenswertesten Tage aus (nur Tage aus den Teilrückblicken).
2. Schreibe eine zusammenfassende Betrachtung (2–4 Absätze) des gesamten Zeitraums.
Nutze NUR Informationen aus den Teilrückblicken und den verdichteten Facetten; füge nichts hinzu.
Gib die Facetten NICHT erneut aus — sie sind bereits final.
</aufgabe>
${RUECKBLICK_CONSTRAINT}${_vorblickBlock(vorblick)}
${RUECKBLICK_SYNTH_OUTPUT}
<verdichtete_facetten zeitraum="${zeitraum}">
${_formatMergedFacets(facets)}
</verdichtete_facetten>
<monats_teilrueckblicke zeitraum="${zeitraum}" teile="${(partResults || []).length}">
${_formatMonthSummaries(partResults)}
</monats_teilrueckblicke>${_jsonOnly()}`;
}

// ── Schema ─────────────────────────────────────────────────────────────────────

// Ohne `haeufigkeit`: die zählt der Server aus den geprüften Belegen.
const _themaItem = _obj({
  label:       _str,
  belege:      { type: 'array', items: _str },
});

const _nennungItem = _obj({
  name:        _str,
  aliase:      { type: 'array', items: _str },
  belege:      { type: 'array', items: _str },
});

const _tagItem = _obj({
  datum:       _str,
  begruendung: _str,
});

export const SCHEMA_RUECKBLICK = _obj({
  themen:              { type: 'array', items: _themaItem },
  personen:            { type: 'array', items: _nennungItem },
  orte:                { type: 'array', items: _nennungItem },
  bemerkenswerteTage:  { type: 'array', items: _tagItem },
  zusammenfassung:     _str,
});

// Reduzierte Ausgabe des Reduce-/Synthese-Passes (Facetten kommen deterministisch
// aus mergeRueckblickFacets, nicht vom Modell).
export const SCHEMA_RUECKBLICK_SYNTH = _obj({
  bemerkenswerteTage:  { type: 'array', items: _tagItem },
  zusammenfassung:     _str,
});
