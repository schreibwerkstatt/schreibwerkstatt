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
      if (it.mustContainAny?.length) lines.push(`- ${t.any}: ${it.mustContainAny.map(g => '[' + g.map(code).join(' | ') + ']').join(' ')}`);
      if (it.mustNotContain?.length) lines.push(`- ${t.not}: ${it.mustNotContain.map(code).join(', ')}`);
      if (it.factIds?.length) lines.push(`- ${t.facts}: ${it.factIds.map(code).join(', ')}`);
      if (it.judge) lines.push(`- ${t.judge}: ${it.judge}`);
      lines.push('', t.score);
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = { buildEvalJudgeMd };
