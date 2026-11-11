// Recherche-Karte (Board + Interview-Slot + Chat-Abbruch): Abläufe, die nur
// über mehrere awaits hinweg sichtbar werden — Rückfrage-Wege, Buch-/Item-Wechsel
// mitten im Request, parallele Läufe je Fundstück. Die Methoden-Objekte werden mit
// einem schlichten `this` aufgerufen (wie in research-status.test.mjs); fetch,
// Alpine-Store und Root (`window.__app`) sind Attrappen.
import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

globalThis.window = globalThis;
const nav = { selectedBookId: 1, rechercheItemId: null };
globalThis.Alpine = { store: (name) => (name === 'nav' ? nav : name === 'badges' ? {} : { jobQueueItems: [] }) };

let calls = [];
let responder = () => ({ status: 200, body: {} });
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  const { status = 200, body = {} } = (await responder(String(url), opts, calls.length)) || {};
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() { return this; },
  };
};

const tKey = (k, p) => (p && Object.keys(p).length ? `${k}|${JSON.stringify(p)}` : k);
let confirmAnswer = true;
let cancelled = [];
globalThis.__app = {
  t: tKey,
  tn: (k, n, p) => tKey(n === 1 ? `${k}One` : k, { ...p, n }),
  appConfirm: async () => confirmAnswer,
  cancelJob: async (id) => { cancelled.push(id); },
  _showJobToast() {},
};

const { rechercheScrapeMethods } = await import('../../public/js/book/recherche/scrape.js');
const { rechercheLinkMethods } = await import('../../public/js/book/recherche/links.js');
const { rechercheBoardMethods } = await import('../../public/js/book/recherche/board.js');
const { rechercheItemMethods } = await import('../../public/js/book/recherche/items.js');
const { rechercheMediaMethods } = await import('../../public/js/book/recherche/media.js');
const { rechercheInterviewMethods, rechercheInterviewState } = await import('../../public/js/book/recherche/interview.js');
const { rechercheBulkState } = await import('../../public/js/book/recherche/bulk.js');
const { rechercheCrosscheckState } = await import('../../public/js/book/recherche/crosscheck.js');
const { makeChatMethods } = await import('../../public/js/chat/chat-base.js');

function card(extra = {}) {
  const c = {
    items: [], errorMessage: '', busy: false, loading: false, refreshing: false,
    suggestions: {}, suggestRunning: {}, _suggestTimers: {},
    _scrapeBusy: {}, _memos: {}, detailItemId: null, detailEditing: false,
    linkPickerItemId: null, linkCheckRunning: false, linkCheckStatus: '', _linkCheckTimer: null,
    filterKind: '', filterTag: '', filterLinked: '', filterText: '',
    ...rechercheCrosscheckState(), ...rechercheBulkState(), ...rechercheInterviewState(),
    _ivPollTimer: null, _ivLoadSeq: 0,
    $refs: {},
    ...rechercheBoardMethods, ...rechercheLinkMethods, ...rechercheScrapeMethods,
    ...rechercheItemMethods, ...rechercheMediaMethods, ...rechercheInterviewMethods,
    // Karten-Umgebung (Popover, Dialoge, Nebenlesungen) — nicht Testgegenstand.
    closeActionMenu() {}, _releasePickerPopover() {},
    closeDetail() { this.detailItemId = null; }, closeCreate() {},
    _refreshRechercheCounts() {}, _loadTags() {},
    ...extra,
  };
  return c;
}

beforeEach(() => {
  calls = [];
  responder = () => ({ status: 200, body: {} });
  confirmAnswer = true;
  cancelled = [];
  nav.selectedBookId = 1;
});

test('scrape: «Überschreiben» schickt den zweiten Request mit overwrite (Busy-Guard sperrt ihn nicht)', async () => {
  const c = card();
  const item = { id: 7 }; const u = { url_id: 3 };
  responder = (url, opts, n) => (n === 1
    ? { body: { item: { id: 7 }, filled: [], skipped: ['title'] } }
    : { body: { item: { id: 7, title: 'neu' }, filled: ['title'], skipped: [] } });
  c.items = [{ id: 7 }];
  await c.scrapeUrl(item, u);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].opts.body).overwrite, true);
  assert.deepEqual(c._scrapeBusy, {});
  assert.equal(c.items[0].title, 'neu');
});

test('scrape: abgelehnte Rückfrage schickt nichts weiter', async () => {
  const c = card();
  confirmAnswer = false;
  responder = () => ({ body: { filled: [], skipped: ['body'] } });
  await c.scrapeUrl({ id: 7 }, { url_id: 3 });
  assert.equal(calls.length, 1);
});

test('addLink liefert true/false; acceptSuggestion filtert nur bei Erfolg', async () => {
  const c = card();
  const item = { id: 5 };
  const sugg = { target_kind: 'figure', target_id: 9 };
  c.items = [{ id: 5 }];
  c.suggestions = { 5: [sugg] };
  responder = () => ({ status: 500, body: {} });
  await c.acceptSuggestion(item, sugg);
  assert.equal(c.suggestions[5].length, 1, 'Fehlschlag: Vorschlag bleibt stehen');
  responder = () => ({ body: { id: 5, links: [] } });
  await c.acceptSuggestion(item, sugg);
  assert.equal(c.suggestions[5].length, 0);
});

test('KI-Vorschläge: parallel je Fundstück, Sperre je Fundstück, Reset stoppt alle Poller', async () => {
  const c = card();
  let job = 0;
  responder = (url) => (url === '/jobs/research-link' ? { body: { jobId: `j${++job}` } } : { body: { status: 'running' } });
  await c.suggestLinks({ id: 1 });
  await c.suggestLinks({ id: 2 });
  await c.suggestLinks({ id: 1 }); // gesperrt: läuft schon
  assert.equal(calls.filter(x => x.url === '/jobs/research-link').length, 2);
  assert.ok(c.suggestBusy(1) && c.suggestBusy(2));
  assert.ok(c._suggestTimers['1'] && c._suggestTimers['2']);
  const holder = c._suggestTimers;
  c.resetRecherche();
  assert.equal(holder['1'], null);
  assert.equal(holder['2'], null);
  assert.deepEqual(c.suggestRunning, {});
});

test('resetRecherche setzt Lauf-, Dialog- und Auswahl-State zurück', () => {
  const c = card();
  Object.assign(c, {
    busy: true, detailEditing: true, linkPickerItemId: 3, linkCheckRunning: true, linkCheckStatus: 'x',
    crosscheckRunning: true, crosscheckItemId: 4, crosscheckStatus: 'y', bulkMode: true, selectedIds: [1, 2],
    _linkCheckTimer: setInterval(() => {}, 1e6), _crosscheckTimer: setInterval(() => {}, 1e6),
  });
  c.resetRecherche();
  assert.equal(c.busy, false);
  assert.equal(c.detailEditing, false);
  assert.equal(c.linkPickerItemId, null);
  assert.equal(c.linkCheckRunning, false);
  assert.equal(c.linkCheckStatus, '');
  assert.equal(c.crosscheckRunning, false);
  assert.equal(c.crosscheckItemId, null);
  assert.equal(c.crosscheckStatus, '');
  assert.equal(c.bulkMode, false);
  assert.deepEqual(c.selectedIds, []);
  assert.equal(c._linkCheckTimer, null);
  assert.equal(c._crosscheckTimer, null);
});

test('togglePin lädt neu (Server-Reihenfolge je sortBy) statt lokal zu sortieren', async () => {
  let loads = 0;
  const c = card({ loadRecherche: async () => { loads++; } });
  c.items = [{ id: 1, pinned: 0 }];
  responder = () => ({ body: { id: 1, pinned: 1 } });
  await c.togglePin(c.items[0]);
  assert.equal(loads, 1);
  assert.equal(c.items[0].pinned, 1);
});

test('createItem: Buchwechsel während des POST verwirft die Antwort', async () => {
  const c = card();
  c.draft = { kind: 'note', title: 'T', body: '', urls: [], source: '', tags: '' };
  responder = () => { nav.selectedBookId = 2; return { body: { id: 99 } }; };
  await c.createItem();
  assert.deepEqual(c.items, []);
  assert.equal(c.busy, false);
});

test('createItem: gescheiterter Anhang öffnet das neue Fundstück und behält die Meldung', async () => {
  let opened = null;
  // openDetail schliesst das Anlegen, closeCreate leert die Meldung — sie muss
  // danach trotzdem stehen.
  const c = card({ openDetail(it) { opened = it.id; this.errorMessage = ''; } });
  c.draft = { kind: 'note', title: 'T', body: '', urls: [], source: '', tags: '' };
  c.creating = true;
  c.$refs = {
    createFile: { files: [{ name: 'a.png', type: 'image/png', arrayBuffer: async () => new ArrayBuffer(1) }] },
  };
  responder = (url) => (url === '/research' ? { body: { id: 42 } } : { status: 500, body: {} });
  await c.createItem();
  assert.equal(opened, 42);
  assert.equal(c.errorMessage, 'recherche.error.image');
});

test('_rechercheErrorText: übersetzter error_code vor dem Fallback', () => {
  const c = card();
  const realT = __app.t;
  __app.t = (k, p) => (k === 'error.INVALID_URL' ? 'URL falsch' : tKey(k, p));
  assert.equal(c._rechercheErrorText({ code: 'INVALID_URL', body: {} }, 'recherche.error.save'), 'URL falsch');
  assert.equal(c._rechercheErrorText({ code: 'UNBEKANNT', body: {} }, 'recherche.error.save'), 'recherche.error.save');
  assert.equal(c._rechercheErrorText(new Error('x'), 'recherche.error.load'), 'recherche.error.load');
  __app.t = realT;
});

test('urlCheckTip: DNS und INVALID haben eigene Texte, Unbekanntes fällt auf NETWORK', () => {
  const c = card();
  assert.equal(c.urlCheckTip({ check_error: 'DNS' }), 'recherche.linkCheck.err.DNS');
  assert.equal(c.urlCheckTip({ check_error: 'INVALID' }), 'recherche.linkCheck.err.INVALID');
  assert.equal(c.urlCheckTip({ check_error: 'WAS_NEUES' }), 'recherche.linkCheck.err.NETWORK');
});

test('_ivPatchItem ersetzt das Item per Reassign (neue items-Referenz)', () => {
  const c = card();
  const before = [{ id: 1, kind: 'note', title: 'a' }];
  c.items = before;
  c._ivPatchItem({ id: 1, kind: 'transcript' });
  assert.notEqual(c.items, before);
  assert.deepEqual(c.items[0], { id: 1, kind: 'transcript', title: 'a' });
});

test('ivLoadTranscript: späte Antwort für ein anderes Fundstück wird verworfen', async () => {
  const c = card();
  c.detailItemId = 1;
  let release;
  responder = () => new Promise(r => { release = () => r({ body: { transcript: { status: 'done' }, segments: [{ t: 1 }] } }); });
  const p = c.ivLoadTranscript(1);
  c.detailItemId = 2;
  c.ivTranscript = { status: 'pending', mine: 2 };
  release();
  await p;
  assert.deepEqual(c.ivTranscript, { status: 'pending', mine: 2 });
  assert.deepEqual(c.ivSegments, []);
});

test('Transkript läuft: Poll über die aktive Job-ID wieder aufnehmen; ohne Job keine Sperre', async () => {
  const polled = [];
  const c = card({ _ivPoll(jobId, itemId) { polled.push([jobId, itemId]); } });
  c.detailItemId = 3;
  responder = (url) => (url.startsWith('/jobs/active')
    ? { body: { jobId: 'job-3' } }
    : { body: { transcript: { status: 'running' }, segments: [] } });
  await c.ivLoadTranscript(3);
  assert.deepEqual(polled, [['job-3', 3]]);
  assert.equal(c.ivRunningItemId, 3);
  assert.ok(calls.some(x => x.url === '/jobs/active?type=interview-transcribe&book_id=i3'));

  const c2 = card({ _ivPoll() { polled.push('nie'); } });
  c2.detailItemId = 4;
  responder = (url) => (url.startsWith('/jobs/active')
    ? { body: { jobId: null } }
    : { body: { transcript: { status: 'running' }, segments: [] } });
  await c2.ivLoadTranscript(4);
  assert.equal(c2.ivRunningItemId, null, 'verwaister Lauf sperrt nicht');
  assert.equal(polled.length, 1);
});

test('Sprecher umbenennen nur am geladenen Transkript', async () => {
  const c = card();
  c.ivItemId = 1;
  c.ivSpeakerDraft = { S1: { label: 'Anna' } };
  await c.ivRenameSpeaker(2, 'S1');
  assert.equal(calls.length, 0);
  responder = () => ({ body: { speakers: { S1: { label: 'Anna' } } } });
  await c.ivRenameSpeaker(1, 'S1');
  assert.equal(c.ivSpeakers.S1.label, 'Anna');
});

test('chat-base: cancel<Label>Run bricht den aktiven Job der laufenden Session ab', async () => {
  for (const [label, type] of [['Chat', 'chat'], ['BookChat', 'book-chat'], ['ResearchChat', 'research-chat']]) {
    const lower = label[0].toLowerCase() + label.slice(1);
    const m = makeChatMethods({
      label, activeJobType: type,
      props: { runningSessionId: `${lower}RunningSessionId` },
    });
    const ctx = { ...m, [`${lower}RunningSessionId`]: 11 };
    calls = [];
    cancelled = [];
    responder = () => ({ body: { jobId: `${type}-job` } });
    await ctx[`cancel${label}Run`]();
    assert.equal(calls[0].url, `/jobs/active?type=${type}&book_id=11`);
    assert.deepEqual(cancelled, [`${type}-job`]);
    ctx[`${lower}RunningSessionId`] = null;
    calls = [];
    await ctx[`cancel${label}Run`]();
    assert.equal(calls.length, 0);
  }
});

test('Recherche-Chat: ungeprüfte URL ist vorab abgewählt, Vorschlag fällt aus «Alle speichern»', async () => {
  const { researchProposalMethods } = await import('../../public/js/chat/research-chat-proposals.js');
  const ctx = { ...researchProposalMethods, _proposalRemovedUrls: {}, _proposalEdits: {}, _proposalSaving: {} };
  const good = { url: 'https://a.example/x', verified: true };
  const bad = { url: 'https://b.example/y', verified: false };
  const msg = { id: 1, context_info: { proposals: [{ title: 'P', urls: [good, bad] }, { title: 'Q', urls: [good] }] } };
  assert.equal(ctx.isProposalUrlRemoved(msg, 0, bad), true);
  assert.equal(ctx.isProposalUrlRemoved(msg, 0, good), false);
  assert.deepEqual(ctx._proposalEditsPayload(msg, 0), { urls: [good.url] });
  assert.deepEqual(ctx.researchSavableProposals(msg).map(x => x.pi), [1]);
  ctx.toggleProposalUrl(msg, 0, bad); // ausdrücklich wieder aufnehmen
  assert.equal(ctx.isProposalUrlRisky(msg, 0, bad), true);
  assert.equal(ctx._proposalEditsPayload(msg, 0), null);
  assert.deepEqual(ctx.researchSavableProposals(msg).map(x => x.pi), [1]);
});

test('Abgleich: `failed` bekommt einen eigenen Hinweis', async () => {
  const { rechercheCrosscheckMethods } = await import('../../public/js/book/recherche/crosscheck.js');
  const c = card({ ...rechercheCrosscheckMethods, loadRecherche: async () => {} });
  responder = (url) => (url === '/jobs/research-crosscheck'
    ? { body: { jobId: 'cc' } }
    : { body: { status: 'done', result: { checked: 3, findings: 0, unchecked: 2, failed: 1 } } });
  await c.runCrosscheck();
  // Erster Poll-Tick nach dem Intervall (2 s) liefert das Ergebnis.
  for (let i = 0; i < 100 && c.crosscheckRunning; i++) await new Promise(r => setTimeout(r, 50));
  assert.match(c.crosscheckStatus, /recherche\.crosscheck\.doneClean/);
  assert.match(c.crosscheckStatus, /recherche\.crosscheck\.failedOne/);
});
