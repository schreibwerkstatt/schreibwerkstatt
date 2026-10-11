// Kachel „Bearbeitungsstand" der Buchübersicht (docs/bearbeitungsstand.md).
// Kein eigener Endpunkt: der Stand liegt nach dem Baum-Laden schon in
// $store.badges (editStatus + editStatusChain), der Kapitelstand kommt aus der
// Root-Methode chapterEditStatus — dieselbe Ableitung wie im Seitenbaum.

import { statusDistribution } from '../redaktion/status.js';

export const editStatusMethods = {
  overviewEditStatus() {
    const badges = Alpine.store('badges');
    const nav = Alpine.store('nav');
    const map = badges.editStatus;
    const chain = badges.editStatusChain;
    const pages = nav.pages;
    const tree = nav.tree;
    const locale = Alpine.store('shell').uiLocale;
    const ideen = badges.ideenCounts;
    return this._memo('editStatus', [map, chain, pages, tree, locale, ideen], () => {
      const app = window.__app;
      const ids = (pages || []).map(p => p.id);
      const counts = statusDistribution(ids, map, chain || []);
      const total = ids.length;
      const done = chain?.length ? chain[chain.length - 1] : null;
      const segments = [...(chain || []).map((s, rank) => ({ key: s, cls: 'status' + rank, n: counts[s] })),
        { key: 'ohne', cls: 'ohne', n: counts.ohne }]
        .filter(s => s.n > 0)
        .map(s => ({
          ...s,
          label: app.t(s.key === 'ohne' ? 'redaktion.status.none' : 'redaktion.status.' + s.key),
        }));
      // Kapitel = oberste Ebene mit Abschnitten; ihr Stand ist der schwaechste
      // darunter (inkl. Unterkapitel).
      const chapters = (tree || []).filter(i => i.type === 'chapter' && !i.solo && !i.parent_id
        && (i.pages?.length > 0 || i.hasChildren));
      const chaptersDone = done
        ? chapters.filter(c => app.chapterEditStatus(c)?.status === done).length
        : 0;
      // Final, aber offene Pendenzen: der Widerspruch, den die Kachel zeigen soll
      // (ideenCounts = offene Ideen je Abschnitt, Sidebar-Plakette).
      const finalOpen = done
        ? ids.filter(id => map?.[String(id)]?.status === done && (ideen?.[id] || 0) > 0).length
        : 0;
      return {
        total,
        finalOpen,
        set: total - counts.ohne,
        doneN: done ? counts[done] : 0,
        doneLabel: done ? app.t('redaktion.status.' + done) : '',
        stale: counts.stale,
        segments,
        chapters: chapters.length,
        chaptersDone,
      };
    });
  },
};
