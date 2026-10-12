'use strict';
// Plain-Text-Export. Verkettet Titel + Kapitel-/Page-Headings + Body. `<br>`
// wird zu `\n` (Shift-Enter aus den Editoren = harter Zeilenumbruch); übrige
// Tags zu Single-Space, horizontale Whitespaces collapsed, Mehrfach-Leerzeilen
// auf max. 2 begrenzt.

const { resolveTitle, prepareCitations, notesTitleFor } = require('./shared');
const { buildXrefContext, applyXrefsInGroups } = require('../xref-render');
const { directoryLines } = require('../anchor-directory');
const { bibliographyItemLines } = require('../bibliography');
const headline = require('../headline-render');
const { decodeEntities } = require('../html-text');

// Tabellen VOR dem generischen Tag-Strip in Zeilen zerlegen. Ohne diesen Schritt
// laufen alle Zellen zu einer einzigen Textwurst zusammen („Jahr Umsatz 2023 1.2
// Mio") und die Tabelle ist als Tabelle nicht mehr erkennbar.
//
// Ausgabeform ist ein pipe-getrenntes Raster, keine ausgerichteten Spalten:
// Plaintext hat keine garantierte Monospace-Anzeige, und eine mit Leerzeichen
// aufgefuellte Spalte verrutscht in jedem proportional gesetzten Betrachter.
// Regex statt Walker, weil dieses Modul bewusst parserfrei arbeitet (wie der
// Rest der Datei). Verschachtelte Tabellen gibt es nicht — der Markup-Vertrag
// (public/js/table/table-html.js) erlaubt in einer Zelle nur Inline-Inhalt.
function _tablesToText(html) {
  return String(html || '').replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (tbl) => {
    const strip = (s) => s
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    const cap = (tbl.match(/<caption\b[^>]*>([\s\S]*?)<\/caption\s*>/i) || [])[1];
    const rows = (tbl.match(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi) || []).map((tr) => {
      const cells = (tr.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]\s*>/gi) || []).map(strip);
      return cells.join(' | ');
    }).filter(Boolean);
    if (!rows.length) return cap ? `\n${strip(cap)}\n` : '\n';
    const out = [];
    if (cap) out.push(strip(cap));
    out.push(...rows);
    return `\n${out.join('\n')}\n`;
  });
}

// Gedicht (`div.poem` / `blockquote.poem`): dieselbe Strophen-Regel wie der
// Walker (lib/pdf-render/html-walker.js). Trägt ein Absatz mehrere Verse, ist
// jeder Absatz eine Strophe → Leerzeile dazwischen; sonst ist jeder Absatz ein
// Vers und die Verse stehen ohne Leerzeile untereinander. Muss VOR der
// allgemeinen Absatz-Regel laufen, die jedem Absatzende eine Leerzeile gibt.
function _poemsToText(html) {
  return html.replace(/<(div|blockquote)\b[^>]*\bclass="[^"]*\bpoem\b[^"]*"[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _tag, inner) => {
    const paras = inner.match(/<p\b[^>]*>[\s\S]*?<\/p\s*>/gi) || [inner];
    const stanzaParas = paras.some(p => /<br\s*\/?>\s*\S/i.test(p.replace(/<br\s*\/?>\s*<\/p>/i, '</p>')));
    const sep = stanzaParas ? '\n\n' : '\n';
    const text = paras.map(p => p
      .replace(/<br\s*\/?>\s*(?=<\/p)/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim()).join(sep);
    return `\n\n${text}\n\n`;
  });
}

// Nachrichtenverlauf (`div.msg-thread`, Markup-SSoT public/js/messages/
// msg-html.js): eine Zeile pro Nachricht, kein Leerraum dazwischen. Ausgehend
// mit „→", Absender mit Doppelpunkt, Zeitangaben in eckigen Klammern —
// dieselbe Konvention wie Markdown/Substack. Läuft wie das Gedicht VOR der
// allgemeinen Absatz-Regel.
function _msgThreadsToText(html) {
  return html.replace(/<div\b[^>]*\bclass="[^"]*\bmsg-thread\b[^"]*"[^>]*>([\s\S]*?)<\/div\s*>/gi, (_m, inner) => {
    const rows = (inner.match(/<p\b[^>]*>[\s\S]*?<\/p\s*>/gi) || []).map((p) => {
      const cls = ((p.match(/^<p\b[^>]*\bclass="([^"]*)"/i) || [])[1] || '').split(/\s+/);
      const t = p.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!t) return '';
      if (cls.includes('msg-name')) return `${t}:`;
      if (cls.includes('msg-meta')) return `[${t}]`;
      return cls.includes('msg-out') ? `→ ${t}` : t;
    }).filter(Boolean);
    return `\n\n${rows.join('\n')}\n\n`;
  });
}

function htmlToText(html) {
  return _msgThreadsToText(_poemsToText(_tablesToText(html)))
    // Blockende = Absatzende. Ohne diese Regel fielen alle Absätze einer Seite
    // zu einer einzigen Zeile zusammen, weil gespeichertes HTML zwischen den
    // Blöcken keinen Zeilenumbruch trägt.
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<\/(p|h[1-6]|blockquote|pre|div|figure|figcaption|ul|ol)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    // Entities erst NACH dem letzten Tag-Strip dekodieren: ein `&lt;b&gt;` im
    // Text ist Text, kein Tag. Tabellen- und Gedicht-Text laufen durch dieselbe
    // Stelle, darum dekodieren _tablesToText/_poemsToText nicht selbst.
    // `&nbsp;` wird zum normalen Leerzeichen: Plaintext traegt kein Umbruch-
    // verbot, und ein `<p>&nbsp;</p>` soll als Leerzeile kollabieren.
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m) => decodeEntities(m))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function buildTxt(bundle, opts = {}) {
  const { scope, book, chapter, page } = bundle;
  const prepared = await prepareCitations(bundle, opts);
  const { bib, showBibliography } = prepared;
  // Querverweise aufloesen (Begruendung wie im HTML-Builder).
  const xrefCtx = await buildXrefContext({ bookId: book?.book_id, groups: prepared.groups });
  const groups = (await applyXrefsInGroups(prepared.groups, xrefCtx)).groups;
  const out = [];
  const title = resolveTitle({ scope, book, chapter, page });
  if (title) out.push(title, '');

  for (const g of groups) {
    const ch = g.chapter;
    if (ch && (scope === 'book' || scope === 'chapter')) {
      out.push(ch.name);
      out.push('');
    }
    const includePageHeadings = scope === 'book' && ch && g.pages.length > 1;
    for (const x of g.pages) {
      // Titel-Kopf. Plaintext hat keine Auszeichnung — Dachzeile und Lead
      // erkennt man hier allein an ihrer Stellung ueber bzw. unter der
      // Ueberschrift. Bewusst NICHT in Versalien gesetzt: das waere eine
      // Aenderung am Wortlaut des Autors, um eine Formatierung zu ersetzen.
      if (includePageHeadings || headline.needsOwnHead(x.p)) {
        const kicker = headline.kickerText(x.p);
        if (kicker) out.push(kicker, '');
        out.push(headline.pageTitle(x.p), '');
        const lead = headline.leadText(x.p);
        if (lead) out.push(lead, '');
      }
      const txt = htmlToText(x.pd.html);
      if (txt) { out.push(txt); out.push(''); }
    }
    if (g.notes && g.notes.length) {
      out.push(notesTitleFor(bib), '');
      for (const nt of g.notes) out.push(`${nt.n}. ${nt.text}`);
      out.push('');
    }
  }
  // Abbildungs-/Tabellenverzeichnis, Sichtbarkeit wie beim Quellenverzeichnis:
  // nur beim ganzen Buch.
  if (showBibliography) {
    for (const kind of ['figure', 'table']) {
      const lines = directoryLines(xrefCtx, kind, { lang: xrefCtx.lang });
      if (lines.length) { out.push(...lines, ''); }
    }
  }
  // Quellenverzeichnis: Klartext-Form der Eintraege (bib.entries[].text) statt
  // des HTML — Plaintext hat keinen Kursivsatz, den man strippen muesste. Das
  // `[n]`-Praefix des numerischen Stils setzt bibliographyItemLines, damit die
  // Nummern-Regel nicht in jedem Builder erneut steht.
  if (showBibliography) {
    out.push(bib.title, '');
    out.push(...bibliographyItemLines(bib));
    out.push('');
  }
  // BOM wird vom Caller (routes/export.js) gesetzt — Builder liefert nackten
  // UTF-8-Text.
  return Buffer.from(out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf8');
}

module.exports = { buildTxt, htmlToText };
