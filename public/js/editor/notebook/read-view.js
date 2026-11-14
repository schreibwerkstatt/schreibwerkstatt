// Die Leseansicht des Notebook-Editors im DOM — ein Selektor für alle, die sie
// suchen (Diagramme, Legenden-Nummern, Kastenhöhe, Kommentar-Leiste, Todo-Haken).
//
// Gescopt auf `.page-view-wrap` (editor-body-view.html), weil zwei weitere
// `.page-content-view` im Dokument stehen: der Edit-Container
// (`--editing`, früher im DOM, im Read-Modus leer) und der Revisions-Viewer
// (`.revision-viewer__content`). Ein nacktes `.page-content-view` mit
// Ausschluss-Liste hält nur so lange, wie jemand jeden neuen Träger der Klasse
// in jede Liste nachträgt.

export const READ_VIEW_SEL = '.page-view-wrap .page-content-view';

export function notebookReadView() {
  return document.querySelector(READ_VIEW_SEL);
}

// Leerabsätze vor dem ersten Inhalt (`<p><br></p>`, z.B. aus Import oder Enter
// am Abschnittsanfang) blähen den oberen Abstand der Leseansicht auf — hinten
// räumt cleanPageHtml sie weg, vorne nicht. Markiert werden sie hier im
// Render-String mit `.pcv-lead-empty` (versteckt in page-view.css), nicht per
// CSS-Selektor über Geschwister: ein `p:is(:empty, :has(br:only-child)) ~ *`
// lässt Chromium bei jedem Enter/Backspace im Edit-Container den ganzen
// Editor neu stilberechnen, obwohl die Regel dort nie greift. Im Edit-Modus
// bleiben die Absätze sichtbar (der Editor mountet `originalHtml`, nicht den
// Render-String), damit man sie löschen kann.
const LEAD_EMPTY_P_RE = /^(\s*)<p(\s[^>]*)?>(?:\s|<br\s*\/?>)*<\/p>/i;

export function markLeadingEmptyParas(html) {
  if (!html) return html;
  let out = '';
  let rest = html;
  for (;;) {
    const m = LEAD_EMPTY_P_RE.exec(rest);
    if (!m) break;
    const attrs = m[2] || '';
    const marked = /\sclass\s*=\s*"/i.test(attrs)
      ? attrs.replace(/(\sclass\s*=\s*")/i, '$1pcv-lead-empty ')
      : attrs + ' class="pcv-lead-empty"';
    out += m[1] + '<p' + marked + '></p>';
    rest = rest.slice(m[0].length);
  }
  return out ? out + rest : html;
}
