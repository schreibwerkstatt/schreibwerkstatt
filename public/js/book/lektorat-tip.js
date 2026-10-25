// Singleton-Tooltip der Lektorat-Marken in der Leseansicht: ein Element am
// `<body>`, das über der jeweils überfahrenen Marke steht. Den Inhalt baut
// book/page-view.js#showTip (escaped); hier liegen nur Element, Positionierung
// und der Zustand „welche Marke ist aktiv".
//
// Bewusst ohne Imports: die Notebook-Karte (editor/notebook/card.js) schliesst
// den Tooltip bei jedem Re-Render der Leseansicht und soll dafür nicht den
// ganzen Seitenansicht-Graph (i18n, Content-Repo) mitladen.

let tipEl = null;
let activeMark = null;

function ensureTipEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'lektorat-tip';
  document.body.appendChild(tipEl);
  // Tooltip bleibt offen wenn die Maus drauf wandert
  tipEl.addEventListener('mouseleave', () => hideLektoratTip());
  return tipEl;
}

/** Tooltip mit vorab escaptem `html` über `mark` zeigen. */
export function placeLektoratTip(mark, html) {
  activeMark = mark;
  const tip = ensureTipEl();
  tip.innerHTML = html;

  // Positionierung: erst messen, dann platzieren
  tip.style.left = '-9999px';
  tip.style.top = '0';
  tip.classList.add('lektorat-tip--visible');

  const tipRect = tip.getBoundingClientRect();
  const markRect = mark.getBoundingClientRect();
  const GAP = 6;

  let left = markRect.left + markRect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));

  let top;
  if (markRect.top - tipRect.height - GAP >= 4) {
    top = markRect.top - tipRect.height - GAP;
  } else {
    top = markRect.bottom + GAP;
  }

  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

// Auch beim Re-Render der Leseansicht aufgerufen (Seitenwechsel per Tastatur,
// Befund umgeschaltet): die Marke verschwindet dann ohne `pointerleave`, und
// der Tooltip bliebe über fremdem Text stehen, bis die Maus sich bewegt.
export function hideLektoratTip() {
  if (tipEl) tipEl.classList.remove('lektorat-tip--visible');
  activeMark = null;
}

export function activeLektoratMark() { return activeMark; }

// Split-Modus: die Marke ist aktiv, ohne dass ein Tooltip steht.
export function setActiveLektoratMark(mark) { activeMark = mark; }

export function lektoratTipContains(node) { return !!tipEl?.contains(node); }
