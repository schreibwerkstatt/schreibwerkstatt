'use strict';

const { normText, valOverlap } = require('./split');
const { familyOf, REFUSAL_TASKS } = require('./tasks');
const { estimateTokens } = require('./tokens');

const FAMILIES = ['writing', 'facts', 'persona', 'refusal', 'editor'];
// Wie `answerTokens` gezählt wird — steht in der Statistik, damit die Anteile
// lesbar bleiben (kein echter Tokenizer im Export).
const TOKEN_METHOD = 'Schätzung Zeichen/3.3 (de) bzw. /4.0 (en), Tekken-Heuristik (lib/tokens.js)';

const TOP_ANSWERS = 10;
const TOP_ANSWER_CHARS = 140;

// Qualitäts-Statistik des exportierten Sets: Anzahl, Antwort-Tokens, eigene
// Antworten und mittlere Antwortlänge je Aufgabentyp, Familienanteile nach
// Anzahl UND nach Antwort-Tokens, Ablehnungen je Untertyp, Paraphrasen, die
// häufigsten Antworten und die Überlappung Val ↔ Train je Val-Datei. Sie
// steht in `meta.stats.quality` (Karte + gespeichertes Set) und im Job-Log.
function buildQualityStats(trainArr, valArr, { langIsEn = false, overlapByVal = null } = {}) {
  const all = [...trainArr, ...valArr];
  const byTask = new Map();
  const answerCount = new Map();
  const family = Object.fromEntries(FAMILIES.map(f => [f, 0]));
  const familyTok = Object.fromEntries(FAMILIES.map(f => [f, 0]));
  const perFact = new Map();
  let totalTok = 0;
  for (const s of all) {
    const task = s.task || 'other';
    if (!byTask.has(task)) byTask.set(task, { count: 0, chars: 0, tokens: 0, answers: new Set() });
    const t = byTask.get(task);
    t.count++;
    const fam = familyOf(task);
    family[fam]++;
    const tok = s.messages.filter(m => m.role === 'assistant').reduce((a, m) => a + estimateTokens(m.content, langIsEn), 0);
    t.tokens += tok;
    familyTok[fam] += tok;
    totalTok += tok;
    if (s.factId) perFact.set(s.factId, (perFact.get(s.factId) || 0) + 1);
    const last = s.messages[s.messages.length - 1].content;
    t.chars += last.length;
    const key = normText(last);
    t.answers.add(key);
    const c = answerCount.get(key);
    if (c) c.n++; else answerCount.set(key, { n: 1, text: last });
  }
  const total = all.length;
  const tasks = [...byTask.entries()]
    .map(([task, t]) => ({
      task,
      family: familyOf(task),
      count: t.count,
      share: total ? t.count / total : 0,
      answerTokens: t.tokens,
      tokenShare: totalTok ? t.tokens / totalTok : 0,
      uniqueAnswers: t.answers.size,
      avgAnswerChars: Math.round(t.chars / t.count),
    }))
    .sort((a, b) => b.count - a.count);
  let repeated3 = 0;
  for (const { n } of answerCount.values()) if (n >= 3) repeated3 += n;
  const topAnswers = [...answerCount.values()]
    .filter(a => a.n > 1)
    .sort((a, b) => b.n - a.n)
    .slice(0, TOP_ANSWERS)
    .map(a => ({ count: a.n, text: a.text.length > TOP_ANSWER_CHARS ? a.text.slice(0, TOP_ANSWER_CHARS) + '…' : a.text }));
  const ov = valOverlap(trainArr, valArr);
  const tShare = (f) => (totalTok ? familyTok[f] / totalTok : 0);
  const refusalCount = { total: 0 };
  for (const t of tasks) if (REFUSAL_TASKS.has(t.task)) { refusalCount[t.task] = t.count; refusalCount.total += t.count; }
  let factParaphraseCount = 0;
  for (const n of perFact.values()) factParaphraseCount += n - 1;
  return {
    tasks,
    tokenMethod: TOKEN_METHOD,
    answerTokens: totalTok,
    writingShare: total ? family.writing / total : 0,
    factShare: total ? family.facts / total : 0,
    personaShare: total ? family.persona / total : 0,
    refusalShare: total ? family.refusal / total : 0,
    writingTokenShare: tShare('writing'),
    factTokenShare: tShare('facts'),
    personaTokenShare: tShare('persona'),
    refusalTokenShare: tShare('refusal'),
    editorTokenShare: tShare('editor'),
    verbatimTokenShare: totalTok ? (byTask.get('verbatim')?.tokens || 0) / totalTok : 0,
    refusalCount,
    factCount: perFact.size,
    factParaphraseCount,
    uniqueAnswers: answerCount.size,
    uniqueAnswerShare: total ? answerCount.size / total : 0,
    repeated3Share: total ? repeated3 / total : 0,
    topAnswers,
    overlap: { prompt: ov.prompt.size, answer: ov.answer.size, shingle: ov.shingle.size },
    overlapByVal: overlapByVal || null,
  };
}

// Anteil der Figuren mit Kernwissen (`eligibleFigIds`, ab `minMentions`
// Erwähnungen), für die das Train-Set «Wer ist X?» (figureCore) UND jede ihrer
// Kernbeziehungen in beiden Fragerichtungen trägt.
function coreFactCoverage(trainArr, eligibleFigIds, relationFacts) {
  if (!eligibleFigIds?.size) return null;
  const coreFigs = new Set();
  const relDirs = new Map();
  for (const s of trainArr) {
    if (s.task === 'figureCore' && s.factId) coreFigs.add(s.factId.replace(/^fig:/, '').replace(/:core$/, ''));
    if (s.task === 'relationCore' && s.factId) {
      if (!relDirs.has(s.factId)) relDirs.set(s.factId, new Set());
      relDirs.get(s.factId).add(s.dir);
    }
  }
  let ok = 0;
  for (const id of eligibleFigIds) {
    if (!coreFigs.has(id)) continue;
    const rels = (relationFacts || []).filter(r => r.a.fig_id === id || r.b.fig_id === id);
    if (rels.every(r => (relDirs.get('rel:' + r.key)?.size || 0) >= 2)) ok++;
  }
  return ok / eligibleFigIds.size;
}

// Einzeilige Zusammenfassung fürs Job-Log.
function qualityLogLine(q) {
  const pct = (x) => (x * 100).toFixed(1) + '%';
  const tasks = q.tasks.map(t => `${t.task}=${t.count}`).join(' ');
  return `Qualität: Tokens writing/facts/persona/refusal ${pct(q.writingTokenShare || 0)}/${pct(q.factTokenShare || 0)}/`
    + `${pct(q.personaTokenShare || 0)}/${pct(q.refusalTokenShare || 0)}, verbatim ${pct(q.verbatimTokenShare || 0)}, `
    + `Schreibaufgaben ${pct(q.writingShare)}, eigene Antworten ${pct(q.uniqueAnswerShare)}, `
    + `Antwort ≥3× ${pct(q.repeated3Share)}, Überlappung Val↔Train prompt/antwort/12w `
    + `${q.overlap.prompt}/${q.overlap.answer}/${q.overlap.shingle} · ${tasks}`;
}

module.exports = { buildQualityStats, qualityLogLine, coreFactCoverage };
