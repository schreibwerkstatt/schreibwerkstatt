// Zwei Katalog-Einträge derselben Gattung zusammenführen (Figuren · Szenen ·
// Schauplätze) — der eine Client-Weg für alle Stellen, die eine Quelle in ein Ziel
// aufgehen lassen: die Danger-Zone der Bucheinstellungen (book-settings/merge.js)
// und der Zeilen-Knopf «zusammenführen mit…» an Einträgen, die nicht mehr im Text
// stehen (book/entity-merge-picker.js). Das Redundanz-Radar führt Figuren über
// figur-merge.js zusammen (es kennt nur die Zeilen-ID, nicht die fig_id).
//
// Server: POST <url>/merge, Merge-Kern db/entity-merge.js. Die Quelle wird gelöscht,
// ihre Verknüpfungen wandern aufs Ziel. Figuren und Schauplätze bekommen einen
// dauerhaften Alias, Szenen nicht. Die Detailansicht der Schauplatz-Karte
// (book/orte.js#mergeOrt) nutzt denselben Weg.

import { figurMergeMessage } from './figur-merge.js';

// i18n über den Root, nicht über i18n.js — wie figur-merge.js.
const _t = (key, params) => window.__app?.t?.(key, params) ?? key;

// Pro Gattung: Endpunkt-Basis, Listen-Feld der GET-Antwort, Namensfeld, Body-
// Schlüssel des POST und das Feld in `Alpine.store('catalog')`. Die `id` ist bei
// Figuren/Schauplätzen die öffentliche TEXT-Kennung (fig_id/loc_id), bei Szenen
// die INTEGER-PK — jeweils genau so, wie der zugehörige GET sie ausliefert.
export const MERGE_KIND_CFG = {
  figur: { list: 'figuren', catalog: 'figuren', nameKey: 'name',  url: (b) => `/figures/${b}`,        body: (s, t) => ({ source: s, target: t }) },
  szene: { list: 'szenen',  catalog: 'szenen',  nameKey: 'titel', url: (b) => `/figures/scenes/${b}`, body: (s, t) => ({ source_id: Number(s), target_id: Number(t) }) },
  ort:   { list: 'orte',    catalog: 'orte',    nameKey: 'name',  url: (b) => `/locations/${b}`,      body: (s, t) => ({ source: s, target: t }) },
};

export const MERGE_KINDS = Object.keys(MERGE_KIND_CFG);

/** Anzeigename eines Katalog-Eintrags der Gattung. */
export function mergeEntryName(kind, entry) {
  return entry?.[MERGE_KIND_CFG[kind]?.nameKey] || '';
}

/** Rückfrage (appConfirm). `true` = weiter. */
export function confirmEntityMerge(sourceName, targetName) {
  return window.__app.appConfirm({
    message: _t('merge.confirm', { source: sourceName, target: targetName }),
    confirmLabel: _t('merge.button'),
    danger: true,
  });
}

/** POST des Merges. Wirft mit übersetzter Meldung; Rückgabe = Server-Antwort. */
export async function postEntityMerge(kind, bookId, sourceId, targetId) {
  const cfg = MERGE_KIND_CFG[kind];
  const r = await fetch(`${cfg.url(bookId)}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg.body(sourceId, targetId)),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(window.__app.tError(data));
  return data;
}

/** Erfolgsmeldung; `src`/`tgt` tragen `name`. */
export function entityMergeMessage(kind, data, src, tgt) {
  if (kind === 'figur') return figurMergeMessage(data, src, tgt);
  // `moved` zählt die umgehängten Zeilen pro Brücke — für den User genügt die Summe.
  const moved = Object.values(data?.moved || {}).reduce((a, n) => a + (Number(n) || 0), 0);
  return _t('merge.done', { source: src.name, target: tgt.name, n: moved });
}

/** Kataloge nachziehen, damit die gelöschte Quelle aus den Karten verschwindet.
 *  Alle drei: ein Merge hängt Querverweise um (Szenen tragen Figuren und Orte). */
export function reloadCatalogsAfterMerge(bookId) {
  const app = window.__app;
  return Promise.all([app.loadFiguren?.(bookId), app.loadOrte?.(bookId), app.loadSzenen?.(bookId)]);
}
