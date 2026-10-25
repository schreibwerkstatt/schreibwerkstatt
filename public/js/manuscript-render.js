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
// entry.headBefore/headAfter: fertiges Markup aus lib/headline-render.js bzw.
// lib/share-helpers.js (Bearbeitungsstand), das seine Textwerte dort bereits
// escaped hat.

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
  // dann KEIN Heading für genau dieses Kapitel im Body (sonst doppelt); seine
  // Abschnitte und Unterkapitel rücken eine Verzeichnis-Ebene hoch.
  omitChapterId: null,
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
  // Verzeichnis-Ebene = Tiefe + 1 (Kapitel: depth 0 = oberstes Kapitel; Seite:
  // depth = Zahl der umschliessenden Kapitel), beim ausgelassenen Wurzel-
  // Kapitel eines Kapitel-Shares eine Ebene höher.
  const omitted = o.omitChapterId != null
    && (entries || []).some(e => e.kind === 'chapter' && e.chapterId === o.omitChapterId);
  const shift = omitted ? 1 : 0;
  const lvl = (d) => Math.max(1, (d || 0) + 1 - shift);
  for (const e of (entries || [])) {
    if (e.kind === 'chapter') {
      pendingChapter = e;
      if (omitted && e.chapterId === o.omitChapterId) continue;
      const a = o.anchorPrefix + (++n);
      const level = lvl(e.depth);
      toc.push({ level, label: e.name || '', anchor: a, chapterId: e.chapterId ?? null, pageId: null });
      // Tiefen-Klasse ab Unterkapitel: der Look stuft die Grösse ab
      // (manuscript-stream.css), das Tag bleibt — Seiten sitzen auf pageTag.
      const cls = level > 1 ? `${o.chapterClass} ${o.chapterClass}--d${Math.min(level, 3) - 1}` : o.chapterClass;
      sections.push(`<${o.chapterTag} id="${a}" class="${cls}">${escHtml(e.name || '')}</${o.chapterTag}>`);
    } else if (e.kind === 'page') {
      const dupOfChapter = !!pendingChapter && !e.article
        && (pendingChapter.chapterId ?? null) === (e.chapterId ?? null)
        && sameStructureTitle(e.name, pendingChapter.name);
      pendingChapter = null;
      if (dupOfChapter) {
        // Die Ueberschrift entfaellt, `headAfter` nicht: ein Nicht-Beitrag traegt
        // dort nur Zusatz-Markup (Share: Bearbeitungsstand), das sonst verloren ginge.
        sections.push(`<section class="${o.pageSectionClass}">
            ${e.headAfter || ''}
            <div class="${o.pageBodyClass}">${e.html || ''}</div>
          </section>`);
        continue;
      }
      const a = o.anchorPrefix + (++n);
      // Seite im Kapitel ohne Tiefenangabe (handgebaute Entries) liegt eine
      // Ebene unter ihrem Kapitel.
      const level = lvl(e.depth || (e.chapterId ? 1 : 0));
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
