// Textarea-Höhe nach Inhalt. CSS `field-sizing: content` erledigt das selbst;
// wo es fehlt (Firefox, ältere WebKit), rechnet dieser Fallback die Höhe aus
// `scrollHeight` nach — sonst schnitte die Textarea mehrzeiligen Inhalt ab.
// Ein CSS-`max-height` am Feld deckelt auch den Fallback (Inhalt scrollt dann).
export function autosizeTextarea(el) {
  if (!el || globalThis.CSS?.supports?.('field-sizing', 'content')) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// Inline-Edit-Feld beim Einblenden: Höhe nach Inhalt, Fokus, Cursor ans
// Textende — wer auf «Bearbeiten» klickt, will weiterschreiben, nicht erst ins
// Feld klicken.
export function mountAutosizeTextarea(el) {
  if (!el) return;
  autosizeTextarea(el);
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}
