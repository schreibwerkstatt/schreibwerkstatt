'use strict';

// Bewertungsanleitung zum Eval-Set (`finetune-eval-judge-….md` im ZIP und
// als eigener Download): für einen menschlichen oder LLM-Richter, Skala 0–2
// pro Frage. Wird beim Herunterladen aus eval.jsonl erzeugt, nicht
// gespeichert. Trainingsbegleitendes Dokument, kein UI-Text: die Sprache folgt
// dem Buch.

const TEXT = {
  de: {
    title: (book) => `# Eval-Bewertung «${book}»`,
    intro: [
      'Jede Frage wird einzeln an das trainierte Modell gestellt (System-Prompt aus dem Modelfile). Die Antwort bekommt **0, 1 oder 2 Punkte**:',
      '',
      '- **2 — richtig:** erfüllt die Kriterien und die Bewertungsanweisung, nichts Erfundenes.',
      '- **1 — teilweise:** Richtung stimmt, aber ein Kriterium fehlt oder ein Detail ist falsch.',
      '- **0 — falsch:** verfehlt die Frage, erfindet Fakten oder verletzt ein Ausschlusskriterium.',
      '',
      'Kriterien (Teilstrings, ohne Gross-/Kleinschreibung):',
      '',
      '- *muss enthalten* — jeder Begriff kommt vor.',
      '- *muss eins aus jeder Gruppe enthalten* — aus jeder Synonymgruppe mindestens ein Begriff.',
      '- *darf nicht enthalten* — kommt einer vor, ist die Antwort höchstens 1 (bei Ablehnungen 0).',
      '- «…» in einem Begriff ist eine Lücke: «gibt es … nicht» trifft «gibt es in «X» nicht».',
      '- *mindestens k Gruppen* — statt aus jeder Gruppe genügen k Gruppen.',
      '- *höchstens wörtlich aus dem Profil* — Anteil der 8-Wort-Folgen der Antwort, die wörtlich im Figurenprofil stehen; darüber höchstens 1.',
      '- *Stil* — kein «ß», Zeitform, keine Wiederholungsschleife (Teilsatz ≥ 3×), kein Metatext («Kapitel 11»); verletzt: höchstens 1.',
      '',
      'Automatisch: `node scripts/eval-judge.js eval.jsonl antworten.jsonl` wendet diese Regeln an und lässt ein Modell die Anweisung bewerten; es vergibt nie mehr, als die Regeln erlauben.',
      '- *Referenz* ist eine mögliche richtige Antwort, kein Wortlaut, der getroffen werden muss.',
      '',
      '*holdout*: `phrasing` = Frageform kommt im Training nicht vor (misst Verallgemeinerung), `unit` = der Fakt lag im Val-Teil, `text` = der Buchtext lag im Val-Teil, `–` = Frageform aus dem Training (die Frage selbst nie wörtlich).',
      '',
      'Am Ende: Punkte je Kategorie summieren und durch 2 × Anzahl Fragen teilen.',
    ],
    summary: 'Übersicht',
    cat: 'Kategorie', count: 'Fragen', phrasing: 'davon neue Frageform',
    q: 'Frage', ref: 'Referenz', must: 'muss enthalten', any: 'muss eins aus jeder Gruppe enthalten', not: 'darf nicht enthalten',
    judge: 'Bewertung', facts: 'Fakten', score: 'Punkte: __ / 2',
    minAny: (k) => `mindestens ${k} Gruppen`, overlap: (m) => `höchstens ${Math.round(m * 100)} % wörtlich aus dem Profil`,
    style: 'Stil', styleParts: { noEszett: 'kein «ß»', past: 'Präteritum', present: 'Präsens', noRepeat: 'keine Wiederholungsschleife', noMeta: 'kein Metatext' },
  },
  en: {
    title: (book) => `# Eval scoring «${book}»`,
    intro: [
      'Ask the trained model each question on its own (system prompt from the Modelfile). Each answer gets **0, 1 or 2 points**:',
      '',
      '- **2 — correct:** meets the criteria and the judging note, nothing invented.',
      '- **1 — partial:** right direction, but a criterion is missing or a detail is wrong.',
      '- **0 — wrong:** misses the question, invents facts or breaks an exclusion criterion.',
      '',
      'Criteria (substrings, case-insensitive):',
      '',
      '- *must contain* — every term appears.',
      '- *must contain one from each group* — at least one term from every synonym group.',
      '- *must not contain* — if one appears, the answer gets at most 1 (0 for refusals).',
      '- «…» in a term is a gap: «does … exist» matches «does not exist».',
      '- *at least k groups* — k groups are enough instead of every group.',
      '- *at most verbatim from the profile* — share of the answer\'s 8-word sequences found verbatim in the character profile; above it, at most 1.',
      '- *style* — no «ß», tense, no repetition loop (phrase ≥ 3×), no meta text («Chapter 11»); violated: at most 1.',
      '',
      'Automatic: `node scripts/eval-judge.js eval.jsonl answers.jsonl` applies these rules and lets a model score the note; it never awards more than the rules allow.',
      '- *Reference* is one possible correct answer, not wording that must be matched.',
      '',
      '*holdout*: `phrasing` = question form not seen in training (measures generalisation), `unit` = the fact was in the val split, `text` = the book text was in the val split, `–` = question form from training (the question itself never verbatim).',
      '',
      'Finally: add up the points per category and divide by 2 × number of questions.',
    ],
    summary: 'Overview',
    cat: 'Category', count: 'Questions', phrasing: 'of which new phrasing',
    q: 'Question', ref: 'Reference', must: 'must contain', any: 'must contain one from each group', not: 'must not contain',
    judge: 'Judging', facts: 'Facts', score: 'Points: __ / 2',
    minAny: (k) => `at least ${k} groups`, overlap: (m) => `at most ${Math.round(m * 100)} % verbatim from the profile`,
    style: 'Style', styleParts: { noEszett: 'no «ß»', past: 'past tense', present: 'present tense', noRepeat: 'no repetition loop', noMeta: 'no meta text' },
  },
};

const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
const quote = (s) => String(s || '').trim().split('\n').map(l => '> ' + l).join('\n');

function buildEvalJudgeMd(items, { bookName = '', langIsEn = false } = {}) {
  const t = TEXT[langIsEn ? 'en' : 'de'];
  const lines = [t.title(bookName), '', ...t.intro, '', `## ${t.summary}`, '', `| ${t.cat} | ${t.count} | ${t.phrasing} |`, '|---|---|---|'];
  const byCat = new Map();
  for (const it of items) {
    if (!byCat.has(it.category)) byCat.set(it.category, []);
    byCat.get(it.category).push(it);
  }
  for (const [cat, list] of byCat) lines.push(`| ${cat} | ${list.length} | ${list.filter(i => i.holdout === 'phrasing').length} |`);
  let n = 0;
  for (const [cat, list] of byCat) {
    lines.push('', `## ${cat}`);
    for (const it of list) {
      n++;
      lines.push('', `### ${n}. ${cat} · holdout: ${it.holdout || '–'}`, '', `**${t.q}:**`, '', quote(it.messages[1].content), '');
      if (it.expected) lines.push(`**${t.ref}:**`, '', quote(it.expected.length > 700 ? it.expected.slice(0, 700) + ' …' : it.expected), '');
      if (it.mustContain?.length) lines.push(`- ${t.must}: ${it.mustContain.map(code).join(', ')}`);
      if (it.mustContainAny?.length) lines.push(`- ${t.any}${Number.isInteger(it.minAny) ? ` (${t.minAny(it.minAny)})` : ''}: ${it.mustContainAny.map(g => '[' + g.map(code).join(' | ') + ']').join(' ')}`);
      if (it.mustNotContain?.length) lines.push(`- ${t.not}: ${it.mustNotContain.map(code).join(', ')}`);
      if (it.maxOverlapWithProfile) lines.push(`- ${t.overlap(it.maxOverlapWithProfile.max ?? 0.6)}`);
      if (it.style) {
        const parts = Object.entries(it.style).filter(([, v]) => v).map(([k, v]) => (k === 'tense' ? t.styleParts[v] : t.styleParts[k])).filter(Boolean);
        if (parts.length) lines.push(`- ${t.style}: ${parts.join(', ')}`);
      }
      if (it.factIds?.length) lines.push(`- ${t.facts}: ${it.factIds.map(code).join(', ')}`);
      if (it.judge) lines.push(`- ${t.judge}: ${it.judge}`);
      lines.push('', t.score);
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = { buildEvalJudgeMd };
