'use strict';
// Embedding-Index-Job (semantische Suche): embeddet Seiten, Szenen, Figuren und
// Recherche-Schnipsel eines Buches und legt die Vektoren in semantic_chunks ab
// (research: Titel + Inhalt + der extrahierte PDF-Volltext eines hochgeladenen
// Dokuments — damit ist eine lange PDF nicht nur über exakte Wörter auffindbar,
// sondern passagenweise über Bedeutung). Rein rückwärts-
// gewandt — liest bestehende Inhalte, schreibt NIE in den Buchtext. Kein KI-
// Prompt: der Embedding-Endpunkt (embed.*, self-hosted) liefert reine Vektoren.
//
// Delta-Cache: pro Chunk ein content_hash; ein Chunk, dessen Hash die Entität
// schon unter irgendeinem chunk_ix hatte, behält seinen Vektor (kein erneuter
// Embedding-Call — auch wenn eine Einfügung vorne die Nummerierung verschiebt).
// Entitäten ohne jede Änderung werden gar nicht geschrieben. model steht im
// Chunk-Key — ein Modellwechsel führt beim nächsten Lauf zu vollständigem
// Neu-Embedden; die Chunks des alten Modells räumt das Ende eines vollständigen
// Laufs (clearForeignModels).
//
// Jeder Lauf ist ein System-Job (userEmail null): die Doppelstart-Sperre gilt
// damit pro Buch, egal wer ihn auslöst (Karte, Cron, Upload, Speichern). Zwei
// parallele Läufe am selben Buch würden sich gegenseitig Chunks wegräumen.
// Wer einen Lauf anfordert, während einer läuft, bekommt einen Folgelauf: der
// laufende hat seine Entitäten schon gesammelt und sieht die neue Änderung nicht.
//
// Frische: jede Buch-Änderung über die Content-Store-Facade (Seite gespeichert,
// angelegt, gelöscht, verschoben) stösst nach embed.autoindex_delay_s Ruhe einen
// Lauf an (scheduleAutoIndex). Der Delta-Cache hält ihn billig.

const express = require('express');
const { db } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
  loadOrderedBookContents, htmlToTextForPrompt, BATCH_SIZE, jobs,
} = require('./shared');
const embed = require('../../lib/embed');
const { chunkText, contentHash } = require('../../lib/embed-chunk');
const semanticChunks = require('../../db/semantic-chunks');
const contentStore = require('../../lib/content-store');
const appSettings = require('../../lib/app-settings');
const { bus: bookBus } = require('../../lib/book-events');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const logger = require('../../logger');

const embedIndexRouter = express.Router();

// Kinds, die indexiert werden. text() extrahiert den einbett­baren Rohtext je
// Entität; leerer Text → Entität wird übersprungen (und via pruneMissing später
// entfernt, falls sie mal Chunks hatte).
const KINDS = ['page', 'scene', 'figure', 'research', 'location', 'fact'];

function _sceneText(r) {
  return [r.titel, r.kommentar].map(s => String(s || '').trim()).filter(Boolean).join('. ');
}
function _figureText(r) {
  return [r.name, r.beschreibung].map(s => String(s || '').trim()).filter(Boolean).join('. ');
}
// Recherche-Schnipsel: Titel + Inhalt + PDF-Volltext am Stück. chunkText schneidet
// daraus die Passagen — bei einem Dokument-Eintrag ist doc_text der weitaus
// grösste Anteil und damit das eigentliche Indexgut. Archivierte Einträge werden
// bewusst mitindexiert (der FTS5-Index tut es auch; sonst driftet die
// Hybrid-Fusion, die beide Ranglisten zusammenführt).
function _researchText(r) {
  return [r.title, r.body, r.doc_text].map(s => String(s || '').trim()).filter(Boolean).join('\n\n');
}
function _locationText(r) {
  return [r.name, r.typ, r.beschreibung, r.stimmung].map(s => String(s || '').trim()).filter(Boolean).join('. ');
}
function _factText(r) {
  const head = [r.kategorie, r.subjekt].map(s => String(s || '').trim()).filter(Boolean).join(' – ');
  return [head, String(r.fakt || '').trim()].filter(Boolean).join(': ');
}

// Alle indexierbaren Entitäten eines Buches laden → { page:[{id,text}], ... }.
// Seiten absatzerhaltend (htmlToTextForPrompt): der Chunker schneidet bevorzugt
// an Absatzgrenzen. Gespeichert wird der Chunk trotzdem einzeilig — die Absätze
// steuern nur, WO geschnitten wird.
async function _collectEntities(bookId, signal) {
  const { pages } = await loadOrderedBookContents(bookId);
  const loaded = await contentStore.loadPagesBatch(pages, null, {
    batchSize: BATCH_SIZE,
    signal,
    onError: (_p, e) => {
      if (e.status) throw i18nError('job.error.contentStore', { status: e.status, text: e.bodyText });
      throw e;
    },
  });
  const pageItems = loaded
    .map(pd => ({ id: pd.id, text: htmlToTextForPrompt(pd.html || '') }))
    .filter(x => x.text);

  const sceneRows = db.prepare('SELECT id, titel, kommentar FROM figure_scenes WHERE book_id = ?').all(bookId);
  const sceneItems = sceneRows.map(r => ({ id: r.id, text: _sceneText(r) })).filter(x => x.text);

  // Stale-Figuren/-Schauplätze (von der Analyse nicht mehr im Text gefunden) bleiben
  // draussen — sie sind kein Wissen über das Buch mehr; pruneMissing räumt ihre
  // alten Chunks.
  const figRows = db.prepare('SELECT id, name, beschreibung FROM figures WHERE book_id = ? AND stale = 0').all(bookId);
  const figItems = figRows.map(r => ({ id: r.id, text: _figureText(r) })).filter(x => x.text);

  const resRows = db.prepare('SELECT id, title, body, doc_text FROM research_items WHERE book_id = ?').all(bookId);
  const resItems = resRows.map(r => ({ id: r.id, text: _researchText(r) })).filter(x => x.text);

  const locRows = db.prepare('SELECT id, name, typ, beschreibung, stimmung FROM locations WHERE book_id = ? AND stale = 0').all(bookId);
  const locItems = locRows.map(r => ({ id: r.id, text: _locationText(r) })).filter(x => x.text);

  const factRows = db.prepare('SELECT id, kategorie, subjekt, fakt FROM world_facts WHERE book_id = ?').all(bookId);
  const factItems = factRows.map(r => ({ id: r.id, text: _factText(r) })).filter(x => x.text);

  return { page: pageItems, scene: sceneItems, figure: figItems, research: resItems, location: locItems, fact: factItems };
}

async function runEmbedIndexJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    if (!embed.isEnabled()) throw i18nError('job.error.embedDisabled');
    const { model, dim, passagePrefix } = embed.getConfig();
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    updateJob(jobId, { statusText: 'job.phase.embedCollect', progress: 5 });
    const entities = await _collectEntities(bookId, signal());

    // Pro Entität die Soll-Chunks bestimmen und gegen den Delta-Cache abgleichen.
    // pending[]: { kind, id, ix, text, hash } — die neu zu embettenden Chunks.
    // reuseRows: Map `${kind}:${id}` → [{chunk_ix, content_hash, vector, text}]
    // (bereits fertige Zeilen, aus Cache übernommen). Nach dem Embedden werden
    // pending in dieselbe Map einsortiert und die Entität am Stück ersetzt.
    const rowsByEntity = new Map();
    const pending = [];
    const presentIds = Object.fromEntries(KINDS.map(k => [k, []]));
    let totalChunks = 0;
    let unchanged = 0;

    for (const kind of KINDS) {
      for (const ent of entities[kind]) {
        presentIds[kind].push(ent.id);
        const chunks = chunkText(ent.text);
        if (!chunks.length) continue;
        const key = `${kind}:${ent.id}`;
        const existing = semanticChunks.getEntityChunks(kind, ent.id, model);
        // Delta-Cache über den Hash statt über die Position: verschiebt eine
        // Einfügung vorne die Chunk-Grenzen, behalten die unveränderten Chunks
        // dahinter trotzdem ihren Vektor.
        const byHash = new Map();
        for (const prev of existing.values()) {
          if (prev.vector.length === dim) byHash.set(prev.content_hash, prev.vector);
        }
        const rows = [];
        let samePlace = existing.size === chunks.length;
        chunks.forEach((text, ix) => {
          totalChunks++;
          // Was tatsächlich embeddet wird (inkl. passage_prefix für asymmetrische
          // Modelle). Der Hash deckt den Präfix ab → Präfixwechsel invalidiert den
          // Delta-Cache und erzwingt Reindex. Der gespeicherte text bleibt roh
          // (Snippet-Quelle).
          const embedInput = passagePrefix ? passagePrefix + text : text;
          const hash = contentHash(embedInput);
          const vec = byHash.get(hash);
          if (existing.get(ix)?.content_hash !== hash) samePlace = false;
          if (vec) {
            rows.push({ chunk_ix: ix, content_hash: hash, vector: vec, text });
          } else {
            samePlace = false;
            pending.push({ kind, id: ent.id, ix, text, embedInput, hash });
          }
        });
        // Nichts geändert → kein Schreiben. Sonst schriebe jeder Lauf alle BLOBs
        // des Buchs neu und verwürfe dabei den Vektor-Cache jedes Buchs.
        if (samePlace) { unchanged++; continue; }
        rowsByEntity.set(key, rows);
      }
    }

    logger.info(`Index ${bookId}: ${totalChunks} Chunks, davon ${pending.length} neu (${totalChunks - pending.length} aus Cache), ${unchanged} Einträge unverändert.`);
    updateJob(jobId, { statusText: 'job.phase.embedding', statusParams: { done: 0, total: pending.length }, progress: 15 });

    // Offene Chunk-Zahl pro Entität → eine Entität wird persistiert, sobald ihr
    // letzter pending-Chunk embeddet ist. So überlebt ein Backend-Tod mitten im
    // Lauf: bereits fertige Entitäten sind in der DB, der Delta-Cache übernimmt
    // sie beim nächsten Lauf (nur der Rest wird neu embeddet).
    const pendingByEntity = new Map();
    for (const p of pending) {
      const k = `${p.kind}:${p.id}`;
      pendingByEntity.set(k, (pendingByEntity.get(k) || 0) + 1);
    }
    let vanished = 0;
    const persistEntity = (key) => {
      const rows = rowsByEntity.get(key);
      const [kind, idStr] = key.split(':');
      rowsByEntity.delete(key);
      // Seit dem Sammeln gelöscht (Szene gemergt, Seite gelöscht …): der FK wiese
      // das INSERT ab und risse den ganzen Lauf mit — überspringen, die CASCADE
      // hat die alten Chunks schon geräumt.
      if (!semanticChunks.entityExists(kind, Number(idStr))) { vanished++; return; }
      rows.sort((a, b) => a.chunk_ix - b.chunk_ix);
      semanticChunks.replaceEntity(kind, Number(idStr), bookId, model, dim, rows);
    };

    // Neue Chunks in Batches embetten (embedBatch chunkt intern auf MAX_BATCH).
    const BATCH = 64;
    for (let i = 0; i < pending.length; i += BATCH) {
      throwIfAborted();
      const slice = pending.slice(i, i + BATCH);
      const vecs = await embed.embedBatch(slice.map(p => p.embedInput), { signal: signal() });
      // embed.dim muss zum Modell passen: ein falsch eingestellter Wert liesse
      // jeden Vektor am Delta-Cache scheitern (jede Nacht ein Voll-Embedding)
      // und an der Abfrage als -Infinity ranken.
      const bad = vecs.find(v => !v || v.length !== dim);
      if (bad) throw i18nError('job.error.embedDimMismatch', { expected: dim, actual: bad?.length ?? 0 });
      const touched = new Set();
      slice.forEach((p, j) => {
        const k = `${p.kind}:${p.id}`;
        rowsByEntity.get(k).push({ chunk_ix: p.ix, content_hash: p.hash, vector: vecs[j], text: p.text });
        pendingByEntity.set(k, pendingByEntity.get(k) - 1);
        touched.add(k);
      });
      for (const k of touched) {
        if (pendingByEntity.get(k) === 0) { persistEntity(k); pendingByEntity.delete(k); }
      }
      const done = Math.min(i + BATCH, pending.length);
      updateJob(jobId, {
        statusText: 'job.phase.embedding', statusParams: { done, total: pending.length },
        progress: 15 + Math.round((done / Math.max(pending.length, 1)) * 75),
      });
    }

    // Verbleibende Entitäten (nur aus Cache-Chunks, kein pending) atomar schreiben,
    // dann Orphans räumen.
    for (const key of [...rowsByEntity.keys()]) persistEntity(key);
    let pruned = 0;
    for (const kind of KINDS) pruned += semanticChunks.pruneMissing(bookId, model, kind, presentIds[kind]);
    // Erst jetzt gilt der Index als vollständig — Konsumenten, die „kein Treffer"
    // als „kommt nicht vor" werten, verlassen sich darauf (isIndexed).
    semanticChunks.markIndexed(bookId, model);
    const dropped = semanticChunks.clearForeignModels(bookId, model);
    if (dropped) logger.info(`Fremdmodell-Chunks entfernt: ${dropped} (aktives Modell ${model}).`);
    if (vanished) logger.info(`${vanished} Einträge während des Laufs gelöscht, übersprungen.`);

    updateJob(jobId, { progress: 98 });
    const stats = semanticChunks.bookStats(bookId, model);
    completeJob(jobId, {
      model, dim, totalChunks: stats.total, embedded: pending.length,
      reused: totalChunks - pending.length, pruned, droppedForeignModel: dropped, byKind: stats.byKind,
    }, null, `${stats.total} Chunks (${pending.length} neu, ${totalChunks - pending.length} aus Cache${pruned ? `, ${pruned} verwaist entfernt` : ''})`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Embedding-Index Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  } finally {
    _afterRun(bookId);
  }
}

// Folgeläufe: Buch-IDs, für die während eines laufenden Index-Laufs ein weiterer
// angefordert wurde. Der laufende sieht die neue Änderung nicht mehr (er hat seine
// Entitäten am Anfang gesammelt) — darum startet nach seinem Ende genau ein
// weiterer. Mehrfach-Anforderungen verschmelzen zu diesem einen.
const _rerunRequested = new Set();
// Warter auf das Ende des (Folge-)Laufs eines Buchs, siehe whenIndexIdle.
const _idleWaiters = new Map(); // bookId → [resolve]

function _afterRun(bookId) {
  if (_rerunRequested.delete(bookId)) { _enqueue(bookId); return; }
  const waiters = _idleWaiters.get(bookId);
  if (waiters) { _idleWaiters.delete(bookId); for (const r of waiters) r(); }
}

function _enqueue(bookId) {
  const jobId = createJob('embed-index', bookId, null, 'job.label.embedIndex', null, bookId);
  enqueueJob(jobId, () => runEmbedIndexJob(jobId, bookId, null));
  return jobId;
}

// Promise, die auflöst, sobald für das Buch kein Index-Lauf mehr aussteht (auch
// kein Folgelauf). Für den Nacht-Cron: die Anker-/Scan-Läufe eines Buchs dürfen
// erst den fertigen Index lesen. Deckel maxWaitMs: ein in der Warteschlange
// abgebrochener Lauf erreicht _afterRun nie — der Warter soll dann nicht ewig
// hängen (der Konsument prüft danach ohnehin isIndexed).
function whenIndexIdle(bookId, { maxWaitMs = 3 * 60 * 60 * 1000 } = {}) {
  if (!findActiveJobId('embed-index', bookId, null)) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, maxWaitMs);
    t.unref?.();
    const list = _idleWaiters.get(bookId) || [];
    list.push(() => { clearTimeout(t); resolve(); });
    _idleWaiters.set(bookId, list);
  });
}

// Index-Lauf für ein Buch anfordern (Recherche-Upload, Komplett-Ende, Auto-Index
// nach dem Speichern, Karte). Läuft schon einer, wird ein Folgelauf vorgemerkt und
// die Id des laufenden zurückgegeben — der Aufrufer kann sie genauso pollen. Der
// Delta-Cache macht den Ein-Dokument-Fall so billig wie einen Einzel-Index.
// userEmail wird nicht mehr gebraucht (System-Job), bleibt aber als Parameter,
// damit die Aufrufer unverändert bleiben.
function enqueueEmbedIndexJob(bookId, userEmail = null) {
  if (!embed.isEnabled()) return null;
  const existing = findActiveJobId('embed-index', bookId, null);
  if (existing) {
    const job = jobs.get(existing);
    if (job?.status === 'running') _rerunRequested.add(bookId);
    return existing;
  }
  return _enqueue(bookId);
}

// Auto-Index nach Buch-Änderungen: entprellt pro Buch. Erst nach
// embed.autoindex_delay_s Sekunden ohne weitere Änderung startet ein Lauf — beim
// Tippen speichert der Editor laufend, ein Lauf pro Speichern wäre Verschwendung.
// 0 schaltet den Auto-Index ab (dann bleibt der Nacht-Cron).
const _autoTimers = new Map(); // bookId → Timeout
function scheduleAutoIndex(bookId) {
  if (!bookId || !embed.isEnabled()) return;
  const delay = Number(appSettings.get('embed.autoindex_delay_s'));
  if (!(delay > 0)) return;
  clearTimeout(_autoTimers.get(bookId));
  const t = setTimeout(() => {
    _autoTimers.delete(bookId);
    try { enqueueEmbedIndexJob(bookId); }
    catch (e) { logger.warn(`Auto-Index Buch ${bookId} fehlgeschlagen: ${e.message}`); }
  }, delay * 1000);
  t.unref?.();
  _autoTimers.set(bookId, t);
}
bookBus.on('change', (bookId) => scheduleAutoIndex(bookId));

// Nacht-Cron: hält die Embedding-Indizes aller Bücher frisch. Reiht pro Buch
// einen embed-index-Job ein (Dedup gegen laufende Jobs). Der Delta-Cache im Job
// embeddet nur seit gestern geänderte Chunks neu — bereits indizierte Bücher
// sind dadurch billig, nie-indizierte bekommen ihren Erst-Index. Rückgabe enthält
// die Buch-IDs, damit der Cron auf jeden einzelnen Lauf warten kann.
async function reindexAllBooks() {
  if (!embed.isEnabled()) return { enqueued: 0, skipped: 0, disabled: true, bookIds: [] };
  const books = await contentStore.listBooks(null);
  let enqueued = 0, skipped = 0;
  const bookIds = [];
  for (const { id: bookId } of books) {
    bookIds.push(bookId);
    if (findActiveJobId('embed-index', bookId, null)) { skipped++; continue; }
    _enqueue(bookId);
    enqueued++;
  }
  logger.info(`Embedding-Reindex (Cron): ${enqueued} Buch/Bücher eingereiht, ${skipped} übersprungen (Job läuft bereits).`);
  return { enqueued, skipped, bookIds };
}

embedIndexRouter.post('/embed-index', jsonBody, (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'lektor')) return;
  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });
  logger.info(`Index-Lauf angefordert von ${sessionEmail(req)} (Buch ${bookId}).`);
  const existing = findActiveJobId('embed-index', bookId, null);
  const jobId = enqueueEmbedIndexJob(bookId);
  res.json(existing ? { jobId, existing: true } : { jobId });
});

module.exports = {
  embedIndexRouter, runEmbedIndexJob, reindexAllBooks, enqueueEmbedIndexJob,
  scheduleAutoIndex, whenIndexIdle,
};
