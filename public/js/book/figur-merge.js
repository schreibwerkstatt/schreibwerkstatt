// Zwei Katalogfiguren zusammenführen, adressiert über die Zeilen-ID — der Weg
// des Redundanz-Radars (Figuren-Paar), das die fig_id nicht kennt (sie ändert
// sich mit jeder Komplettanalyse). Danger-Zone und der Zeilen-Knopf
// «zusammenführen mit…» der Katalog-Listen nehmen den Gattungs-Kern
// book/entity-merge.js; die Erfolgsmeldung `figurMergeMessage` teilen alle.
//
// Server: POST /figures/:book_id/merge { source, target } (fig_id, editor-ACL),
// Merge-Kern db/entity-merge.js#mergeFigures. Die Quelle wird gelöscht; ihr Name,
// Kurzname und ihre Aliasse werden dauerhafte Aliasse des Ziels, damit die nächste
// Komplettanalyse sie nicht als eigene Figur zurückbringt.

import { sendJson } from '../utils/net.js';
import { tFetchError } from '../i18n.js';
import { isSelectedBook } from '../cards/book-guard.js';

const _t = (key, params) => window.__app?.t?.(key, params) ?? key;

/** Bestätigt (appConfirm), führt `source` in `target` zusammen und lädt den
 *  Figuren-Katalog neu. `source`/`target` sind `{ id, name }` (Katalog-Kennung
 *  fig_id) oder `{ rowId, name }` (figures.id, so wie das Redundanz-Radar sie
 *  speichert — die fig_id ändert sich mit jeder Komplettanalyse).
 *  Rückgabe: Server-Antwort, `null` bei Abbruch durch den User. Wirft den
 *  `sendJson`-Fehler (status/code/body) mit übersetzter `message` (tFetchError). */
export async function mergeFigurPair(bookId, source, target) {
  const app = window.__app;
  const byRow = source?.rowId != null && target?.rowId != null;
  const sKey = byRow ? source.rowId : source?.id;
  const tKey = byRow ? target.rowId : target?.id;
  if (!bookId || !sKey || !tKey || sKey === tKey) return null;
  if (!await app.appConfirm({
    message: _t('merge.confirm', { source: source.name, target: target.name }),
    confirmLabel: _t('merge.button'),
    danger: true,
  })) return null;
  let data;
  try {
    data = await sendJson(`/figures/${encodeURIComponent(bookId)}/merge`, 'POST',
      byRow ? { source_id: sKey, target_id: tKey } : { source: sKey, target: tKey });
  } catch (e) {
    e.message = tFetchError(e);
    throw e;
  }
  // Nur nachladen, wenn der User inzwischen nicht das Buch gewechselt hat — der
  // Buchwechsel lädt den Katalog des neuen Buchs selbst.
  if (isSelectedBook(bookId)) app.loadFiguren?.(bookId);
  return data;
}

/** Erfolgsmeldung zu einer Merge-Antwort (inkl. Hinweis auf gelöste Werkstatt-Figuren). */
export function figurMergeMessage(data, source, target) {
  const moved = Object.values(data?.moved || {}).reduce((a, n) => a + (Number(n) || 0), 0);
  let msg = _t('merge.done', { source: source.name, target: target.name, n: moved });
  const unlinked = data?.draftsUnlinked || [];
  if (unlinked.length) {
    msg += ' ' + _t('merge.draftsUnlinked', { names: unlinked.map(d => d.name).join(', ') });
  }
  return msg;
}
