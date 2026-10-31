// Spaltengriff (ARIA «Window Splitter»): Ziehen, Pfeiltasten, Home/End,
// Doppelklick setzt zurück. Geteilt von Seitenbaum (app-chrome.js) und der
// Leiste eines `.aside-split` (aside-resize.js) — beide unterscheiden sich nur
// in Messung, Speicherort und Richtung.
//
//   bindColumnResize(handle, {
//     min, max,            Grenzen in px (aria-valuemin/-max, Home/End)
//     measure(),           gerenderte Spaltenbreite in px
//     apply(w),            Breite setzen (der Aufrufer klemmt und schreibt zurück)
//     persist(),           nach Drag-Ende bzw. Tastendruck
//     reset(),             Doppelklick
//     grow,                +1: Ziehen nach rechts verbreitert (Spalte links
//                          vom Griff), -1: Ziehen nach links (Spalte rechts)
//   })
//
// Pfeiltasten bewegen den Griff, nicht den Wert: auf einer rechten Spalte
// verbreitert «←». Während des Ziehens trägt <body> `.col-resizing`
// (twocolumn.css: Cursor, keine Textauswahl, Iframes ohne Pointer).
export function bindColumnResize(handle, { min, max, measure, apply, persist, reset, grow = 1 }) {
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-valuemin', String(min));
  handle.setAttribute('aria-valuemax', String(max));
  handle.tabIndex = 0;

  const syncAria = () => handle.setAttribute('aria-valuenow', String(measure()));
  const set = (w) => { apply(w); syncAria(); };

  let dragging = false;
  let startX = 0;
  let startW = 0;

  const onMove = (e) => {
    if (!dragging) return;
    set(startW + grow * (e.clientX - startX));
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('col-resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    persist();
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startW = measure();
    handle.classList.add('dragging');
    document.body.classList.add('col-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  handle.addEventListener('keydown', (e) => {
    let target;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = (e.shiftKey ? 32 : 8) * (e.key === 'ArrowRight' ? 1 : -1);
      target = measure() + grow * step;
    } else if (e.key === 'Home') target = min;
    else if (e.key === 'End') target = max;
    else return;
    e.preventDefault();
    set(target);
    persist();
  });

  handle.addEventListener('dblclick', () => { reset(); syncAria(); });
  // Fensterbreite ändert die vw-Deckel und damit die gerenderte Breite.
  window.addEventListener('resize', syncAria);
  syncAria();
  return { syncAria };
}
