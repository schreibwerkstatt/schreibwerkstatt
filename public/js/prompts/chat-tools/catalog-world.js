// Chat-Werkzeuge: erzählte Welt aus dem Analyse-Index — Figuren, Beziehungen,
// Alter, Zeitstrahl, Szenen, Orte, Welt-Fakten, Songs, Kontinuität.
// Format und Regeln: ./CLAUDE.md (gilt für jeden Eintrag).

const FIGUR_ID   = { type: 'string', description: 'fig_id der Figur (z.B. "fig_3").' };
const FIGUR_NAME = { type: 'string', description: 'Alternative: Name oder Kurzname der Figur.' };

export const WORLD_TOOLS = [
  {
    name: 'list_figures',
    description: 'Figurenkatalog des Buchs: pro Figur fig_id, Name, Kurzname, Typ, Rolle, Präsenz und Erwähnungen. Leichter Einstieg, um zu wissen, welche Figuren es gibt und welche fig_ids sie haben.',
    see: {
      get_figure_profile: 'Profil, Beziehungen und Lebensereignisse einer Figur → `get_figure_profile`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        sort:  { type: 'string', enum: ['mentions_desc', 'name', 'presence_desc'], description: 'Reihenfolge. Default: mentions_desc (häufigste zuerst).' },
        limit: { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'get_figure_profile',
    description: 'Vollständiges Profil einer Figur: Stammdaten (Typ, Geburtstag, Beruf, Rolle, Motivation, Konflikt, Entwicklung, Sozialschicht, Präsenz), Tags, Schlüsselzitate, Lebensereignisse mit Kapitel/Abschnitt, Szenen, Kapitel-Auftritte und alle Beziehungen in beide Richtungen. Für «was weisst du über X?». Teuer. figur_id (bevorzugt) oder figur_name angeben.',
    see: {
      get_figure_mentions: 'Nur die Auftrittsverteilung → `get_figure_mentions`.',
      get_figure_relations: 'Nur die Kanten zwischen mehreren Figuren → `get_figure_relations`.',
    },
    input_schema: {
      type: 'object',
      properties: { figur_id: FIGUR_ID, figur_name: FIGUR_NAME },
      required: [],
    },
  },
  {
    name: 'get_figure_mentions',
    description: 'Wo und wie oft eine Figur vorkommt: nach Kapitel und Abschnitt mit Anzahl, dazu first_appearance, last_appearance, total_mentions und pages_with_mention — beantwortet «wann zuerst, wann zuletzt, wie lange präsent?». Leicht. figur_id (bevorzugt) oder figur_name angeben.',
    see: {
      get_figure_profile: 'Profil und Beziehungen → `get_figure_profile`.',
    },
    input_schema: {
      type: 'object',
      properties: { figur_id: FIGUR_ID, figur_name: FIGUR_NAME },
      required: [],
    },
  },
  {
    name: 'get_figure_relations',
    description: 'Soziogramm: Figurenbeziehungen als gerichtete Kanten (from → to) mit Typ, Beschreibung, Machtverhältnis und bis zu 3 Belegen. Ohne Filter das ganze Buch, mit Figur nur ihre Kanten. Für «wer kennt wen?», «Konflikt zwischen X und Y», «wer dominiert?».',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'Optional: nur Kanten dieser Figur (fig_id).' },
        figur_name: FIGUR_NAME,
      },
      required: [],
    },
  },
  {
    name: 'get_figure_age',
    description: 'Alter bzw. Jahrgang einer Figur, deterministisch im Server gerechnet: Geburtsjahr mit Quelle, wörtliche Altersangaben aus dem Text und — mit `jahr` oder `ereignis` — das Alter zu diesem Jahr bzw. zu passenden datierten Ereignissen des Zeitstrahls. Für «wie alt war X, als Y passierte?», «welcher Jahrgang ist X?». Rechne Alter NIE selbst aus Jahreszahlen.',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   FIGUR_ID,
        figur_name: FIGUR_NAME,
        jahr:       { type: 'integer', description: 'Optional: Kalenderjahr, für das das Alter gerechnet wird.' },
        ereignis:   { type: 'string',  description: 'Optional: Stichwort eines Ereignisses (Teilstring, z.B. "Mauerfall"), gesucht in den datierten Ereignissen des Zeitstrahls.' },
      },
      required: [],
    },
  },
  {
    name: 'get_timeline',
    description: 'Konsolidierter Zeitstrahl in chronologischer Reihenfolge: Datum, Ereignis, Typ, Bedeutung, betroffene Kapitel/Abschnitte/Figuren. Filter nach Figur und Ereignistyp (z.B. "persoenlich", "historisch"). Für «wann passiert was?», «biografische Timeline von X».',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'Optional: nur Ereignisse dieser Figur (fig_id).' },
        figur_name: FIGUR_NAME,
        typ:        { type: 'string', description: 'Optional: Typ-Filter (Gross-/Kleinschreibung egal).' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 60, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'list_scenes',
    description: 'Szenenkatalog: Titel, Wertung, Kommentar, Kapitel/Abschnitt, beteiligte Figuren und Orte. Filter nach Kapitel, Abschnitt, Figur (ist in der Szene) und Ort. Für «welche Szenen spielt X?», «Szenen in Kapitel 3», «Szenen im Wald».',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Szenen dieses Kapitels.' },
        page_id:    { type: 'integer', description: 'Nur Szenen dieses Abschnitts.' },
        figur_id:   { type: 'string',  description: 'Nur Szenen mit dieser Figur (fig_id).' },
        figur_name: FIGUR_NAME,
        loc_id:     { type: 'string',  description: 'Nur Szenen an diesem Ort (loc_id).' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'list_locations',
    description: 'Schauplätze des Buchs: loc_id, Name, Typ, Beschreibung, Stimmung, erste Erwähnung, Kapitel mit Häufigkeit, last_chapter (wo der Ort zuletzt vorkommt) und zugehörige Figuren. Filter nach Kapitel.',
    see: {
      get_location_profile: 'Alle Szenen und Details eines Orts → `get_location_profile`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Orte, die in diesem Kapitel vorkommen.' },
      },
      required: [],
    },
  },
  {
    name: 'get_location_profile',
    description: 'Profil eines Orts: Stammdaten (Typ, Beschreibung, Stimmung, erste Erwähnung), alle Kapitel mit Häufigkeit, last_chapter, zugehörige Figuren und alle Szenen dort (Titel, Wertung, Kapitel/Abschnitt). Für «erzähl mir alles über den Wald», «welche Szenen spielen im Schloss?», «wer war je am Hafen?». Auswahl per loc_id oder name.',
    input_schema: {
      type: 'object',
      properties: {
        loc_id: { type: 'string', description: 'loc_id des Orts.' },
        name:   { type: 'string', description: 'Alternative: Ortsname (exakt oder Teilstring, Gross-/Kleinschreibung egal).' },
      },
      required: [],
    },
  },
  {
    name: 'list_world_facts',
    description: 'Etablierte Welt-Fakten des Buchs (deklaratives Buch-Wissen aus der Komplettanalyse): Regeln, Geografie, Daten, feste Aussagen. Pro Fakt kategorie, subjekt, fakt-Text und Kapitel; real_widerlegt=true heisst, der Faktencheck hat die Aussage per Quelle als real falsch belegt — sie bleibt eine Buchaussage, keine reale Tatsache. Für «welche Regeln gelten?», «wie funktioniert die Magie?», «was ist über X etabliert?».',
    input_schema: {
      type: 'object',
      properties: {
        kategorie: { type: 'string', description: 'Nur Fakten dieser Kategorie. Gültige Werte: figur, ort, objekt, organisation, technik, regel, kultur, historie, zeit, soziolekt, ereignis, sonstiges.' },
        subjekt:   { type: 'string', description: 'Nur Fakten zu diesem Subjekt (Teilstring, Gross-/Kleinschreibung egal).' },
      },
      required: [],
    },
  },
  {
    name: 'list_songs',
    description: 'Songs und Soundtrack des Buchs (Musikbibliothek): Titel, Interpret, Genre, Kontext-Typ, Beschreibung, Stimmung, erste Erwähnung, verknüpfte Kapitel (mit Häufigkeit) und Figuren. Für «welche Musik gehört zum Buch?», «welcher Song zu Figur X?».',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Songs, die in diesem Kapitel verknüpft sind.' },
        figur_id:   { type: 'string',  description: 'Nur Songs zu dieser Figur (fig_id).' },
        figur_name: FIGUR_NAME,
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'list_continuity_issues',
    description: 'Befunde des letzten Kontinuitätschecks: Typ, Schwere, Beschreibung, betroffene Stellen (stelle_a/stelle_b), Empfehlung sowie betroffene Figuren und Kapitel. Für «wo widerspricht sich das Buch?», «was sind die schwersten Lücken?».',
    input_schema: {
      type: 'object',
      properties: {
        schwere:    { type: 'string', description: 'Optionaler Filter (z.B. "hoch", "mittel", "niedrig"), Gross-/Kleinschreibung egal.' },
        typ:        { type: 'string', description: 'Optionaler Typ-Filter (z.B. "zeit", "ort", "fakt"), Gross-/Kleinschreibung egal.' },
        chapter_id: { type: 'integer', description: 'Nur Befunde, die dieses Kapitel betreffen.' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 30, max 100).' },
      },
      required: [],
    },
  },
];
