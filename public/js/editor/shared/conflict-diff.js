// Anzeige eines kollidierenden Blocks im Auflösungs-Modal (Notebook + Focus-Editor,
// partials/conflict-resolution.html): beide Fassungen als Klartext mit markiertem
// Wort-Diff statt rohem Block-HTML samt `data-bid`, zwischen dem der Leser die
// Änderung selbst suchen müsste.
//
// Pure — Text-Extraktion per Regex (Entities im Browser via DOMParser), damit
// Node den Pfad testen kann.
// Die Vorschau ist reine Lesehilfe; übernommen wird weiterhin das rohe Block-HTML
// (block-merge.js#buildResolvedHtml).

import { wordDiff } from '../../chat/word-diff.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '' };

// Im Browser decodiert DOMParser jede Entity (inert, keine Resource-Loads);
// Node-Fallback deckt die Entities ab, die der Editor selbst schreibt.
function _decode(s) {
  if (typeof DOMParser !== 'undefined') {
    try { return new DOMParser().parseFromString(s, 'text/html').body?.textContent ?? s; } catch { /* Fallback */ }
  }
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Block-HTML → Lesetext. Zeilenumbrüche an `<br>` und inneren Block-Grenzen
// (Listenpunkte, Tabellenzeilen, Gedichtzeilen), sonst zusammengezogener Whitespace.
export function blockText(html) {
  if (!html) return '';
  return _decode(String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|tr|div|blockquote|figcaption|dt|dd)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]*>/g, ''))
    .replace(/[^\S\n\t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Anzeige-Modell eines Konflikts.
 * @param {{ local_html: string|null, remote_html: string|null }} c
 * @returns {{ local: Array<{t:string,v:string}>|null, remote: Array<{t:string,v:string}>|null, formatOnly: boolean }}
 *   `local`/`remote`: Teile für die jeweilige Spalte (`eq` + `del` bzw. `eq` + `add`);
 *   `null` = Block in dieser Fassung gelöscht. `formatOnly`: gleicher Text, nur das
 *   Markup unterscheidet sich (Fett, Überschriftenebene …) — der Diff zeigt dann nichts.
 */
export function conflictDiffView(c) {
  const lt = c.local_html == null ? null : blockText(c.local_html);
  const rt = c.remote_html == null ? null : blockText(c.remote_html);
  if (lt == null || rt == null) {
    return {
      local: lt == null ? null : [{ t: 'eq', v: lt }],
      remote: rt == null ? null : [{ t: 'eq', v: rt }],
      formatOnly: false,
    };
  }
  const parts = wordDiff(lt, rt);
  if (!parts) {
    // Zu lang für die LCS-Tabelle: beide Fassungen ungemarkert.
    return { local: [{ t: 'eq', v: lt }], remote: [{ t: 'eq', v: rt }], formatOnly: false };
  }
  return {
    local: parts.filter(p => p.t !== 'add'),
    remote: parts.filter(p => p.t !== 'del'),
    formatOnly: lt === rt,
  };
}
