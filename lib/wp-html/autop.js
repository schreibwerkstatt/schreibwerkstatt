'use strict';
// Absatzbildung fuer Classic-Editor-Posts — Nachbau von WordPress' `wpautop`
// (wp-includes/formatting.php). Ein Classic-Post speichert in `content.raw`
// keine `<p>`: Absaetze sind Leerzeilen, Zeilenumbrueche einzelne `\n`, und
// erst beim Rendern macht `wpautop` daraus HTML. Ohne denselben Schritt beim
// Pull packte html-clean den ganzen Text in EINEN Absatz, und ein Push schriebe
// ihn als einen Absatz-Block zurueck — in einem Post mit Block-Kommentaren
// laesst WordPress `wpautop` weg, der Live-Blog zeigte eine Textwand.
//
// Nur fuer Posts OHNE `<!-- wp:`-Kommentare (dom.js#hasBlockComments): im
// Block-Editor-Post stehen die `<p>` schon im Inhalt.

const ALLBLOCKS = '(?:table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|math|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary)';

const RE_BLOCK_OPEN = new RegExp(`(<${ALLBLOCKS}[\\s/>])`, 'gi');
const RE_BLOCK_CLOSE = new RegExp(`(</${ALLBLOCKS}>)`, 'gi');
const RE_P_AROUND_BLOCK = new RegExp(`<p>\\s*(</?${ALLBLOCKS}[^>]*>)\\s*</p>`, 'gi');
const RE_P_BEFORE_BLOCK = new RegExp(`<p>\\s*(</?${ALLBLOCKS}[^>]*>)`, 'gi');
const RE_P_AFTER_BLOCK = new RegExp(`(</?${ALLBLOCKS}[^>]*>)\\s*</p>`, 'gi');
const RE_BR_AFTER_BLOCK = new RegExp(`(</?${ALLBLOCKS}[^>]*>)\\s*<br />`, 'gi');
const RE_BR_BEFORE_BLOCK = /<br \/>(\s*<\/?(?:p|li|div|dl|dd|dt|th|pre|td|ul|ol)[^>]*>)/gi;

/** Zeilenumbrueche innerhalb von Tags (`<a\nhref>`) zu Leerzeichen — sonst
 *  machte der `<br>`-Schritt aus ihnen Umbrueche mitten im Tag. */
function _flattenNewlinesInTags(text) {
  return text.replace(/<[^>]*>/g, (tag) => (tag.startsWith('<!--') ? tag : tag.replace(/\s*\n\s*/g, ' ')));
}

function wpautop(input) {
  let text = String(input || '');
  if (!text.trim()) return '';
  text = text.replace(/\r\n|\r/g, '\n') + '\n';

  // <pre> bleibt unangetastet (Umbrueche darin sind Inhalt).
  const preTags = new Map();
  if (text.includes('<pre')) {
    const parts = text.split('</pre>');
    const last = parts.pop();
    text = '';
    parts.forEach((part, i) => {
      const start = part.indexOf('<pre');
      if (start === -1) { text += part; return; }
      const name = `<pre wp-pre-tag-${i}></pre>`;
      preTags.set(name, `${part.slice(start)}</pre>`);
      text += part.slice(0, start) + name;
    });
    text += last;
  }

  text = text.replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '\n\n');
  text = text.replace(RE_BLOCK_OPEN, '\n\n$1');
  text = text.replace(RE_BLOCK_CLOSE, '$1\n\n');
  text = text.replace(/<hr\s*?\/?>/gi, '<hr />\n\n');
  text = _flattenNewlinesInTags(text);
  text = text.replace(/\n\n+/g, '\n\n');

  const paras = text.split(/\n\s*\n/).filter(s => s.trim());
  text = paras.map(p => `<p>${p.replace(/^\n+|\n+$/g, '')}</p>\n`).join('');

  text = text.replace(/<p>\s*<\/p>/g, '');
  text = text.replace(/<p>([^<]+)<\/(div|address|form)>/gi, '<p>$1</p></$2>');
  text = text.replace(RE_P_AROUND_BLOCK, '$1');
  text = text.replace(/<p>(<li.+?)<\/p>/gi, '$1');
  text = text.replace(/<p><blockquote([^>]*)>/gi, '<blockquote$1><p>');
  text = text.replace(/<\/blockquote><\/p>/gi, '</p></blockquote>');
  text = text.replace(RE_P_BEFORE_BLOCK, '$1');
  text = text.replace(RE_P_AFTER_BLOCK, '$1');
  // Ein HTML-Kommentar allein im Absatz (`<!--more-->`) ist keine Zeile Text.
  text = text.replace(/<p>\s*(<!--[\s\S]*?-->)\s*<\/p>/g, '$1');

  text = text.replace(/<br>|<br\/>/gi, '<br />');
  text = text.replace(/(?<!<br \/>)\s*\n/g, '<br />\n');
  text = text.replace(RE_BR_AFTER_BLOCK, '$1');
  text = text.replace(RE_BR_BEFORE_BLOCK, '$1');
  // Zeilenende vor dem schliessenden Absatz bzw. Kommentar ist kein Umbruch.
  text = text.replace(/<br \/>\n(\s*<\/p>)/g, '\n$1');
  text = text.replace(/(-->)<br \/>\n/g, '$1\n');
  text = text.replace(/<br \/>\n$/g, '\n');
  // Der Zeilenumbruch hinter `<br />` ist nur Quelltext-Formatierung; in der App
  // stuende er als Leerzeichen am Zeilenanfang.
  text = text.replace(/<br \/>\n/g, '<br />');

  for (const [name, html] of preTags) text = text.replace(name, html);
  return text.trim();
}

module.exports = { wpautop };
