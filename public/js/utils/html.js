// HTML-Bereinigung für Editor-Inhalte: Text-Extraktion, Paste-Sanitizing,
// Inline-Style-/Leerblock-Cleanup. DOMParser-basiert (inert, keine
// Resource-Loads). Idempotent aufrufbar.

// Sicherheitscheck vor dem Speichern: < 50 % wirkt unvollständig → Abbruch
export const SAFETY_HTML_RATIO = 0.5;

export function htmlToText(html) {
  // DOMParser statt detached div: `div.innerHTML = …` triggert in allen
  // Browsern einen GET auf `<img src>`/Background-URLs (HTML-Parser-Pipeline
  // setzt Resource-Loads nicht aus). DOMParser('text/html') produziert ein
  // inert document ohne Resource-Requests.
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html || '', 'text/html');
      return doc.body?.textContent || '';
    } catch { /* fallback unten */ }
  }
  const d = document.createElement('template');
  d.innerHTML = html || '';
  return d.content?.textContent || '';
}

/**
 * Entfernt Fokus-Modus-Artefakte aus Seiten-HTML. Browser friert bei
 * contenteditable-Edits die computed `font-size` des Fokus-Containers als
 * inline `<span style="font-size:…">` ein; die `focus-paragraph-*`-Klassen sind
 * rein interne UI-Markierungen, die nie ins persistierte HTML gehören.
 * Idempotent – auch auf bereits sauberem HTML sicher aufrufbar. Aufruf an allen
 * Seams: nach dem Laden vom Server und vor dem Speichern.
 */
export function stripFocusArtefacts(html) {
  if (!html) return html;
  // Trigger erweitern: leeres `class=""` entsteht, wenn classList.remove die
  // letzte Klasse wegnimmt — Attribut bleibt mit leerem Wert stehen. Ohne
  // diesen Branch erzeugt Focus-Mode-Aktiv-Markierung beim Save eine Revision,
  // obwohl semantisch nichts geändert wurde.
  if (
    !html.includes('focus-paragraph') &&
    !html.includes('hr-selected') &&
    !/font-size|background-color\s*:\s*transparent/i.test(html) &&
    !/\sclass\s*=\s*""/.test(html)
  ) {
    return html;
  }

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Transiente Editor-UI-Markierungen (Focus-Spotlight-Klassen, per Klick
  // selektierte <hr>) sind reine Laufzeit-Dekoration — nie persistieren, sonst
  // falsch-dirty im Vergleich + landen in der Revision.
  //
  // Praefix-basiert statt Klassenliste: der Focus-Editor markiert heute den
  // aktiven Absatz (`-active`) und in der Granularitaet window-3 zusaetzlich
  // dessen Nachbarn (`-near`); beide haengen waehrend der ganzen Edit-Session im
  // DOM, also auch wenn Autosave oder der Exit-Save mitten drin speichert. Die
  // Erweitern-Checkliste in docs/focus-editor.md nennt diese Stelle nicht — eine
  // gepflegte Liste driftet beim naechsten Granularitaetsmodus zwangslaeufig
  // wieder auseinander, das Praefix nicht.
  tmp.querySelectorAll('[class*="focus-paragraph"], .hr-selected').forEach(el => {
    for (const c of Array.from(el.classList)) {
      if (c.startsWith('focus-paragraph-')) el.classList.remove(c);
    }
    el.classList.remove('hr-selected');
    if (el.classList.length === 0) el.removeAttribute('class');
  });

  tmp.querySelectorAll('[style]').forEach(el => {
    const cleaned = (el.getAttribute('style') || '')
      .split(';')
      .map(d => d.trim())
      .filter(d => {
        if (!d) return false;
        const key = d.split(':')[0].trim().toLowerCase();
        if (key === 'font-size') return false;
        if (key === 'background-color' && /transparent/i.test(d)) return false;
        return true;
      })
      .join('; ');
    if (cleaned) el.setAttribute('style', cleaned);
    else el.removeAttribute('style');
  });

  tmp.querySelectorAll('span').forEach(span => {
    if (span.attributes.length === 0) {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  });

  // Verbleibende leere class=""-Attribute unabhängig von ihrer Herkunft entfernen.
  tmp.querySelectorAll('[class=""]').forEach(el => el.removeAttribute('class'));

  return tmp.innerHTML;
}

// Paste-Sanitizer: utils/html/paste.js.
export { sanitizePasteHtml } from './html/paste.js';

// Tags, auf denen `style` IMMER unerwünscht ist (Block-Styling kommt über
// .poem/.callout/style.css; der Editor selbst setzt nie inline-style).
// Strukturelemente wie img/table/td/col/figure/iframe bleiben unangetastet,
// dort sind Width-/Height-Angaben legitim.
const STRIP_STYLE_TAGS = new Set([
  'P', 'SPAN', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'UL', 'OL', 'BLOCKQUOTE', 'A', 'B', 'I', 'STRONG', 'EM',
  'BR', 'PRE', 'CODE', 'SMALL', 'MARK', 'U', 'S', 'SUB', 'SUP',
]);

// Formatierungs-Tags, die leer (oder nur mit Leerraum) wegfallen — nur
// attributlose: `<a>`, Marker-Spans und alles mit Klasse bleibt.
const EMPTY_INLINE_TAGS = 'i,em,b,strong,u,s,mark,small,sub,sup';
const EMPTY_INLINE_PROBE = /<(i|em|b|strong|u|s|mark|small|sub|sup)\b[^>]*>\s*<\//i;

/**
 * Säubert HTML von Inline-Style-Müll, leeren Spans und Paste-Wrapper-Tags.
 *
 * Chrome friert beim Tippen oder Pasten in `contenteditable` die Computed-
 * Styles auf jedem Block ein (z.B. `<p style="margin:0.4em 0px;color:rgb(...);
 * font-family:Lato,...">`). Werden diese Inline-Styles mitgespeichert,
 * überschreiben sie beim Rendern die echten Block-Styles (`.poem` &Co)
 * und das Resultat sieht kaputt aus.
 *
 * Idempotent. Behält `style` auf img/table/td/col/figure/iframe.
 */
// Eine Bildunterschrift, die nur den Caret-Platzhalter trägt, ist leer: so
// gespeichert blendet `figcaption:empty` (manuscript-content.css) sie in
// Leseansicht und Share-Reader aus. Im Editor bleibt das `<br>` als Schreibplatz
// stehen — die Regel greift nur auf dem gesendeten/verglichenen HTML.
// Server-Pendant: lib/html-clean.js#emptyBlankFigcaptions (gleiche Regel).
const BLANK_FIGCAPTION_RE = /(<figcaption\b[^>]*>)\s*<br\s*\/?>\s*(<\/figcaption>)/gi;

export function cleanContentArtefacts(html) {
  if (!html) return html;
  html = html.replace(BLANK_FIGCAPTION_RE, '$1$2');
  if (!/\sstyle\s*=|<(span|meta|link|script|style|title)\b/i.test(html)
    && !EMPTY_INLINE_PROBE.test(html)) return html;

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Paste-Wrapper aus Browser/Office (komplett raus, samt Inhalt)
  tmp.querySelectorAll('meta, link, script, style, title').forEach(el => el.remove());

  tmp.querySelectorAll('[style]').forEach(el => {
    if (STRIP_STYLE_TAGS.has(el.tagName)) el.removeAttribute('style');
  });

  // Leere Spans aus Paste-/Selection-Operationen entkernen
  tmp.querySelectorAll('span').forEach(span => {
    if (span.attributes.length === 0) {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  });

  // Leere Formatierungs-Hüllen (`<i></i>`), die ein Schnitt am Formatrand
  // zurücklässt — nach dem style-Strip, damit auch `<i style="…"></i>` fällt.
  // Server-Pendant: lib/html-clean.js#stripEmptyInline (gleiche Regel).
  for (const el of Array.from(tmp.querySelectorAll(EMPTY_INLINE_TAGS)).reverse()) {
    if (el.attributes.length || el.firstElementChild) continue;
    if ((el.textContent || '').trim()) continue;
    while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
    el.remove();
  }

  return tmp.innerHTML;
}

// Elemente mit eigenem "visuellen" Inhalt (dürfen leer wirken, bleiben erhalten).
const _STRUCTURAL_LEAF = 'img,iframe,video,audio,table,figure,hr,object,embed,canvas,svg,input,button';

function _isBlankTrailing(node) {
  if (!node) return false;
  if (node.nodeType === 3) return !node.textContent.replace(/\u00A0/g, ' ').trim();
  if (node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag !== 'P' && tag !== 'DIV' && tag !== 'BR') return false;
  if (tag === 'BR') return true;
  if ((node.textContent || '').replace(/\u00A0/g, ' ').trim()) return false;
  if (node.querySelector(_STRUCTURAL_LEAF)) return false;
  return true;
}

/**
 * Reduziert Runs aufeinanderfolgender Leerblöcke (`<p></p>`, `<p><br></p>`,
 * `<p>&nbsp;</p>`, top-level `<br>`) auf je einen Block und Runs von `<br>`
 * innerhalb von Inline-Kontext (z.B. `<p>foo<br><br>bar</p>`) auf ein einzelnes
 * `<br>`. Ein einzelner Leerblock bleibt als bewusste Absatz-Trennung erhalten.
 * Idempotent. Nutzt DOMParser, keine Script-Side-Effects.
 */
export function collapseEmptyBlocks(html) {
  if (!html) return html;
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return html;

  // Top-Level: Run von Leerblöcken → erster Block bleibt, Rest weg.
  let node = root.firstChild;
  while (node) {
    const next = node.nextSibling;
    if (_isBlankTrailing(node)) {
      let probe = next;
      while (probe) {
        const probeNext = probe.nextSibling;
        if (probe.nodeType === 3 && !probe.textContent.replace(/\u00A0/g, ' ').trim()) {
          probe.remove();
          probe = probeNext;
          continue;
        }
        if (_isBlankTrailing(probe)) {
          probe.remove();
          probe = probeNext;
          continue;
        }
        break;
      }
    }
    node = next;
  }

  // Inline: aufeinanderfolgende `<br>` (auch durch Whitespace getrennt) → ein `<br>`.
  // Nicht im Code-Block: dort ist eine Leerzeile (`a<br><br>b`) Inhalt.
  root.querySelectorAll('br').forEach(br => {
    if (br.closest('pre')) return;
    let s = br.nextSibling;
    while (s) {
      const sn = s.nextSibling;
      if (s.nodeType === 3 && !s.textContent.replace(/\u00A0/g, ' ').trim()) {
        s.remove();
        s = sn;
        continue;
      }
      if (s.nodeType === 1 && s.tagName === 'BR') {
        s.remove();
        s = sn;
        continue;
      }
      break;
    }
  });

  return root.innerHTML;
}

/**
 * Entfernt leere Absätze am Ende des HTML. contenteditable hängt beim Tippen
 * oft `<p><br></p>`/`<p>&nbsp;</p>` an; ohne Strip wachsen beim jedem Save
 * weitere Leerabsätze hinten ans Seiten-HTML. Idempotent, Top-Level only.
 * Nutzt DOMParser statt innerHTML-Assign, um keine Script-Side-Effects auszulösen.
 */
export function stripTrailingEmptyBlocks(html) {
  if (!html) return html;
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return html;
  let last = root.lastChild;
  while (last && _isBlankTrailing(last)) {
    const prev = last.previousSibling;
    root.removeChild(last);
    last = prev;
  }
  return root.innerHTML;
}
