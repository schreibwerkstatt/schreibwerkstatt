'use strict';
// Seed für die Landing-Screenshots: das Beispielbuch plus die Daten, die die
// Oberfläche zeigen soll — Figuren, Beat-Board, Recherche-Board, geteilte
// Abschnitte mit Leserkommentaren.
//
// Alles kommt aus dem ECHTEN Datenmodell (Content-Store-Facade für Buch,
// Kapitel, Abschnitte; die db-Module für Figuren, Plot, Recherche, Shares).
// Dadurch rendert die App beim Screenshot genau die Oberfläche, die ein User
// nach einem echten Analyse-Lauf sieht.

const crypto = require('crypto');
const contentStore = require('../../lib/content-store');
const { createDemoBook } = require('../../lib/demo-book');
const figures = require('../../db/figures');
const plot = require('../../db/plot');
const researchItems = require('../../db/research-items');
const shareLinks = require('../../db/share-links');
const { db } = require('../../db/schema');

const OWNER = 'dev@local';

// ── Figuren des Beispielbuchs ────────────────────────────────────────────────
const K1 = 'Kapitel 1 — Das Erwachen';
const K2 = 'Kapitel 2 — Der Rückzug';

const FIGUREN = [
  {
    id: 'fig_1',
    name: 'Gregor Samsa',
    kurzname: 'Gregor',
    typ: 'hauptfigur',
    geschlecht: 'männlich',
    beruf: 'Reisender',
    wohnadresse: 'Ein Mietszimmer; die Familie wohnt im selben Haus',
    aeusseres: 'Ein ungeheueres Ungeziefer mit panzerartig hartem Rücken, gewölbtem braunem Bauch und vielen Beinen',
    stimme: 'Nüchtern, unauffällig, beinahe geschäftlich',
    hintergrund: 'Reisender, zuletzt viel unterwegs; Familie mit Schuldenlast',
    beschreibung: 'Wird eines Morgens in ein ungeheueres Ungeziefer verwandelt und hört die Familie durch die geschlossene Tür.',
    sozialschicht: 'Mittleres Bürgertum, wirtschaftlich unter Druck',
    praesenz: 'ab Kapitel 1 durchgehend',
    rolle: 'Hauptfigur',
    motivation: 'Seine Stellung behalten und die Familie nicht belasten — beides gelingt ihm nicht mehr.',
    konflikt: 'Die Verwandlung macht ihn zur Last; die Familie ersetzt ihn durch die drei Untermieter.',
    entwicklung: 'Vom sorgenden Reisenden zum ausgeschlossenen Wesen, das die Familie mit in die Freiheit führt.',
    arc: {
      start: 'Sorgender, zurückhaltender Familienvater',
      ende: 'Ausgestoßenes Wesen ohne Stimme',
    },
    erste_erwaehnung: 'Die Verwandlung',
    schluesselzitate: [
      'Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt.',
    ],
    eigenschaften: ['reiselebend', 'pflichtbewusst', 'zurückhaltend'],
    kapitel: [{ name: K1, haeufigkeit: 8 }, { name: K2, haeufigkeit: 12 }],
    beziehungen: [
      { figur_id: 'fig_3', typ: 'feind', beschreibung: 'Der Apfel beendet die gemeinsame Geschichte.', machtverhaltenswert: null, belege: [{ kapitel: K2, seite: 'Der Apfel' }] },
      { figur_id: 'fig_2', typ: 'komplize', beschreibung: 'Grete versorgt ihn heimlich und deckt ihn am Ende.', belege: [{ kapitel: K2, seite: 'Ende' }] },
    ],
  },
  {
    id: 'fig_2',
    name: 'Grete Samsa',
    kurzname: 'Grete',
    typ: 'nebenfigur',
    geschlecht: 'weiblich',
    beruf: 'Verkäuferin',
    aeusseres: 'Schlank, dunkles Haar, schnell',
    stimme: 'Jung, bestimmt, seltener laut',
    beschreibung: 'Die siebzehnjährige Schwester, die zuerst versorgt und später den Tod feststellt.',
    rolle: 'Die einzige Figur mit eigener Bewegung',
    motivation: 'Die Familie zusammenhalten und die Schulden des Hauses tilgen.',
    konflikt: 'Sie muss zwischen Gregor und der wirtschaftlichen Existenz wählen.',
    entwicklung: 'Von der Versorgerin zur Vollstreckerin.',
    erste_erwaehnung: 'Die Familie',
    schluesselzitate: [
      'die Schwester Grete, gerade siebzehn Jahre alt, hatte eine Stellung als Verkäuferin gefunden',
    ],
    eigenschaften: ['fürsorglich', 'ehrgeizig', 'entschlossen'],
    kapitel: [{ name: K1, haeufigkeit: 4 }, { name: K2, haeufigkeit: 6 }],
    beziehungen: [
      { figur_id: 'fig_1', typ: 'geschwister', beschreibung: 'Sister and secret keeper — and later his judge.', belege: [{ kapitel: K2, seite: 'Ende' }] },
    ],
  },
  {
    id: 'fig_3',
    name: 'Der Vater',
    kurzname: 'Vater',
    typ: 'nebenfigur',
    geschlecht: 'männlich',
    beruf: 'seit fünf Jahren arbeitslos',
    stimme: 'Hart, herrisch, wirtschaftlich bedroht',
    beschreibung: 'Der Vater, der die Schulden im Kopf hat und den Wurf mit dem Apfel beginnt.',
    rolle: 'Gegenspieler der Verwandlung',
    motivation: 'Die Existenz der Familie sichern.',
    konflikt: 'Gregor ist für ihn kein Sohn mehr, sondern ein Ungeziefer im eigenen Haus.',
    entwicklung: 'Vom geduldten Hausherrn zum Werfer.',
    erste_erwaehnung: 'Die Familie',
    eigenschaften: ['streng', 'ehrgeizig', 'gebrochen'],
    kapitel: [{ name: K1, haeufigkeit: 3 }, { name: K2, haeufigkeit: 3 }],
    beziehungen: [
      { figur_id: 'fig_1', typ: 'elternteil', beschreibung: 'Der Vater sieht den Sohn als Last.', belege: [{ kapitel: K2, seite: 'Der Apfel' }] },
    ],
  },
  {
    id: 'fig_4',
    name: 'Die Mutter',
    kurzname: 'Mutter',
    typ: 'randfigur',
    geschlecht: 'weiblich',
    beruf: 'näht feine Wäsche für ein Modegeschäft',
    stimme: 'Besorgt, ängstlich, selten zu Wort',
    beschreibung: 'Die asthma-kranke Mutter, die Gregor nicht sehen kann.',
    rolle: 'Die stille Mitte der Familie',
    erste_erwaehnung: 'Die Familie',
    eigenschaften: ['fürsorglich', 'ängstlich', 'kränklich'],
    kapitel: [{ name: K1, haeufigkeit: 2 }, { name: K2, haeufigkeit: 2 }],
    beziehungen: [],
  },
  {
    id: 'fig_5',
    name: 'Die Bedienerin',
    kurzname: 'Bedienerin',
    typ: 'randfigur',
    geschlecht: 'weiblich',
    beruf: 'Putzfrau',
    stimme: 'Rau, ungeniert, sachlich',
    beschreibung: 'Die Bedienerin, die Gregors leblosen Körper findet und die Todesfrage stellt.',
    rolle: 'Zeugin am Ende',
    erste_erwaehnung: 'Ende',
    eigenschaften: ['direct', 'nüchtern'],
    kapitel: [{ name: K2, haeufigkeit: 1 }],
    beziehungen: [],
  },
];

// ── Plot-Werkstatt ───────────────────────────────────────────────────────────
const AKTE = [
  {
    name: 'Akt I — Das Erwachen',
    beats: [
      { titel: 'Die Verwandlung', status: 'im_buch', kapitel: K1, intensitaet: 3, zeit: 'Morgens', beschreibung: 'Gregor erwacht als Ungeziefer. Der erste Satz trägt die ganze Szene.' },
      { titel: 'Die Familie hinter der Tür', status: 'im_buch', kapitel: K1, intensitaet: 2, zeit: 'Am selben Tag', beschreibung: 'Die Schritte der Familie werden zu Gregors einziger Zeitgefühl.' },
    ],
  },
  {
    name: 'Akt II — Der Rückzug',
    beats: [
      { titel: 'Der Apfel', status: 'im_buch', kapitel: K2, intensitaet: 5, zeit: 'Abends', beschreibung: 'Der Vater wirft. Der Apfel fährt Gregor ein und bleibt.' },
      { titel: 'Die drei Untermieter', status: 'im_buch', kapitel: K2, intensitaet: 4, zeit: 'Später', beschreibung: 'Die Violine macht Gregor für alle zugleich sichtbar.' },
    ],
  },
  {
    name: 'Akt III — Der Ausstoß',
    beats: [
      { titel: '„Tot?"', status: 'geplant', kapitel: K2, intensitaet: 5, zeit: 'Am frühen Morgen', beschreibung: 'Die Bedienerin stellt die Frage, die niemand beantworten will.' },
      { titel: 'Die Familie fährt hinaus', status: 'geplant', intensitaet: 3, zeit: 'Danach', beschreibung: 'Die Familie fährt mit der elektrischen Bahn ins Freie — zum ersten Mal seit Monaten.' },
    ],
  },
];

// ── Recherche-Board ───────────────────────────────────────────────────────────
const RECHERCHE = [
  {
    kind: 'note',
    title: 'Warum der Beruf so früh fällt',
    body: 'Reisender ist die erste Angabe nach dem ersten Satz. Sie begründet gleich zwei Dinge: dass Gregor fremd unterwegs war, und dass die Familie ohne sein Geld nicht über die Runden kommt. Wer die Verwandlung streicht, verliert diese Begründung.',
    tags: ['figur', 'gregor'],
  },
  {
    kind: 'quote',
    title: 'Das Käfig-Motiv',
    body: 'Ein Käfig ging man sich auszubeten',
    source: 'Kafka, Tagebuch, 3. Juni 1915',
    tags: ['motiv', 'kafka'],
  },
  {
    kind: 'fact',
    title: 'Ersters Erscheinen',
    body: 'Die Erzählung erschien 1915 in der Monatsschrift «Die weißen Blätter», Leipzig, Kurt Wolff Verlag.',
    source: 'Verlagshinweis, Erstausgabe',
    tags: ['fakt'],
  },
  {
    kind: 'note',
    title: 'Grete — die einzige bewegte Figur',
    body: 'Sie trägt die Schüssel mit Speiseresten hinein, sie spielt Violine, sie stellt die Todesfrage. Alles andere in der Familie ist Reaktion. Wenn Grete mehr Raum bekommt, muss die Familie weniger typisch bleiben.',
    tags: ['figur', 'grete'],
  },
];

// ── Geteilte Abschnitte + Leserkommentare ────────────────────────────────────
// anchor: [Abschnittsname, Blockindex, Zitat]. Zitat nicht im Text → „Stelle
// geändert" (der Diff-Pfad des Lesers).
const SHARES = [
  { key: 'page', kind: 'page', page: 'Die Verwandlung', intro: 'Erster Abschnitt — sagt euch, ob der Einstieg trägt.', views: 24 },
  { key: 'chapter', kind: 'chapter', chapter: K2, intro: 'Das zweite Kapitel als Ganzes.', views: 11 },
];

const COMMENTS = [
  {
    share: 'page', reader: 'Lektorin Anna',
    anchor: ['Die Verwandlung', 0, 'ungeheueren Ungeziefer'],
    body: 'Starkes Bild gleich im ersten Satz — das zieht sofort rein.',
    replies: [{ owner: true, body: 'Danke! Das Bild bleibt genau so.' }],
  },
  {
    share: 'page', reader: 'Sara',
    anchor: ['Die Verwandlung', 1, 'Was ist mit mir geschehen'],
    body: 'Der innere Monolog hier ist großartig. Den würde ich als E-Mail-Formulierung in ein Lektorat geben — 1:1.',
  },
  {
    share: 'page', reader: 'Sara',
    body: 'Insgesamt ein sehr starker, geschlossener Text. Danke fürs Teilen!',
  },
  {
    share: 'chapter', reader: 'Tom B.',
    anchor: ['Drei Untermieter', 1, 'die Tochter spielt'],
    body: 'Schöner Moment — die Musik als Wendepunkt. Wäre das ohne den Spalt im Türsatz genauso stark?',
    replies: [{ reader: 'Lektorin Anna', body: 'Genau das habe ich beim Lesen auch gedacht.' }],
  },
  {
    share: 'chapter', reader: 'Lektorin Anna',
    anchor: ['Ende', 0, 'Tot?'],
    body: 'Hier wirkt „Tot?" einen Tick zu modern. Originalton prüfen?',
  },
];

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function _readerToken(name) { return crypto.createHash('sha256').update('reader:' + name).digest('base64url').slice(0, 22); }
function _ipHash(name) { return crypto.createHash('sha256').update('ip:' + name).digest('hex').slice(0, 16); }

/** Alle Abschnitte des Buchs mit HTML — für Block-IDs (data-bid) und Texte. */
async function _loadPages(bookId) {
  const pages = await contentStore.listPages(bookId, { session: { user: { email: OWNER } } });
  const out = [];
  for (const meta of pages) {
    const full = await contentStore.loadPage(meta.id, { session: { user: { email: OWNER } } });
    out.push({ meta, html: full.html || '' });
  }
  return out;
}

/** data-bid + Text je Block eines Abschnitts-HTMLs. */
function _blocks(html) {
  const out = [];
  const re = /<(p|h[1-6]|li|blockquote|td|th|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[2] || '';
    const bid = (attrs.match(/data-bid="([^"]+)"/) || [])[1] || null;
    const text = m[3].replace(/<[^>]+>/g, '').trim();
    out.push({ bid, text, tag: m[1].toLowerCase() });
  }
  return out;
}

/** idMaps für die Figuren-Persistenz (Kapitel-/Seitennamen → IDs). */
function _idMaps(pages) {
  const chNameToId = {};
  const pageNameToIdByChapter = {};
  for (const p of pages) {
    const chapId = p.meta.chapter_id;
    if (chapId == null) continue;
    if (!chNameToId[p.meta.chapter_name]) {
      chNameToId[p.meta.chapter_name] = chapId;
    }
    const byName = pageNameToIdByChapter[chapId] || (pageNameToIdByChapter[chapId] = {});
    byName[p.meta.name] = p.meta.id;
  }
  return { chNameToId, pageNameToIdByChapter };
}

// ── Seed-Schritte ────────────────────────────────────────────────────────────

async function seedBook() {
  const { bookId, deduplicated } = await createDemoBook(OWNER);
  return { bookId, deduplicated };
}

async function seedFigures(bookId) {
  const pages = await _loadPages(bookId);
  const idMaps = _idMaps(pages);
  figures.saveFigurenToDb(bookId, FIGUREN, OWNER, idMaps);
  figures.rebuildFigureAppearances(bookId, OWNER, FIGUREN, idMaps);
  return FIGUREN.length;
}

function seedPlot(bookId) {
  let beats = 0;
  for (const act of AKTE) {
    const a = plot.createAct(bookId, OWNER, { name: act.name });
    for (const b of act.beats) {
      const chapterId = b.kapitel
        ? (db.prepare('SELECT chapter_id FROM chapters WHERE book_id = ? AND chapter_name = ?').get(bookId, b.kapitel)?.chapter_id ?? null)
        : null;
      plot.createBeat(bookId, a.id, OWNER, {
        titel: b.titel,
        beschreibung: b.beschreibung || null,
        status: b.status || 'geplant',
        chapterId,
        intensitaet: b.intensitaet ?? null,
        zeit: b.zeit || null,
      });
      beats += 1;
    }
  }
  return beats;
}

function seedResearch(bookId) {
  let items = 0;
  for (const r of RECHERCHE) {
    researchItems.createItem({
      bookId,
      userEmail: OWNER,
      kind: r.kind,
      title: r.title,
      body: r.body,
      source: r.source || null,
      urls: [],
      tags: r.tags || [],
    });
    items += 1;
  }
  return items;
}

async function seedShares(bookId) {
  const pages = await _loadPages(bookId);
  const pageByName = new Map();
  for (const p of pages) {
    pageByName.set(p.meta.name, { pageId: p.meta.id, chapterId: p.meta.chapter_id, blocks: _blocks(p.html) });
  }
  const chapterByName = new Map(
    db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookId)
      .map(c => [c.chapter_name, c.chapter_id]),
  );

  const tokenByKey = new Map();
  for (const s of SHARES) {
    const link = shareLinks.createShareLink({
      kind: s.kind,
      pageId: s.kind === 'page' ? (pageByName.get(s.page)?.pageId ?? null) : null,
      chapterId: s.kind === 'chapter' ? (chapterByName.get(s.chapter) ?? null) : null,
      bookId,
      ownerEmail: OWNER,
      intro: s.intro ?? null,
    });
    tokenByKey.set(s.key, link.token);
  }

  let count = 0;
  for (const c of COMMENTS) {
    const token = tokenByKey.get(c.share);
    if (!token) continue;
    let anchor = null;
    if (c.anchor) {
      const [pageName, blockIndex, quote] = c.anchor;
      const blk = pageByName.get(pageName)?.blocks?.[blockIndex];
      if (blk) {
        const start = blk.text.indexOf(quote);
        anchor = {
          bid: blk.bid,
          quote,
          start: start < 0 ? null : start,
          end: start < 0 ? null : start + quote.length,
        };
      }
    }
    const root = shareLinks.insertComment({
      token,
      readerName: c.reader,
      readerToken: _readerToken(c.reader),
      body: c.body,
      ipHash: _ipHash(c.reader),
      anchorBid: anchor?.bid ?? null,
      anchorQuote: anchor?.quote ?? null,
      anchorStart: anchor?.start ?? null,
      anchorEnd: anchor?.end ?? null,
    });
    count += 1;
    for (const r of c.replies || []) {
      if (r.owner) {
        shareLinks.insertOwnerReply({ token, parentId: root.id, authorEmail: OWNER, body: r.body });
      } else {
        shareLinks.insertComment({
          token,
          readerName: r.reader,
          readerToken: _readerToken(r.reader),
          body: r.body,
          ipHash: _ipHash(r.reader),
          parentId: root.id,
        });
      }
      count += 1;
    }
  }

  return { links: SHARES.length, comments: count, tokens: tokenByKey };
}

/** Setzt alle Daten und gibt die IDs zurück, die die Screenshots brauchen. */
async function seedAll() {
  const { bookId } = await seedBook();
  const figCount = await seedFigures(bookId);
  const beatCount = seedPlot(bookId);
  const researchCount = seedResearch(bookId);
  const shares = await seedShares(bookId);

  const pages = await _loadPages(bookId);
  const firstPage = pages.find(p => p.meta.name === 'Die Verwandlung') || pages[0];

  return {
    bookId,
    pageId: firstPage?.meta.id ?? null,
    pageName: firstPage?.meta.name ?? null,
    figures: figCount,
    beats: beatCount,
    research: researchCount,
    shares: shares.links,
    comments: shares.comments,
    shareTokens: Object.fromEntries(shares.tokens),
  };
}

module.exports = { seedAll, OWNER, FIGUREN };
