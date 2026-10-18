// Anzeige eines kollidierenden Blocks im Auflösungs-Modal (Notebook, Focus-Editor
// und Bucheditor, partials/conflict-blocks.html): beide Fassungen als Klartext mit
// markiertem Wort-Diff statt rohem Block-HTML samt `data-bid`, zwischen dem der
// Leser die Änderung selbst suchen müsste.
//
// Pure — Text-Extraktion (diff/html-blocks.js) und Markierung (diff/diff-parts.js)
// teilt es mit Abschnitts-Historie und Chat-Vorschlägen.
// Die Vorschau ist reine Lesehilfe; übernommen wird weiterhin das rohe Block-HTML
// (block-merge.js#buildResolvedHtml).

import { blockText } from '../../diff/html-blocks.js';
import { markParts } from '../../diff/diff-parts.js';
import { wordDiff } from '../../diff/word-diff.js';

const _plain = v => [{ t: 'eq', v, c: '' }];

/**
 * Anzeige-Modell eines Konflikts.
 * @param {{ local_html: string|null, remote_html: string|null }} c
 * @returns {{ local: Array<{t:string,v:string,c:string}>|null, remote: Array<{t:string,v:string,c:string}>|null, formatOnly: boolean }}
 *   `local`/`remote`: markierte Teile für die jeweilige Spalte (`eq` + `del` bzw.
 *   `eq` + `add`); `null` = Block in dieser Fassung gelöscht. `formatOnly`: gleicher
 *   Text, nur das Markup unterscheidet sich (Fett, Überschriftenebene …) — der
 *   Diff zeigt dann nichts.
 */
export function conflictDiffView(c) {
  const lt = c.local_html == null ? null : blockText(c.local_html);
  const rt = c.remote_html == null ? null : blockText(c.remote_html);
  if (lt == null || rt == null) {
    return {
      local: lt == null ? null : _plain(lt),
      remote: rt == null ? null : _plain(rt),
      formatOnly: false,
    };
  }
  const parts = wordDiff(lt, rt);
  if (!parts) {
    // Zu lang für die LCS-Tabelle: beide Fassungen ungemarkert.
    return { local: _plain(lt), remote: _plain(rt), formatOnly: false };
  }
  return {
    local: markParts(parts, 'old'),
    remote: markParts(parts, 'new'),
    formatOnly: lt === rt,
  };
}
