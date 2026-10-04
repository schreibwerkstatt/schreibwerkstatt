'use strict';

const { db } = require('../../../../db/schema');

// Übernommene Lektorats-Korrekturen eines Buchs, dedupliziert, neueste zuerst.
// Quelle ist `applied_errors_json` — nur was der Autor tatsächlich in den Text
// übernommen hat. `errors_json` enthält jeden KI-Vorschlag, auch die
// abgelehnten; die als Autor-Prosa zu trainieren, brächte dem Modell genau die
// Formulierungen bei, gegen die sich der Autor entschieden hat.
// Geteilt mit dem Reasoning-Backfill in ai-augment.js.
function collectAppliedCorrections(bookIdInt, userEmail, maxChars) {
  const rows = db.prepare(`
    SELECT applied_errors_json FROM page_checks
    WHERE book_id = ? AND user_email = ? AND applied_errors_json IS NOT NULL
    ORDER BY checked_at DESC
  `).all(bookIdInt, userEmail);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    let errs = null;
    try { errs = JSON.parse(row.applied_errors_json); } catch { continue; }
    if (!Array.isArray(errs)) continue;
    for (const e of errs) {
      const orig = (e?.original || '').trim();
      const korr = (e?.korrektur || '').trim();
      if (orig.length < 8 || korr.length < 5) continue;
      if (orig.toLowerCase() === korr.toLowerCase()) continue;
      if (orig.length > maxChars || korr.length > maxChars) continue;
      const key = orig + '→' + korr;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        orig, korr,
        erkl: (e.erklaerung || '').trim(),
        kontext: (e.kontext || '').trim(),
      });
    }
  }
  return out;
}

function buildCorrectionSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys,
    bookIdInt, userEmail,
  } = ctx;

  // Lektor-Persona absichtlich entfernt: Korrekturen fliessen mit unifiedSys
  // ein, sodass die übernommene Fassung als Autor-Prosa gelernt wird, nicht
  // als Lektor-Output. Task-Hinweis steckt im User-Prefix.
  const userPrefix    = langIsEn
    ? 'Revise this sentence:\n\n'
    : 'Überarbeite diesen Satz:\n\n';
  const reasonedUser  = langIsEn
    ? 'Revise this sentence and explain the change in one sentence:\n\n'
    : 'Überarbeite diesen Satz und erkläre die Änderung in einem Satz:\n\n';
  const reasonLabel   = langIsEn ? 'Reason: ' : 'Grund: ';

  const corrections = collectAppliedCorrections(bookIdInt, userEmail, opts.maxChars);
  corrections.forEach(({ orig, korr, erkl }, i) => {
    const idx = i + 1;
    // Base-Variante: nur verbesserter Satz als Antwort.
    samples.push({
      id: 'correction|a|' + idx,
      type: 'correction',
      messages: [
        { role: 'system', content: unifiedSys },
        { role: 'user',   content: userPrefix + orig },
        { role: 'assistant', content: korr },
      ],
    });
    counts.correction++;
    // Reasoned-Variante (nur wenn Begründung vorhanden): verbesserter Satz
    // + kurze Begründung. Trainiert ein Warum-Signal mit, ohne Basis-Antworten
    // mit Reasoning zu verwässern.
    if (erkl.length >= 15 && erkl.length <= 400) {
      samples.push({
        id: 'correction|b|' + idx,
        type: 'correction',
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user',   content: reasonedUser + orig },
          { role: 'assistant', content: korr + '\n\n' + reasonLabel + erkl },
        ],
      });
      counts.correction++;
    }
  });
}

module.exports = { buildCorrectionSamples, collectAppliedCorrections };
