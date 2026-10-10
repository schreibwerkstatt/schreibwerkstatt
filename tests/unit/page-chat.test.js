'use strict';
// Seiten-Chat (kind='page'): Antwort-Parsing (Vorschläge, Titelvarianten,
// Parse-Fallback), Kontext-Budget (Seiten-Deckel, Änderungs-Diff statt zweiter
// Vollfassung, Verlauf gekürzt), Verlauf mit Vorschlags-Status, Fehlerpfad bei
// nicht ladbarer Seite. callAIChat ist gemockt.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('page-chat');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const ai = require('../../lib/ai');

// Mock VOR dem Require des Jobs: page-chat.js destrukturiert callAIChat beim Laden.
const aiCalls = [];
let nextReply = () => JSON.stringify({ antwort: 'ok', vorschlaege: [], titel_varianten: [] });
ai.callAIChat = async (messages, system) => {
  aiCalls.push({ messages: structuredClone(messages), system });
  const text = nextReply();
  return { text, truncated: false, tokensIn: 10, tokensOut: 5, provider: 'claude', model: 'test', genDurationMs: 5 };
};

const { _parseChatResponse, _sanitizeVorschlaege, _sanitizeTitelVarianten } = require('../../routes/jobs/chat/shared');
const { pageChatBudget, computePageChangeHunks, fitHistory } = require('../../routes/jobs/chat/page-chat-context');
const { buildChatMessageHistory, createJob, jobs } = require('../../routes/jobs/shared');
const { runChatJob } = require('../../routes/jobs/chat/page-chat');

const USER = 'pagechat@example.com';
const BOOK = 82001;
const PAGE = 82011;
appUsers.createUser({ email: USER });
db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'PC', datetime('now'), datetime('now'))`).run(BOOK);
db.prepare(`INSERT INTO pages (page_id, book_id, page_name, body_html, updated_at) VALUES (?, ?, 'Seite 1', ?, datetime('now'))`)
  .run(PAGE, BOOK, '<p>Der Hund bellt laut. Die Katze schläft.</p>');

const sysText = (system) => (Array.isArray(system) ? system.map(b => b.text).join('\n') : String(system));

function newSession({ pageId = PAGE, opening = null } = {}) {
  return db.prepare(`INSERT INTO chat_sessions (book_id, page_id, kind, user_email, title, opening_page_text, created_at, last_message_at)
                     VALUES (?, ?, 'page', ?, 'T', ?, datetime('now'), datetime('now'))`).run(BOOK, pageId, USER, opening).lastInsertRowid;
}
let tsCounter = 0;
function addMsg(sessionId, role, content, vorschlaege = null) {
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, tsCounter++)).toISOString();
  return db.prepare(`INSERT INTO chat_messages (session_id, role, content, vorschlaege, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(sessionId, role, content, vorschlaege ? JSON.stringify(vorschlaege) : null, ts).lastInsertRowid;
}
async function runJob(sessionId, message) {
  const userMsgId = addMsg(sessionId, 'user', message);
  const jobId = createJob('chat', BOOK, USER, 'job.label.chat', null, sessionId);
  await runChatJob(jobId, sessionId, userMsgId, message, USER);
  return jobs.get(jobId);
}

// ── Parsing ──────────────────────────────────────────────────────────────────

test('_parseChatResponse: Vorschläge + Titelvarianten aus validem JSON', () => {
  const r = _parseChatResponse(JSON.stringify({
    antwort: 'Hier.',
    vorschlaege: [{ original: 'bellt laut', ersatz: 'bellt leise', begruendung: 'ruhiger' }],
    titel_varianten: ['«Nachtwache»', 'Nachtwache', 'Der stille Hund'],
  }));
  assert.equal(r.fallback, false);
  assert.equal(r.lostVorschlaege, false);
  assert.deepEqual(r.vorschlaege, [{ original: 'bellt laut', ersatz: 'bellt leise', begruendung: 'ruhiger' }]);
  assert.deepEqual(r.titel_varianten, ['Nachtwache', 'Der stille Hund']);
});

test('_parseChatResponse: kaputtes JSON mit Vorschlägen → Fallback + lostVorschlaege', () => {
  // Fehlendes Komma + Müll dahinter: auch jsonrepair gibt hier auf.
  const broken = '{"antwort": "x", "vorschlaege": [{"original": "a" "ersatz": "b"}}} trailing { broken';
  const r = _parseChatResponse(broken);
  assert.equal(r.fallback, true);
  assert.equal(r.lostVorschlaege, true);
  assert.deepEqual(r.vorschlaege, []);
  assert.deepEqual(r.titel_varianten, []);
});

test('_parseChatResponse: Prosa ohne Vorschläge → Fallback ohne lostVorschlaege', () => {
  const r = _parseChatResponse('Einfach nur Text.');
  assert.equal(r.fallback, true);
  assert.equal(r.lostVorschlaege, false);
});

test('_sanitizeVorschlaege: leere/identische raus, Status-Felder des Modells verworfen', () => {
  const out = _sanitizeVorschlaege([
    { original: 'a', ersatz: 'b', applied: true, status: 'discarded', begruendung: '' },
    { original: ' ', ersatz: 'x' },
    { original: 'gleich', ersatz: 'gleich' },
    { original: 'c', ersatz: 42 },
    null,
  ]);
  assert.deepEqual(out, [{ original: 'a', ersatz: 'b' }]);
  assert.deepEqual(_sanitizeVorschlaege('kein array'), []);
});

test('_sanitizeTitelVarianten: trimmt, entquotet, dedupliziert, deckelt auf 5', () => {
  const out = _sanitizeTitelVarianten([
    '  „Der  Titel“ ', 'der titel', 'Das «Ende» naht', 7, '', 'x'.repeat(201),
    'A', 'B', 'C', 'D', 'E',
  ]);
  assert.deepEqual(out, ['Der Titel', 'Das «Ende» naht', 'A', 'B', 'C']);
  assert.deepEqual(_sanitizeTitelVarianten(undefined), []);
});

// ── Kontext-Budget ───────────────────────────────────────────────────────────

test('computePageChangeHunks: null bei gleichem Stand, sonst kompakte Hunks', () => {
  assert.equal(computePageChangeHunks('Gleich.', 'Gleich.'), null);
  assert.equal(computePageChangeHunks('', 'Neu.'), null);
  const before = 'Anfang. ' + 'Füllwort '.repeat(30) + 'Der Hund bellt laut. Ende.';
  const after = 'Anfang. ' + 'Füllwort '.repeat(30) + 'Der Hund bellt leise. Ende.';
  const c = computePageChangeHunks(before, after);
  assert.equal(c.hunks.length, 1);
  assert.equal(c.hunks[0].removed, 'laut');
  assert.equal(c.hunks[0].added, 'leise');
  assert.ok(c.hunks[0].before.length <= 61, 'Kontext gedeckelt');
  assert.equal(c.heavy, false);
  assert.equal(c.omitted, 0);
});

test('computePageChangeHunks: Budget kappt Hunks und weist den Rest aus', () => {
  // Jede zehnte Stelle geändert, mit genug Gleichtext dazwischen für eigene Hunks.
  const words = Array.from({ length: 400 }, (_, i) => `wort${i}`);
  const after = words.map((w, i) => (i % 10 === 0 ? w + 'x' : w)).join(' ');
  const c = computePageChangeHunks(words.join(' '), after, { maxChars: 300 });
  assert.ok(c.hunks.length > 0, 'mindestens ein Hunk');
  assert.ok(c.omitted > 0, 'Rest ausgewiesen');
  assert.equal(c.hunks.length + c.omitted, 40);
  assert.equal(c.heavy, false);
});

test('fitHistory: älteste zuerst raus, erste verbleibende ist eine User-Nachricht', () => {
  const h = [
    { role: 'user', content: 'u1'.repeat(200) },
    { role: 'assistant', content: 'a1'.repeat(200) },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
  ];
  const all = fitHistory(h, 100000);
  assert.equal(all.dropped, 0);
  assert.equal(all.messages.length, 4);
  const cut = fitHistory(h, 400);
  assert.equal(cut.dropped, 2);
  assert.equal(cut.messages[0].role, 'user');
  assert.equal(cut.messages[0].content, 'u2');
  const none = fitHistory(h, 0);
  assert.equal(none.messages.length, 0);
});

test('pageChatBudget: Seite ≤ 45 %, Gesamt ≤ 90 % des Input-Budgets', () => {
  const b = pageChatBudget({ inputBudgetChars: 100000 });
  assert.equal(b.pageMax, 45000);
  assert.equal(b.total, 90000);
  assert.ok(b.changeNoteMax >= 1000 && b.changeNoteMax <= 6000);
});

// ── Verlauf mit Vorschlags-Status ────────────────────────────────────────────

test('buildChatMessageHistory: annotate hängt Vorschläge samt Status an; ohne annotate unverändert', async () => {
  const { formatHistoryVorschlaege } = await import('../../public/js/prompts.js');
  const sid = newSession();
  addMsg(sid, 'user', 'Frage');
  addMsg(sid, 'assistant', 'Antwort', [
    { original: 'bellt laut', ersatz: 'bellt leise', applied: true },
    { original: 'Die Katze', ersatz: 'Die alte Katze', status: 'discarded' },
    { original: 'schläft', ersatz: 'döst' },
  ]);
  const plain = buildChatMessageHistory(sid);
  assert.equal(plain[1].content, 'Antwort');
  const annotated = buildChatMessageHistory(sid, {
    annotate: (r) => (r.role === 'assistant' && r.vorschlaege ? formatHistoryVorschlaege(JSON.parse(r.vorschlaege)) : ''),
  });
  assert.match(annotated[1].content, /\[übernommen\] «bellt laut» → «bellt leise»/);
  assert.match(annotated[1].content, /\[verworfen\]/);
  assert.match(annotated[1].content, /\[offen\] «schläft» → «döst»/);
});

// ── Job ──────────────────────────────────────────────────────────────────────

test('runChatJob: Verlauf trägt frühere Vorschläge, Titelvarianten landen in context_info', async () => {
  const sid = newSession();
  addMsg(sid, 'user', 'Erste Frage');
  addMsg(sid, 'assistant', 'Erste Antwort', [{ original: 'bellt laut', ersatz: 'bellt leise', applied: true }]);
  nextReply = () => JSON.stringify({ antwort: 'Titel:', vorschlaege: [], titel_varianten: ['Hundenacht', 'Bellen'] });
  aiCalls.length = 0;
  const job = await runJob(sid, 'Gib mir Titel');
  assert.equal(job.status, 'done', job.error);
  const { messages, system } = aiCalls[0];
  assert.equal(messages.at(-1).content, 'Gib mir Titel');
  assert.match(messages[1].content, /\[übernommen\]/);
  assert.match(sysText(system), /titel_varianten/);
  const row = db.prepare(`SELECT context_info FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`).get(sid);
  assert.deepEqual(JSON.parse(row.context_info), { titel_varianten: ['Hundenacht', 'Bellen'] });
});

test('runChatJob: geänderte Seite → Diff-Abschnitt statt zweiter Vollfassung', async () => {
  const sid = newSession({ opening: 'Der Hund bellt sehr laut. Die Katze schläft.' });
  nextReply = () => JSON.stringify({ antwort: 'ok', vorschlaege: [], titel_varianten: [] });
  aiCalls.length = 0;
  const job = await runJob(sid, 'Was hat sich geändert?');
  assert.equal(job.status, 'done', job.error);
  const sys = sysText(aiCalls[0].system);
  assert.match(sys, /ÄNDERUNGEN DES AUTORS SEIT CHAT-START/);
  assert.match(sys, /\[-sehr-\]/);
  assert.ok(!sys.includes('Der Hund bellt sehr laut. Die Katze schläft.'), 'keine zweite Vollfassung');
});

test('runChatJob: kaputtes JSON → context_info.parse_fallback + lost_vorschlaege', async () => {
  const sid = newSession();
  nextReply = () => '{"antwort": "x", "vorschlaege": [{"original": "a" "ersatz": "b"}}} trailing { broken';
  const job = await runJob(sid, 'Verbessere');
  assert.equal(job.status, 'done', job.error);
  const row = db.prepare(`SELECT context_info, vorschlaege FROM chat_messages WHERE session_id = ? AND role = 'assistant'`).get(sid);
  assert.deepEqual(JSON.parse(row.context_info), { parse_fallback: true, lost_vorschlaege: true });
  assert.equal(row.vorschlaege, null);
});

test('runChatJob: Seite nicht ladbar → Job-Fehler mit i18n-Key statt Antwort über leere Seite', async (t) => {
  const contentStore = require('../../lib/content-store');
  const realLoad = contentStore.loadPage;
  contentStore.loadPage = async () => { throw Object.assign(new Error('weg'), { status: 404 }); };
  t.after(() => { contentStore.loadPage = realLoad; });
  const sid = newSession();
  aiCalls.length = 0;
  const job = await runJob(sid, 'Hallo?');
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.pageChatLoadFailed');
  assert.equal(aiCalls.length, 0, 'kein KI-Call');
});

test('runChatJob: langer Verlauf wird gekürzt (älteste zuerst) und ausgewiesen statt die Session zu töten', async () => {
  // Nachrichtengrösse am echten Budget des effektiven Providers ausrichten:
  // zwölf Nachrichten à einem Viertel des Gesamtbudgets = dreifacher Überlauf.
  const { getContextConfigFor, resolveProvider } = require('../../lib/ai');
  const per = Math.ceil(pageChatBudget(getContextConfigFor(resolveProvider({ userEmail: USER }))).total / 4);
  const sid = newSession();
  for (let i = 0; i < 6; i++) {
    addMsg(sid, 'user', `Frage ${i} ` + 'x'.repeat(per));
    addMsg(sid, 'assistant', `Antwort ${i} ` + 'y'.repeat(per));
  }
  nextReply = () => JSON.stringify({ antwort: 'kurz', vorschlaege: [], titel_varianten: [] });
  aiCalls.length = 0;
  const job = await runJob(sid, 'Und jetzt?');
  assert.equal(job.status, 'done', job.error);
  const { messages } = aiCalls[0];
  assert.equal(messages[0].role, 'user');
  assert.ok(/ältere Nachrichten dieses Gesprächs wurden aus Platzgründen weggelassen/.test(messages[0].content), 'Kürzungs-Hinweis vorn');
  assert.ok(!messages.some(m => m.content.includes('Frage 0 ')), 'älteste Runde fehlt');
  assert.ok(messages.some(m => m.content.includes('Antwort 5 ')), 'jüngste Runde bleibt');
  const row = db.prepare(`SELECT context_info FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`).get(sid);
  assert.ok(JSON.parse(row.context_info).history_trimmed > 0);
});

test('runChatJob: Seite über dem Deckel → eigener Fehler statt Kontext-Überlauf', async () => {
  const { getContextConfigFor, resolveProvider } = require('../../lib/ai');
  const { pageMax } = pageChatBudget(getContextConfigFor(resolveProvider({ userEmail: USER })));
  const BIG = 82012;
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, body_html, updated_at) VALUES (?, ?, 'Gross', ?, datetime('now'))`)
    .run(BIG, BOOK, '<p>' + 'Wort '.repeat(Math.ceil(pageMax / 5) + 100) + '</p>');
  const sid = newSession({ pageId: BIG });
  aiCalls.length = 0;
  const job = await runJob(sid, 'Hallo?');
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.pageChatPageTooLarge');
  assert.equal(aiCalls.length, 0);
});

// ── Fundstellen-Prüfung beim Erzeugen (routes/jobs/chat/page-chat-verify.js) ──
test('_sanitizeVorschlaege: original/ersatz getrimmt gespeichert', () => {
  assert.deepEqual(_sanitizeVorschlaege([{ original: ' bellt laut ', ersatz: 'bellt leise ' }]),
    [{ original: 'bellt laut', ersatz: 'bellt leise' }]);
});

test('runChatJob: original gegen den Abschnittstext geprüft → match not_found/ambiguous, Modell-Feld verworfen', async () => {
  const pageId = 82091;
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, body_html, updated_at) VALUES (?, ?, 'Seite 2', ?, datetime('now'))`)
    .run(pageId, BOOK, '<p>Sie sagte: «Komm her». Er kam.</p><p>Er kam.</p>');
  const sid = newSession({ pageId });
  nextReply = () => JSON.stringify({
    antwort: 'Vorschläge',
    vorschlaege: [
      { original: 'sagte: "Komm her"', ersatz: 'rief: "Komm her"', match: 'not_found' },
      { original: 'Er kam.', ersatz: 'Er ging.' },
      { original: 'Das steht nirgends', ersatz: 'Anders' },
    ],
    titel_varianten: [],
  });
  aiCalls.length = 0;
  const job = await runJob(sid, 'Verbessere');
  assert.equal(job.status, 'done', job.error);
  // Prompt-Text mit Absatzgrenze (htmlToTextForPrompt).
  assert.match(sysText(aiCalls[0].system), /Er kam\.\n\nEr kam\./);
  const row = db.prepare(`SELECT vorschlaege FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`).get(sid);
  const vs = JSON.parse(row.vorschlaege);
  assert.equal(vs[0].match, undefined, 'Anführungszeichen-Variante gilt als gefunden; Modell-`match` verworfen');
  assert.equal(vs[1].match, 'ambiguous');
  assert.equal(vs[2].match, 'not_found');
});

test('formatHistoryVorschlaege: nicht gefundener offener Vorschlag wird markiert', async () => {
  const { formatHistoryVorschlaege } = await import('../../public/js/prompts.js');
  const out = formatHistoryVorschlaege([{ original: 'a', ersatz: 'b', match: 'not_found' }, { original: 'c', ersatz: 'd' }]);
  assert.match(out, /\[offen, Stelle nicht im Text gefunden\] «a»/);
  assert.match(out, /\[offen\] «c»/);
});
