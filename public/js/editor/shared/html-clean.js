// Editor-übergreifende HTML-Bereinigung. Single source für Normal- und
// Focus-Editor, damit beide bit-identisch normalisieren. Eingangspunkte:
// - vor Save (stripLektoratMarks): Korrekturvorschlags-Markup raus
// - für Dirty-Vergleich (normalizeForCompare): roher Server-HTML vs.
//   contenteditable-HTML auf eine Vergleichs-Normalform bringen
// - bei Edit-Start (normalizeEditorBlocks): orphan Text-/Inline-Runs in <p>
//   verpacken, damit Block-Erkennung greift
//
// Server-Pendant ist lib/html-clean.js (cleanPageHtml am Save-Chokepoint);
// Client normalisiert dieselbe Form vorab, damit der Vergleich gegen den
// Originalstand stimmt.

import {
  stripFocusArtefacts,
  cleanContentArtefacts,
  collapseEmptyBlocks,
  stripTrailingEmptyBlocks,
} from '../../utils.js';

export {
  stripFocusArtefacts,
  cleanContentArtefacts,
  collapseEmptyBlocks,
  stripTrailingEmptyBlocks,
};

// Parst ein HTML-Fragment in ein detached <div>, ohne den innerHTML-Setter zu
// nutzen. Identisches Verhalten zum klassischen `tmp.innerHTML = out`-Pattern
// (beide gehen durch denselben HTML5-Parser), aber das resultierende Element
// hängt nie im Live-DOM — Lektorat-Marks sind Korrektur-Wrapper aus dem
// Editor-Eigeninhalt (kein externer User-Input).
function parseFragment(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  return doc.body.firstElementChild || null;
}

// Entfernt Korrekturvorschlags-Markup:
//   - .lektorat-ins / .chat-mark-ins → komplett entfernen (nur Vorschlagstext)
//   - .lektorat-mark / .chat-mark → unwrap (Originaltext behalten)
//   - .lt-popover / .lt-badge → komplett entfernen (LanguageTool-UI, s.u.)
// Danach via collapse/cleaner durch die gleichen Filter wie der Save-Pfad.
export function stripLektoratMarks(html) {
  let out = html;
  const hasMark = out && (out.indexOf('lektorat-mark') !== -1 || out.indexOf('chat-mark') !== -1);
  const hasIns = out && (out.indexOf('lektorat-ins') !== -1 || out.indexOf('chat-mark-ins') !== -1);
  // LanguageTool-UI haengt zur Laufzeit als contenteditable="false"-Insel IM
  // Editier-Root (damit Scroll sie nativ mitnimmt). Wer bei offenem Popover
  // speichert, persistiert sonst das komplette UI-Markup samt <button>/<svg> in
  // die Revision — und bekommt es beim naechsten Laden als Inhalt zurueck.
  // Der Trigger gehoert zwingend in diese Bedingung: sonst greift der
  // Early-Return und der Filter unten laeuft nie.
  // `.xref-num` ist die Vorschau-Nummer der Legende („Abb. 3.2: ",
  // public/js/xrefs/caption-preview.js). Sie steht in der Leseansicht und im
  // Bucheditor-Stream; bliebe sie in der Vergleichsform, gaelte jede Seite mit
  // Abbildung beim blossen Hinsehen als veraendert — und ein Save schriebe die
  // Zaehlung in den Text. Server-Pendant: lib/html-clean.js#_UI_ARTEFACT_SEL.
  const hasLtUi = out && (out.indexOf('lt-popover') !== -1 || out.indexOf('lt-badge') !== -1
    || out.indexOf('xref-num') !== -1);
  // `contenteditable` ist Editor-Laufzeit, kein Inhalt: der Quellen-Chip
  // (public/js/sources/cite-html.js) bekommt es beim Mount gesetzt, damit der
  // Caret ihn ueberspringt. Bliebe es in der Vergleichsform stehen, gaelte jede
  // Seite mit Quellenangabe direkt beim Oeffnen als veraendert — Autosave, Revision und
  // updated_at-Bump bei jedem blossen Hinsehen. Server-Pendant:
  // lib/html-clean.js#stripEditorUiArtefacts.
  const hasEditableAttr = out && out.indexOf('contenteditable') !== -1;
  if (hasMark || hasIns || hasLtUi || hasEditableAttr) {
    const tmp = parseFragment(out);
    if (tmp) {
      tmp.querySelectorAll('.lt-popover, .lt-badge, .xref-num').forEach(ui => {
        ui.parentNode?.removeChild(ui);
      });
      tmp.querySelectorAll('[contenteditable]').forEach(el => {
        el.removeAttribute('contenteditable');
      });
      tmp.querySelectorAll('.lektorat-ins, .chat-mark-ins').forEach(ins => {
        ins.parentNode?.removeChild(ins);
      });
      tmp.querySelectorAll('.lektorat-mark, .chat-mark').forEach(mark => {
        const parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      });
      out = tmp.innerHTML;
    }
  }
  return stripTrailingEmptyBlocks(collapseEmptyBlocks(cleanContentArtefacts(stripFocusArtefacts(out))));
}

// Block-Tags, die der Editor-Root als gültigen Block akzeptiert. Alles andere
// (bare Text-Nodes, Inline-Elements) wird via normalizeEditorBlocks in <p>
// gewrapt.
export const ROOT_BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'LI', 'PRE', 'UL', 'OL', 'TABLE',
  'FIGURE', 'HR', 'DIV', 'DL', 'SECTION', 'ARTICLE',
  'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'MAIN', 'FORM',
]);

// Mutiert el in-place: orphan Text-/Inline-Runs zwischen Block-Tags werden in
// <p> gewrapt. Idempotent — zweiter Lauf macht nichts mehr.
export function normalizeEditorBlocks(el) {
  if (!el) return;
  let group = [];
  const flushBefore = (target) => {
    if (!group.length) return;
    const hasContent = group.some(n =>
      (n.nodeType === 3 && n.textContent.replace(/ /g, ' ').trim()) ||
      (n.nodeType === 1)
    );
    if (!hasContent) { group = []; return; }
    const p = el.ownerDocument.createElement('p');
    for (const n of group) p.appendChild(n);
    if (target) el.insertBefore(p, target);
    else el.appendChild(p);
    group = [];
  };
  const children = Array.from(el.childNodes);
  for (const child of children) {
    if (child.nodeType === 1 && ROOT_BLOCK_TAGS.has(child.tagName)) {
      flushBefore(child);
    } else {
      group.push(child);
    }
  }
  flushBefore(null);
}

// Gemeinsame Normalform für Dirty-Vergleich: Original-HTML vom Server und
// contenteditable-HTML aus dem Browser durch denselben DOM-Roundtrip +
// Block-Normalizer + Cleaner. Ohne diese Vereinheitlichung schlägt
// `newHtml === originalHtml` byte-genau fehl, obwohl semantisch identisch
// (Whitespace, Attribut-Reihenfolge, self-closing, fehlende <p>-Wrapper).
export function normalizeForCompare(html) {
  if (!html) return '';
  const wrap = parseFragment(html);
  if (!wrap) return '';
  normalizeEditorBlocks(wrap);
  return stripLektoratMarks(wrap.innerHTML);
}


// Vergleichsform für das, was der Server-Cleaner beim Write zusätzlich ändert,
// ohne dass sich der Inhalt ändert (lib/html-clean.js#cleanPageHtml):
//  - `stripBlockEdgeNbsp`: Rand-Leerraum inkl. NBSP im ersten/letzten
//    Text-Node jedes Blocks fällt weg,
//  - `linkifyBareUrls`: eine nackte URL wird `<a href="URL">URL</a>`.
// Nur für den Vergleich, nie für die Persistenz: statt hier nachzulinken,
// packt die Form solche Auto-Links auf BEIDEN Seiten aus (ausserhalb von
// `pre`/`code`, wo auch der Server nicht linkt) — ein so getippter Link wird
// beim Speichern ohnehin wieder einer. Ohne diese Stufe gälte der Editor direkt
// nach einem Save als geändert, sobald ein Absatz auf ein Leerzeichen endet
// oder eine URL trägt (Phantom-Draft nach F5, Extra-PUT, falscher Konflikt).
// Selektor und Rand-Suche spiegeln den Server (`_EDGE_TRIM_BLOCKS`,
// `_edgeTextNodeIn`), iterativ wie dort.
const EDGE_TRIM_BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,td,th,dd,dt,figcaption';

function edgeTextNodeIn(el, first) {
  const down = first ? 'firstChild' : 'lastChild';
  const side = first ? 'nextSibling' : 'previousSibling';
  let n = el[down];
  while (n) {
    if (n.nodeType === 3) return n;
    if (n.nodeType === 1 && n[down]) { n = n[down]; continue; }
    while (n && n !== el && !n[side]) n = n.parentNode;
    if (!n || n === el) return null;
    n = n[side];
  }
  return null;
}

function isInsidePreOrCode(node) {
  for (let p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) {
    if (p.tagName === 'PRE' || p.tagName === 'CODE') return true;
  }
  return false;
}

export function serverEquivalentForm(html) {
  if (!html) return '';
  const wrap = parseFragment(html);
  if (!wrap) return '';
  for (const a of Array.from(wrap.querySelectorAll('a'))) {
    if (a.attributes.length !== 1 || !a.hasAttribute('href')) continue;
    if (a.getAttribute('href') !== a.textContent || a.firstElementChild) continue;
    if (isInsidePreOrCode(a)) continue;
    a.replaceWith(...a.childNodes);
  }
  wrap.normalize();
  for (const el of wrap.querySelectorAll(EDGE_TRIM_BLOCKS)) {
    const last = edgeTextNodeIn(el, false);
    if (last) last.textContent = last.textContent.replace(/[\s ]+$/u, '');
    const first = edgeTextNodeIn(el, true);
    if (first) first.textContent = first.textContent.replace(/^[\s ]+/u, '');
  }
  return wrap.innerHTML;
}
