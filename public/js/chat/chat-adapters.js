// Adapter-Methoden aus makeChatMethods (chat-base.js) für die geteilten
// Chat-Fragmente — alle fünf Chats:
//   <l>SessionList()   → chat-session-list.html
//   <l>SendButton()    → chat-send-btn.html (Senden / Stopp / belegt)
//   open<L>Question() / retryOpen<L>Question() → «Erneut fragen»
// `m` ist das Methoden-Objekt des Chats; die Adapter rufen dessen Methoden
// (is<L>SessionRunning, send<L>Message, cancel<L>Run, …) zur Laufzeit.

export function addChatAdapters(m, cfg) {
  const p = cfg.props;
  const L = cfg.label;
  // Adapter für das Fragment chat-session-list.html: `x-data="{ sessionList: chatSessionList() }"`.
  m[`${L[0].toLowerCase()}${L.slice(1)}SessionList`] = function () {
    const call = (name) => (id) => m[name].call(this, id);
    return { sessions: () => this[p.sessions], activeId: () => this[p.sessionId],
      running: call(`is${L}SessionActive`), deleteDisabled: call(`is${L}SessionRunning`),
      load: call(`load${L}Session`), remove: call(`delete${L}Session`), untitledKey: cfg.untitledKey || 'chat.previewEmpty' };
  };
  // Letzte Frage des Gesprächs ohne Antwort (Lauf gescheitert oder abgebrochen)
  // — dann bietet die Karte «Erneut fragen» an. null, solange etwas läuft.
  m[`open${L}Question`] = function () {
    const msgs = this[p.messages];
    const last = msgs[msgs.length - 1];
    if (this[p.loading] || !last || last.role !== 'user' || !last.id || last.sendError) return null;
    return m[`is${L}SessionActive`].call(this, this[p.sessionId]) ? null : last;
  };
  // Schickt die offene Frage noch einmal ab; ein angefangener Entwurf im
  // Eingabefeld bleibt stehen. Verbraucht `send<L>Message` die Frage nicht
  // (früher Abbruch), kommt sie in die Liste zurück.
  m[`retryOpen${L}Question`] = async function () {
    const q = m[`open${L}Question`].call(this);
    if (!q) return;
    const draft = this[p.input];
    this[p.messages].splice(this[p.messages].length - 1, 1);
    this[p.input] = q.content;
    try {
      await this[`send${L}Message`]({ retryOf: q.id });
    } finally {
      if (this[p.input] === q.content) this[p.messages].push(q);
      this[p.input] = draft;
    }
  };
  // Adapter für das Fragment chat-send-btn.html: `x-data="{ sendBtn: chatSendButton() }"`
  // an der `.chat-input-row`. Ein Knopf, drei Zustände (wie ChatGPT/Claude):
  //   'stop' — die offene Session läuft und die Karte pollt den Job → Klick bricht ab;
  //   'busy' — Job läuft woanders (andere Session dieser Karte, anderer Tab,
  //            Warteschlange) oder Senden ist noch nicht beim Job angekommen → Spinner, gesperrt;
  //   'send' — Pfeil, gesperrt bei leerem Eingabefeld.
  m[`${L[0].toLowerCase()}${L.slice(1)}SendButton`] = function () {
    const mode = () => {
      const sid = this[p.sessionId];
      if (m[`is${L}SessionRunning`].call(this, sid)) return 'stop';
      if (this[p.loading] || m[`is${L}SessionActive`].call(this, sid)) return 'busy';
      return 'send';
    };
    return {
      mode,
      disabled: () => {
        const md = mode();
        return md === 'busy' || (md === 'send' && !String(this[p.input] || '').trim());
      },
      click: () => (mode() === 'stop' ? this[`cancel${L}Run`]() : this[`send${L}Message`]()),
    };
  };
}
