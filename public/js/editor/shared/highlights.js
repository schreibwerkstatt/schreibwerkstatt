// CSS Custom Highlight API: Feature-Check + benannte Highlight-Instanz anlegen.
// Geteilt von Notebook-Editor (Entitäten, Lektorat-Live, Find), Bucheditor
// (Find via text-find.js) und den zwei SPA-Kommentar-Leisten. Der Focus-Editor
// (editor/focus/sentence.js) hat bewusst seine eigene Kopie — stabilisiert.
// Highlights gehören zum Dokument, nicht zum DOM: sie landen nie im
// gespeicherten Seiten-HTML. Ohne API (ältere Browser, Node-Tests) `null`.

/** `CSS.highlights`-Registry oder `null`, wenn die API fehlt. */
export function highlightRegistry() {
  return (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') ? CSS.highlights : null;
}

/**
 * Neue, leere Highlight-Instanz unter `name` registrieren (ersetzt eine
 * gleichnamige). `priority` < 0 lässt andere Highlights (LanguageTool,
 * Default 0) bei Überlappung gewinnen. Ohne API `null`.
 */
export function registerHighlight(name, { priority } = {}) {
  const reg = highlightRegistry();
  if (!reg) return null;
  const hl = new Highlight();
  if (priority != null) hl.priority = priority;
  reg.set(name, hl);
  return hl;
}
