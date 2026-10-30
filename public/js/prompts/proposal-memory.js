// Gedächtnis-Block der Vorschlags-Chats (Plot-Chat, Ideen-Chat): frühere
// Vorschläge der Session mit ihrem Status. Die Liste baut der Server
// (routes/jobs/proposal-chat-shared.js#sessionProposalMemory); hier steht nur
// die Textform, einmal für beide Chats.

const STATE = {
  applied: 'übernommen',
  removed: 'übernommen, danach rückgängig gemacht bzw. gelöscht — steht NICHT mehr im Bestand',
  discarded: 'vom User verworfen',
  open: 'noch offen',
};

/**
 * @param {Array<{type,label,state}>} list
 * @param {string} intro  Kopfzeile (was «übernommen» für diesen Chat heisst)
 * @param {(label: string) => string} [fmt]  Darstellung des Labels
 */
export function buildProposalMemoryBlock(list, intro, fmt = (l) => l) {
  if (!Array.isArray(list) || !list.length) return '';
  const lines = list.map(p => `- ${p.type}: ${fmt(p.label)} — ${STATE[p.state] || STATE.open}`);
  return `${intro}\n${lines.join('\n')}`;
}
