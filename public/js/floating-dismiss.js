// Gemeinsames Wegräumen für schwebende Hover-Ebenen (Tooltip-Layer, Vorschau
// der Entitäts-Referenz): beide zeigen eine Ebene über einem Quell-Element und
// müssen verschwinden, sobald der Kontext nicht mehr stimmt.

/**
 * Hängt die Standard-Auslöser an, bei denen eine Hover-Ebene geht: Fokus
 * verlässt das Element, Scrollen (auch in inneren Containern, capture),
 * Fenstergrösse, Escape.
 */
export function installFloatingDismiss(hide) {
  document.addEventListener('focusout', () => hide());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}

/**
 * MutationObserver, der die Ebene schliesst, wenn ihr Quell-Element aus dem
 * DOM fällt (Alpine-Re-Render, Karten-/Seitenwechsel): dabei feuert kein
 * mouseout, die Ebene bliebe verwaist stehen. Beim Zeigen
 * `observe(document.body, { childList: true, subtree: true })`, beim
 * Verstecken `disconnect()`. Ohne MutationObserver (Tests) `null`.
 */
export function makeRemovalWatcher(getCurrent, hide) {
  if (typeof MutationObserver !== 'function') return null;
  return new MutationObserver(() => {
    const cur = getCurrent();
    if (cur && !document.contains(cur)) hide();
  });
}
