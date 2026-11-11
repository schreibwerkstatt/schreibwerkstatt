// Erkennung der LanguageTool-Browser-Erweiterung.
//
// Laeuft sie mit, unterstreicht sie dieselben Stellen ein zweites Mal — die
// eigenen Markierungen werden pausiert, statt zwei Wellenlinien uebereinander
// zu legen.
//
// Der Beobachter haengt an `document.body{subtree}` und feuert damit bei JEDEM
// Tastendruck im Editor (Zaehler, Badge, Marken-Layer aendern den DOM mit).
// Darum prueft er nur, was die Mutation betrifft: solange keine Erweiterung da
// ist, die eingefuegten Knoten bzw. das Element mit geaenderter Klasse — ein
// Tastendruck fuegt keine solchen Knoten ein und kostet nichts. Den Scan ueber
// das ganze Dokument (`detect()`) braucht es nur beim Start und, solange die
// Erweiterung als vorhanden gilt, fuer ihr Verschwinden; dort mit
// Trailing-Throttle — Erweiterungs-Marker erscheinen und verschwinden nicht
// zeitkritisch.

const EXTENSION_SELECTORS = [
  'lt-div',
  'lt-highlighter',
  '[class*="lt-toolbar"]',
  '[class*="languagetool"]',
];

const THROTTLE_MS = 300;
const EXTENSION_SELECTOR = EXTENSION_SELECTORS.join(', ');

function detect() {
  return !!document.querySelector(EXTENSION_SELECTOR);
}

// Traegt ein eingefuegter Teilbaum einen Erweiterungs-Marker?
function subtreeHasMarker(node) {
  if (node.nodeType !== 1) return false;
  return node.matches(EXTENSION_SELECTOR) || !!node.querySelector(EXTENSION_SELECTOR);
}

// Betrifft eine Mutationsserie einen Erweiterungs-Marker? Ohne Erweiterung
// reicht der Blick auf das Neue: Text-/Zaehler-Mutationen fuegen keine Elemente
// mit diesen Namen oder Klassen ein.
export function mutationsTouchMarker(records) {
  for (const r of records) {
    if (r.type === 'attributes') {
      if (r.target.nodeType === 1 && r.target.matches(EXTENSION_SELECTOR)) return true;
      continue;
    }
    for (const n of r.addedNodes) if (subtreeHasMarker(n)) return true;
  }
  return false;
}

/**
 * @param {object} deps
 * @param {() => void} deps.onDetected  Erweiterung ist aufgetaucht
 * @param {() => void} deps.onCleared   Erweiterung ist verschwunden
 */
export function createExtensionGuard({ onDetected, onCleared }) {
  let observer = null;
  let timer = null;
  let present = false;

  function evaluate() {
    const now = detect();
    if (now && !present) { present = true; onDetected(); }
    else if (!now && present) { present = false; onCleared(); }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; evaluate(); }, THROTTLE_MS);
  }

  return {
    // Blockiert die Erweiterung gerade? Der Controller ueberspringt dann Checks.
    get blocked() { return present; },

    start() {
      // Erweiterung da: jede Mutation kann ihr Verschwinden sein → gedrosselter
      // Voll-Scan. Sonst nur, wenn das Neue einen Marker traegt.
      observer = new MutationObserver((records) => {
        if (present || mutationsTouchMarker(records)) schedule();
      });
      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
      });
      evaluate();
    },

    stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (observer) { observer.disconnect(); observer = null; }
    },
  };
}
