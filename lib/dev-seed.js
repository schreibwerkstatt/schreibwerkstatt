'use strict';
// Einmaliger Auto-Seed fuer LOCAL_DEV_MODE auf leerer DB.
//
// Trigger-Bedingung:
//   - LOCAL_DEV_MODE === 'true'
//   - LOCAL_DEV_SEED !== 'false' (Default an)
//   - SELECT COUNT(*) FROM books = 0 (idempotent)
//
// Prosa-Text: Public-Domain (Franz Kafka, „Die Verwandlung").
//
// Seedet zusaetzlich Share-Links (Buch/Kapitel/Seite) + Leser-Kommentare, damit
// die Kommentar-Leisten (Bucheditor vertikal verankert, Notebook-Leseansicht)
// lokal mit echten Daten getestet werden koennen: verankerte + allgemeine
// Kommentare, Threads mit Reader-/Owner-Replies, ein erledigter und ein
// „Stelle-geaendert"-Fall. Block-HTML traegt explizite data-bid (sonst koennen
// verankerte Kommentare nicht lokalisiert werden — data-bid wird sonst erst am
// Page-Write-Chokepoint vergeben, den der Raw-SQL-Seed umgeht).

const crypto = require('crypto');
const { db } = require('../db/connection');
const appUsers = require('../db/app-users');
const categories = require('../db/book-categories');
const logger = require('../logger');

const DEV_OWNER = 'dev@local';

// Default-Kategorie-Pool (global, admin-kuratiert). Auf frischer DB einmalig
// angelegt, damit Bucher direkt einsortiert werden koennen.
const _DEFAULT_CATEGORIES = ['Blog', 'Buch', 'Tagebuch'];

// Prosa block-weise (ein Eintrag = ein <p>), damit der Seed pro Block eine
// stabile data-bid vergeben und Kommentar-Anker auf exakte Offsets setzen kann.
const _PROSE = [
  {
    chapter: 'Kapitel 1',
    pages: [
      {
        name: 'Die Verwandlung',
        blocks: [
          'Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt. Er lag auf seinem panzerartig harten Rücken und sah, wenn er den Kopf ein wenig hob, seinen gewölbten, braunen, von bogenförmigen Versteifungen geteilten Bauch, auf dessen Höhe sich die Bettdecke, zum gänzlichen Niedergleiten bereit, kaum noch erhalten konnte. Seine vielen, im Vergleich zu seinem sonstigen Umfang kläglich dünnen Beine flimmerten ihm hilflos vor den Augen.',
          '„Was ist mit mir geschehen?", dachte er. Es war kein Traum. Sein Zimmer, ein richtiges, nur etwas zu kleines Menschenzimmer, lag ruhig zwischen den vier wohlbekannten Wänden. Über dem Tisch, auf dem eine auseinandergepackte Musterkollektion von Tuchwaren ausgebreitet war — Samsa war Reisender — hing das Bild, das er vor kurzem aus einer illustrierten Zeitschrift ausgeschnitten und in einem hübschen, vergoldeten Rahmen untergebracht hatte.',
        ],
      },
      {
        name: 'Familie',
        blocks: [
          'Die Verwandlung hatte den Haushalt der Familie Samsa von einem Tag auf den anderen verändert. Der Vater, der seit fünf Jahren nicht mehr gearbeitet hatte, kramte alte Anzüge aus dem Schrank. Die Mutter, von Asthma geplagt, nähte feine Wäsche für ein Modegeschäft, und die Schwester Grete, gerade siebzehn Jahre alt, hatte ein Stellung als Verkäuferin gefunden.',
          'Gregor verfolgte alle Geräusche durch die geschlossene Tür. Er erkannte den Gang des Vaters, das schleppende Schreiten der Mutter, den raschen, leichten Schritt der Schwester. Manchmal wurde die Tür geöffnet, und Grete trat herein. Sie stellte die Schüssel mit alten Speiseresten in eine Ecke und zog sich rasch wieder zurück.',
        ],
      },
    ],
  },
  {
    chapter: 'Kapitel 2',
    pages: [
      {
        name: 'Der Apfel',
        blocks: [
          'Eines Abends kam der Vater früher als sonst nach Hause. Gregor hatte das Zimmer verlassen wollen, um die Schwester nicht zu erschrecken. Doch der Vater, in seiner blauen Uniform mit den Goldknöpfen, sah die Tochter mit dem Schreckensschrei umsinken. Er griff nach einer Schüssel mit Obst, die auf der Anrichte stand, und begann, Apfel um Apfel zu werfen.',
          'Ein schwach geworfener Apfel streifte Gregors Rücken, glitt aber ohne Schaden ab. Ein ihm sofort nachfliegender drang dagegen förmlich in Gregors Rücken ein. Gregor wollte sich weiter schleppen, als drücke ihn der überraschende, unglaubliche Schmerz. Mit dem letzten Blick sah er noch, wie die Tür seines Zimmers aufgerissen wurde und vor der schreienden Schwester die Mutter herauslief, gänzlich entkleidet, denn die Schwester hatte sie entkleidet, um ihr im Ohnmachtsanfall Luft zu verschaffen.',
        ],
      },
      {
        name: 'Drei Untermieter',
        blocks: [
          'Die drei Zimmerherren waren ernste Männer. Alle drei trugen Vollbärte und sahen einander zum Verwechseln ähnlich. Sie nahmen ihre Mahlzeiten mit ungeheurer Würde ein und prüften jeden Bissen, bevor er in den Mund gelangte. Die Eltern sahen ihnen mit Sorgfalt zu, dass nichts fehlte. Grete war stets bereit, das geringste Bedürfnis zu erfüllen.',
          'Doch eines Abends spielte Grete Violine in der Küche. Der mittlere Herr rief zuerst seinen Freunden zu: „Kommen Sie doch, die Tochter spielt!" Sie nickten und setzten sich erwartungsvoll. Da öffnete Gregor die Tür um einen Spalt — und alle drei Herren bemerkten ihn zugleich.',
        ],
      },
      {
        name: 'Ende',
        blocks: [
          'Am frühen Morgen kam die Bedienerin und schrie laut auf. Sie stand vor dem leblosen Körper Gregors. Die Familie eilte herbei: der Vater im Hemd, die Mutter im Schlafrock, Grete in einem dünnen Kleid. „Tot?", fragte die Mutter. „Ich glaub schon", sagte die Bedienerin. Herr Samsa sagte: „Nun, jetzt können wir Gott danken." Er bekreuzigte sich, und die drei Frauen folgten seinem Beispiel.',
          'Grete wandte den Blick nicht von dem Leichnam ab. „Seht nur, wie mager er war. Er hat ja auch schon so lange nichts gegessen. So wie die Speisen hereinkamen, sind sie wieder hinausgekommen." Tatsächlich war Gregors Körper vollständig flach und trocken; man erkannte es eigentlich erst jetzt, da er nicht mehr von den Beinchen gehoben wurde und auch sonst kein Blick die Sicht ablenkte.',
        ],
      },
    ],
  },
];

// Share-Links + Kommentar-Spezifikation. anchor: [pageName, blockIndex, quote]
// (Quote nicht im Text → „Stelle geändert"). Ohne anchor = allgemeiner
// Kommentar. replies: [{ owner } | { reader }] in Reihenfolge.
const _SHARES = [
  { key: 'book', kind: 'book', intro: 'Erste komplette Fassung — bin gespannt auf euer Feedback!', views: 12 },
  { key: 'pageVerwandlung', kind: 'page', page: 'Die Verwandlung', intro: 'Nur der Anfang, reicht das als Einstieg?', views: 5 },
  { key: 'chapter2', kind: 'chapter', chapter: 'Kapitel 2', intro: null, views: 3 },
];

const _COMMENTS = [
  // Buch-Share: quer durchs Buch verankert + allgemein.
  {
    share: 'book', reader: 'Lektorin Anna', anchor: ['Die Verwandlung', 0, 'ungeheueren Ungeziefer'],
    body: 'Starkes Bild gleich im ersten Satz — das zieht sofort rein.',
    replies: [{ owner: true, body: 'Danke! Das Bild bleibt genau so.' }],
  },
  {
    share: 'book', reader: 'Tom B.', anchor: ['Familie', 0, 'Grete'], resolved: true,
    body: 'Heißt sie durchgehend „Grete"? Bitte konsequent halten.',
    replies: [{ owner: true, body: 'Geprüft, überall Grete. Erledigt.' }],
  },
  {
    share: 'book', reader: 'Lektorin Anna', anchor: ['Der Apfel', 0, 'Apfel um Apfel'],
    body: 'Die Wiederholung wirkt absichtlich und rhythmisch — gut.',
  },
  {
    // „Stelle geändert": Quote existiert nicht (mehr) im Block → Diff-Pfad.
    share: 'book', reader: 'Tom B.', anchor: ['Ende', 0, 'ein roter Apfel'],
    body: 'War hier nicht vorher vom Apfel die Rede? Wirkt jetzt verschoben.',
  },
  {
    share: 'book', reader: 'Lektorin Anna',
    body: 'Insgesamt ein sehr starker, geschlossener Text. Danke fürs Teilen!',
  },

  // Seiten-Share „Die Verwandlung": verankert (mit Reader-Folgekommentar) + allgemein.
  {
    share: 'pageVerwandlung', reader: 'Sara', anchor: ['Die Verwandlung', 1, 'Was ist mit mir geschehen'],
    body: 'Der innere Monolog hier ist großartig.',
    replies: [{ reader: 'Sara', body: 'Ergänzung: Vielleicht den Gedanken noch eine Spur kürzer?' }],
  },
  {
    share: 'pageVerwandlung', reader: 'Sara',
    body: 'Danke fürs Teilen — liest sich rund.',
  },

  // Kapitel-Share „Kapitel 2": verankert.
  {
    share: 'chapter2', reader: 'Tom B.', anchor: ['Drei Untermieter', 1, 'die Tochter spielt'],
    body: 'Schöner Moment — die Musik als Wendepunkt.',
  },
];

function _shouldSeed() {
  const devMode = String(process.env.LOCAL_DEV_MODE || '').toLowerCase() === 'true';
  if (!devMode) return { run: false, reason: 'LOCAL_DEV_MODE != true' };
  const seedOn = String(process.env.LOCAL_DEV_SEED || '').toLowerCase() !== 'false';
  if (!seedOn) return { run: false, reason: 'LOCAL_DEV_SEED = false' };
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM books').get();
  if (c > 0) return { run: false, reason: `books-Tabelle hat bereits ${c} Eintraege` };
  return { run: true, reason: null };
}

function _newBid() { return crypto.randomBytes(8).toString('hex'); }
function _shareToken() { return crypto.randomBytes(16).toString('base64url'); }
function _readerToken(name) { return crypto.createHash('sha256').update('reader:' + name).digest('base64url').slice(0, 22); }
function _ipHash(name) { return crypto.createHash('sha256').update('ip:' + name).digest('hex').slice(0, 16); }

function runDevSeedIfNeeded() {
  const decision = _shouldSeed();
  if (!decision.run) {
    if (decision.reason && String(process.env.LOCAL_DEV_MODE || '').toLowerCase() === 'true') {
      logger.info(`LOCAL_DEV_SEED uebersprungen: ${decision.reason}`);
    }
    return null;
  }

  // Owner-User muss als app_user existieren (FK-Ziel von share_links.owner_email
  // + share_comments.author_email). Der Request-Bootstrap legt ihn sonst erst
  // beim ersten Login an — der Seed laeuft aber davor beim Server-Start.
  if (!appUsers.getUser(DEV_OWNER)) {
    appUsers.createUser({ email: DEV_OWNER, displayName: 'Dev (lokal)', globalRole: 'admin', status: 'active' });
  }

  // Default-Kategorie-Pool nur anlegen, wenn er leer ist (idempotent).
  let seededCategories = 0;
  if (categories.list().length === 0) {
    _DEFAULT_CATEGORIES.forEach((name, position) => {
      categories.create({ name, position, createdBy: DEV_OWNER });
      seededCategories += 1;
    });
  }

  const now = new Date().toISOString();
  const bookId = db.prepare(`
    INSERT INTO books (name, slug, description, owner_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('Devmode-Testbuch', 'devmode-testbuch', 'Public-Domain-Prosa fuer Local-Dev-Smoke-Tests.', DEV_OWNER, now, now).lastInsertRowid;

  // page/chapter-Lookups fuer die Share-/Kommentar-Verknuepfung.
  const pageByName = new Map();    // name → { pageId, blocks: [{ bid, text }] }
  const chapterByName = new Map(); // name → chapterId

  let chapterPosition = 0;
  let pagePosition = 0;
  let pageCount = 0;
  for (const ch of _PROSE) {
    const chapterId = db.prepare(`
      INSERT INTO chapters (book_id, chapter_name, position, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(bookId, ch.chapter, chapterPosition, now).lastInsertRowid;
    chapterByName.set(ch.chapter, chapterId);
    chapterPosition += 1;

    for (const p of ch.pages) {
      const blocks = p.blocks.map((text) => ({ bid: _newBid(), text }));
      const html = blocks.map((b) => `<p data-bid="${b.bid}">${b.text}</p>`).join('');
      const pageId = db.prepare(`
        INSERT INTO pages (book_id, chapter_id, page_name, body_html, position, updated_at, local_updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(bookId, chapterId, p.name, html, pagePosition, now, now).lastInsertRowid;
      pageByName.set(p.name, { pageId, blocks });
      pagePosition += 1;
      pageCount += 1;
    }
  }

  const seeded = _seedSharesAndComments({ bookId, now, pageByName, chapterByName });

  logger.info(`LOCAL_DEV_SEED: Buch "Devmode-Testbuch" (id=${bookId}) mit ${_PROSE.length} Kapiteln + ${pageCount} Pages, ${seeded.links} Share-Links + ${seeded.comments} Kommentaren, ${seededCategories} Kategorien angelegt.`);
  return { bookId, chapters: _PROSE.length, pages: pageCount, categories: seededCategories, ...seeded };
}

function _seedSharesAndComments({ bookId, now, pageByName, chapterByName }) {
  const insertLink = db.prepare(`
    INSERT INTO share_links (token, kind, page_id, chapter_id, book_id, owner_email, intro, view_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertComment = db.prepare(`
    INSERT INTO share_comments
      (share_token, parent_id, reader_name, reader_token, author_email, body,
       anchor_bid, anchor_quote, anchor_start, anchor_end, resolved_at, ip_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Tokens pro Share-Key.
  const tokenByKey = new Map();
  for (const s of _SHARES) {
    const token = _shareToken();
    tokenByKey.set(s.key, token);
    const pageId = s.kind === 'page' ? (pageByName.get(s.page)?.pageId ?? null) : null;
    const chapterId = s.kind === 'chapter' ? (chapterByName.get(s.chapter) ?? null) : null;
    insertLink.run(token, s.kind, pageId, chapterId, bookId, DEV_OWNER, s.intro ?? null, s.views || 0, now);
  }

  // Anker [pageName, blockIndex, quote] → { bid, quote, start, end }. Quote nicht
  // im Block-Text → start/end null (rendert als „Stelle geändert").
  const resolveAnchor = ([pageName, blockIndex, quote]) => {
    const blk = pageByName.get(pageName)?.blocks?.[blockIndex];
    if (!blk) return null;
    const start = blk.text.indexOf(quote);
    if (start < 0) return { bid: blk.bid, quote, start: null, end: null };
    return { bid: blk.bid, quote, start, end: start + quote.length };
  };

  // Aelteste zuerst einfuegen (created_at staffeln), damit Threads chronologisch
  // wirken. Index 0 = aeltester.
  let count = 0;
  const total = _COMMENTS.reduce((n, c) => n + 1 + (c.replies?.length || 0), 0);
  let slot = total;
  const tsAt = (i) => new Date(Date.now() - (i + 1) * 47 * 60 * 1000).toISOString();

  for (const c of _COMMENTS) {
    const token = tokenByKey.get(c.share);
    if (!token) continue;
    const a = c.anchor ? resolveAnchor(c.anchor) : null;
    const createdAt = tsAt(--slot);
    const rootId = insertComment.run(
      token, null, c.reader, _readerToken(c.reader), null, c.body,
      a?.bid ?? null, a?.quote ?? null, a?.start ?? null, a?.end ?? null,
      c.resolved ? new Date(Date.now() - 30 * 60 * 1000).toISOString() : null,
      _ipHash(c.reader), createdAt,
    ).lastInsertRowid;
    count += 1;

    for (const r of (c.replies || [])) {
      const replyAt = tsAt(--slot);
      if (r.owner) {
        insertComment.run(token, rootId, null, null, DEV_OWNER, r.body, null, null, null, null, null, null, replyAt);
      } else {
        insertComment.run(token, rootId, r.reader, _readerToken(r.reader), null, r.body, null, null, null, null, null, _ipHash(r.reader), replyAt);
      }
      count += 1;
    }
  }

  return { links: _SHARES.length, comments: count };
}

module.exports = { runDevSeedIfNeeded, _shouldSeed };
