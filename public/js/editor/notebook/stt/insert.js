// Einfuege-Seite des Diktats: wohin der Text kommt und wie er sich an den
// vorhandenen Satz anschliesst.
//
// Der Caret wird NICHT aus der Live-Selection gelesen, sondern aus dem
// Vorwaerts-Anker `_sttLastNode` — der Browser kollabiert/resettet die Selection
// nach laengeren Pausen (Fokusverlust) an den Editoranfang, was den Caret „nach
// oben" springen liesse.

import { caretRangeIn, rangeAtEnd } from '../../utils.js';

export const sttInsertMethods = {
  // Klick oder Eingabe des Users im Edit-Feld, waehrend das Diktat laeuft oder
  // auslaeuft: dessen Caret wird die neue Einfuegestelle. Ohne das schriebe das
  // Diktat hinter seinem eigenen letzten Knoten weiter — von Hand getippter
  // Text landete HINTER dem naechsten Segment, ein Klick an eine andere Stelle
  // wuerde ignoriert. Die geklonte Range ist live (der Browser verschiebt sie
  // bei DOM-Aenderungen mit) und gilt bis zum naechsten STT-Insert, ab dann
  // fuehrt wieder `_sttLastNode`. Aufrufer: `@input` am Edit-Feld und
  // figur-lookup.js#`_onEditClick`.
  _sttReanchorFromUser() {
    if (!this._sttRt && !this._sttDraining) return;
    const range = caretRangeIn(this._getEditEl?.());
    if (!range) return;
    this._sttUserRange = range.cloneRange();
    this._sttLastNode = null;
  },

  // Range fuer die naechste Einfuegung. Vorrang hat die vom User waehrend der
  // Aufnahme gesetzte Stelle (`_sttUserRange`). Danach der Vorwaerts-Anker
  // (`_sttLastNode`): Caret direkt HINTER dem zuletzt diktierten Knoten. So
  // bewegt sich die Einfuegestelle nur vorwaerts. Die Live-Selection ist
  // unzuverlaessig — der Browser kollabiert/resettet sie nach laengeren Pausen
  // an den Editoranfang, was den Caret „nach oben" springen liesse. Nur fuer
  // das ERSTE Segment (kein Anker) wird die Live-Selection (vom User bewusst
  // gesetzter Caret bzw. der Start-Anker ans Ende) honoriert, sonst Editorende.
  _sttResolveRange() {
    const editEl = this._getEditEl?.();
    if (!editEl) return null;
    const ur = this._sttUserRange;
    if (ur && editEl.contains(ur.startContainer)) {
      const range = ur.cloneRange();
      range.collapse(true);
      return range;
    }
    if (this._sttLastNode && editEl.contains(this._sttLastNode)) {
      const range = document.createRange();
      range.setStartAfter(this._sttLastNode);
      range.collapse(true);
      return range;
    }
    return caretRangeIn(editEl) || rangeAtEnd(editEl);
  },

  // `midCut`: Segment endet an der Hoechstdauer mitten im Satz (Whispers
  // Schlusspunkt faellt weg). `uncertain`: Whisper-Konfidenz vom Proxy, steuert
  // den Halluzinations-Filter (siehe `_isLikelyHallucination`).
  _sttInsertText(text, boundaryKind, { midCut = false, uncertain = null } = {}) {
    let clean = this._normalizeTranscript(text);
    if (!clean) return; // leerer/Whitespace-Transkript -> nichts einfuegen
    if (this._isLikelyHallucination(clean, uncertain)) return; // Whisper-Geisterphrase -> verwerfen
    if (midCut) clean = this._computeMidCutText(clean);
    if (!clean) return;
    this._trackSttChars?.(clean.length); // Diktat-Tracking: diktierte Zeichen buchen
    if (boundaryKind === 'paragraph') { this._sttInsertParagraph(clean); return; }
    const range = this._sttResolveRange();
    if (!range) return;
    const sel = document.getSelection();
    let prevChar = this._sttCharBefore(range);
    // Beginnt das Segment mit Satzzeichen und steht davor schon ein Leerzeichen,
    // dieses entfernen (kein „Wort , dann").
    if (range.collapsed && this._computeEatPrevSpace(prevChar, clean) && this._sttDeletePrevWhitespace(range)) {
      prevChar = this._sttCharBefore(range);
    }
    const prevText = this._sttTextBefore(range);
    const node = document.createTextNode(this._computeSpacedInsert(prevText, clean));
    range.deleteContents();
    range.insertNode(node);
    this._sttLastNode = node; // Vorwaerts-Anker auf den frisch eingefuegten Knoten
    this._sttUserRange = null;
    range.setStartAfter(node);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    this._markEditDirty?.();
    // Programmatischer Insert: der Browser zieht den Scroll nicht automatisch
    // nach — den eingefügten Knoten selbst vermessen und ins Sichtfeld holen.
    let caretRect = null;
    try { const rr = document.createRange(); rr.selectNode(node); caretRect = rr.getBoundingClientRect(); } catch { /* noop */ }
    this._scrollEditCaretIntoView?.(caretRect);
  },

  // Fuegt das Transkript als NEUEN Absatz (`<p>`) ein — getriggert, wenn die
  // Sprechpause deutlich laenger war (Absatz-Erkennung im VAD). Steht der Caret
  // mitten in einem Prosa-Absatz, wird dieser dort geteilt: das Diktat beginnt
  // den zweiten Teil, der Rest des Absatzes folgt dahinter. Sonst kommt der neue
  // Absatz hinter den Block des Carets (bzw. ans Editorende). Der vorausgehende
  // Teil bekommt ein Satzendezeichen, falls es fehlt. Erster Buchstabe gross
  // (neuer Absatz = neuer Satz). data-bid vergibt der Write-Chokepoint beim
  // Speichern (idempotent) — hier kein manuelles Setzen noetig.
  _sttInsertParagraph(clean) {
    const editEl = this._getEditEl?.();
    if (!editEl) return;
    const range = this._sttResolveRange();
    if (!range) return;
    const sel = document.getSelection();

    // Direkten Kind-Block von editEl ermitteln, in dem der Caret steht.
    let block = range.startContainer;
    while (block && block !== editEl && block.parentNode !== editEl) block = block.parentNode;
    if (block === editEl) block = editEl.lastElementChild; // Caret direkt am Root

    const head = document.createTextNode(this._capitalizeSentenceStart(clean));
    const p = document.createElement('p');
    p.appendChild(head);
    if (block && block.parentNode === editEl) {
      const rest = this._sttSplitBlockAt(block, range);
      if (rest) p.append(' ', rest);
      if (block.tagName === 'P' && this._sttBlockIsEmpty(block)) {
        // Caret stand am Absatzanfang bzw. im leeren Absatz: nichts zu teilen,
        // das Diktat beginnt den Absatz. Inhalt in den bestehenden Block, damit
        // er seine data-bid behaelt.
        block.replaceChildren(...p.childNodes);
      } else {
        this._sttEnsureTerminalPunct(block);
        block.after(p);
      }
    } else {
      editEl.appendChild(p);
    }

    // Vorwaerts-Anker auf den Textknoten des Diktats, damit das naechste
    // Segment direkt dahinter weiterschreibt (vor einem abgeteilten Rest, nicht
    // dahinter am Root).
    this._sttLastNode = head;
    this._sttUserRange = null;
    const r2 = document.createRange();
    r2.setStartAfter(head);
    r2.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(r2);
    this._markEditDirty?.();
    let rect = null;
    try { const rr = document.createRange(); rr.selectNode(head); rect = rr.getBoundingClientRect(); } catch { /* noop */ }
    this._scrollEditCaretIntoView?.(rect);
  },

  // Schneidet den Inhalt eines Prosa-Absatzes ab `range` bis zum Absatzende
  // heraus und liefert ihn als Fragment (fuehrender Whitespace getilgt), oder
  // null, wenn dort nichts steht (Caret am Absatzende) bzw. der Block kein
  // `<p>` ist oder den Caret nicht enthaelt.
  _sttSplitBlockAt(block, range) {
    if (block.nodeType !== 1 || block.tagName !== 'P' || !block.contains(range.startContainer)) return null;
    const tail = document.createRange();
    tail.setStart(range.startContainer, range.startOffset);
    tail.setEnd(block, block.childNodes.length);
    if (!tail.toString().trim() && !tail.cloneContents().querySelector?.('img,[contenteditable="false"]')) return null;
    const frag = tail.extractContents();
    const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      n.textContent = n.textContent.replace(/^\s+/, '');
      if (n.textContent) break;
    }
    return frag;
  },

  // True, wenn ein Block nach dem Teilen keinen Text und keinen atomaren
  // Inhalt (Bild, Chip) mehr traegt.
  _sttBlockIsEmpty(block) {
    return !block.textContent.trim() && !block.querySelector('img,[contenteditable="false"]');
  },

  // Haengt ein '.' an den letzten Textknoten eines Blocks an, wenn dieser nicht
  // bereits auf einem Satz-/Doppelpunkt endet — damit beim Absatzwechsel der
  // vorausgehende Satz sauber schliesst. Nur an Prosa-Absaetzen: Ueberschrift,
  // Liste, Tabelle oder Diagramm-Quelltext bekommen keinen Punkt, und ein
  // atomarer Chip (Beleg, Querverweis) am Absatzende bleibt unangetastet.
  _sttEnsureTerminalPunct(block) {
    try {
      if (!block || block.nodeType !== 1 || block.tagName !== 'P') return;
      // Schliessende Anfuehrungs-/Klammerzeichen mit abstreifen, damit ein vom
      // Modell gesetztes Satzzeichen im Dialog („…her.«") erkannt wird und wir
      // keinen zweiten Punkt anhaengen.
      const txt = (block.textContent || '').replace(/[\s"'’”“»«)\]]+$/u, '');
      if (!txt || /[.!?…:;]$/.test(txt)) return;
      // Steht ein atomarer Chip als letzter Inhalt, liefert die Suche `ATOMIC`
      // und bricht auf jeder Ebene ab, statt zu einem frueheren Text zu springen.
      const ATOMIC = {};
      const lastTextNode = (node) => {
        for (let i = node.childNodes.length - 1; i >= 0; i--) {
          const c = node.childNodes[i];
          if (c.nodeType === 3 && c.textContent.trim()) return c;
          if (c.nodeType === 1) {
            if (c.getAttribute('contenteditable') === 'false') return ATOMIC;
            const r = lastTextNode(c); if (r) return r;
          }
        }
        return null;
      };
      const tn = lastTextNode(block);
      if (tn && tn !== ATOMIC) tn.textContent = tn.textContent.replace(/\s+$/, '') + '.';
    } catch { /* noop */ }
  },

  // Zeichen unmittelbar vor dem Caret (fuer Leerzeichen-Heuristik). Der Caret
  // steht zwischen Segmenten meist an einer Knotengrenze (nach dem zuletzt
  // eingefuegten Textknoten), wo `startContainer` ein Elementknoten ist — darum
  // den gesamten Text links vom Caret per Range einsammeln und das letzte
  // Zeichen nehmen (deckt Text- und Elementknoten gleichermassen ab).
  // Letzte n Zeichen links vom Caret (Default 12) — genug Kontext, um ein
  // Satzendezeichen auch hinter einer schliessenden Anfuehrung zu erkennen
  // (siehe `_endsSentence`). Sammelt den Text per Range ueber Knotengrenzen.
  _sttTextBefore(range, n = 12) {
    try {
      const editEl = this._getEditEl?.();
      if (!editEl) return '';
      const probe = range.cloneRange();
      probe.collapse(true);
      const left = document.createRange();
      left.selectNodeContents(editEl);
      left.setEnd(probe.startContainer, probe.startOffset);
      return left.toString().slice(-n);
    } catch { /* noop */ }
    return '';
  },

  _sttCharBefore(range) {
    try {
      const probe = range.cloneRange();
      probe.collapse(true);
      const node = probe.startContainer;
      if (node.nodeType === 3 && probe.startOffset > 0) {
        return node.textContent[probe.startOffset - 1] || '';
      }
      const editEl = this._getEditEl?.();
      if (editEl) {
        const left = document.createRange();
        left.selectNodeContents(editEl);
        left.setEnd(probe.startContainer, probe.startOffset);
        const txt = left.toString();
        if (txt.length) return txt[txt.length - 1];
      }
    } catch { /* noop */ }
    return '';
  },

  // Loescht ein einzelnes Whitespace-Zeichen direkt vor dem (kollabierten)
  // Caret und setzt `range` an die Tilgungsstelle. Liefert true bei Erfolg.
  // Deckt Textknoten-Caret und Element-Knoten-Grenze (vorausgehender Textknoten)
  // ab. Idempotent-sicher: tilgt nur, wenn dort wirklich Whitespace steht.
  _sttDeletePrevWhitespace(range) {
    try {
      if (!range.collapsed) return false;
      let node = range.startContainer;
      let offset = range.startOffset;
      if (node.nodeType === 1 && offset > 0) {
        let child = node.childNodes[offset - 1];
        while (child && child.nodeType === 1 && child.lastChild) child = child.lastChild;
        if (child && child.nodeType === 3) { node = child; offset = child.textContent.length; }
      }
      if (node.nodeType === 3 && offset > 0 && /\s/.test(node.textContent[offset - 1])) {
        node.deleteData(offset - 1, 1);
        range.setStart(node, offset - 1);
        range.collapse(true);
        return true;
      }
    } catch { /* noop */ }
    return false;
  },
};
