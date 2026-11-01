'use strict';

const { normText, valOverlap } = require('./split');
const { familyOf } = require('./tasks');

const TOP_ANSWERS = 10;
const TOP_ANSWER_CHARS = 140;

// Qualitäts-Statistik des exportierten Sets: Anzahl, eigene Antworten und
// mittlere Antwortlänge je Aufgabentyp, Familienanteile, die häufigsten
// Antworten und die Überlappung Val ↔ Train. Sie steht in `meta.stats.quality`
// (Karte + gespeichertes Set) und im Job-Log.
function buildQualityStats(trainArr, valArr) {
  const all = [...trainArr, ...valArr];
  const byTask = new Map();
  const answerCount = new Map();
  const family = { writing: 0, facts: 0 };
  for (const s of all) {
    const task = s.task || 'other';
    if (!byTask.has(task)) byTask.set(task, { count: 0, chars: 0, answers: new Set() });
    const t = byTask.get(task);
    t.count++;
    family[familyOf(task)]++;
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
  return {
    tasks,
    writingShare: total ? family.writing / total : 0,
    factShare: total ? family.facts / total : 0,
    uniqueAnswers: answerCount.size,
    uniqueAnswerShare: total ? answerCount.size / total : 0,
    repeated3Share: total ? repeated3 / total : 0,
    topAnswers,
    overlap: { prompt: ov.prompt.size, answer: ov.answer.size, shingle: ov.shingle.size },
  };
}

// Einzeilige Zusammenfassung fürs Job-Log.
function qualityLogLine(q) {
  const pct = (x) => (x * 100).toFixed(1) + '%';
  const tasks = q.tasks.map(t => `${t.task}=${t.count}`).join(' ');
  return `Qualität: Schreibaufgaben ${pct(q.writingShare)}, eigene Antworten ${pct(q.uniqueAnswerShare)}, `
    + `Antwort ≥3× ${pct(q.repeated3Share)}, Überlappung Val↔Train prompt/antwort/12w `
    + `${q.overlap.prompt}/${q.overlap.answer}/${q.overlap.shingle} · ${tasks}`;
}

module.exports = { buildQualityStats, qualityLogLine };
