'use strict';
// Beat-Marker im Freitext auflösen. Der Board-Prompt nummeriert jeden Beat mit
// einem [#id]-Marker, damit das Modell ihn per ID referenzieren kann; Modelle
// tragen diese Nummern aber gern in Freitext weiter («Entfremdung (#33)»,
// «Setup für #101/#53»). Landet so ein Text als Beat-Titel/-Beschreibung im Board,
// steht dort eine Nummer, die die Autorin nirgends sieht. Darum wird jede Nummer
// eines Beats, den es auf dem Board gibt, durch «Titel» ersetzt — bevor der Text
// gespeichert oder als Vorschlag gezeigt wird. Unbekannte Nummern bleiben stehen
// («Platz #1» ist kein Beat-Verweis).
//
// Konsumenten: Brainstorm-Job (routes/jobs/plot.js, label + begruendung, die beim
// Übernehmen Titel und Beschreibung werden) und Plot-Chat (routes/jobs/plot-chat-tools.js,
// Freitextfelder jedes Vorschlags, klassisch wie agentisch).

const MARKER = /(?<![\w&])\[?#(\d+)\]?/g;

function _norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

// titleOf: Map<id, titel> | (id → titel|undefined)
function resolveBeatRefs(text, titleOf) {
  if (typeof text !== 'string' || !text.includes('#')) return text;
  const get = typeof titleOf === 'function' ? titleOf : (id => titleOf?.get(id));
  return text.replace(MARKER, (m, num, offset, whole) => {
    const titel = get(Number(num));
    if (!titel) return m;
    // «[#42] Titel» / «[#42] «Titel»»: der Titel steht schon dahinter → nur den Marker weg.
    const rest = whole.slice(offset + m.length).replace(/^\s*[«"„]?/, '');
    if (_norm(rest).startsWith(_norm(titel))) return '';
    return `«${titel}»`;
  }).replace(/ {2,}/g, ' ').replace(/^ /gm, '');
}

module.exports = { resolveBeatRefs };
