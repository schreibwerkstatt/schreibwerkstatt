const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');
const { matchFiguren } = require('../../lib/entity-match');
const { dedupRelations, relationKey, _cleanRefName, resolveErstePageId, enrichBelegWithIds, _arcToFlat } = require('./refs');
const { listFigureAliasesByFigure } = require('./aliases');
require('../migrations');

// Cross-Run-Matching (Bestand ↔ neue Analyse-Figuren) liegt in
// lib/entity-match.js#matchFiguren — dieselbe Verdikt-Schicht (gleich / unsicher /
// verschieden), die auch Orte und Szenen benutzen, inkl. Indizien-Score
// (figureEvidence) und Ambiguitaets-Guard. Hier bleibt nur die Adaption der
// DB-/Analyse-Formen auf die Match-Kandidaten-Form.
//
// `unsure`-Paare werden hier NICHT gemergt: eine DB-Schreibfunktion darf keinen
// KI-Call machen (harte Regel). Der Job beurteilt sie vorab und reicht das Ergebnis
// als `opts.matchHint` herein (siehe routes/jobs/komplett/entity-reconcile.js).

// Bestands-Row → Match-Kandidat. `chapters` kommt als Set von Kapitelnamen,
// `aliases` aus figure_aliases (vom Autor beim Zusammenfuehren bestaetigt).
function _figMatchCandidateFromRow(ex) {
  return {
    id: ex.id, name: ex.name, kurzname: ex.kurzname, beruf: ex.beruf,
    geburtstag: ex.geburtstag, geschlecht: ex.geschlecht, typ: ex.typ,
    chapters: ex.chapters, aliases: ex.aliases,
  };
}

// Neue Analyse-Figur → Match-Kandidat. Kapitel liegen als [{ name, haeufigkeit }] vor
// und brauchen dieselbe Namensreinigung wie beim Schreiben (Markdown-Header-Praefixe).
function _figMatchCandidateFromIncoming(f) {
  return {
    id: f.id, name: f.name, kurzname: f.kurzname, beruf: f.beruf,
    geburtstag: f.geburtstag, geschlecht: f.geschlecht, typ: f.typ,
    chapters: (f.kapitel || []).map(k => _cleanRefName(typeof k === 'object' && k ? k.name : k)).filter(Boolean),
  };
}

// Match-Planung Figuren (NUR LESEND) — SSoT fuer beide Seiten: `_reconcileFiguren`
// ruft sie selbst, und der Job ruft sie VOR dem Speichern, um die unsicheren Paare vom
// KI-Judge beurteilen zu lassen (eine DB-Schreibfunktion darf keinen KI-Call machen).
// `hint` = Map(fig_id → figures.id) der bestaetigten Paare.
function planFigurenMatch(bookId, figuren, userEmail, hint = null) {
  const em = userEmail || null;
  // Gematcht wird gegen den Namen, den die Analyse zuletzt geliefert hat (`ki_name`):
  // eine vom Autor umbenannte Figur heisst im Text weiter so. Ohne ki_name (im Katalog
  // angelegt) matcht sie ueber ihren eigenen Namen. Muster: locations-write.js.
  // Dieselbe Regel fuer die Widerspruchs-Indizien Geschlecht/Geburtsdatum: bei einer
  // gepflegten Figur (manually_edited) zaehlt der letzte Analysewert (`ki_*`), nicht
  // die Korrektur des Autors — sonst laese figureEvidence die Korrektur als
  // Widerspruch zur naechsten Analyse und die Figur kaeme als Dublette zurueck.
  // Unbekannter Analysewert (Altbestand vor Migration 321) = kein Indiz.
  const existingRows = db.prepare(`
    SELECT id, fig_id, COALESCE(ki_name, name) AS name, kurzname, beruf, typ,
           CASE WHEN manually_edited = 1 THEN ki_geburtstag ELSE geburtstag END AS geburtstag,
           CASE WHEN manually_edited = 1 THEN ki_geschlecht ELSE geschlecht END AS geschlecht
      FROM figures WHERE book_id = ? AND user_email IS ?`
  ).all(bookId, em);
  const aliasesByFig = listFigureAliasesByFigure(bookId, em);
  const chapRows = db.prepare(`
    SELECT fa.figure_id AS fid, c.chapter_name AS cname
    FROM figure_appearances fa
    JOIN figures f ON f.id = fa.figure_id
    JOIN chapters c ON c.chapter_id = fa.chapter_id
    WHERE f.book_id = ? AND f.user_email IS ?`).all(bookId, em);
  const chaptersByFig = new Map();
  for (const r of chapRows) {
    if (!chaptersByFig.has(r.fid)) chaptersByFig.set(r.fid, new Set());
    chaptersByFig.get(r.fid).add(r.cname);
  }
  for (const ex of existingRows) {
    ex.chapters = chaptersByFig.get(ex.id) || new Set();
    ex.aliases = aliasesByFig.get(ex.id) || [];
  }
  const plan = matchFiguren(
    existingRows.map(_figMatchCandidateFromRow),
    figuren.map(_figMatchCandidateFromIncoming),
    { hint },
  );
  return { ...plan, existing: existingRows };
}

// Pure-Compute der persistierbaren Figur-Felder (geteilt zwischen INSERT/UPDATE).
function _figFields(f, idMaps) {
  const zitate = Array.isArray(f.schluesselzitate) && f.schluesselzitate.length
    ? JSON.stringify(f.schluesselzitate.filter(Boolean).slice(0, 5))
    : null;
  // erste_erwaehnung ist Freitext (kann Kapitel- ODER Seitenname sein).
  // Auflösen: zuerst in den Kapiteln der Figur (figure_appearances) suchen,
  // dann globaler Unambiguous-Match. Kein Name → null.
  const ersteErwaehnung = _cleanRefName(f.erste_erwaehnung);
  // Vom Aufrufer mitgebrachte page_id (Katalog-PUT: GET→PUT-Round-Trip) bleibt
  // stehen, wenn der Name sich nicht aufloesen laesst — aber nur, wenn sie eine
  // Seite DIESES Buchs ist (idMaps.validPageIds).
  const givenPageId = Number.isInteger(f.erste_erwaehnung_page_id) && idMaps?.validPageIds?.has(f.erste_erwaehnung_page_id)
    ? f.erste_erwaehnung_page_id : null;
  const erstPageId = ersteErwaehnung
    ? (resolveErstePageId(ersteErwaehnung, f.kapitel, idMaps) ?? givenPageId)
    : null;
  const arcJson = (f.arc && typeof f.arc === 'object') ? JSON.stringify(f.arc)
    : (typeof f.arc === 'string' && f.arc ? f.arc : null);
  const entwicklungFlat = f.entwicklung || _arcToFlat(f.arc) || null;
  return { zitate, ersteErwaehnung, erstPageId, arcJson, entwicklungFlat };
}

// Vom Autor kuratierte Stammdaten. Bei `manually_edited = 1` gewinnt der Bestand gegen
// die Analyse (dazu die Eigenschaften/figure_tags); die Analyse liefert dann nur noch
// die abgeleiteten Felder: fig_id, erste_erwaehnung(+_page_id), schluesselzitate,
// sort_order, stale — und ausserhalb dieser Tabelle Kapitel-Auftritte, Szenen,
// Lebensereignisse (eigene manually_edited-Achse) und Statistik.
const CURATED_FIELDS = [
  'name', 'kurzname', 'typ', 'geburtstag', 'geschlecht', 'beruf', 'wohnadresse',
  'aeusseres', 'stimme', 'hintergrund', 'beschreibung', 'sozialschicht', 'praesenz',
  'rolle', 'motivation', 'konflikt', 'entwicklung', 'arc',
];

// Alle persistierbaren Spalten einer Figur als benannte Parameter.
function _figColumns(f, v, sortOrder) {
  return {
    fig_id: f.id, name: f.name, kurzname: f.kurzname || null, typ: f.typ || null,
    geburtstag: f.geburtstag || null, geschlecht: f.geschlecht || null, beruf: f.beruf || null,
    wohnadresse: f.wohnadresse || null, aeusseres: f.aeusseres || null, stimme: f.stimme || null,
    hintergrund: f.hintergrund || null, beschreibung: f.beschreibung || null,
    sozialschicht: f.sozialschicht || null, praesenz: f.praesenz || null, rolle: f.rolle || null,
    motivation: f.motivation || null, konflikt: f.konflikt || null,
    entwicklung: v.entwicklungFlat, arc: v.arcJson,
    erste_erwaehnung: v.ersteErwaehnung, erste_erwaehnung_page_id: v.erstPageId,
    schluesselzitate: v.zitate, sort_order: sortOrder,
  };
}

const _txt = (x) => (x == null || x === '' ? null : String(x));

// Entwicklungsbogen kanonisch (gleiche Lesart wie queries.js#_parseArc): GET liefert
// den geparsten Bogen, PUT schreibt ihn neu serialisiert — ein unveraenderter
// Round-Trip darf nicht als Autorenaenderung zaehlen.
function _normArc(raw) {
  if (raw == null || raw === '') return null;
  let a = raw;
  if (typeof raw === 'string') {
    try { a = JSON.parse(raw); } catch { a = { ende: raw }; }
  }
  if (!a || typeof a !== 'object') return null;
  const c = {
    typ: a.typ || '', anfang: a.anfang || '',
    wendepunkte: Array.isArray(a.wendepunkte) ? a.wendepunkte : [], ende: a.ende || '',
  };
  return (c.typ || c.anfang || c.ende || c.wendepunkte.length) ? JSON.stringify(c) : null;
}

// Hat der Katalog-PUT kuratierte Felder oder Eigenschaften einer Bestands-Figur
// geaendert? `f` ist die eingehende Figur (Round-Trip der GET-Form), `prev` die Zeile.
function _curatedChanged(prev, prevTags, f, cols) {
  for (const k of CURATED_FIELDS) {
    if (k === 'arc') { if (_normArc(prev.arc) !== _normArc(cols.arc)) return true; continue; }
    // entwicklung: roh vergleichen — cols.entwicklung leitet ein leeres Feld aus dem
    // Bogen ab, das waere ein Scheinunterschied.
    const next = k === 'entwicklung' ? f.entwicklung : cols[k];
    if (_txt(prev[k]) !== _txt(next)) return true;
  }
  const a = [...new Set(prevTags || [])].sort();
  const b = [...new Set((f.eigenschaften || []).filter(Boolean))].sort();
  return a.length !== b.length || a.some((t, i) => t !== b[i]);
}

// Schreibt die Tags einer Figur (Caller löscht vorab bei Re-Write).
// Kapitel-Vorkommen gehören NICHT hierher: `figure_appearances` ist ein abgeleiteter
// Index aus drei Quellen und wird von rebuildFigureAppearances geschrieben, sobald alle
// drei vorliegen (Begründung dort).
function _writeFigTags(insTag, fid, f) {
  for (const tag of (f.eigenschaften || [])) insTag.run(fid, tag);
}

// Sammelt die Beziehungen einer Figur als {from, to, typ, ...}-Liste (fig_id-basiert).
function _collectRelations(f, idMaps, out) {
  for (const bz of (f.beziehungen || [])) {
    const belegeArr = Array.isArray(bz.belege)
      ? bz.belege.filter(b => b && (b.kapitel || b.seite))
          .slice(0, 5)
          .map(b => enrichBelegWithIds(b, idMaps))
          .filter(b => b.kapitel || b.seite)
      : [];
    out.push({
      from: f.id, to: bz.figur_id, typ: bz.typ,
      beschreibung: bz.beschreibung || null,
      machtverhaltnis: bz.machtverhaltnis ?? null,
      belege: belegeArr.length ? JSON.stringify(belegeArr) : null,
    });
  }
}

/** Persistiert Figuren eines Buchs/Users. Gemeinsames Ziel aller Reconcile-Modi:
 *  `figures.id` über Schreibvorgänge stabil halten, damit FK-Referenzen
 *  (`plot_beat_figures`, `research_item_links`, manually_edited `figure_events` …)
 *  erhalten bleiben — ein DELETE+INSERT kaskadiert sie weg.
 *  Modi:
 *   - **Reconcile identity** (`{ reconcile: true }`; Komplettanalyse): matcht per
 *     Name/Indizien, weil die `fig_id` pro Analyse-Lauf frisch vergeben und NICHT
 *     identitätsstabil ist. Matched → `stale=0` (re-detektiert). Verschwundene →
 *     `stale=1` statt Löschen (`onMissing: 'stale'`). Vom Autor gepflegte Figuren
 *     (`manually_edited=1`) behalten ihre kuratierten Felder (CURATED_FIELDS) und
 *     Eigenschaften; Beziehungen mit `origin='manual'` bleiben stehen.
 *   - **Reconcile figId** (`{ reconcile: true, matchBy: 'figId', onMissing: 'delete' }`;
 *     Manual-Edit-CRUD `PUT /figures/:book_id`): matcht per exakter `fig_id` (round-trippt
 *     stabil durch GET→PUT), behaltene Figuren behalten `id` + ihren stale-Stand;
 *     im Katalog entfernte werden gelöscht (User autoritativ). Setzt die Schutz-
 *     Markierungen (`manually_edited`, Beziehungs-`origin`) aus dem Diff zum Bestand.
 *   - **Legacy Full-Replace** (Default, kein `reconcile`; Buch-Import): löscht alle
 *     Figuren + Beziehungen und legt sie neu an. Korrekt für frische Bücher, wo es
 *     nichts zu reconcilen gibt. */
function saveFigurenToDb(bookId, figuren, userEmail, idMaps, opts = {}) {
  const em = userEmail || null;
  if (opts.reconcile === true) {
    return _reconcileFiguren(bookId, figuren, em, idMaps, opts);
  }
  db.transaction(() => {
    if (userEmail) {
      db.prepare('DELETE FROM figures WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
      db.prepare('DELETE FROM figure_relations WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
    } else {
      db.prepare('DELETE FROM figures WHERE book_id = ? AND user_email IS NULL').run(bookId);
      db.prepare('DELETE FROM figure_relations WHERE book_id = ? AND user_email IS NULL').run(bookId);
    }

    const insFig = db.prepare(`
      INSERT INTO figures
        (book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, wohnadresse, aeusseres, stimme, hintergrund,
         beschreibung, sozialschicht, praesenz, rolle, motivation, konflikt, entwicklung, arc,
         erste_erwaehnung, erste_erwaehnung_page_id, schluesselzitate, sort_order, user_email, ki_name,
         ki_geschlecht, ki_geburtstag, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`);
    const insTag = db.prepare('INSERT OR IGNORE INTO figure_tags (figure_id, tag) VALUES (?, ?)');
    const insRel = db.prepare('INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, belege, user_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

    const validIds = new Set(figuren.map(f => f.id));
    const allRelations = [];
    const figIdToRowId = {}; // TEXT-fig_id → INTEGER figures.id (für FK auf figure_relations)

    for (let i = 0; i < figuren.length; i++) {
      const f = figuren[i];
      const v = _figFields(f, idMaps);
      const { lastInsertRowid: fid } = insFig.run(
        bookId, f.id, f.name, f.kurzname || null, f.typ || null,
        f.geburtstag || null, f.geschlecht || null, f.beruf || null,
        f.wohnadresse || null, f.aeusseres || null, f.stimme || null, f.hintergrund || null,
        f.beschreibung || null, f.sozialschicht || null,
        f.praesenz || null, f.rolle || null, f.motivation || null, f.konflikt || null,
        v.entwicklungFlat, v.arcJson, v.ersteErwaehnung, v.erstPageId, v.zitate,
        i, em, f.name, f.geschlecht || null, f.geburtstag || null
      );
      figIdToRowId[f.id] = fid;
      _writeFigTags(insTag, fid, f);
      _collectRelations(f, idMaps, allRelations);
    }
    for (const r of dedupRelations(allRelations, validIds)) {
      const fromId = figIdToRowId[r.from];
      const toId   = figIdToRowId[r.to];
      if (fromId == null || toId == null) continue;
      insRel.run(bookId, fromId, toId, r.typ, r.beschreibung, r.machtverhaltnis, r.belege, em);
    }
  })();
}

// fig_id-basiertes Matching (Manual-Edit-CRUD): die `fig_id` round-trippt stabil
// durch GET→PUT, ist hier also die autoritative Identität. Greedy, jede Bestands-
// Figur höchstens einmal. Gibt Map(incomingIndex → existingId) zurück.
function _matchFigurenByFigId(existingRows, incoming) {
  const byFigId = new Map(existingRows.map(ex => [ex.fig_id, ex.id]));
  const matchOf = new Map();
  const used = new Set();
  for (let i = 0; i < incoming.length; i++) {
    const exId = byFigId.get(incoming[i].id);
    if (exId != null && !used.has(exId)) { matchOf.set(i, exId); used.add(exId); }
  }
  return matchOf;
}

// Reconcile-Pfad: siehe saveFigurenToDb-Doku.
//   matchBy 'identity' (Default, Komplettanalyse): Name/Indizien-Match; matched →
//     stale=0 (re-detektiert = aktiv); fig_id wird auf den frischen Lauf-Wert gesetzt.
//     Bei manually_edited=1 bleiben die kuratierten Felder + Eigenschaften stehen.
//     Beziehungen: nur origin='ki' wird neu aufgebaut, 'manual' bleibt.
//   matchBy 'figId' (Manual-Edit): exakter fig_id-Match; matched behält seinen
//     stale-Stand (User kuratiert, kein Re-Detektions-Signal). Geänderte oder neu
//     angelegte Figuren → manually_edited=1; neue/geänderte Beziehungen → 'manual'.
function _reconcileFiguren(bookId, figuren, em, idMaps, opts) {
  const onMissing = opts.onMissing === 'stale' ? 'stale' : 'delete';
  const matchBy = opts.matchBy === 'figId' ? 'figId' : 'identity';
  const manual = matchBy === 'figId';
  return db.transaction(() => {
    // 1./2. Bestand + Match: auch stale-Figuren sind Match-Kandidaten — eine
    //    wiederaufgetauchte Figur soll revived werden. Der identity-Pfad geht durch
    //    planFigurenMatch (dieselbe Funktion, die der Job vor dem Judge ruft).
    let existingRows;
    let matchOf;
    if (manual) {
      existingRows = db.prepare(
        'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
      ).all(bookId, em);
      matchOf = _matchFigurenByFigId(existingRows, figuren);
    } else {
      const plan = planFigurenMatch(bookId, figuren, em, opts.matchHint || null);
      existingRows = plan.existing;
      matchOf = plan.matchOf;
    }
    const matchedExisting = new Set([...matchOf.values()]);
    // Volle Bestandszeilen (kuratierte Felder + manually_edited) und Eigenschaften.
    const prevById = new Map(db.prepare(
      'SELECT * FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, em).map(r => [r.id, r]));
    const prevTags = new Map();
    for (const t of db.prepare(`
      SELECT ft.figure_id, ft.tag FROM figure_tags ft JOIN figures f ON f.id = ft.figure_id
      WHERE f.book_id = ? AND f.user_email IS ?`).all(bookId, em)) {
      if (!prevTags.has(t.figure_id)) prevTags.set(t.figure_id, []);
      prevTags.get(t.figure_id).push(t.tag);
    }

    // 3. Verschwundene (nicht wiedergefundene) Bestands-Figuren behandeln.
    const missing = existingRows.filter(ex => !matchedExisting.has(ex.id));
    if (onMissing === 'stale') {
      // Markieren + fig_id aus dem 'fig_N'-Namespace ziehen (kollisionsfrei mit
      // den frisch vergebenen Lauf-IDs). 'orphan_<id>' ist stabil & eindeutig.
      const markStale = db.prepare("UPDATE figures SET stale = 1, fig_id = 'orphan_' || id WHERE id = ?");
      for (const ex of missing) markStale.run(ex.id);
    } else {
      const delFig = db.prepare('DELETE FROM figures WHERE id = ?');
      for (const ex of missing) delFig.run(ex.id);
    }

    // 4. Matched-Figuren transient auf 'tmp_<id>' umbenennen, damit das finale
    //    Umnummerieren auf die Lauf-fig_ids nicht in UNIQUE(book_id,fig_id,user_email)
    //    läuft (zwei Figuren tauschen ihre fig_ids).
    const tmpRename = db.prepare("UPDATE figures SET fig_id = 'tmp_' || id WHERE id = ?");
    for (const exId of matchedExisting) tmpRename.run(exId);

    // 5. Bestand der Beziehungen NACH dem Löschen verschwundener Figuren (CASCADE)
    //    festhalten; geschrieben wird in Schritt 7.
    const prevRels = db.prepare(
      'SELECT from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, origin FROM figure_relations WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, em);

    const _cols = `fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, wohnadresse, aeusseres,
        stimme, hintergrund, beschreibung, sozialschicht, praesenz, rolle, motivation, konflikt,
        entwicklung, arc, erste_erwaehnung, erste_erwaehnung_page_id, schluesselzitate, sort_order`.split(',').map(c => c.trim());
    const insFig = db.prepare(`
      INSERT INTO figures (${_cols.join(', ')}, book_id, user_email, manually_edited, ki_name,
        ki_geschlecht, ki_geburtstag, stale, updated_at)
      VALUES (${_cols.map(c => '@' + c).join(', ')}, @book_id, @user_email, @manually_edited, @ki_name,
        @ki_geschlecht, @ki_geburtstag, 0, ${NOW_ISO_SQL})`);
    // identity-Match setzt stale=0 (re-detektiert) und den ki_name/ki_geschlecht/
    // ki_geburtstag des Laufs; figId-Match lässt stale und die ki_*-Werte unangetastet
    // (User kuratiert; eine orphan-Figur bleibt orphan, der letzte Analysewert bleibt
    // der Vergleichsmassstab für den nächsten Lauf).
    const updFig = db.prepare(`
      UPDATE figures SET ${_cols.map(c => `${c} = @${c}`).join(', ')},
        manually_edited = @manually_edited, ki_name = COALESCE(@ki_name, ki_name),
        ${manual ? '' : 'ki_geschlecht = @ki_geschlecht, ki_geburtstag = @ki_geburtstag, stale = 0, '}updated_at = ${NOW_ISO_SQL}
      WHERE id = @id`);
    const delTag = db.prepare('DELETE FROM figure_tags WHERE figure_id = ?');
    const insTag = db.prepare('INSERT OR IGNORE INTO figure_tags (figure_id, tag) VALUES (?, ?)');

    const validIds = new Set(figuren.map(f => f.id));
    const allRelations = [];
    const figIdToRowId = {};

    // 6. Figuren schreiben.
    for (let i = 0; i < figuren.length; i++) {
      const f = figuren[i];
      const cols = _figColumns(f, _figFields(f, idMaps), i);
      const existingId = matchOf.get(i);
      let fid;
      let writeTags = true;
      if (existingId != null) {
        const prev = prevById.get(existingId);
        let edited = prev.manually_edited ? 1 : 0;
        if (manual) {
          if (!edited && _curatedChanged(prev, prevTags.get(existingId), f, cols)) edited = 1;
        } else if (edited) {
          // Autor-Stammdaten gewinnen gegen die Analyse.
          for (const k of CURATED_FIELDS) cols[k] = prev[k];
          writeTags = false;
        }
        updFig.run({
          ...cols, manually_edited: edited, ki_name: manual ? null : f.name, id: existingId,
          ...(manual ? {} : { ki_geschlecht: f.geschlecht || null, ki_geburtstag: f.geburtstag || null }),
        });
        fid = existingId;
        // Analyse-Kinder neu schreiben (CASCADE-Kinder ohne externe Refs). Die Kapitel-
        // Vorkommen bleiben hier unangetastet — sie sind ein abgeleiteter Index, den
        // rebuildFigureAppearances am Ende des Laufs komplett neu baut.
        if (writeTags) delTag.run(fid);
      } else {
        fid = insFig.run({
          ...cols, book_id: bookId, user_email: em,
          // Im Katalog angelegt = vom Autor kuratiert; kein Analyse-Name.
          manually_edited: manual ? 1 : 0, ki_name: manual ? null : f.name,
          ki_geschlecht: manual ? null : (f.geschlecht || null),
          ki_geburtstag: manual ? null : (f.geburtstag || null),
        }).lastInsertRowid;
      }
      figIdToRowId[f.id] = fid;
      if (writeTags) _writeFigTags(insTag, fid, f);
      _collectRelations(f, idMaps, allRelations);
    }

    // 7. Beziehungen. `keepKiRelations` (Teil-Lauf ohne «Beziehungen»): die bestehenden
    //    KI-Kanten bleiben stehen — darunter die kapitelübergreifenden aus P3b, die dieser
    //    Lauf nicht neu berechnet —, neue kommen hinzu, Doppeltes fällt am UNIQUE weg.
    _writeRelations(bookId, em, manual, prevRels, figIdToRowId, allRelations, validIds, { keepKi: opts.keepKiRelations === true });
    // Lauf-fig_id → figures.id: der Job haengt damit die Aliasse der gematchten
    // Bestandsfiguren an die Namens-Aufloesung der Szenen/Ereignisse.
    return { rowIdByFigId: figIdToRowId };
  })();
}

const _relSame = (a, b) => _txt(a.beschreibung) === _txt(b.beschreibung)
  && (a.machtverhaltnis ?? null) == (b.machtverhaltnis ?? null);

// Beziehungen eines Reconcile-Laufs schreiben.
//   Analyse (manual=false): nur origin='ki' wird neu aufgebaut; vom Autor angelegte
//     Beziehungen ('manual') bleiben stehen, und eine KI-Beziehung, die eine manuelle
//     auf demselben Paar mit demselben (bzw. inversen) Typ doppelt, entfällt.
//   Katalog-PUT (manual=true): der Body ist autoritativ (Full-Replace). Eine
//     unveränderte KI-Beziehung behält origin='ki'; neue oder in Beschreibung/
//     Machtverhältnis geänderte werden 'manual', eine schon manuelle bleibt es.
function _writeRelations(bookId, em, manual, prevRels, figIdToRowId, allRelations, validIds, { keepKi = false } = {}) {
  const insRel = db.prepare(
    `INSERT ${keepKi ? 'OR IGNORE ' : ''}INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, belege, user_email, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const rows = [];
  for (const r of dedupRelations(allRelations, validIds, { byTyp: manual })) {
    const fromId = figIdToRowId[r.from];
    const toId   = figIdToRowId[r.to];
    if (fromId == null || toId == null) continue;
    rows.push({ ...r, fromId, toId });
  }
  if (manual) {
    db.prepare('DELETE FROM figure_relations WHERE book_id = ? AND user_email IS ?').run(bookId, em);
    const prevByKey = new Map(prevRels.map(p => [`${p.from_fig_id}|${p.to_fig_id}|${p.typ}`, p]));
    for (const r of rows) {
      const prev = prevByKey.get(`${r.fromId}|${r.toId}|${r.typ}`);
      const origin = prev && prev.origin === 'ki' && _relSame(prev, r) ? 'ki' : 'manual';
      insRel.run(bookId, r.fromId, r.toId, r.typ, r.beschreibung, r.machtverhaltnis, r.belege, em, origin);
    }
    return;
  }
  if (!keepKi) db.prepare("DELETE FROM figure_relations WHERE book_id = ? AND user_email IS ? AND origin = 'ki'").run(bookId, em);
  const manualKeys = new Set(prevRels.filter(p => p.origin === 'manual')
    .map(p => relationKey(p.from_fig_id, p.to_fig_id, p.typ)));
  for (const r of rows) {
    if (manualKeys.has(relationKey(r.fromId, r.toId, r.typ))) continue;
    insRel.run(bookId, r.fromId, r.toId, r.typ, r.beschreibung, r.machtverhaltnis, r.belege, em, 'ki');
  }
}

module.exports = { planFigurenMatch, saveFigurenToDb };
