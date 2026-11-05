// Muster aller Übergaben zwischen Oberflächen (docs/chats.md): eine
// vorformulierte Frage geht in den Ziel-Chat als NEUE Session mit
// vorbereiteter Nachricht. Das Eingabefeld wird belegt (Cursor ans Ende),
// NICHT gesendet — ein Chat-Lauf kostet, der User prüft die Frage erst.
//
// Die Methode hängt an der geteilten Chat-Basis (chat-base.js#makeChatMethods):
// Session-Anlage, Eingabefeld und Fokus kennt nur dort. Ein bereits offenes,
// LEERES Gespräch wird weiterbenutzt (keine zweite leere Session), ein
// laufendes nicht — die neue Frage beginnt ein eigenes Gespräch.

/**
 * Factory: die Draft-Methode eines Chats (`prepare<L>Draft`).
 * @param {object} cfg
 * @param {object} cfg.props            Prop-Namen des Chats (`input` u. a.)
 * @param {Function} cfg.loadSessions    Sessions-Liste laden (Basis)
 * @param {Function} cfg.startNewSession neue Session anlegen (Basis)
 * @param {string} [cfg.inputSelector]   Selektor des Eingabefelds (Default `.chat-input`)
 */
export function makeDraftMethod({ props, loadSessions, startNewSession, inputSelector = '.chat-input' }) {
  return async function (text) {
    const draft = String(text || '').trim();
    if (!draft) return;
    await loadSessions.call(this);
    await startNewSession.call(this);
    this[props.input] = draft;
    this.$nextTick(() => {
      const ta = this.$root?.querySelector(inputSelector);
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange?.(ta.value.length, ta.value.length);
    });
  };
}
