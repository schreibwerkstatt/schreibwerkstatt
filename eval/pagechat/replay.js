'use strict';
// Spielt echte Abschnitts-Chat-Fragen mit dem echten Job ab (routes/jobs/chat/
// page-chat.js#runChatJob über die Job-Queue), gegen eine Wegwerf-Kopie der Eval-DB.
// Der Aufrufer setzt DB_PATH auf diese Kopie, BEVOR dieses Modul geladen wird.
//
// Je Fall wird der Stand zur Fragezeit hergestellt:
//   - Verlauf: die Session enthält genau die Nachrichten bis einschliesslich der
//     Frage (frühere Antworten wie damals gespeichert, spätere entfernt);
//     `opening_page_text` wie damals (erste Runde: leer, der Job setzt ihn).
//   - Abschnitt: die jüngste Revision vor der Frage (page_revisions), über die
//     Content-Store-Facade gespeichert. Ohne Revision der heutige Stand.
// Nicht historisch: Figuren, Lektorat, Ideen, Buchbewertung, Embedding-Index —
// für den Vergleich zweier Varianten unerheblich, beide sehen denselben Stand.
// Der Sitzungstitel bleibt gesetzt, damit kein Titel-Call die Kosten verfälscht.

const VERLAUF_MAX_CHARS = 6000;

function _parse(json, fallback) {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

async function _waitJob(jobs, jobId, timeoutMs = 15 * 60 * 1000) {
  const t0 = Date.now();
  for (;;) {
    const job = jobs.get(jobId);
    if (job && ['done', 'error', 'cancelled'].includes(job.status)) return job;
    if (Date.now() - t0 > timeoutMs) throw new Error('Timeout');
    await new Promise(r => setTimeout(r, 400));
  }
}

function _checks(vorschlaege, ci, antwort) {
  return {
    parseFallback: !!ci.parse_fallback,
    vorschlaegeVerloren: !!ci.lost_vorschlaege,
    antwortLeer: !String(antwort || '').trim() || /^__i18n:/.test(String(antwort || '')),
    vorschlaege: vorschlaege.length,
    nichtGefunden: vorschlaege.filter(v => v.match === 'not_found').length,
    mehrdeutig: vorschlaege.filter(v => v.match === 'ambiguous').length,
    ohneAenderung: vorschlaege.filter(v => String(v.original || '').trim() === String(v.ersatz || '').trim()).length,
    gekappt: ci.vorschlaege_gekappt || 0,
    ideen: (ci.proposals || []).filter(p => !p.idee_id).length,
    ideenAenderungen: (ci.proposals || []).filter(p => p.idee_id).length,
    verlaufGekuerzt: ci.history_trimmed || 0,
  };
}

// shouldStop(): vor jedem Fall gefragt (Kostendeckel, Limit-Antwort); onResult(r): je Fall.
async function runCases(cases, { log = console.log, shouldStop = () => false, onResult = () => {} } = {}) {
  const { db } = require('../../db/schema');
  const contentStore = require('../../lib/content-store');
  const sh = require('../../routes/jobs/shared');
  const { runChatJob } = require('../../routes/jobs/chat/page-chat');
  const { costUsd } = require('../../lib/pricing');

  const snap = new Map();
  for (const sid of new Set(cases.map(c => c.session_id))) {
    snap.set(sid, {
      session: db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sid),
      messages: db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id').all(sid),
    });
  }

  const refs = {};
  const results = [];
  const push = (r) => { results.push(r); onResult(r); };
  for (const [i, c] of cases.entries()) {
    if (shouldStop()) break;
    const s = snap.get(c.session_id);
    const q = s?.messages.find(m => m.id === c.message_id && m.role === 'user');
    const base = { id: c.id, session_id: c.session_id, message_id: c.message_id, turn: c.turn };
    if (!s?.session || !q) { push({ ...base, error: 'Session oder Frage fehlt' }); continue; }
    const { session } = s;
    const email = session.user_email;

    // Verlauf bis einschliesslich der Frage.
    db.transaction(() => {
      db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(session.id);
      const cols = Object.keys(s.messages[0]);
      const ins = db.prepare(`INSERT INTO chat_messages (${cols.join(', ')}) VALUES (${cols.map(k => '@' + k).join(', ')})`);
      for (const m of s.messages) if (m.id <= q.id) ins.run(m);
      db.prepare('UPDATE chat_sessions SET opening_page_text = ?, title = ? WHERE id = ?')
        .run(c.turn > 1 ? session.opening_page_text : null, session.title || 'eval', session.id);
    })();

    // Abschnitt zur Fragezeit.
    let restored = false;
    try {
      const rev = db.prepare(`SELECT body_html FROM page_revisions WHERE page_id = ? AND created_at <= ?
                              ORDER BY created_at DESC, id DESC LIMIT 1`).get(session.page_id, q.created_at);
      if (rev) {
        await contentStore.savePage(session.page_id, { html: rev.body_html, source: 'restore' }, { userEmail: email });
        restored = true;
      }
    } catch (e) {
      push({ ...base, error: `Abschnitt nicht ladbar: ${e.message}` });
      continue;
    }
    let pd;
    try { pd = await contentStore.loadPage(session.page_id); } catch (e) {
      push({ ...base, error: `Abschnitt nicht ladbar: ${e.message}` });
      continue;
    }
    const abschnitt = sh.htmlToText(pd.html || '', sh.bookTextOpts(session.book_id, email));

    // Referenz für den Paarvergleich: Volldossiers der Kapitelfiguren (unabhängig
    // davon, was die Variante dem Modell zeigte), einmal je Kapitel.
    const refKey = `${session.book_id}:${pd.chapter_id ?? '-'}`;
    if (!(refKey in refs)) {
      const fig = sh.getFiguren(session.book_id, email, pd.chapter_id ?? null);
      refs[refKey] = fig.length ? fig.map(f => JSON.stringify(f)).join('\n') : '';
    }

    const verlauf = s.messages.filter(m => m.id < q.id)
      .map(m => `${m.role === 'user' ? 'AUTOR' : 'KI'}: ${m.content || ''}`)
      .join('\n\n').slice(-VERLAUF_MAX_CHARS);

    log(`  [${i + 1}/${cases.length}] ${c.id} (Runde ${c.turn}${restored ? ', Stand zur Fragezeit' : ''}) …`);
    const jobId = sh.createJob('chat', session.book_id || 0, email, 'job.label.chat', null, session.id);
    const t0 = Date.now();
    sh.enqueueJob(jobId, () => runChatJob(jobId, session.id, q.id, String(q.content || '').trim(), email));
    let job;
    try { job = await _waitJob(sh.jobs, jobId); } catch (e) { job = { status: 'error', error: e.message }; }
    const ms = Date.now() - t0;
    if (job.status !== 'done') {
      push({ ...base, frage: q.content, abschnitt, verlauf, ref: refKey, error: String(job.error || job.status), ms });
      log(`    ✖ ${job.error || job.status}`);
      continue;
    }

    const asst = db.prepare(`SELECT * FROM chat_messages WHERE session_id = ? AND role = 'assistant' AND id > ?
                             ORDER BY id DESC LIMIT 1`).get(session.id, q.id);
    const vorschlaege = _parse(asst?.vorschlaege, []);
    const ci = _parse(asst?.context_info, {});
    const usage = {
      tokensIn: asst?.tokens_in || 0, tokensOut: asst?.tokens_out || 0,
      cacheRead: asst?.cache_read_in || 0, cacheWrite: asst?.cache_creation_in || 0, cacheWrite1h: asst?.cache_creation_1h_in || 0,
    };
    const usd = costUsd({
      provider: asst?.provider, model: asst?.model, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut,
      cacheReadIn: usage.cacheRead, cacheCreationIn: usage.cacheWrite, cacheCreation1hIn: usage.cacheWrite1h,
    });
    push({
      ...base, frage: q.content, abschnitt, verlauf, ref: refKey, model: asst?.model, ms, usd, usage,
      antwort: asst?.content || '', vorschlaege,
      ideen: ci.proposals || [], titel_varianten: ci.titel_varianten || [],
      checks: _checks(vorschlaege, ci, asst?.content),
    });
    log(`    ✓ ${(ms / 1000).toFixed(0)} s, ${usage.tokensIn} ↑ (${usage.cacheRead} aus Cache) ${usage.tokensOut} ↓, ${usd.toFixed(3)} $`);
  }
  return { results, refs };
}

module.exports = { runCases };
