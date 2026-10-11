// Bearbeitungsstand an den Bahnen des Ideen-Boards (docs/bearbeitungsstand.md).
// Der Stand selbst kommt aus der Root (tree/edit-status.js) — hier nur die
// Abbildung auf Bahnen: Abschnitts-Bahn = Stand des Abschnitts, Kapitel-Bahn =
// schwaechste Stufe darunter.
//
// `laneFinalConflict`: eine Bahn auf der Fertig-Stufe mit offenen Pendenzen ist
// ein Widerspruch — entweder ist die Pendenz eingeloest oder der Abschnitt ist
// nicht fertig. Genau das soll im Board auffallen.

import { IDEE_OPEN_STATUSES } from '../ideen-shared.js';

function _laneEntry(lane) {
  const app = window.__app;
  if (!app || !lane) return null;
  if (lane.kind === 'page') return app.pageEditStatus(lane.id);
  if (lane.kind === 'chapter') {
    const item = (Alpine.store('nav').tree || []).find(i => i.type === 'chapter' && i.id === lane.id);
    return item ? app.chapterEditStatus(item) : null;
  }
  return null;
}

export const ideenBoardEditStatus = {
  laneEditStatusClass(lane) {
    const e = _laneEntry(lane);
    return 'edit-status-meter ' + window.__app.editStatusClass(e);
  },

  laneEditStatusTip(lane) {
    const e = _laneEntry(lane);
    return e?.status ? window.__app.editStatusTipLine(e) : '';
  },

  laneFinalConflict(lane) {
    const chain = Alpine.store('badges').editStatusChain || [];
    const e = _laneEntry(lane.lane);
    if (!chain.length || e?.status !== chain[chain.length - 1]) return 0;
    return IDEE_OPEN_STATUSES.reduce((n, st) => n + (lane.columns?.[st]?.length || 0) + (lane.hidden?.[st] || 0), 0);
  },
};
