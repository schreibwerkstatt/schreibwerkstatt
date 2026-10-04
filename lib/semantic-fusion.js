'use strict';
// Pure Fusions-Helfer für die hybride semantische Suche: Reciprocal Rank Fusion
// (RRF) über die semantische (Cosinus) und die lexikalische (FTS5/bm25)
// Trefferliste. RRF mischt zwei Ranglisten allein über die Rang-Position (nicht
// über inkompatible Score-Skalen) und schlägt in der Praxis jede der beiden
// einzeln — exakte Begriffe/Eigennamen kommen aus FTS, Paraphrasen aus den
// Embeddings. Ohne DB-/Netz-Abhängigkeit → unit-testbar
// (tests/unit/semantic-fusion.test.mjs). Konsument: lib/semantic-retrieval.js.

// Standard-Dämpfung. Grösser = flacherer Einfluss der Rang-Position (späte
// Treffer zählen relativ mehr); 60 ist der in der Literatur übliche Wert.
const RRF_K = 60;

// Entschärft FTS-Snippet/Titel zu Klartext (für ein etwaiges Reranking eines
// nur-lexikalischen Treffers, der keinen Embedding-Chunk-Text hat).
function _stripTags(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fusioniert semantische + FTS-Treffer zu einer nach RRF absteigend sortierten
// Kandidatenliste, gekeyt auf `kind:entity_id` (derselbe Treffer aus beiden
// Quellen wird zu EINEM Kandidaten verschmolzen).
//   semHits: [{ kind, entity_id, chunk_ix, text, score }]  (Cosinus-Reihenfolge)
//   ftsHits: [{ kind, entity_id, title, snippet }] (bm25-Reihenfolge)
// Rückgabe: [{ kind, entity_id, chunk_ix|null, semRank|null, ftsRank|null,
//   semScore|null, rrf, text }] — text = bester verfügbarer Volltext (Embedding-
//   Chunk bevorzugt, sonst entschärfter FTS-Titel+Snippet). Nur-FTS-Kandidaten
//   tragen chunk_ix null; semanticQuery füllt sie danach mit ihrem besten Chunk.
function fuseCandidates(semHits = [], ftsHits = [], { k = RRF_K } = {}) {
  const map = new Map();
  const keyOf = (h) => `${h.kind}:${h.entity_id}`;

  semHits.forEach((h, i) => {
    map.set(keyOf(h), {
      kind: h.kind,
      entity_id: h.entity_id,
      chunk_ix: Number.isInteger(h.chunk_ix) ? h.chunk_ix : null,
      semRank: i,
      ftsRank: null,
      semScore: typeof h.score === 'number' ? h.score : null,
      text: String(h.text || ''),
    });
  });

  ftsHits.forEach((h, i) => {
    const key = keyOf(h);
    const cur = map.get(key);
    if (cur) {
      cur.ftsRank = i;
      if (!cur.text) cur.text = _stripTags(`${h.title || ''} ${h.snippet || ''}`);
    } else {
      map.set(key, {
        kind: h.kind,
        entity_id: h.entity_id,
        chunk_ix: null,
        semRank: null,
        ftsRank: i,
        semScore: null,
        text: _stripTags(`${h.title || ''} ${h.snippet || ''}`),
      });
    }
  });

  const out = [];
  for (const c of map.values()) {
    c.rrf = (c.semRank != null ? 1 / (k + c.semRank) : 0)
          + (c.ftsRank != null ? 1 / (k + c.ftsRank) : 0);
    out.push(c);
  }
  out.sort((a, b) => b.rrf - a.rrf);
  return out;
}

module.exports = { fuseCandidates, RRF_K, _stripTags };
