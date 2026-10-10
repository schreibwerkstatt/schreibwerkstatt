// Zwei Katalogfiguren zusammenführen — geteilter Client-Weg für die Stellen, an
// denen eine Dublette sichtbar wird: Redundanz-Radar (Figuren-Paar) und die
// Figurenkarte (ausgemusterte Figur «zusammenführen mit…»). Die Bucheinstellungen
// (Danger-Zone, book-settings/merge.js) bedienen alle drei Gattungen über ihren
// eigenen Kandidaten-State und rufen dieselbe Route.
//
// Server: POST /figures/:book_id/merge { source, target } (fig_id, editor-ACL),
// Merge-Kern db/entity-merge.js#mergeFigures. Die Quelle wird gelöscht; ihr Name,
// Kurzname und ihre Aliasse werden dauerhafte Aliasse des Ziels, damit die nächste
// Komplettanalyse sie nicht als eigene Figur zurückbringt.

// i18n über den Root (`window.__app.t`), nicht über i18n.js: das Modul hängt beim
// Import Listener an `window` und machte die Figurenkarte ohne Browser unladbar.
const _t = (key, params) => window.__app?.t?.(key, params) ?? key;

/** Bestätigt (appConfirm), führt `source` in `target` zusammen und lädt den
 *  Figuren-Katalog neu. `source`/`target` sind `{ id, name }` (Katalog-Kennung
 *  fig_id) oder `{ rowId, name }` (figures.id, so wie das Redundanz-Radar sie
 *  speichert — die fig_id ändert sich mit jeder Komplettanalyse).
 *  Rückgabe: Server-Antwort, `null` bei Abbruch durch den User. Wirft mit
 *  übersetzter Meldung bei einem Fehler. */
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
  const r = await fetch(`/figures/${encodeURIComponent(bookId)}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(byRow ? { source_id: sKey, target_id: tKey } : { source: sKey, target: tKey }),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(app.tError(data));
  // Nur nachladen, wenn der User inzwischen nicht das Buch gewechselt hat — der
  // Buchwechsel lädt den Katalog des neuen Buchs selbst.
  if (String(Alpine.store('nav').selectedBookId) === String(bookId)) app.loadFiguren?.(bookId);
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
