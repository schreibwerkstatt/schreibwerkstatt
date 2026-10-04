#!/usr/bin/env node
'use strict';
// Werkstatt-Beispieldaten fürs lokale Devmode-Testbuch (Kafka, „Die Verwandlung").
//
//   node scripts/seed-werkstaetten.js [buchname] [owner-email]
//
// Defaults: „Devmode-Testbuch" / dev@local (lib/dev-seed.js). Legt an:
//   · Figuren-Werkstatt: drei Drafts mit gefüllter Mindmap — Gregor und Grete
//     mit Quell-Figur aus dem Katalog (falls die Komplettanalyse gelaufen ist),
//     dazu „Der Prokurist" als reine Werkstatt-Figur ohne Katalog-Pendant.
//   · Plot-Werkstatt: drei geteilte Akte, zwei Stränge (Gregor, Grete), zwölf
//     Beats quer über Status/Intensität/Kapitel, ein verworfener Beat, dazu
//     Beat-Beziehungen (Setup/Payoff, Kausalität).
//   · Motiv-Werkstatt: zwei Themen, sieben Motive mit Trigger-Begriffen,
//     Motiv-Beziehungen und Soll-Brücken zu Figuren, Drafts, Beats, Kapiteln
//     und Seiten.
//
// Schreibt über die db-Facaden (keine Buchinhalte — Pages/Chapters werden nur
// gelesen). Idempotent: hat der Owner im Buch schon Akte, Motive oder Drafts,
// bricht der Lauf mit Hinweis ab, statt doppelt anzulegen.

const { db } = require('../db/connection');
const plotDb = require('../db/plot');
const motifsDb = require('../db/motifs');
const drafts = require('../db/draft-figures');
const { defaultMindmap } = require('../lib/draft-mindmap-default');

const BOOK_NAME = process.argv[2] || 'Devmode-Testbuch';
const OWNER = process.argv[3] || 'dev@local';

// ── Lookups (lesend) ─────────────────────────────────────────────────────────
const book = db.prepare('SELECT book_id FROM books WHERE name = ?').get(BOOK_NAME);
if (!book) { console.error(`Buch "${BOOK_NAME}" nicht gefunden.`); process.exit(1); }
const bookId = book.book_id;

const existing = {
  acts: plotDb.listActs(bookId, OWNER).length,
  motifs: motifsDb.listMotifs(bookId, OWNER).length,
  drafts: drafts.listDraftFigures(bookId, OWNER).length,
};
if (existing.acts || existing.motifs || existing.drafts) {
  console.error(`Abbruch: Buch ${bookId} hat für ${OWNER} schon Werkstatt-Daten (${JSON.stringify(existing)}).`);
  process.exit(1);
}

const chapterId = Object.fromEntries(db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?')
  .all(bookId).map(r => [r.chapter_name, r.chapter_id]));
const pageId = Object.fromEntries(db.prepare('SELECT page_id, page_name FROM pages WHERE book_id = ?')
  .all(bookId).map(r => [r.page_name, r.page_id]));
// Katalog-Figuren nach Namensanfang (nur vorhanden, wenn die Komplettanalyse lief).
const figRows = db.prepare('SELECT id, name FROM figures WHERE book_id = ? AND user_email = ?').all(bookId, OWNER);
const fig = (prefix) => figRows.find(f => f.name.startsWith(prefix))?.id ?? null;
const figIds = (...prefixes) => prefixes.map(fig).filter(id => id != null);
const wohnung = db.prepare('SELECT id FROM locations WHERE book_id = ? ORDER BY id LIMIT 1').get(bookId)?.id ?? null;

// ── Figuren-Werkstatt ────────────────────────────────────────────────────────
let _nid = 0;
function mindmap(name, fill) {
  const mm = defaultMindmap(name);
  const find = (node, id) => node.id === id ? node : (node.children || []).map(c => find(c, id)).find(Boolean);
  for (const [nodeId, topics] of Object.entries(fill)) {
    const node = find(mm.data, nodeId);
    node.children = [...(node.children || []), ...topics.map(topic => ({ id: `seed-${++_nid}`, topic }))];
  }
  return mm;
}

const DRAFTS = [
  {
    key: 'gregor', name: 'Gregor Samsa', archetype: 'Der Pflichtmensch', source: 'Gregor',
    notes: 'Ernährer wider Willen. Die Verwandlung macht sichtbar, was er für die Familie längst war: ein Werkzeug.',
    fill: {
      aussehen: ['Panzerartiger Rücken, gewölbter brauner Bauch', 'Viele dünne, flimmernde Beinchen'],
      persoenlichkeit: ['Pflichtbewusst bis zur Selbstverleugnung', 'Sorgt sich zuerst um den Zug, nicht um den Körper'],
      hintergrund: ['Handlungsreisender für Tuchwaren', 'Tilgt seit fünf Jahren die Schulden des Vaters'],
      beziehungen: ['Grete: einzige Vertraute, will sie aufs Konservatorium schicken', 'Vater: Angst und Gehorsam'],
      konflikt: ['Will gebraucht werden — und wird zur Last'],
      bogen: ['Vom Ernährer zum Ungeziefer zum stillen Verzicht'],
      sprechweise: ['Kaum noch verständlich, Stimme mit „piepsendem" Beiklang'],
      want: ['Weiter zur Arbeit gehen, als sei nichts geschehen'],
      need: ['Als Mensch gesehen werden, nicht als Funktion'],
      wound: ['Der Zusammenbruch des väterlichen Geschäfts'],
      lie: ['„Wenn ich nur funktioniere, bin ich geliebt."'],
    },
  },
  {
    key: 'grete', name: 'Grete Samsa', archetype: 'Die Wandelnde', source: 'Grete',
    notes: 'Spiegelfigur zu Gregor: während er schrumpft, wächst sie. Ihr Bogen trägt den Schluss.',
    fill: {
      aussehen: ['Siebzehn, zu Beginn kindlich', 'Am Ende „aufgeblüht zu einem schönen und üppigen Mädchen"'],
      persoenlichkeit: ['Zuerst fürsorglich, dann zunehmend ungeduldig', 'Spielt Violine'],
      hintergrund: ['Findet eine Stellung als Verkäuferin'],
      beziehungen: ['Gregor: Pflegerin, später Richterin', 'Eltern: übernimmt die Wortführerschaft'],
      konflikt: ['Mitleid gegen Selbsterhaltung'],
      bogen: ['Vom Kind zur Entscheiderin: „Wir müssen versuchen, es loszuwerden."'],
      phrasen: ['„Es muss weg"'],
      want: ['Ein eigenes Leben jenseits der Krankenstube'],
      need: ['Sich ohne Schuld vom Bruder lösen'],
    },
  },
  {
    key: 'prokurist', name: 'Der Prokurist', archetype: 'Der Antagonist im Anzug', source: null,
    notes: 'Kommt am ersten Morgen persönlich, um Gregors Fehlen zu prüfen. Steht für die Firma, die keine Ausnahme kennt.',
    fill: {
      persoenlichkeit: ['Misstrauisch, formell, gnadenlos höflich'],
      konflikt: ['Unterstellt Gregor Unterschlagung'],
      sprechweise: ['Spricht von der Tür aus, nie direkt zu Gregor'],
      want: ['Ordnung in der Firma, keine Ausreden'],
    },
  },
];

const draftId = {};
for (const d of DRAFTS) {
  const created = drafts.createDraftFigure(bookId, OWNER, {
    name: d.name, archetype: d.archetype, notes: d.notes,
    mindmap: mindmap(d.name, d.fill), sourceFigureId: d.source ? fig(d.source) : null,
  });
  draftId[d.key] = created.id;
}

// ── Plot-Werkstatt ───────────────────────────────────────────────────────────
const acts = {
  I: plotDb.createAct(bookId, OWNER, { name: 'Die Verwandlung', farbe: 'blue' }).id,
  II: plotDb.createAct(bookId, OWNER, { name: 'Die Eskalation', farbe: 'orange' }).id,
  III: plotDb.createAct(bookId, OWNER, { name: 'Die Befreiung', farbe: 'green' }).id,
};
const threads = {
  gregor: plotDb.createThread(bookId, OWNER, { name: 'Gregor', farbe: 'purple', figureId: fig('Gregor'), draftFigureId: draftId.gregor }).id,
  grete: plotDb.createThread(bookId, OWNER, { name: 'Grete', farbe: 'pink', figureId: fig('Grete'), draftFigureId: draftId.grete }).id,
};

const K1 = chapterId['Kapitel 1'] ?? null;
const K2 = chapterId['Kapitel 2'] ?? null;
const BEATS = [
  { key: 'erwachen', act: 'I', thread: 'gregor', titel: 'Gregor erwacht als Ungeziefer', status: 'im_buch', intensitaet: 4, chapter: K1, zeit: 'Montagmorgen',
    beschreibung: 'Er sorgt sich zuerst um den verpassten Zug — die Verwandlung selbst nimmt er hin.', figs: ['Gregor'], drafts: ['gregor'] },
  { key: 'prokurist', act: 'I', thread: 'gregor', titel: 'Der Prokurist an der Tür', status: 'geplant', intensitaet: 3, chapter: K1, zeit: 'Montagmorgen, 7 Uhr',
    beschreibung: 'Die Firma klopft an. Gregor öffnet — und der Prokurist flieht.', figs: ['Gregor'], drafts: ['gregor', 'prokurist'] },
  { key: 'pflege', act: 'I', thread: 'grete', titel: 'Grete übernimmt die Pflege', status: 'im_buch', intensitaet: 2, chapter: K1,
    beschreibung: 'Sie bringt Speisereste, testet, was er noch mag. Fürsorge mit abgewandtem Blick.', figs: ['Grete', 'Gregor'], drafts: ['grete'] },
  { key: 'arbeit', act: 'I', thread: null, titel: 'Die Familie muss arbeiten', status: 'im_buch', intensitaet: 2, chapter: K1,
    beschreibung: 'Vater, Mutter und Grete nehmen Stellen an — der Haushalt ordnet sich ohne Gregor neu.', figs: ['Herr Samsa', 'Frau Samsa', 'Grete'] },
  { key: 'moebel', act: 'II', thread: 'grete', titel: 'Das Zimmer wird ausgeräumt', status: 'geplant', intensitaet: 3,
    beschreibung: 'Grete will ihm Platz zum Kriechen schaffen; Gregor klammert sich ans Bild an der Wand.', figs: ['Grete', 'Frau Samsa', 'Gregor'], drafts: ['grete'] },
  { key: 'apfel', act: 'II', thread: 'gregor', titel: 'Der Vater wirft Äpfel', status: 'im_buch', intensitaet: 5, chapter: K2, zeit: 'Abend',
    beschreibung: 'Ein Apfel bleibt im Rücken stecken und fault dort — die Wunde, die nicht mehr heilt.', figs: ['Herr Samsa', 'Gregor'], drafts: ['gregor'] },
  { key: 'untermieter', act: 'II', thread: null, titel: 'Drei Untermieter ziehen ein', status: 'im_buch', intensitaet: 2, chapter: K2,
    beschreibung: 'Die Wohnung wird zum Erwerbsbetrieb; Gregors Zimmer zur Rumpelkammer.', figs: ['Drei Untermieter'] },
  { key: 'traum', act: 'II', thread: 'gregor', titel: 'Gregor träumt sich zurück ins Büro', status: 'geplant', verworfen: 1, intensitaet: 1,
    beschreibung: 'Rückblende in den Arbeitsalltag — verworfen, bremst die Eskalation.', drafts: ['gregor'] },
  { key: 'violine', act: 'III', thread: 'grete', titel: 'Grete spielt Violine', status: 'im_buch', intensitaet: 4, chapter: K2,
    beschreibung: 'Die Musik lockt Gregor aus dem Zimmer — die Untermieter sehen ihn und kündigen.', figs: ['Grete', 'Gregor', 'Drei Untermieter'], drafts: ['grete', 'gregor'] },
  { key: 'urteil', act: 'III', thread: 'grete', titel: '„Wir müssen versuchen, es loszuwerden"', status: 'geplant', intensitaet: 5, chapter: K2,
    beschreibung: 'Grete spricht aus, was alle denken. Aus „er" wird „es".', figs: ['Grete'], drafts: ['grete'] },
  { key: 'tod', act: 'III', thread: 'gregor', titel: 'Gregors Tod', status: 'im_buch', intensitaet: 5, chapter: K2, zeit: 'Früher Morgen',
    beschreibung: 'Die Bedienerin findet ihn. Mager, flach, trocken.', figs: ['Gregor', 'Bedienerin'], drafts: ['gregor'] },
  { key: 'ausflug', act: 'III', thread: null, titel: 'Ausflug ins Freie', status: 'geplant', intensitaet: 1, chapter: K2,
    beschreibung: 'Die Eltern bemerken, wie Grete aufgeblüht ist — Zeit, einen Mann für sie zu suchen.', figs: ['Herr Samsa', 'Frau Samsa', 'Grete'], drafts: ['grete'] },
];

const beatId = {};
for (const b of BEATS) {
  const created = plotDb.createBeat(bookId, acts[b.act], OWNER, {
    titel: b.titel, beschreibung: b.beschreibung, status: b.status, verworfen: b.verworfen || 0,
    chapterId: b.chapter ?? null, intensitaet: b.intensitaet, zeit: b.zeit || null,
    threadId: b.thread ? threads[b.thread] : null,
    figureIds: figIds(...(b.figs || [])),
    draftFigureIds: (b.drafts || []).map(k => draftId[k]),
    locationIds: wohnung ? [wohnung] : [],
  });
  beatId[b.key] = created.id;
}

const BEAT_RELATIONS = [
  ['erwachen', 'prokurist', 'fuehrt-zu'],
  ['pflege', 'urteil', 'bereitet-vor'],
  ['apfel', 'tod', 'zahlt-ein'],
  ['untermieter', 'violine', 'bereitet-vor'],
  ['violine', 'urteil', 'fuehrt-zu'],
  ['erwachen', 'tod', 'spiegelt'],
];
for (const [from, to, typ] of BEAT_RELATIONS) {
  plotDb.createBeatRelation(bookId, OWNER, { fromBeatId: beatId[from], toBeatId: beatId[to], typ });
}

// ── Motiv-Werkstatt ──────────────────────────────────────────────────────────
const themes = {
  isolation: motifsDb.createTheme(bookId, OWNER, { name: 'Entfremdung & Isolation', farbe: 'blue',
    beschreibung: 'Gregor verliert erst die Sprache, dann den Raum, dann die Zugehörigkeit.' }).id,
  familie: motifsDb.createTheme(bookId, OWNER, { name: 'Familie & Pflicht', farbe: 'amber',
    beschreibung: 'Liebe als Tauschgeschäft: wer nicht mehr beiträgt, fällt aus der Familie.' }).id,
};

const MOTIFS = [
  { key: 'tuer', theme: 'isolation', name: 'Die Tür', terms: ['Tür', 'Türe', 'Spalt'],
    beschreibung: 'Grenze zwischen Gregor und der Welt. Wird verschlossen, aufgerissen, einen Spalt geöffnet.',
    figs: ['Gregor'], drafts: ['gregor'], beats: ['prokurist', 'violine'], chapters: ['Kapitel 1', 'Kapitel 2'], pages: ['Familie', 'Drei Untermieter'] },
  { key: 'ungeziefer', theme: 'isolation', name: 'Das Ungeziefer', terms: ['Ungeziefer', 'Panzer', 'Beinchen'],
    beschreibung: 'Der Körper als Urteil — Gregor wird zu dem, als was ihn die Welt behandelt.',
    figs: ['Gregor'], drafts: ['gregor'], beats: ['erwachen', 'tod'], chapters: ['Kapitel 1'], pages: ['Die Verwandlung'] },
  { key: 'zimmer', theme: 'isolation', name: 'Das Zimmer', terms: ['Zimmer', 'Wände', 'Möbel'],
    beschreibung: 'Erst Zuflucht, dann Käfig, zuletzt Rumpelkammer.',
    drafts: ['gregor', 'grete'], beats: ['moebel', 'untermieter'], pages: ['Die Verwandlung'] },
  { key: 'apfel', theme: 'familie', name: 'Der Apfel', terms: ['Apfel', 'Äpfel', 'Obst'],
    beschreibung: 'Die Gewalt des Vaters, die im Körper weiterfault.',
    figs: ['Herr Samsa', 'Gregor'], beats: ['apfel', 'tod'], chapters: ['Kapitel 2'], pages: ['Der Apfel'] },
  { key: 'speisen', theme: 'familie', name: 'Speisen', terms: ['Speisen', 'Schüssel', 'Speisereste', 'Mahlzeit'],
    beschreibung: 'Fürsorge, die zur Routine verkommt; die Untermieter essen, Gregor hungert.',
    figs: ['Grete', 'Drei Untermieter'], drafts: ['grete'], beats: ['pflege', 'untermieter'], pages: ['Familie', 'Drei Untermieter', 'Ende'] },
  { key: 'musik', theme: 'familie', name: 'Die Violine', terms: ['Violine', 'spielt', 'Musik'],
    beschreibung: 'Gretes Talent und Gregors letzte Sehnsucht nach Nähe.',
    figs: ['Grete'], drafts: ['grete'], beats: ['violine'], chapters: ['Kapitel 2'], pages: ['Drei Untermieter'] },
  { key: 'uniform', theme: null, name: 'Die Uniform', terms: ['Uniform', 'Goldknöpfe'],
    beschreibung: 'Der Vater richtet sich wieder auf — Macht wandert zurück.',
    figs: ['Herr Samsa'], beats: ['apfel', 'arbeit'], pages: ['Der Apfel'] },
];

const motifId = {};
for (const m of MOTIFS) {
  const id = motifsDb.createMotif(bookId, OWNER, {
    themeId: m.theme ? themes[m.theme] : null, name: m.name, beschreibung: m.beschreibung, triggerTerms: m.terms,
  }).id;
  motifId[m.key] = id;
  motifsDb.setMotifFigures(id, figIds(...(m.figs || [])));
  motifsDb.setMotifDraftFigures(id, (m.drafts || []).map(k => draftId[k]));
  motifsDb.setMotifBeats(id, (m.beats || []).map(k => beatId[k]));
  motifsDb.setMotifChapters(id, (m.chapters || []).map(n => chapterId[n]).filter(Boolean));
  motifsDb.setMotifPages(id, (m.pages || []).map(n => pageId[n]).filter(Boolean));
}

const MOTIF_RELATIONS = [
  ['tuer', 'zimmer', 'verstaerkt'],
  ['ungeziefer', 'zimmer', 'bedingt'],
  ['apfel', 'uniform', 'verstaerkt'],
  ['musik', 'ungeziefer', 'kontrastiert'],
  ['speisen', 'musik', 'spiegelt'],
  ['apfel', 'speisen', 'bricht'],
];
for (const [from, to, typ] of MOTIF_RELATIONS) motifsDb.createRelation(motifId[from], motifId[to], typ);

console.log(`Buch ${bookId} (${BOOK_NAME}), Owner ${OWNER}:`);
console.log(`  Figuren-Werkstatt: ${DRAFTS.length} Drafts (${figRows.length ? 'mit' : 'ohne'} Katalog-Quelle)`);
console.log(`  Plot: ${Object.keys(acts).length} Akte, ${Object.keys(threads).length} Stränge, ${BEATS.length} Beats, ${BEAT_RELATIONS.length} Beziehungen`);
console.log(`  Motive: ${Object.keys(themes).length} Themen, ${MOTIFS.length} Motive, ${MOTIF_RELATIONS.length} Beziehungen`);
