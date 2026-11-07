'use strict';
// Manuskriptseiten, die einem Recherche-Fundstueck inhaltlich am naechsten
// stehen (Embeddings). Geteilt von den Seiten-Vorschlaegen des Verknuepfungs-
// Jobs (routes/jobs/research-link.js) und dem Recherche-Abgleich
// (routes/jobs/research-crosscheck.js), damit beide dieselbe Auswahl treffen.
//
// Zuerst ueber den Vektor des Fundstuecks selbst; ist es noch nicht indexiert
// (frisch angelegt), ersatzweise eine Freitext-Anfrage aus Titel, Text und
// PDF-Anfang. Ohne Embedding-Endpunkt: leer.

const embed = require('./embed');
const semanticRetrieval = require('./semantic-retrieval');

const QUERY_MAX = 2000;
// Anfang des PDF-Texts in der Ersatz-Anfrage. Exportiert: Aufrufer laden nur so
// viel doc_text (db/research-jobs.js#crosscheckCandidates).
const DOC_QUERY_CHARS = 1500;

/** @returns {Promise<Array<{kind:'page', entity_id:number, text:string, score:number}>>} */
async function researchPageHits(bookId, item, { topK = 6, signal } = {}) {
  if (!embed.isEnabled()) return [];
  const res = await semanticRetrieval.similarToEntity(bookId, 'research', item.id, { kinds: ['page'], topK, signal });
  if (!res.notIndexed) return (res.hits || []).filter(h => h.kind === 'page');
  const q = [item.title, item.body, String(item.doc_text || '').slice(0, DOC_QUERY_CHARS)]
    .filter(Boolean).join('\n').slice(0, QUERY_MAX);
  if (!q.trim()) return [];
  const hits = await semanticRetrieval.semanticQuery(bookId, q, { kinds: ['page'], topK, signal });
  return (Array.isArray(hits) ? hits : []).filter(h => h.kind === 'page');
}

module.exports = { researchPageHits, DOC_QUERY_CHARS };
