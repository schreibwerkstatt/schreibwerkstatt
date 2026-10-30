// Werkzeug-Verlauf der agentischen Chats im Frontend (public/js/chat/tool-log.js)
// und die Label-Abdeckung: jedes Werkzeug aus dem gemeinsamen Katalog, den
// Ausgabe-Werkzeugen der Chats und den abgelösten Namen (alte Antworten) hat in
// beiden Locales ein `chat.tool.<name>` — sonst stünde im Verlauf der rohe Name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { toolLogEntries, toolLogHeading } = await import('../../public/js/chat/tool-log.js');
const { CHAT_TOOLS, RETIRED_CHAT_TOOL_NAMES } = await import('../../public/js/prompts/chat-tools/index.js');
const { RESEARCH_CHAT_TOOLS, RESEARCH_WEB_FUNCTION_TOOLS } = await import('../../public/js/prompts/recherche.js');
const { PLOT_CHAT_PROPOSE_TOOLS } = await import('../../public/js/prompts/plot-chat.js');
const { IDEEN_CHAT_PROPOSE_TOOLS } = await import('../../public/js/prompts/ideen-chat.js');

const de = JSON.parse(readFileSync(new URL('../../public/js/i18n/de.json', import.meta.url)));
const en = JSON.parse(readFileSync(new URL('../../public/js/i18n/en.json', import.meta.url)));
const t = (k, p = {}) => (de[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => (n in p ? p[n] : `{${n}}`));

const rowsOf = (items) => items.flatMap(i => (i.kind === 'row' ? [i] : i.kind === 'group' ? i.children : []));

test('jedes Werkzeug aller agentischen Chats (auch abgelöste) hat ein Label in de und en', () => {
  const names = new Set([
    ...[...CHAT_TOOLS, ...RESEARCH_CHAT_TOOLS, ...RESEARCH_WEB_FUNCTION_TOOLS, ...PLOT_CHAT_PROPOSE_TOOLS, ...IDEEN_CHAT_PROPOSE_TOOLS].map(x => x.name),
    ...RETIRED_CHAT_TOOL_NAMES,
  ]);
  names.delete('final_answer');
  const missing = [...names].filter(n => !de[`chat.tool.${n}`] || !en[`chat.tool.${n}`]);
  assert.deepEqual(missing, []);
});

test('Server-Sicht: Label, Zitat, Verweis, Ergebnis; Runden mit Notiz und Tokens; Vorab-Kontext und Zitat-Abschluss', () => {
  const { items, rows } = toolLogEntries({
    pre_context: { count: 8 },
    tool_rounds: [{ iter: 1, tokIn: 12000, tokOut: 400, note: 'Ich suche zuerst die Stelle.' }, { iter: 2, tokIn: 1000, tokOut: 50 }],
    tool_calls: [
      { name: 'search_passages', ok: true, iter: 1, durationMs: 3, input: { pattern: 'März' },
        view: { subject: [{ t: 'q', v: 'März' }, { t: 'ref', k: 'chapter', id: '7', v: 'Teil 1' }], result: { key: 'chat.toolResult.hitsNone' } } },
      { name: 'get_plot_board', ok: true, iter: 2, durationMs: 1500,
        view: { subject: [{ t: 'ref', k: 'act', id: '5', v: 'Aufbruch' }, { t: 'ref', k: 'beat', id: '9', v: 'Neujahr' }], result: null } },
      { name: 'final_answer', ok: true, iter: 3, input: { zitate_count: 5 }, citations_invalid: 1 },
    ],
  }, t, { fmtTok: n => `${n / 1000}k` });
  assert.deepEqual(items.map(i => i.kind), ['pre', 'round', 'row', 'round', 'row', 'final']);
  assert.equal(items[0].text, 'Vorab geladen: 8 passende Textstellen');
  assert.deepEqual([items[1].text, items[1].note, items[1].tokens], ['Runde 1', 'Ich suche zuerst die Stelle.', '12.4k Tokens']);
  assert.equal(rows[0].label, de['chat.tool.search_passages']);
  assert.equal(rows[0].parts[0].text, '«März»');
  assert.deepEqual(rows[0].parts[1].entity, { type: 'chapter', id: '7', name: 'Teil 1' });
  assert.equal(rows[0].result, 'keine Treffer');
  assert.equal(rows[0].empty, true);
  assert.equal(rows[0].duration, '', 'schnelle Aufrufe ohne Dauer');
  assert.equal(rows[1].duration, '1.5 s');
  assert.equal(rows[1].parts[0].text, 'Akt Aufbruch', 'Akt hat keinen Verweistyp → Text');
  assert.deepEqual(rows[1].parts[1].entity, { type: 'beat', id: '9', name: 'Neujahr', label: 'Neujahr' });
  assert.equal(items.at(-1).text, 'Antwort mit 5 Zitaten, 1 davon nicht im Text bestätigt');
  assert.equal(items.at(-1).bad, true);
});

test('gleiche Aufrufe einer Runde werden ab drei gebündelt; Zusammenfassung bei langen Verläufen', () => {
  const search = (pattern, n) => ({ name: 'search_passages', ok: true, iter: 1, input: { pattern },
    view: { subject: [{ t: 'q', v: pattern }], result: { key: n ? 'chat.toolResult.hits' : 'chat.toolResult.hitsNone', params: { n } } } });
  const { items, rows, summary } = toolLogEntries({ tool_calls: [
    { name: 'list_chapters', ok: true, iter: 1, input: {}, view: { subject: [], result: null } },
    search('naked', 3), search('tampons', 0), search('earbud', 2), search('Ida', 1),
    { name: 'search_passages', ok: false, skipped: true, iter: 1, input: { pattern: 'x' }, errorKey: 'chat.toolError.roundLimit', errorParams: { max: 8 } },
    { name: 'get_pages', ok: true, iter: 1, input: { ids: [1] } },
  ] }, t);
  assert.deepEqual(items.map(i => i.kind), ['row', 'group', 'row'], 'eine Runde → kein Rundenkopf; Gruppe am Ort des ersten Aufrufs');
  const g = items[1];
  assert.equal(g.label, `${de['chat.tool.search_passages']} ×5`);
  assert.equal(g.preview, '«naked», «tampons», «earbud» +2 weitere');
  assert.equal(g.result, '3 mit Treffer, 1 ohne · 1 übersprungen');
  assert.equal(g.failed, false, 'übersprungen ist kein Fehler');
  assert.equal(rows.length, 7);
  assert.equal(summary, `${de['chat.tool.search_passages']} ×5 · ${de['chat.tool.list_chapters']} · ${de['chat.tool.get_pages']}`);
  assert.equal(toolLogHeading(rows, t), 'Werkzeug-Verlauf (7)', 'Übersprungenes zählt nicht als Fehler');
});

test('ältere Antwort ohne Sicht: Suchbegriff und IDs aus den Argumenten; Fehler, Übersprungen, Wiederholung, Kürzung', () => {
  const { items, rows } = toolLogEntries({ tool_calls: [
    { name: 'quote_match', ok: false, iter: 1, input: { page_id: 1005674, pattern: 'zwinkert', context_chars: 0 },
      error: 'pattern nicht gefunden.', errorKey: 'chat.toolError.patternNotFound' },
    { name: 'quote_match', ok: false, iter: 1, input: { page_id: 1, pattern: 'y' }, error: 'Nicht ausgeführt', errorKey: 'chat.toolError.roundLimit', errorParams: { max: 8 } },
    { name: 'unbekannt_neu', ok: true, iter: 1, input: { query: 'x' } },
    { name: 'unbekannt_neu', ok: true, iter: 1, input: { query: 'x' } },
    { name: 'list_chapters', ok: true, iter: 1, truncated: true, input: {}, view: { subject: [], result: null, trunc: { shown: 30, total: 120 } } },
  ] }, t);
  assert.equal(items[0].kind, 'row', 'zwei quote_match bleiben Einzelzeilen');
  assert.equal(rows[0].parts[0].text, '«zwinkert»');
  assert.deepEqual(rows[0].parts[1].entity, { type: 'page', id: '1005674' });
  assert.equal(rows[0].error, de['chat.toolError.patternNotFound']);
  assert.equal(rows[0].failed, true);
  assert.equal(rows[1].skipped, true, 'alter Deckel-Fehler ohne skipped-Flag wird als übersprungen erkannt');
  assert.equal(rows[1].failed, false);
  assert.equal(rows[2].label, 'unbekannt_neu', 'unbekanntes Werkzeug → roher Name');
  assert.equal(rows[2].repeat, false);
  assert.equal(rows[3].repeat, true);
  assert.equal(rows[4].truncated, 'gekürzt: 30 von 120');
  assert.equal(toolLogHeading(rows, t), 'Werkzeug-Verlauf (5, davon 1 mit Fehler)');
});

test('Filter- und Ergebnis-Keys der Server-Sicht existieren in beiden Locales', () => {
  const src = readFileSync(new URL('../../routes/jobs/agentic-chat/tool-view.js', import.meta.url), 'utf8');
  const filters = [...src.match(/const FILTER_KEYS = new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  const results = [...src.matchAll(/chat\.toolResult\.([a-zA-Z]+)/g)].map(m => m[1])
    .flatMap(base => (/(?:One|None|Of)$/.test(base) || ['quoteFound', 'quoted', 'proposed', 'proposedExists', 'image'].includes(base)
      ? [base] : [base, `${base}One`, `${base}None`]));
  const counted = ['hits', 'sections', 'entries'].flatMap(b => [b, `${b}One`, `${b}None`]);
  const keys = [...new Set([...filters.map(f => `chat.toolFilter.${f}`), ...[...results, ...counted].map(r => `chat.toolResult.${r}`),
    'chat.toolError.webSearchFailed'])];
  assert.deepEqual(keys.filter(k => !de[k] || !en[k]), []);
});

test('Fehler ohne Key: generischer übersetzter Text, Rohtext nur als errorDetail', () => {
  const { rows } = toolLogEntries({ tool_calls: [
    { name: 'list_chapters', ok: false, iter: 1, input: {}, error: 'Unbekanntes Werkzeug: <b>x</b>' },
    { name: 'list_chapters', ok: false, iter: 1, input: { a: 1 }, error: 'SQLITE_BUSY', errorKey: 'chat.toolError.failedCode', errorParams: { code: 'SQLITE_BUSY' } },
    { name: 'list_figures', ok: false, skipped: true, iter: 1, input: {}, errorKey: 'chat.toolError.notOffered' },
  ] }, t);
  assert.equal(rows[0].error, de['chat.toolError.failed']);
  assert.equal(rows[0].errorDetail, 'Unbekanntes Werkzeug: <b>x</b>');
  assert.equal(rows[1].error, 'Werkzeug-Aufruf fehlgeschlagen (SQLITE_BUSY)');
  assert.equal(rows[2].error, de['chat.toolError.notOffered']);
  assert.equal(rows[2].skipped, true);
  for (const k of ['chat.toolError.failed', 'chat.toolError.failedCode', 'chat.toolError.notOffered']) {
    assert.ok(de[k] && en[k], `${k} in beiden Locales`);
  }
});
