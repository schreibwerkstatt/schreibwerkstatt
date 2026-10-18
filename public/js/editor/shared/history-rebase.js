// Undo-Verlauf über einen kollisionsfreien Remote-Merge tragen — Notebook-Editor
// und Bucheditor. Liefert die `mapHtml`-Funktion für `history.rebase()` des
// Kerns (shared/edit-history.js), der selbst importfrei bleibt.
//
// Ein Merge bringt fremde Blöcke in den Editor. Jeder ältere Verlaufsstand kennt
// sie nicht: ein Undo dorthin nähme sie wieder heraus, und der nächste Save liefe
// gegen den schon übernommenen Server-Stempel ohne 409 durch — die Änderung des
// anderen Geräts wäre still überschrieben. Darum wird jeder Stand mit demselben
// 3-Way-Block-Merge auf den Remote-Stand gehoben (base = Basis vor dem Merge,
// local = der Verlaufsstand, remote = Server-Stand): danach unterscheidet er sich
// vom aktuellen Inhalt nur noch in den eigenen Schritten.
//
// Ergebnis `null` = dieser Stand ist nicht verlustfrei übertragbar; der Kern
// verwirft ihn samt allen älteren:
//  - die Basis trägt keine Block-IDs (Seite nie gespeichert) — ohne IDs gibt es
//    keine Block-Identität, gegen die gemergt werden könnte;
//  - der Stand hat Inhalt ausserhalb von Blöcken (loser Text, Inline-Knoten
//    direkt unter der Wurzel) — `parseBlocks` sieht nur Elemente, der Rest fiele
//    still weg;
//  - derselbe Block wurde in diesem Stand und remote verschieden geändert.

import { parseBlocks, mergeBlockLists, mergedToHtml } from './block-merge.js';
import { syncLiveBlockIds } from './block-ids.js';
import { stripLektoratMarks } from './html-clean.js';

const HAS_BID = /\sdata-bid=/;

export function createSnapshotRebaser(baseHtml, remoteHtml) {
  if (!HAS_BID.test(baseHtml || '')) return () => null;
  // Basis und Remote einmal parsen, nicht je Verlaufsstand (bis zu 100 Stände).
  const baseBlocks = parseBlocks(baseHtml);
  const remoteBlocks = parseBlocks(remoteHtml || '');
  return (snapHtml) => {
    const el = document.createElement('div');
    el.innerHTML = stripLektoratMarks(snapHtml || '');
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.nodeValue.trim()) return null;
    }
    // IDs wie vor jedem Save: neue Absätze bekommen eine, Enter-Klone verlieren
    // die doppelte — sonst hielte der Merge pro ID nur einen der beiden Absätze.
    syncLiveBlockIds(el, baseHtml);
    for (const c of el.children) {
      if (!c.hasAttribute('data-bid')) return null;
    }
    const m = mergeBlockLists(baseBlocks, parseBlocks(el.innerHTML), remoteBlocks);
    return m.conflicts.length ? null : mergedToHtml(m.merged);
  };
}
