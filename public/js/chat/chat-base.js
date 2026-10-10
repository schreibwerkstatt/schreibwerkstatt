// Gemeinsame Chat-Logik für Seiten-Chat und Buch-Chat Cards.
// makeChatMethods liefert ein Methoden-Objekt, das in eine Card gespreadet wird.
// `this` ist die Card; Root-Zugriffe laufen über window.__app. Der Root setzt
// die showXxxCard-Flag, die Card reagiert per $watch und ruft onVisible().

import { escHtml, fmtTok, renderChatMarkdown, fetchJson } from '../utils.js';
import { startPoll, runningJobStatus } from '../cards/job-helpers.js';
import { tFetchError } from '../i18n.js';

function _newClientMsgId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback für sehr alte Browser ohne crypto.randomUUID.
  return 'cm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Tool-Calls eines agentischen Turns nach Name gruppiert: [{ name, count, errors }].
// `skip`: Tool-Namen, die nicht in die Zusammenfassung gehören (Recherche-Chat:
// `final_answer` ist die Antwort selbst, kein Werkzeug).
export function toolSummary(toolCalls, { skip = [] } = {}) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
  const byName = new Map();
  for (const tc of toolCalls) {
    if (skip.includes(tc.name)) continue;
    const e = byName.get(tc.name) || { name: tc.name, count: 0, errors: 0 };
    e.count++;
    if (tc.ok === false) e.errors++;
    byName.set(tc.name, e);
  }
  return Array.from(byName.values());
}

export function makeChatMethods(cfg) {
  const p = cfg.props;
  const L = cfg.label; // 'Chat', 'BookChat' oder 'ResearchChat'
  // Generationszähler: `reset${L}` zählt hoch, jeder async Pfad merkt sich den
  // Stand vor dem ersten `await` und verwirft seine Antwort, wenn inzwischen ein
  // Reset (Buch-/Seitenwechsel, Karte zu) lief — sonst schreibt eine späte
  // Response das alte Buch/die alte Seite in die frisch geleerte Karte.
  const GEN = p.gen || `_${L[0].toLowerCase()}${L.slice(1)}Gen`;
  const gen = (ctx) => ctx[GEN] || 0;

  // ── Interne Helfer (Aufruf via .call(this)) ──────────────────────────────

  async function loadSessions() {
    // `canOpen` deckt hier die Vorbedingungen von `sessionsUrl` ab (offene Seite
    // bzw. gewähltes Buch): der Refresh läuft auch nach einem Job-Ende, und da
    // kann der User die Seite längst verlassen haben.
    if (!cfg.canOpen(this)) return;
    const g = gen(this);
    try {
      const rows = await fetchJson(cfg.sessionsUrl(this));
      if (gen(this) !== g) return;
      this[p.sessions] = rows;
      if (cfg.onSessionsChanged) cfg.onSessionsChanged.call(this);
    } catch (e) {
      console.error(`[load${L}Sessions]`, e);
    }
  }

  async function loadSession(sessionId) {
    const g = gen(this);
    try {
      // Session-Payload und Active-Job-Check parallel — beide Reads idempotent,
      // sequentielle awaits verdoppelten sonst Latenz beim History-Klick.
      const wantActiveCheck = !this[p.pollTimer] && !this[p.loading];
      const [data, active] = await Promise.all([
        fetchJson('/chat/session/' + sessionId),
        wantActiveCheck
          ? fetchJson(`/jobs/active?type=${cfg.activeJobType}&book_id=${sessionId}`)
              .catch((e) => { console.error(`[load${L}Session] active-job check:`, e); return null; })
          : Promise.resolve(null),
      ]);
      if (gen(this) !== g) return;
      this[p.sessionId] = data.id;
      this[p.messages] = data.messages || [];
      this[p.status] = '';
      if (cfg.onAfterSessionLoad) cfg.onAfterSessionLoad.call(this);
      this.$nextTick(() => scrollToBottom.call(this));

      if (active && active.jobId) {
        this[p.loading] = true;
        startPollLocal.call(this, active.jobId);
      } else if (this[p.loading] && this[p.runningSessionId] !== data.id) {
        // Es läuft ein Job — aber für ein anderes Gespräch. Ohne diesen
        // Hinweis steht die gesperrte Eingabe hier unerklärt da: die
        // Ladeanzeigen hängen an der laufenden Session, nicht an der Karte.
        setElsewhereStatus.call(this);
      }
    } catch (e) {
      console.error(`[load${L}Session]`, e);
    }
  }

  // Statuszeile, wenn der laufende Job NICHT zum sichtbaren Gespräch gehört.
  function setElsewhereStatus() {
    const root = window.__app;
    this[p.status] = `<span class="muted-msg">${escHtml(root.t('chat.runningElsewhere'))}</span>`;
  }

  async function startNewSession() {
    if (!cfg.canOpen(this)) return;
    const g = gen(this);
    try {
      if (cfg.onBeforeNewSession) await cfg.onBeforeNewSession.call(this);
      if (gen(this) !== g) return;
      const { id } = await fetchJson(cfg.newSessionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg.newSessionBody(this)),
      });
      if (gen(this) !== g) return;
      this[p.sessionId] = id;
      this[p.messages] = [];
      this[p.status] = '';
      await loadSessions.call(this);
    } catch (e) {
      console.error(`[startNew${L}Session]`, e);
    }
  }

  // Ein Lauf gehört der Session, für die er gestartet wurde — nicht der Karte.
  // `viewing()` entscheidet deshalb bei jeder Anzeige und jedem Reload, ob das
  // gerade sichtbare Gespräch überhaupt gemeint ist. Ohne diese Unterscheidung
  // zeigt ein während des Laufs geöffnetes früheres Gespräch Progressbar,
  // Skelett und Token-Status (liest sich als „dieses Gespräch wird bearbeitet")
  // und `onDone` zieht den User am Ende ungefragt dorthin zurück, wo er
  // weggeklickt hat.
  function startPollLocal(jobId, sessionId = this[p.sessionId]) {
    // Ohne Session gibt es kein Gespräch, dem der Lauf gehören könnte (Reset
    // zwischen Senden und Job-Start) — nichts anzeigen, nichts pollen.
    if (sessionId == null) { finishRun.call(this); return; }
    const root = window.__app;
    const g = gen(this);
    this[p.runningSessionId] = sessionId;
    const viewing = () => this[p.sessionId] === sessionId;
    // Nach einem Reset gehört der Poller zu einer Karte, die es so nicht mehr
    // gibt: jeder Callback bricht dann ab (der Stream kann noch einen Tick
    // nachschieben, obwohl der Timer schon weg ist).
    const stale = () => gen(this) !== g;
    const finish = () => finishRun.call(this);
    startPoll(this, {
      timerProp: p.pollTimer,
      ...(p.progress ? { progressProp: p.progress } : {}),
      jobId,
      onProgress: (job) => {
        if (stale()) return;
        // Den Fortschritt traegt in diesem Fall die Zeile in der Historie.
        if (!viewing()) { setElsewhereStatus.call(this); return; }
        this[p.status] = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams, job.cacheReadIn);
      },
      onNotFound: async () => {
        if (stale()) return;
        finish();
        if (viewing()) await loadSession.call(this, sessionId);
        else await loadSessions.call(this);
      },
      onError: async (job) => {
        if (stale()) return;
        // Belt-and-suspenders: startPoll clear't Timer eigentlich vor dem
        // Callback. Doppelt clearen schützt vor stuck `loading=true`-States,
        // bei denen weder „Neue Session" noch Senden möglich wäre.
        if (this[p.pollTimer]) { clearInterval(this[p.pollTimer]); this[p.pollTimer] = null; }
        finish();
        if (p.pendingRefresh) this[p.pendingRefresh] = false;
        const errLabel = job.error ? root.t(job.error, job.errorParams) : root.t('common.unknownError');
        if (!viewing()) {
          // Fehler nicht verschlucken, aber auch nicht dem sichtbaren Gespräch
          // anhängen — er gehört zu dem Lauf, der woanders lief.
          this[p.status] = `<span class="error-msg">${escHtml(root.t('chat.errorElsewhere', { msg: errLabel }))}</span>`;
          await loadSessions.call(this);
          return;
        }
        const errHtml = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(errLabel)}</span>`;
        // Server-State neu laden: User-Msg ist serverseitig persistiert
        // (_handleChatPost), Assistant-Msg fehlt. Optimistischer Stub wird durch
        // Server-Stand ersetzt; danach kann der User eine neue Session starten
        // oder eine neue Nachricht senden. loadSession setzt intern status='',
        // Fehler-HTML deshalb DANACH setzen.
        try { await loadSession.call(this, sessionId); }
        catch (e) { console.error(`[${L} onError reload]`, e); }
        this[p.status] = errHtml;
      },
      onDone: async (job) => {
        if (stale()) return;
        finish();
        // Nur nachladen, wenn der User noch in diesem Gespräch steht — sonst
        // wäre das ein Sprung weg von dem, was er gerade liest.
        if (viewing()) await loadSession.call(this, sessionId);
        // Die Historie dagegen IMMER: der abgeschlossene Lauf gehört mit
        // frischem Titel und Zeitstempel an die Spitze der Liste, egal wo der
        // User gerade steht. Darum hier und nicht in den drei Chat-Configs.
        await loadSessions.call(this);
        if (cfg.onPollDone) await cfg.onPollDone.call(this);
        // KI-Titel wird nur auf der ersten Runde generiert und kommt im Job-Result
        // zurück. In die Sessions-Liste übernehmen, damit der History-Eintrag
        // sofort den Titel statt der Vorschau zeigt.
        const newTitle = job?.result?.sessionTitle;
        if (newTitle && Array.isArray(this[p.sessions])) {
          const row = this[p.sessions].find(s => s.id === sessionId);
          if (row) row.title = newTitle;
        }
      },
    });
  }

  // Lauf-State der Karte räumen: Job-Ende, Fehler, Löschen der laufenden Session.
  function finishRun() {
    this[p.loading] = false;
    if (p.progress) this[p.progress] = 0;
    this[p.runningSessionId] = null;
    this[p.status] = '';
  }

  function scrollToBottom() {
    const el = document.getElementById(cfg.scrollElId);
    if (el) el.scrollTop = el.scrollHeight;
  }

  // Wird beim $watch(showXxxCard) aufgerufen, wenn die Karte geöffnet wird.
  async function onVisible() {
    if (!cfg.canOpen(this)) return;
    await loadSessions.call(this);
    if (this[p.sessions].length === 0) {
      await startNewSession.call(this);
    } else if (!this[p.sessionId]) {
      await loadSession.call(this, this[p.sessions][0].id);
    }
    this.$nextTick(() => scrollToBottom.call(this));
  }

  // ── Öffentliche Methoden ────────────────────────────────────────────────

  const m = {};

  m[`_onVisible${L}`] = async function () { return onVisible.call(this); };

  m[`startNew${L}Session`] = function () { return startNewSession.call(this); };
  m[`load${L}Sessions`]    = function () { return loadSessions.call(this); };
  m[`load${L}Session`]     = function (id) { return loadSession.call(this, id); };

  m[`delete${L}Session`] = async function (id) {
    const root = window.__app;
    const g = gen(this);
    try {
      // fetchJson prüft `ok`: ein 403/500 darf die Session nicht aus der
      // Liste nehmen, die serverseitig noch existiert.
      await fetchJson('/chat/session/' + id, { method: 'DELETE' });
    } catch (e) {
      console.error(`[delete${L}Session]`, e);
      if (gen(this) === g) {
        this[p.status] = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(tFetchError(e))}</span>`;
      }
      return;
    }
    if (gen(this) !== g) return;
    // Der Poller gehört dem laufenden Gespräch, nicht dem sichtbaren: nur
    // stoppen, wenn genau DESSEN Session gelöscht wurde — dann aber auch den
    // Lauf-State räumen, sonst bleibt die Eingabe gesperrt (`loading`).
    if (this[p.runningSessionId] === id) {
      if (this[p.pollTimer]) { clearInterval(this[p.pollTimer]); this[p.pollTimer] = null; }
      finishRun.call(this);
    }
    this[p.sessions] = this[p.sessions].filter(s => s.id !== id);
    if (cfg.onSessionsChanged) cfg.onSessionsChanged.call(this);
    if (this[p.sessionId] === id) {
      this[p.sessionId] = null;
      this[p.messages] = [];
      try {
        if (this[p.sessions].length > 0) {
          await loadSession.call(this, this[p.sessions][0].id);
        } else {
          await startNewSession.call(this);
        }
      } catch (e) {
        console.error(`[delete${L}Session] reload`, e);
      }
    }
  };

  m[`send${L}Message`] = async function () {
    const root = window.__app;
    if (this[p.loading] || !this[p.sessionId]) return;
    const msg = (this[p.input] || '').trim();
    if (!msg) return;

    // Idempotency-Key: UUID pro logischem Send. Bei Retry mit identischem Text
    // wird die UUID des fehlgeschlagenen Versuchs wiederverwendet, damit der
    // Server (chat.js _handleChatPost) Doppel-Inserts dedupen kann.
    const lastMsg = this[p.messages][this[p.messages].length - 1];
    const isRetry = !!(lastMsg && lastMsg.role === 'user' && lastMsg.sendError && lastMsg.content === msg && lastMsg.clientMsgId);
    const clientMsgId = isRetry ? lastMsg.clientMsgId : _newClientMsgId();

    this[p.input] = '';
    this[p.loading] = true;
    this[p.status] = '';
    if (isRetry) {
      lastMsg.sendError = false;
    } else {
      this[p.messages].push({ role: 'user', content: msg, id: null, clientMsgId, sendError: false });
    }
    this.$nextTick(() => scrollToBottom.call(this));
    // Session + Generation vor dem ersten `await` pinnen: der Lauf gehört dem
    // Gespräch, in das gesendet wurde — auch wenn der User während des POST
    // wechselt oder die Karte zurückgesetzt wird.
    const sessionId = this[p.sessionId];
    const g = gen(this);
    if (cfg.onBeforeSend) await cfg.onBeforeSend.call(this);
    try {
      const { jobId } = await fetchJson(cfg.sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `sendExtra`: zusätzliche Body-Felder eines Chats (Recherche-Chat:
        // `context` des Kontext-Chips). Der Server legt sie an der User-Nachricht ab.
        body: JSON.stringify({
          session_id: sessionId, message: msg, client_msg_id: clientMsgId,
          ...(cfg.sendExtra ? cfg.sendExtra(this) : {}),
        }),
      });
      // Reset während des POST: die Karte zeigt ein anderes Buch/eine andere
      // Seite (oder nichts). Der Job läuft serverseitig weiter und erscheint
      // beim nächsten Öffnen der Session über /jobs/active.
      if (gen(this) !== g) return;
      if (jobId) startPollLocal.call(this, jobId, sessionId);
      else { this[p.loading] = false; this.$nextTick(() => scrollToBottom.call(this)); }
      // Ab jetzt steht das Gespräch in der Historie: die User-Nachricht ist
      // serverseitig persistiert (_handleChatPost), und die Liste fuehrt nur
      // Sessions MIT Nachrichten. Ohne diesen Refresh fehlt der gerade
      // abgefeuerte Lauf in der Liste, bis er fertig ist — und genau dort
      // gehört die Lauf-Anzeige hin, während der User anderswo liest.
      await loadSessions.call(this);
    } catch (e) {
      if (gen(this) !== g) return;
      // Für dieses Gespräch läuft schon ein Lauf (zweiter Tab/zweites Gerät): der
      // Server hat die Nachricht NICHT gespeichert. Optimistische Nachricht zurück-
      // nehmen, Text im Eingabefeld lassen, Hinweis zeigen und den laufenden Job
      // über loadSession (Active-Check) sichtbar machen.
      if (e?.status === 409 && e?.code === 'CHAT_JOB_RUNNING') {
        const msgs = this[p.messages];
        const tail = msgs[msgs.length - 1];
        if (tail && tail.clientMsgId === clientMsgId) msgs.pop();
        this[p.input] = msg;
        this[p.loading] = false;
        const hint = `<span class="muted-msg">${escHtml(root.t('error.CHAT_JOB_RUNNING'))}</span>`;
        if (this[p.sessionId] === sessionId) {
          try { await loadSession.call(this, sessionId); }
          catch (err) { console.error(`[send${L}Message] reload`, err); }
        }
        if (gen(this) !== g) return;
        // loadSession leert den Status; ohne laufenden Poll bleibt der Hinweis stehen,
        // mit Poll übernimmt die Fortschrittszeile.
        if (!this[p.pollTimer]) this[p.status] = hint;
        return;
      }
      console.error(`[send${L}Message]`, e);
      // Optimistische Msg behalten + sendError markieren + Input restaurieren,
      // damit User mit selber UUID erneut senden kann (Server dedupt dann).
      const tail = this[p.messages][this[p.messages].length - 1];
      if (tail && tail.clientMsgId === clientMsgId) tail.sendError = true;
      this[p.input] = msg;
      this[p.status] = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(tFetchError(e))}</span>`;
      this[p.loading] = false;
      this.$nextTick(() => scrollToBottom.call(this));
    }
  };

  // Laeuft der Job dieser Karte für genau dieses Gespräch? Alle Ladeanzeigen
  // (Progressbar, Skelett, Lauf-Punkt in der Historie) fragen danach statt nach
  // `loading` allein — das ist karten-global und sagt nur, DASS etwas läuft.
  m[`is${L}SessionRunning`] = function (id) {
    return !!this[p.loading] && id != null && this[p.runningSessionId] === id;
  };
  // Feedback (Daumen hoch/runter) an einer Assistant-Antwort — alle drei Chats.
  // Erneuter Klick auf denselben Daumen nimmt es zurück. Optimistisch gesetzt,
  // bei Fehler zurückgerollt; Auswertung im Admin-Usage (db/chat-quality.js).
  m._chatFeedback = async function (msg, value) {
    if (!msg || msg.role !== 'assistant' || !msg.id || msg._feedbackSaving) return;
    const prev = msg.feedback ?? null;
    const next = prev === value ? null : value;
    msg.feedback = next;
    msg._feedbackSaving = true;
    try {
      await fetchJson(`/chat/message/${msg.id}/feedback`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: next }),
      });
    } catch (e) {
      console.error(`[${L} feedback]`, e);
      msg.feedback = prev;
      const root = window.__app;
      this[p.status] = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(tFetchError(e))}</span>`;
    } finally {
      msg._feedbackSaving = false;
    }
  };

  // Server-persistierte Fallback-Nachrichten werden als `__i18n:key__` gespeichert
  // und beim Rendern in die aktuelle Locale aufgelöst (siehe CLAUDE.md, i18n-Regel).
  // Tool-Call-Zusammenfassung eines agentischen Turns (Buch-/Recherche-Chat).
  m._toolSummary = function (toolCalls, opts) { return toolSummary(toolCalls, opts); };
  m._renderChatMarkdown    = function (text) {
    const match = /^__i18n:([a-zA-Z0-9_.-]+)__$/.exec(text || '');
    return renderChatMarkdown(match ? window.__app.t(match[1]) : text);
  };

  // `tokens_in` ist cache-INKLUSIV (input + cache_read + cache_creation, siehe
  // lib/ai/claude.js) und im agentischen Pfad zusätzlich über alle Tool-Iterationen
  // aufsummiert. Ohne den Cache-Anteil liest sich die Zahl wie voll bezahlter Input,
  // obwohl der gelesene Cache nur ein Zehntel des Tarifs kostet — darum die Quote
  // sichtbar am Badge, die vollständige Aufschlüsselung im title.
  m._chatTokenInfo = function (msg) {
    if (!msg.tokens_in && !msg.tokens_out) return '';
    const tokIn = msg.tokens_in || 0;
    const cached = msg.cache_read_in || 0;
    const tpsPart = msg.tps ? ` · ${Math.round(msg.tps)} tok/s` : '';
    const cachePart = (tokIn > 0 && cached > 0)
      ? ` · ${window.__app.t('chat.tokenCacheShare', { pct: Math.round((cached / tokIn) * 100) })}`
      : '';
    return `↑${fmtTok(tokIn)} ↓${fmtTok(msg.tokens_out || 0)}${cachePart}${tpsPart}`;
  };

  // Vollständige Input-Aufschlüsselung als title (Hover) — die drei Posten haben
  // drei verschiedene Tarife (frisch 1x, Cache-Schreiben 1.25x, Cache-Lesen 0.1x).
  m._chatTokenTitle = function (msg) {
    const tokIn = msg.tokens_in || 0;
    if (!tokIn) return '';
    const cached  = msg.cache_read_in || 0;
    const written = msg.cache_creation_in || 0;
    const fresh   = Math.max(0, tokIn - cached - written);
    if (!cached && !written) return '';
    const t = (k, p2) => window.__app.t(k, p2);
    return [
      t('chat.tokenBreakdownTotal',  { n: fmtTok(tokIn) }),
      t('chat.tokenBreakdownFresh',  { n: fmtTok(fresh) }),
      t('chat.tokenBreakdownWrite',  { n: fmtTok(written) }),
      t('chat.tokenBreakdownRead',   { n: fmtTok(cached) }),
    ].join(' · ');
  };

  // Status-HTML für laufende Jobs — Fortschrittszeile aller drei Chats
  // (startPollLocal#onProgress).
  // cacheReadIn (optional): Cache-Anteil der bisher gezählten Input-Tokens; im
  // agentischen Tool-Loop wächst tokensIn pro Iteration um den ganzen Präfix.
  m._runningJobStatus = function (statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams, cacheReadIn) {
    return runningJobStatus(
      (k, p2) => window.__app.t(k, p2),
      statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams, cacheReadIn,
    );
  };

  m[`reset${L}`] = function () {
    this[GEN] = gen(this) + 1;
    if (this[p.pollTimer]) { clearInterval(this[p.pollTimer]); this[p.pollTimer] = null; }
    this[p.sessions] = [];
    this[p.messages] = [];
    this[p.sessionId] = null;
    this[p.runningSessionId] = null;
    this[p.input] = '';
    this[p.loading] = false;
    if (p.progress) this[p.progress] = 0;
    this[p.status] = '';
    if (p.pendingRefresh) this[p.pendingRefresh] = false;
    if (cfg.onReset) cfg.onReset.call(this);
  };

  return m;
}
