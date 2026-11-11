// Knoten-Bearbeitung, die mitwächst.
//
// jsMind setzt sein Eingabefeld beim Bearbeitungsstart auf die alte
// Knotenbreite und rechnet bis zum Enter nichts mehr nach: ein neuer Knoten
// („Neuer Knoten") bleibt beim Tippen schmal, der Text scrollt im Feld weg.
// Hier wird das Feld durch eine Textarea ersetzt, die über einem unsichtbaren
// Spiegel-Span im Knoten liegt. Der Spiegel trägt denselben Text mit derselben
// Schrift und Umbruchbreite wie der fertige Knoten — der Knoten bekommt so beim
// Tippen genau die Grösse, die er nach dem Speichern hat. Pro Eingabe misst
// jsMind den Knoten neu und legt die Map neu an: Nachbarn und Linien rücken mit.
//
// Ein Topic bleibt einzeilig im Sinn der Daten: Enter übernimmt, ein
// eingefügter Zeilenumbruch wird zum Leerzeichen; umbrochen wird nur optisch.

function _isEnterCommit(e) {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
}

export function installGrowingEditor(jm) {
  const view = jm?.view;
  if (!view || view._swEditor) return;
  const ta = document.createElement('textarea');
  ta.className = 'jsmind-editor';
  ta.rows = 1;
  ta.spellcheck = true;
  ta.setAttribute('autocomplete', 'off');
  view._swEditor = true;
  view.e_editor = ta;

  let mirror = null;
  let raf = 0;

  const relayout = () => {
    raf = 0;
    const node = view.editing_node;
    if (!node || !mirror) return;
    mirror.textContent = (ta.value || ' ') + '​';
    try {
      view.init_nodes_size(node);
      jm.layout.layout();
      view.show(false);
    } catch {}
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(relayout); };

  ta.addEventListener('keydown', (e) => {
    if (_isEnterCommit(e)) {
      e.preventDefault();
      e.stopPropagation();
      view.edit_node_end();
    } else if (e.key === 'Escape') {
      // Verwerfen: alter Text zurück, dann normal beenden (gleicher Text →
      // jsMind rendert nur neu, kein Edit-Event, kein Undo-Schritt).
      e.preventDefault();
      e.stopPropagation();
      if (view.editing_node) ta.value = view.editing_node.topic;
      view.edit_node_end();
    }
  });
  ta.addEventListener('input', () => {
    if (/[\r\n]/.test(ta.value)) {
      const pos = ta.selectionStart;
      ta.value = ta.value.replace(/[\r\n]+/g, ' ');
      ta.setSelectionRange(pos, pos);
    }
    schedule();
  });
  ta.addEventListener('blur', () => view.edit_node_end());

  const begin = view.edit_node_begin.bind(view);
  view.edit_node_begin = function editNodeBeginGrowing(node) {
    begin(node);
    if (view.editing_node !== node) return;
    const el = node._data.view.element;
    // jsMind gibt dem Feld eine feste Pixelbreite — die Breite kommt hier vom
    // Spiegel (CSS: .jsmind-editor liegt absolut darüber).
    ta.style.width = '';
    mirror = document.createElement('span');
    mirror.className = 'jsmind-editor-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    el.insertBefore(mirror, ta);
    el.classList.add('is-editing');
    relayout();
  };

  const end = view.edit_node_end.bind(view);
  view.edit_node_end = function editNodeEndGrowing() {
    const node = view.editing_node;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const el = node?._data?.view?.element;
    end();
    // Unverändert/leer: jsMind rendert nur den Text neu, misst aber nicht —
    // der Knoten hätte sonst die Tipp-Grösse behalten.
    if (el) {
      el.classList.remove('is-editing');
      mirror?.remove();
      try { view.init_nodes_size(node); jm.layout.layout(); view.show(false); } catch {}
    }
    mirror = null;
  };
}
