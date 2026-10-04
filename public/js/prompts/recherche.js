// Recherche-Verknüpfungs-Resolver: ordnet einen Recherche-Schnipsel (Notiz,
// Zitat, Faktensplitter, Link) den passenden bereits existierenden Buch-
// Entitäten zu (Figuren/Orte/Szenen/Plot-Beats). Rein rückwärtsgewandt — liest
// vorhandene Entitäten + Schnipseltext, generiert keinen Buchtext und schlägt
// NIEMALS neue Entitäten vor. Die KI darf ausschliesslich IDs aus der
// gelieferten Kandidatenliste zurückgeben; alles andere wird verworfen.

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';

export function buildSystemResearchLink() {
  return `Du bist ein Verknüpfungs-Assistent für ein Recherche-Archiv eines Buchprojekts. Du bekommst einen Recherche-Schnipsel (Notiz, Zitat, Fakt oder Link) und Listen bereits existierender Buch-Entitäten: Figuren, Schauplätze, Szenen und Plot-Abschnitte. Jede Entität hat eine id.

Deine Aufgabe: bestimme, auf welche dieser Entitäten sich der Schnipsel bezieht — also wo diese Recherche beim Schreiben relevant wäre.

Regeln:
- Gib NUR Verknüpfungen zurück, deren id exakt in den gelieferten Listen steht. Erfinde keine ids und keine neuen Entitäten.
- Hinter jeder Entität steht nach «—» ein kurzer Kontext (Typ, Rolle, Beschreibung). Nutze ihn zum Abgleich, auch wenn der Name selbst im Schnipsel nicht vorkommt (z.B. Schnipsel über Bronzezeit-Grabungen passt zur Figur «Archäologin»).
- Verknüpfe nur bei klarem inhaltlichem Bezug (genannte Figur, beschriebener Ort, thematisch passende Szene). Im Zweifel weglassen — lieber wenige präzise Treffer als viele vage.
- Eine Entität höchstens einmal.
- «art» ist die Kategorie der Entität: «figur», «ort», «szene», «beat» oder «strang» (Handlungsstrang).
- «grund» ist eine sehr kurze Begründung (wenige Wörter), warum der Schnipsel zu dieser Entität passt.${_jsonOnly()}`;
}

export function buildResearchLinkPrompt(snippet, candidates) {
  const trunc = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const block = (label, arr, meta) => {
    if (!arr || !arr.length) return `${label}: (keine)`;
    return `${label}:\n` + arr.map(c => {
      const m = trunc(meta(c), 200);
      return `- id=${c.id}: ${c.label}${m ? ` — ${m}` : ''}`;
    }).join('\n');
  };
  const head = (...fields) => fields.map(f => trunc(f, 40)).filter(Boolean).join(', ');
  const figMeta = (c) => [head(c.typ, c.beruf, c.rolle), trunc(c.beschreibung, 150)].filter(Boolean).join(' · ');
  const ortMeta = (c) => [head(c.typ, c.land), trunc(c.beschreibung, 150)].filter(Boolean).join(' · ');
  const szeneMeta = (c) => trunc(c.kommentar, 150);
  const beatMeta = (c) => [head(c.status), trunc(c.beschreibung, 150)].filter(Boolean).join(' · ');
  const strangMeta = () => '';
  const parts = [
    block('Figuren', candidates.figur, figMeta),
    block('Schauplätze', candidates.ort, ortMeta),
    block('Szenen', candidates.szene, szeneMeta),
    block('Plot-Abschnitte', candidates.beat, beatMeta),
    block('Handlungsstränge', candidates.strang, strangMeta),
  ].join('\n\n');
  // Dokument-Text (PDF) ist potentiell lang → eigener, grosszuegig gedeckelter
  // Block hinter den Kurzfeldern, damit Titel/Notiz nicht abgeschnitten werden.
  const docPart = snippet.doc_text
    ? `\nAngehängtes Dokument${snippet.doc_name ? ` (${snippet.doc_name})` : ''}:\n${String(snippet.doc_text).slice(0, 6000)}`
    : '';
  const urlText = Array.isArray(snippet.urls)
    ? snippet.urls.map(u => [u.label, u.url].filter(Boolean).join(': ')).join('\n')
    : '';
  const snip = ([snippet.title, snippet.body, snippet.source, urlText]
    .filter(Boolean).join('\n').slice(0, 4000)) + docPart;
  return `Recherche-Schnipsel:
"""
${snip}
"""

Vorhandene Buch-Entitäten (nur aus diesen darfst du ids wählen):

${parts}

Antworte mit diesem JSON-Schema:
{
  "links": [
    { "art": "figur|ort|szene|beat|strang", "id": "exakt eine id von oben", "grund": "kurze Begründung" }
  ]
}
Gib ein leeres "links"-Array zurück, wenn keine Entität klar passt.`;
}

export const SCHEMA_RESEARCH_LINK = _obj({
  links: {
    type: 'array',
    items: _obj({ art: _str, id: _str, grund: _str }),
  },
});

// ── Recherche-Chat (agentisch, Claude-only, mit Web-Suche) ───────────────────
// Ein Chat NEBEN dem Recherche-Board: recherchiert im Netz + im vorhandenen
// Material, kennt die Buch-Entitäten als Kontext und schlägt Fundstücke als neue
// Recherche-Items vor (User bestätigt). Rückwärtsgewandt: schreibt NIE Buchtext.

export const RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION =
  'Du hast die maximale Zahl an Recherche-Iterationen erreicht — keine weitere Suche mehr möglich. '
  + 'Fasse JETZT aus dem bereits Gesammelten die bestmögliche Antwort zusammen und liefere sie über das Werkzeug `final_answer`. '
  + 'Wenn etwas offen blieb, weise kurz darauf hin. Sprache der Antwort: die der Userfrage.';

/**
 * Kompakter Block der früheren Speicher-Vorschläge dieser Session (Titel, Typ,
 * gespeichert ja/nein). Steht am ENDE des System-Prompts, damit der stabile Teil
 * davor cachebar bleibt. Leere Liste → ''.
 * @param {Array<{title,kind,saved_item_id?,exists_item_id?}>} list
 */
export function buildResearchProposalMemoryBlock(list = []) {
  if (!Array.isArray(list) || !list.length) return '';
  const lines = list.map(p => {
    const state = p.saved_item_id
      ? `gespeichert als Eintrag id=${p.saved_item_id}`
      : (p.exists_item_id ? `nicht gespeichert (lag schon im Archiv als id=${p.exists_item_id})` : 'nicht gespeichert');
    return `- «${p.title}» (${p.kind}) — ${state}`;
  });
  return 'BISHERIGE SPEICHER-VORSCHLÄGE IN DIESEM GESPRÄCH (Stand jetzt; schlage dasselbe nicht erneut vor — gespeicherte Einträge liegen im Archiv und sind über list_research_items/read_research_item lesbar):\n'
    + lines.join('\n');
}

// Schreibkontext der aktuellen Frage (Kontext-Chip „Für Seite/Kapitel …
// recherchieren"): wo im Buch der Autor gerade steht, ein Textauszug und das
// dort schon verknüpfte Material. Volatil (je Frage) → ans Prompt-Ende.
// ctx = { kind: 'page'|'chapter', name, excerpt, items: [{id, kind, title, status}] }
export function buildResearchWritingContextBlock(ctx) {
  if (!ctx) return '';
  const where = ctx.kind === 'chapter' ? `Kapitel «${ctx.name}»` : `Abschnitt «${ctx.name}»`;
  const lines = [
    `SCHREIBKONTEXT DIESER FRAGE: Der Autor recherchiert für ${where}. Richte Suche und Vorschläge auf das aus, was diese Stelle braucht (Zeit, Ort, Sachverhalte, Figuren darin). Gespeicherte Vorschläge werden mit dieser Stelle verknüpft.`,
  ];
  if (ctx.excerpt) {
    lines.push('', `Textauszug (nur zur Orientierung — NICHT umschreiben, NICHT fortsetzen, keine Stil-Hinweise):`, ', ctx.excerpt, ');
  }
  if (Array.isArray(ctx.items) && ctx.items.length) {
    lines.push('', 'Schon mit dieser Stelle verknüpftes Material (nicht erneut vorschlagen; Details via read_research_item):');
    for (const it of ctx.items) lines.push(`- id=${it.id} [${it.kind}, ${it.status}] ${it.title || '(ohne Titel)'}`);
  }
  return lines.join('\n');
}

export function buildResearchChatAgentSystemPrompt(bookName, itemCount, maxToolIter = 6, figures = [], locations = [], profile = {}, extra = {}) {
  // extra = { maxWebSearches, bookContext, proposalMemory, writingContext }
  //   bookContext    — Sprachnorm + Buchtyp/Autoren-Angaben (prompts/core.js#getResearchPromptContext),
  //                    bewusst OHNE Buch-Chat-Persona: die erlaubt Stil-Feedback, das hier verboten ist.
  //   proposalMemory — Ergebnis von buildResearchProposalMemoryBlock (volatil, ans Ende).
  const maxWebSearches = Number(extra?.maxWebSearches) || 0;
  const bookContext = String(extra?.bookContext || '').trim();
  const proposalMemory = String(extra?.proposalMemory || '').trim();
  const writingContext = String(extra?.writingContext || '').trim();
  // Figuren + Schauplätze werden vorgeladen (kompakte Liste), damit das Modell
  // schon bei der ERSTEN Web-Suche den Welt-Kontext in den Suchbegriff
  // einarbeiten kann — ohne erst eine list_book_entities-Runde zu verbrauchen.
  // Szenen/Beats/Stränge bleiben on-demand über list_book_entities.
  const entityBlock = (label, arr) => arr.length
    ? `\n${label}:\n` + arr.map(e => `- ${e.name}${e.kontext ? ` — ${e.kontext}` : ''}`).join('\n') + '\n'
    : '';
  const worldBlock = entityBlock('Figuren des Buchs (Kontext — nutze sie, um gezielt FÜR die Geschichte zu recherchieren)', figures)
    + entityBlock('Schauplätze des Buchs (Kontext)', locations);
  // Recherche-Profil des Buchs (book_settings.research_profile/_domains).
  // Der Freitext folgt der Konvention des Buch-Kontexts: eine Angabe des Autors
  // hat Vorrang vor den allgemeinen Arbeitsregeln darueber.
  const profileText = (profile?.text || '').trim();
  const domains = Array.isArray(profile?.domains) ? profile.domains.filter(Boolean) : [];
  const profileBlock = profileText
    ? `\nVORRANGIGE ANGABEN DER AUTORIN / DES AUTORS ZUR RECHERCHE (gehen bei Konflikt den allgemeinen Regeln unten vor):\n${profileText}\n`
    : '';
  // Die Eingrenzung MUSS im Prompt stehen, nicht nur als allowed_domains am
  // Werkzeug: sonst liest das Modell eine leere Trefferliste als „dazu gibt es
  // nichts" statt als „dort gibt es nichts" und gibt eine Fehlanzeige weiter,
  // die keine ist. Gleiches Muster wie `scanned: false` beim Motiv-Index.
  const domainBlock = domains.length
    ? `\nEINGRENZUNG DER WEB-SUCHE: \`web_search\` erreicht ausschliesslich diese Domains — ${domains.join(', ')}. `
      + 'Das ist eine Vorgabe des Autors, kein Fehler. Formuliere deine Suchbegriffe so, dass sie DORT treffen. '
      + 'Findest du etwas nicht, sage ausdrücklich, dass die Suche eingegrenzt war — behaupte nie, es gebe die Information nicht.\n'
    : '';
  return [
    'Du bist ein Recherche-Assistent für ein Buchprojekt. Du hilfst dem Autor / der Autorin, Hintergrund-, Sach- und Weltaufbau-Material zu recherchieren, einzuordnen und zu sammeln — neben dem Manuskript, NICHT darin.',
    '',
    `Buch: «${bookName}» — das Recherche-Archiv enthält aktuell ${itemCount} Einträge (Notizen, Links, Zitate, Faktensplitter, hochgeladene PDFs).`,
    worldBlock,
    profileBlock,
    domainBlock,
    'Deine Werkzeuge:',
    '- `web_search` — durchsucht das offene Web in Echtzeit. Nutze es für aktuelle, externe oder überprüfbare Fakten (historisches, geografisches, technisches, kulturelles Hintergrundwissen). Gib in der Antwort die Quelle/URL an, auf die du dich stützt.',
    '- `list_research_items` / `read_research_item` — durchsuche und lies das vorhandene Recherche-Material des Autors (inkl. PDF-Volltext). Prüfe es, bevor du etwas Neues recherchierst — vieles ist evtl. schon gesammelt.',
    '- `search_research_passages` — semantische Passagen-Suche über das Archiv: findet Stellen nach BEDEUTUNG, auch bei anderer Wortwahl. Mit `item_id` durchsuchst du EIN langes PDF gezielt (`read_research_item` liefert davon nur den Anfang) — genau der Weg zu Stellen weiter hinten im Dokument.',
    '- `lookup_literature` — Fachliteratur und Bücher aus bibliografischen Registern (Crossref, OpenLibrary) mit DOI/ISBN. Bevorzugt vor `web_search`, wenn zitierfähige Literatur gefragt ist; schlägst du einen Treffer vor, nimm die doi.org-URL in `urls` und Autoren/Jahr in `source`. Die gelieferten URLs darfst du in `final_answer.quellen` nennen.',
    '- `list_book_entities` — Szenen, Plot-Abschnitte und Handlungsstränge des Buchs (sowie die oben gelisteten Figuren und Schauplätze in voller Tiefe), damit du gezielt FÜR die Geschichte recherchieren kannst.',
    '- `propose_research_item` — schlage ein konkretes Fundstück als neuen Recherche-Eintrag vor (Notiz/Link/Zitat/Fakt). Es wird NICHT automatisch gespeichert — der User bestätigt jeden Vorschlag selbst. Nutze dies großzügig, wenn du Brauchbares findest: knackiger Titel, präziser Inhalt, bei Web-Quellen die URL als Quelle.',
    '- `final_answer` — Pflicht-Endpunkt: jede Antwort an den User MUSS hierüber laufen.',
    '',
    'Arbeitsweise:',
    '- Nennt die Userfrage eine Figur oder einen Schauplatz, ziehe deren oben gelisteten Kontext heran und arbeite ihn in deine Web-Suche ein.',
    '- Recherchiere, bevor du behauptest. Bei Faktenfragen lieber kurz `web_search`, statt aus dem Gedächtnis zu antworten — und nenne die Quelle.',
    '- Bittet dich der User ausdrücklich, etwas als Recherche-Eintrag/Item anzulegen, zu speichern oder ins Board zu legen, MUSST du `propose_research_item` aufrufen (der User bestätigt danach) — antworte das nicht nur in Prosa.',
    '- Bündle unabhängige Werkzeug-Aufrufe in EINER Runde (mehrere Suchen / Lese-Calls parallel), statt seriell.',
    `- Maximal ${maxToolIter} Werkzeug-Iterationen pro Antwort (eine Iteration = eine Runde, nicht ein Call). Geh effizient damit um.`,
    ...(maxWebSearches ? [`- Insgesamt höchstens ${maxWebSearches} Web-Suchen pro Antwort (über alle Runden; jede Suche kostet). Formuliere gezielte Suchbegriffe statt vieler ähnlicher.`] : []),
    '- WICHTIG — rückwärtsgewandt: Du schreibst NIEMALS Manuskripttext, formulierst keine Romanszenen und machst keine Stil-Vorschläge für den Fließtext. Du sammelst und ordnest Wissen. Wenn der User um Textgenerierung für das Buch bittet, biete stattdessen Recherche/Strukturierung an.',
    '- Wenn du Material vorschlägst, das es im Archiv schon gibt (via list_research_items geprüft), weise darauf hin statt zu duplizieren. `propose_research_item` meldet einen Treffer im Archiv als `already_in_archive` — schlage dann nur vor, wenn dein Vorschlag wirklich Neues ergänzt.',
    '- Nenne in `final_answer` unter `quellen` die Web-Quellen (URL + Titel), auf die sich deine Antwort stützt — nur URLs, die dir `web_search` in diesem Durchgang tatsächlich geliefert hat.',
    'Liefere die finale Antwort IMMER über `final_answer`. Sprache: passe dich der Userfrage an, nicht diesem Prompt.',
    ...(bookContext ? ['', bookContext] : []),
    ...(proposalMemory ? ['', proposalMemory] : []),
    ...(writingContext ? ['', writingContext] : []),
  ].join('\n');
}

/**
 * Werkzeug-Definitionen für den agentischen Recherche-Chat (Anthropic-Tool-Format).
 * `web_search` ist Anthropics serverseitiges Tool (kein eigener Handler — die API
 * führt die Suche selbst aus). Alle anderen Tools laufen über
 * routes/jobs/research-chat-tools.js#executeResearchTool.
 */
export const RESEARCH_CHAT_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 6 },
  {
    name: 'list_research_items',
    description: 'Listet die vorhandenen Recherche-Einträge des Buchs (id, kind, status, Titel, Kurztext, Tags, `stellen` = verknüpfte Kapitel/Abschnitte, `bezug` = Figuren/Orte/Szenen, ob ein PDF/Dokument angehängt ist). Optional nach kind/status/Kapitel/Abschnitt filtern oder mit q volltextsuchen. Nutze dies zuerst, um zu sehen, was schon gesammelt wurde.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['note', 'link', 'quote', 'fact', 'image', 'document', 'transcript'], description: 'Optionaler Typfilter.' },
        q: { type: 'string', description: 'Optionale Volltextsuche über die Einträge.' },
        status: { type: 'string', enum: ['offen', 'in_arbeit', 'eingearbeitet', 'verworfen'], description: 'Optional: nur Einträge dieser Einarbeitungs-Stufe.' },
        chapter_id: { type: 'integer', description: 'Optional: nur Einträge an diesem Kapitel oder einem seiner Abschnitte.' },
        page_id: { type: 'integer', description: 'Optional: nur Einträge an diesem Abschnitt.' },
      },
      required: [],
    },
  },
  {
    name: 'read_research_item',
    description: 'Liefert den vollständigen Inhalt EINES Recherche-Eintrags: Titel, Volltext (body), URL, Quelle, Tags und — bei angehängtem PDF — den extrahierten Dokument-Volltext (doc_text). Nutze dies, um vorhandenes Material wirklich zu lesen, bevor du extern suchst.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'id des Recherche-Eintrags (aus list_research_items).' } },
      required: ['id'],
    },
  },
  {
    name: 'lookup_literature',
    description: 'Sucht in bibliografischen Registern statt im offenen Web: Crossref (Fachaufsätze, Berichte, alles mit DOI) und OpenLibrary (Bücher). Liefert zitierfähige Kerndaten je Treffer — Titel, Autoren, Jahr, Zeitschrift/Verlag, DOI bzw. ISBN und eine stabile URL (doi.org). Nutze es, wenn der User Fachliteratur, Studien oder Bücher zu einem Thema will, oder um eine bekannte DOI/ISBN aufzulösen. Kein Volltext und keine Studiendetails (Design, Fallzahl) — die stehen nur im Werk selbst (ggf. danach `web_search` auf die DOI-Seite).',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Thema oder Titel-/Autorenstichworte (bei Fachdatenbanken englische Begriffe bevorzugen).' },
        doi: { type: 'string', description: 'Alternativ: eine bekannte DOI exakt auflösen.' },
        isbn: { type: 'string', description: 'Alternativ: eine bekannte ISBN exakt auflösen.' },
        register: { type: 'string', enum: ['artikel', 'buch', 'beide'], description: 'artikel = nur Crossref, buch = nur OpenLibrary, beide (Default).' },
        anzahl: { type: 'integer', description: 'Treffer je Register (1–10, Default 5).' },
      },
      required: [],
    },
  },
  {
    name: 'search_research_passages',
    description: 'Semantische Passagen-Suche über das Recherche-Archiv (Embeddings): findet Stellen, die einer Frage BEDEUTUNGSMÄSSIG nahestehen — auch bei anderer Wortwahl als in `list_research_items` (Wortsuche). Ohne item_id: die beste Passage je Eintrag über das ganze Board. MIT item_id: mehrere passende Passagen INNERHALB eines Eintrags — der Weg in ein langes PDF, von dem `read_research_item` nur den Anfang liefert. Liefert {item_id,title,passage,score}. Rein rückwärtsgewandt.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Suchtext / Frage in natürlicher Sprache.' },
        item_id: { type: 'integer', description: 'Optional: nur in diesem Eintrag suchen (id aus list_research_items). Für gezieltes Lesen in einem langen PDF.' },
        top_k: { type: 'integer', description: 'Anzahl Passagen (1–15, Default 6).' },
      },
      required: ['q'],
    },
  },
  {
    name: 'list_book_entities',
    description: 'Liefert die Welt-Entitäten des Buchs als Recherche-Kontext: Figuren, Schauplätze, Szenen, Plot-Abschnitte und Handlungsstränge (je id, Name, Kurzbeschreibung). Nutze dies, um gezielt für die Geschichte zu recherchieren (z.B. Hintergrund zum Beruf einer Figur, zum Schauplatz-Land).',
    input_schema: {
      type: 'object',
      properties: {
        art: { type: 'string', enum: ['figur', 'ort', 'szene', 'beat', 'strang', 'alle'], description: "Welche Kategorie. Default 'alle'." },
      },
      required: [],
    },
  },
  {
    name: 'propose_research_item',
    description: 'Schlägt dem User EINEN neuen Recherche-Eintrag zum Speichern vor. Wird NICHT automatisch gespeichert — der User bestätigt jeden Vorschlag mit einem Klick. Nutze es für konkrete Fundstücke (eine oder mehrere Web-Quellen, ein Fakt, ein Zitat). Hänge alle belegenden Web-Quellen als urls an. Mehrere Vorschläge = mehrere Aufrufe.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['note', 'link', 'quote', 'fact'], description: 'Eintragstyp: note=Notiz, link=Web-Link, quote=Zitat, fact=Faktensplitter.' },
        title: { type: 'string', description: 'Kurzer, prägnanter Titel.' },
        body: { type: 'string', description: 'Inhalt / Notiztext / Zitatwortlaut (Pflicht außer bei reinem link mit urls).' },
        urls: {
          type: 'array',
          description: 'Eine oder mehrere belegende Web-Quellen. Bei kind=link mindestens eine. Nur http(s).',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Die URL (http/https).' },
              label: { type: 'string', description: 'Optionaler Anzeigetext (z.B. Seitentitel).' },
            },
            required: ['url'],
          },
        },
        source: { type: 'string', description: 'Quelle (z.B. Buchtitel, Datenbank, Archiv), worauf der Inhalt sich stützt — als Freitext-Nachweis.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optionale Schlagworte.' },
      },
      // title NICHT zwingend: ein reiner link-Eintrag darf nur aus urls bestehen
      // (der Handler verlangt mindestens Titel ODER body ODER eine url).
      required: ['kind'],
    },
  },
  {
    name: 'final_answer',
    description: 'Liefert die finale Antwort an den User. ALLERLETZTER Aufruf einer Runde — Pflicht-Endpunkt. Freitext ohne final_answer wird nicht akzeptiert. Markdown erlaubt. Bei Web-Recherche die genutzten Quellen/URLs in der Antwort nennen. Wenn du Einträge via propose_research_item vorgeschlagen hast, weise kurz darauf hin, dass sie unten zum Speichern bereitstehen — aber wiederhole sie nicht im Volltext. Sprache: die der Userfrage.',
    input_schema: {
      type: 'object',
      properties: {
        antwort: { type: 'string', description: 'Antwort an den User als Freitext, Markdown erlaubt. Pflichtfeld.' },
        quellen: {
          type: 'array',
          description: 'Optional: die Web-Quellen, auf die sich die Antwort stützt (nur URLs aus web_search dieses Durchgangs; andere werden verworfen). Reihenfolge = Nummerierung in der Quellenliste.',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL eines web_search-Treffers.' },
              titel: { type: 'string', description: 'Kurzer Titel der Quelle.' },
            },
            required: ['url'],
          },
        },
      },
      required: ['antwort'],
    },
  },
];

/**
 * Werkzeugliste fuer EINEN Call. Einziger Unterschied zur Basisliste ist die
 * Domain-Eingrenzung am serverseitigen `web_search` — sie haengt am Buch und
 * kann deshalb keine Konstante sein.
 *
 * Leere Liste ⇒ `allowed_domains` wird gar nicht erst gesetzt: ein leeres Array
 * waere fuer die API eine Eingrenzung auf nichts.
 */
export function buildResearchChatTools({ allowedDomains = [] } = {}) {
  const domains = (allowedDomains || []).filter(Boolean);
  if (!domains.length) return RESEARCH_CHAT_TOOLS;
  return RESEARCH_CHAT_TOOLS.map(t => (
    t.name === 'web_search' ? { ...t, allowed_domains: domains } : t
  ));
}

// ── Recherche-Abgleich (Job research-crosscheck) ────────────────────────────
// Prüft Manuskriptstellen gegen das, was der Autor SELBST gesammelt hat (Fakten,
// Zitate im Recherche-Board) — nicht gegen die Wirklichkeit (das ist der
// Weltfakten-Faktencheck mit Web-Suche). Rückwärtsgewandt: meldet Befunde,
// schlägt keinen neuen Text vor.

export function buildSystemResearchCrosscheck() {
  return `Du gleichst ein Buchmanuskript mit dem Recherche-Material seines Autors ab. Du bekommst Fundstücke (gesammelte FAKTEN und ZITATE, je mit id) und zu jedem Fundstück Textstellen aus dem Manuskript (je mit page_id).

Deine Aufgabe: finde Stellen, an denen das Manuskript dem Fundstück widerspricht.
- typ «widerspruch»: das Manuskript behauptet etwas, das dem gesammelten FAKT widerspricht (anderes Datum, andere Zahl, anderer Ort, andere Person, umgekehrter Sachverhalt).
- typ «zitat»: das Manuskript gibt ein gesammeltes ZITAT wieder, aber im Wortlaut abweichend (andere Wörter, fehlende/zusätzliche Teile, anderer Sprecher). Nur für Fundstücke vom Typ quote.

Regeln:
- Melde NUR echte Abweichungen. Eine Stelle, die das Thema bloss streift, nichts dazu sagt oder es bestätigt, ist KEIN Befund.
- Fiktion darf erfinden: was das Fundstück nicht berührt, ist kein Widerspruch. Eine bewusst als Figurenmeinung, Irrtum oder Lüge markierte Aussage ist kein Widerspruch.
- «stelle» ist ein WÖRTLICHER, zusammenhängender Ausschnitt aus der gelieferten Textstelle (höchstens etwa 300 Zeichen), exakt so wie dort geschrieben — keine Paraphrase, keine Auslassungszeichen.
- «item_id» und «page_id» stammen exakt aus den gelieferten Daten.
- «erklaerung»: ein Satz, worin die Abweichung besteht (Fundstück sagt X, Manuskript sagt Y). Keine Formulierungsvorschläge.
- Keine Abweichung gefunden → leeres Array «befunde».${_jsonOnly()}`;
}

/**
 * @param {Array<{id, kind, title, body, source, passages: Array<{page_id, page_name, text}>}>} candidates
 */
export function buildResearchCrosscheckPrompt(candidates) {
  const trunc = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const blocks = candidates.map(c => {
    const head = `FUNDSTÜCK id=${c.id} (${c.kind === 'quote' ? 'ZITAT' : 'FAKT'})${c.title ? ` — ${trunc(c.title, 200)}` : ''}`;
    const body = trunc(c.body, 1500);
    const src = c.source ? `\nQuelle: ${trunc(c.source, 200)}` : '';
    const passages = c.passages.map(p => `  [page_id=${p.page_id}${p.page_name ? `, «${trunc(p.page_name, 80)}»` : ''}]\n  ${p.text}`).join('\n\n');
    return `${head}\n${body}${src}\n\nTextstellen aus dem Manuskript:\n${passages}`;
  });
  return blocks.join('\n\n────────\n\n');
}

export const SCHEMA_RESEARCH_CROSSCHECK = _obj({
  befunde: {
    type: 'array',
    items: _obj({ item_id: _str, page_id: _str, typ: _str, stelle: _str, erklaerung: _str }),
  },
});
