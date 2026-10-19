// Unit-Tests für public/js/chat/research-chat-render.js — pure Marker-Logik des
// Recherche-Chats (extrahiert aus research-chat.js, mit der Tests-trackbar sein
// soll). Mocks für renderChatMarkdown (passthrough), escHtml (passthrough) und
// t (key -> '[i18n]key'); tests üben allein die Zitat-Resolver-/Sentinel-Logik.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderResearchAnswer,
  citedSources,
  parseCiteDocNums,
  resolveSource,
  displaySources,
  effectiveAnswerText,
  listLocalNumbering,
} from '../../public/js/chat/research-chat-render.js';

const ID = (s) => s;          // escHtml mock: passthrough
const MK = (s) => s;          // renderChatMarkdown mock: passthrough
const T = (k) => `[i18n]${k}`; // t mock

function render(text, sources = [], opts = {}) {
  return renderResearchAnswer({
    text, sources,
    renderChatMarkdown: opts.renderChatMarkdown ?? MK,
    escHtml: opts.escHtml ?? ID,
    t: opts.t ?? T,
  });
}

test('parseCiteDocNums: erste Zahl pro Komma-Teil, distinkt, Reihenfolge erhalten', () => {
  assert.deepEqual(parseCiteDocNums('4-4,4-5,1-2,4-7'), [4, 1]);
  assert.deepEqual(parseCiteDocNums(' 2-1 ,3-9 '), [2, 3]);
  assert.deepEqual(parseCiteDocNums(''), []);
  assert.deepEqual(parseCiteDocNums(null), []);
});

test('resolveSource: 1-basiert, null bei Overflow', () => {
  const srcs = [{ url: 'a' }, { url: 'b' }];
  assert.equal(resolveSource(srcs, 1).url, 'a');
  assert.equal(resolveSource(srcs, 2).url, 'b');
  assert.equal(resolveSource(srcs, 3), null);
  assert.equal(resolveSource([], 1), null);
});

test('renderResearchAnswer: einzelner cite-Index mit Source → klickbarer sup', () => {
  const sources = [{ url: 'https://a.example', title: 'Alpha' }];
  const out = render('Siehe <cite index="1-3">hier</cite> für mehr.', sources);
  assert.match(out, /<sup class="chat-cite"><a href="https:\/\/a\.example" target="_blank" rel="noopener noreferrer" data-tip="Alpha">1<\/a><\/sup>/);
  // Innerer Text erhalten, Tag-Wrapper aufgelöst.
  assert.ok(out.includes('Siehe hier'));
  assert.ok(!out.includes('<cite'));
});

test('renderResearchAnswer: mehrere Kommas in einem index (4-4,1-2) → beide Marker', () => {
  const sources = [
    { url: 'https://a.example', title: 'A' },
    { url: 'https://b.example', title: 'B' },
    { url: 'https://c.example', title: 'C' },
    { url: 'https://d.example', title: 'D' },
  ];
  // Index "4-4,1-2" → parseCiteDocNums gibt [4, 1] (distinkt, Reihenfolge erhalten).
  const out = render('Mehr <cite index="4-4,1-2">dazu</cite>.', sources);
  const sups = out.match(/<sup class="chat-cite">/g) || [];
  assert.equal(sups.length, 2, 'beide Marker werden gerendert');
  assert.ok(/data-tip="D"[^]*data-tip="A"/.test(out), 'Reihenfolge: D zuerst, dann A');
});

test('renderResearchAnswer: gleicher Index zweimal (4-4,4-5) → ein Marker (Parser dedup)', () => {
  const sources = [
    { url: 'https://a.example', title: 'A' },
    { url: 'https://b.example', title: 'B' },
    { url: 'https://c.example', title: 'C' },
    { url: 'https://d.example', title: 'D' },
  ];
  const out = render('Mehr <cite index="4-4,4-5">dazu</cite>.', sources);
  const sups = out.match(/<sup class="chat-cite">/g) || [];
  assert.equal(sups.length, 1, 'Parser dedup führt 4-4,4-5 auf Index [4] → ein Marker');
  assert.match(out, /data-tip="D"/);
});

test('renderResearchAnswer: cite-Index ohne Source → dim-marker', () => {
  const sources = [{ url: 'https://a.example', title: 'A' }];
  const out = render('XX <cite index="2-1">dort</cite> YY', sources);
  // Index 2 hat keine Source → dim, kein <a>.
  assert.match(out, /<sup class="chat-cite chat-cite--dim">2<\/sup>/);
  assert.ok(out.includes('dort'));
});

test('renderResearchAnswer: keine Sources → Tags entwrappen, Text erhalten', () => {
  const out = render('Siehe <cite index="1-1">hier</cite>.', []);
  assert.ok(out.includes('Siehe hier'));
  assert.ok(!out.includes('<cite'));
  assert.ok(!out.includes('<sup'));
});

test('renderResearchAnswer: reste-<cite> ohne index werden entwrapt', () => {
  const out = render('Rest <cite>blah</cite> bleibt', [{ url: 'u', title: 't' }]);
  assert.ok(out.includes('Rest blah bleibt'));
  assert.ok(!out.includes('<cite'));
});

test('renderResearchAnswer: __i18n:Marker geht durch t + renderChatMarkdown', () => {
  const out = render('__i18n:chat.errors.generic__', []);
  assert.equal(out, '[i18n]chat.errors.generic');
});

test('renderResearchAnswer: __i18n:Marker ohne t-Resolver → key als Fallback', () => {
  const out = renderResearchAnswer({
    text: '__i18n:foo.bar__', sources: [],
    renderChatMarkdown: MK, escHtml: ID, t: undefined,
  });
  assert.equal(out, 'foo.bar');
});

test('renderResearchAnswer: escHtml wird nur für url + title aufgerufen', () => {
  let escCalls = [];
  const esc = (s) => { escCalls.push(s); return 'ESC(' + s + ')'; };
  const out = renderResearchAnswer({
    text: '<cite index="1-1">x</cite>',
    sources: [{ url: 'https://a.example/path?a=1&b=2', title: 'A & B' }],
    renderChatMarkdown: MK, escHtml: esc, t: T,
  });
  // url + title beide escaped — NICHT der citae-Inner 'x' (der durch markdown).
  assert.deepEqual(escCalls, ['https://a.example/path?a=1&b=2', 'A & B']);
  assert.ok(out.includes('ESC(https://a.example/path?a=1&b=2)'));
  assert.ok(out.includes('data-tip="ESC(A & B)"'));
});

test('citedSources: distinkt nach url, sortiert nach Index', () => {
  const sources = [
    { url: 'https://c.example', title: 'C' },
    { url: 'https://a.example', title: 'A' },
    { url: 'https://a.example', title: 'A-Dup' },   // dieselbe URL, ignoriert
  ];
  const text = '<cite index="2-1">x</cite>, <cite index="3-2">y</cite>, <cite index="1-1">z</cite>';
  const out = citedSources(text, sources);
  assert.deepEqual(out, [
    { n: 1, url: 'https://c.example', title: 'C' },
    { n: 2, url: 'https://a.example', title: 'A' },
  ]);
});

test('citedSources: leere Sources → []', () => {
  assert.deepEqual(citedSources('<cite index="1">x</cite>', []), []);
});

test('citedSources: Index ohne Source wird übersprungen', () => {
  const sources = [{ url: 'https://a.example', title: 'A' }];
  const out = citedSources('<cite index="1-1">x</cite><cite index="3-1">y</cite>', sources);
  // Index 1 → ok, Index 3 → keine Source → nicht in der Liste.
  assert.deepEqual(out, [{ n: 1, url: 'https://a.example', title: 'A' }]);
});
// ── Geprüfte Belege (final_answer.quellen → context_info.answer_sources) ────

const SRCS = [
  { url: 'https://a.example', title: 'A' },
  { url: 'https://b.example', title: 'B' },
  { url: 'https://c.example', title: 'C' },
];
const ANS = [
  { url: 'https://c.example', title: 'C-Beleg', doc_nums: [3] },
  { url: 'https://a.example', title: 'A-Beleg', doc_nums: [1] },
];

test('displaySources: answer_sources haben Vorrang und werden 1..k nummeriert', () => {
  const out = displaySources('<cite index="2-1">x</cite>', SRCS, ANS);
  assert.deepEqual(out, [
    { n: 1, url: 'https://c.example', title: 'C-Beleg' },
    { n: 2, url: 'https://a.example', title: 'A-Beleg' },
  ]);
});

test('displaySources: ohne answer_sources → Fallback auf cite-Marker', () => {
  const out = displaySources('<cite index="2-1">x</cite>', SRCS, []);
  assert.deepEqual(out, [{ n: 2, url: 'https://b.example', title: 'B' }]);
});

test('renderResearchAnswer: Marker nimmt die Nummer der Belegliste (über doc_nums)', () => {
  const html = renderResearchAnswer({
    text: 'Fakt <cite index="3-1">eins</cite>.', sources: SRCS, answerSources: ANS,
    renderChatMarkdown: MK, escHtml: ID, t: T,
  });
  assert.match(html, /href="https:\/\/c\.example"[^>]*>1<\/a>/);
});

test('renderResearchAnswer: zitierter, aber nicht belegter Treffer → Link ohne Nummer', () => {
  const html = renderResearchAnswer({
    text: 'Fakt <cite index="2-1">zwei</cite>.', sources: SRCS, answerSources: ANS,
    renderChatMarkdown: MK, escHtml: ID, t: T,
  });
  assert.match(html, /chat-cite--loose/);
  assert.match(html, /href="https:\/\/b\.example"/);
  assert.doesNotMatch(html, />2<\/a>/);
});

test('effectiveAnswerText: leer/Abbruch + Vorschläge → proposalsOnly-Marker', () => {
  assert.equal(effectiveAnswerText('', 2), '__i18n:recherche.chat.proposalsOnly__');
  assert.equal(effectiveAnswerText('__i18n:chat.errors.emptyAnswer__', 1), '__i18n:recherche.chat.proposalsOnly__');
  assert.equal(effectiveAnswerText('__i18n:chat.errors.maxIterReached__', 0), '__i18n:chat.errors.maxIterReached__');
  assert.equal(effectiveAnswerText('Text', 4), 'Text');
  const html = renderResearchAnswer({ text: '', sources: [], proposalCount: 1, renderChatMarkdown: MK, escHtml: ID, t: T });
  assert.equal(html, '[i18n]recherche.chat.proposalsOnly');
});

// ── Suchweg SearXNG: [n]-Belege ──────────────────────────────────────────────

const WEB = [{ url: 'https://a.ch/', title: 'A' }, { url: 'https://b.ch/', title: 'B' }, { url: 'https://c.ch/', title: 'C' }];

test('[n]-Belege: werden zu Links auf den n-ten Treffer, Listen [1, 3] zu zwei Markern', () => {
  const html = render('Eröffnet 2016 [2]. Länge 57 km [1, 3].', WEB);
  assert.match(html, /2016<sup class="chat-cite"><a href="https:\/\/b\.ch\/"[^>]*>2<\/a><\/sup>\./);
  assert.match(html, /km<sup class="chat-cite"><a href="https:\/\/a\.ch\/"[^>]*>1<\/a><\/sup><sup class="chat-cite"><a href="https:\/\/c\.ch\/"[^>]*>3<\/a><\/sup>\./);
  assert.ok(!html.includes('[2]'));
});

test('[n]-Belege: unbekannte Nummer, Markdown-Link und Antwort ohne Treffer bleiben Text', () => {
  assert.ok(render('Siehe [7].', WEB).includes('[7]'));
  assert.ok(render('[3](https://x.ch/)', WEB).includes('[3](https://x.ch/)'));
  assert.equal(render('Liste [1].', []), 'Liste [1].');
});

test('[n]-Belege: Antwort mit cite-Markern rendert unverändert (Anthropic-Weg)', () => {
  const html = render('<cite index="1-1">Satz</cite> und [2].', WEB);
  assert.ok(html.includes('[2]'), '[2] bleibt Text, wenn cite-Marker im Spiel sind');
  assert.match(html, /Satz<sup class="chat-cite"><a href="https:\/\/a\.ch\/"/);
});

test('[n]-Belege: mit answer_sources trägt der Marker die Nummer der Belegliste', () => {
  const html = renderResearchAnswer({
    text: 'Fakt [3].', sources: WEB,
    answerSources: [{ url: 'https://c.ch/', title: 'C', doc_nums: [3] }],
    renderChatMarkdown: MK, escHtml: ID, t: T,
  });
  assert.match(html, /<a href="https:\/\/c\.ch\/"[^>]*>1<\/a>/);
});

test('displaySources/citedSources: Fallback-Liste aus [n]-Belegen', () => {
  assert.deepEqual(citedSources('A [3], B [1] und [3].', WEB).map(s => s.n), [1, 3]);
  assert.deepEqual(displaySources('A [2].', WEB, []).map(s => s.url), ['https://b.ch/']);
});

// Modell nummeriert nach der eigenen Quellenliste statt nach den Trefferzahlen
// (echter Lauf, qwen3.8): [2]/[3] meinen die 2./3. genannte Quelle, zeigten aber
// auf den 2./3. Suchtreffer — fremde Seiten.
const WEB8 = Array.from({ length: 8 }, (_, i) => ({ url: `https://t${i + 1}.ch/`, title: `T${i + 1}` }));
const ANS_LOCAL = [
  { url: 'https://t1.ch/', title: 'Einwohner', doc_nums: [1] },
  { url: 'https://t6.ch/', title: 'Hansen', doc_nums: [6] },
  { url: 'https://t7.ch/', title: 'Ostseehandel', doc_nums: [7] },
];

test('[n]-Belege: Nummerierung nach eigener Quellenliste → keine Links auf fremde Treffer', () => {
  const text = 'Rund 25.600 [1]. Roggen vor Weizen [2]. Hansen 1912 [3].';
  assert.equal(listLocalNumbering(text, ANS_LOCAL), true);
  const html = renderResearchAnswer({ text, sources: WEB8, answerSources: ANS_LOCAL, renderChatMarkdown: MK, escHtml: ID, t: T });
  assert.ok(!html.includes('t2.ch') && !html.includes('t3.ch'), 'kein Link auf nicht belegte Treffer');
  assert.ok(!/\[\d\]/.test(html), 'Marker entfernt');
  assert.match(html, /Hansen 1912\./);
});

test('[n]-Belege: korrekte Trefferzahlen bleiben verlinkt (Gegenprobe)', () => {
  const text = 'Rund 25.600 [1]. Hansen 1912 [6]. Ostseehandel [7].';
  assert.equal(listLocalNumbering(text, ANS_LOCAL), false);
  const html = renderResearchAnswer({ text, sources: WEB8, answerSources: ANS_LOCAL, renderChatMarkdown: MK, escHtml: ID, t: T });
  assert.match(html, /<a href="https:\/\/t6\.ch\/"[^>]*>2<\/a>/);
  assert.match(html, /<a href="https:\/\/t7\.ch\/"[^>]*>3<\/a>/);
});

test('listLocalNumbering: einzelner Beleg oder Nummer über der Belegliste → nicht als lokal gewertet', () => {
  assert.equal(listLocalNumbering('Fakt [2].', ANS_LOCAL), false);
  assert.equal(listLocalNumbering('A [1]. B [2]. C [5].', ANS_LOCAL), false);
  assert.equal(listLocalNumbering('A [1]. B [2].', []), false);
});
