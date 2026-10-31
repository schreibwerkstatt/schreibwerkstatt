'use strict';

// Block 20: Fakten aus chapter_extract_cache
function buildFactSamples(ctx) {
  const { langIsEn, extractCacheRows, pushQA } = ctx;

  // Pro Kapitel liefert die Komplettanalyse typischerweise 20–50 präzise
  // Ein-Satz-Fakten (kategorie=figur|ort|objekt|zeit|ereignis|…). Diese
  // sind die dichteste Quelle atomarer Buchwelt-Behauptungen. Pro Fakt
  // ein Q&A + gruppiert pro Subjekt eine Sammel-Antwort.
  const factsBySubject = new Map(); // subjekt lower → [{kategorie,fakt,seite}]
  let factCounter = 0;
  for (const row of extractCacheRows) {
    let data = null;
    try { data = JSON.parse(row.extract_json); } catch { continue; }
    const facts = Array.isArray(data?.fakten) ? data.fakten : [];
    for (const fk of facts) {
      const subjekt = (fk.subjekt || '').trim();
      const fakt    = (fk.fakt    || '').trim();
      if (!subjekt || fakt.length < 10) continue;
      const kategorie = (fk.kategorie || '').trim();
      const seite     = (fk.seite     || '').trim();
      // Einzel-Fakt-Q&A
      const answer = seite
        ? (langIsEn ? `${fakt} (from «${seite}»)` : `${fakt} (aus «${seite}»)`)
        : fakt;
      factCounter++;
      pushQA('authorChat|fact|' + factCounter,
        langIsEn
          ? `Tell me a fact about ${subjekt}${kategorie ? ` (${kategorie})` : ''}.`
          : `Nenn mir einen Fakt zu ${subjekt}${kategorie ? ` (${kategorie})` : ''}.`,
        answer);
      // Für Gruppierung
      const key = subjekt.toLowerCase();
      if (!factsBySubject.has(key)) factsBySubject.set(key, { subjekt, items: [] });
      factsBySubject.get(key).items.push({ kategorie, fakt, seite });
    }
  }
  // Gruppierte Antworten pro Subjekt — wenn viele Fakten zu X gesammelt,
  // entsteht eine reichhaltige „Erzähl mir alles über X"-Antwort.
  for (const [, group] of factsBySubject) {
    if (group.items.length < 2) continue;
    const joined = group.items.slice(0, 15).map(it => it.fakt).join(' ');
    pushQA('authorChat|factAll|' + group.subjekt.toLowerCase(),
      langIsEn ? `What do we know about ${group.subjekt}?` : `Was wissen wir über ${group.subjekt}?`,
      joined);
  }
}

module.exports = { buildFactSamples };
