// Werkzeugnamen im System-Prompt eines Chats: der Prompt darf nur nennen, was
// der Lauf tatsächlich anbietet — sonst verbrennt das Modell Runden an
// Werkzeugen, die es nicht hat, oder erfindet den Aufruf. Jede Prompt-Zeile, die
// ein Werkzeug nennt, geht durch diese Helfer. Gegated durch
// tests/unit/chat-tools-contract.test.mjs (Prompt mit je einem fehlenden Werkzeug
// gebaut darf dessen Namen nicht enthalten).

/**
 * @param {string[]|null|undefined} toolNames  angebotene Werkzeuge; ohne Angabe gilt alles als angeboten
 */
export function toolMentions(toolNames) {
  const offered = Array.isArray(toolNames) ? new Set(toolNames) : null;
  const has = (name) => !offered || offered.has(name);
  const pick = (names) => names.filter(has);
  return {
    has,
    any: (names) => names.some(has),
    /** Die angebotenen Namen aus `names`, kommagetrennt ('' wenn keiner). */
    list: (names, sep = ', ') => pick(names).join(sep),
    /** Routing-Zeile «- label → a, b» mit nur den angebotenen Namen; [] wenn keiner. */
    route: (label, names, suffix = '') => {
      const p = pick(names);
      return p.length ? [`- ${label} → ${p.join(', ')}${suffix}`] : [];
    },
    /** Zeile nur, wenn ALLE genannten Werkzeuge angeboten werden. */
    ifAll: (names, line) => (names.every(has) ? [line] : []),
  };
}
