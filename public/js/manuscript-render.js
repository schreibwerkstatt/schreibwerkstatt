// Read-only Stream→HTML-Renderer für das kanonische Manuskript-Stream-Modell
// (manuscript-stream.js). Konsument: Share-SSR (routes/share.js lädt das Modul
// serverseitig via dynamic import(), Muster wie lib/prompts-loader.js).
//
// PURE + ISOMORPH: kein DOM, kein Browser-Import. escHtml direkt aus
// utils/escape.js (pure, ohne Importe) — NICHT aus der utils.js-Facade, die
// trägt Browser-Annahmen und würde den Node-Import brechen.
//
// ESCAPING-INVARIANTE: Entry-Namen werden via escHtml escaped; entry.html wird
// VERBATIM eingefügt (bereits via lib/html-clean.js sanitisiert, trägt data-bid
// für Kommentar-Anker). Niemals beides vertauschen — roher Name = XSS-Sink,
// doppelt-escaptes html = kaputte Anzeige. Dasselbe gilt für
// entry.headBefore/headAfter: fertiges Markup aus lib/headline-render.js, das
// seine Textwerte dort bereits escaped hat.

import { escHtml } from './utils/escape.js';
import { sameStructureTitle } from './structure-title.js';

const DEFAULTS = {
  chapterTag: 'h2',
  pageTag: 'h3',
  // Neutrale .ms-*-Klassen → geteilter Stream-Look (public/css/components/
  // manuscript-stream.css), gespiegelt vom Bucheditor.
  chapterClass: 'ms-chapter',
  pageSectionClass: 'ms-page',
  pageTitleClass: 'ms-page__title',
  pageBodyClass: 'ms-page__body',
  anchorPrefix: 'sec',
  // Bei Kapitel-Shares hängt der Kapitel-Titel schon im Seiten-Header (h1) —
  // dann KEIN Kapitel-Heading im Body (sonst doppelt), Seiten bleiben Top-Level.
  omitChapterHeaders: false,
};

// entries: StreamEntry[] (siehe manuscript-stream.js).
// Liefert { html, toc } — toc = [{ level, label, anchor, chapterId, pageId }] für
// buildTocBlock (label/anchor/level) sowie die Reader-Lesetiefe-Zuordnung
// (chapterId/pageId → echte Entitäten; additiv, andere Konsumenten ignorieren sie).
export function renderStreamHtml(entries, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const sections = [];
  const toc = [];
  let n = 0;
  // Kapitel, dessen erster Abschnitt als naechstes kommt (null, sobald einer
  // gerendert ist). Traegt dieser erste Abschnitt denselben Namen, entfaellt
  // seine Ueberschrift samt Verzeichnis-Eintrag — dieselbe Regel wie PDF/Word
  // (structure-title.js). Bei Kapitel-Shares steht der Kapitelname im h1-Kopf
  // der Leseansicht und zaehlt genauso.
  let pendingChapter = null;
  for (const e of (entries || [])) {
    if (e.kind === 'chapter') {
      pendingChapter = e;
      if (o.omitChapterHeaders) continue;
      const a = o.anchorPrefix + (++n);
      toc.push({ level: 1, label: e.name || '', anchor: a, chapterId: e.chapterId ?? null, pageId: null });
      sections.push(`<${o.chapterTag} id="${a}" class="${o.chapterClass}">${escHtml(e.name || '')}</${o.chapterTag}>`);
    } else if (e.kind === 'page') {
      const dupOfChapter = !!pendingChapter && !e.article
        && (pendingChapter.chapterId ?? null) === (e.chapterId ?? null)
        && sameStructureTitle(e.name, pendingChapter.name);
      pendingChapter = null;
      if (dupOfChapter) {
        sections.push(`<section class="${o.pageSectionClass}">
            <div class="${o.pageBodyClass}">${e.html || ''}</div>
          </section>`);
        continue;
      }
      const a = o.anchorPrefix + (++n);
      const level = (e.chapterId && !o.omitChapterHeaders) ? 2 : 1;
      toc.push({ level, label: e.name || '', anchor: a, chapterId: e.chapterId ?? null, pageId: e.id ?? null });
      // headBefore/headAfter (Dachzeile bzw. Lead) sind FERTIGES Markup aus
      // lib/headline-render.js und werden — wie e.html — verbatim eingefügt.
      // Nicht escapen: escHtml gilt hier nur für die Entry-Namen.
      // `article`: die Seite ist ein Beitrag mit eigener Schlagzeile. Die
      // Seiten-Caption ist sonst eine kleine gesperrte Marginalie — als
      // Schlagzeile gesetzt wäre das falsch, darum die Variantenklasse statt
      // eines zweiten Renderers.
      const secCls = e.article ? `${o.pageSectionClass} ${o.pageSectionClass}--article` : o.pageSectionClass;
      const titleCls = e.article ? `${o.pageTitleClass} ${o.pageTitleClass}--headline` : o.pageTitleClass;
      sections.push(`<section class="${secCls}">
            ${e.headBefore || ''}
            <${o.pageTag} id="${a}" class="${titleCls}">${escHtml(e.name || '')}</${o.pageTag}>
            ${e.headAfter || ''}
            <div class="${o.pageBodyClass}">${e.html || ''}</div>
          </section>`);
    }
  }
  return { html: sections.join('\n'), toc };
}
