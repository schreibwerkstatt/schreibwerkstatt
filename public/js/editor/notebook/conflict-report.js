// Diagnosezeile zum Konflikt-Modal, gemeldet an /telemetry/js-error (kind
// 'conflict'). Das Modal entsteht meist im Browser (Pre-Save-Check, Pull nach
// Aufwachen, Draft-Wiederaufnahme) — der Server sieht davon nichts. Ohne diese
// Zeile bleibt nur der Screenshot des Users.
//
// Kein Text aus dem Manuskript: nur Block-IDs (gekürzt), Zeitstempel und die
// Entscheidungsgrundlagen (eigenes Konto/Gerät, Fingerabdruck-Treffer).
import { parseBlocks } from '../shared/block-merge.js';
import { getDeviceId } from '../../device-id.js';

const short = (bid) => (bid && !bid.startsWith('__nobid_') ? bid.slice(0, 6) : bid || '-');

// Reiner Formatierer, getrennt testbar. Eine Zeile, deutsch wie die übrigen
// Admin-Diagnosezeilen. `where` je Konflikt-Block: in welcher Fassung die
// Block-ID vorkommt (B=Basis, L=lokal, R=Server).
export function formatConflictReport({ pageId, via, baseAt, remoteAt, author, ownFp, baseHtml, localHtml, remoteHtml, conflicts }) {
  const sets = [baseHtml, localHtml, remoteHtml].map((h) => new Set(parseBlocks(h || '').map((b) => b.bid)));
  const counts = sets.map((s) => s.size).join('/');
  const blocks = (conflicts || []).slice(0, 8).map((c) => {
    const where = ['B', 'L', 'R'].filter((_, i) => sets[i].has(c.bid)).join('') || '∅';
    return `${short(c.bid)}:${where}`;
  }).join(' ');
  const remoteDev = author?.remoteDeviceId
    ? (author.remoteDeviceId === getDeviceId() ? 'dieses' : 'anderes')
    : 'unbekannt';
  return [
    `Konflikt-Modal Abschnitt ${pageId} via ${via || '?'}`,
    `Basis ${baseAt || '-'} · Server ${remoteAt || '-'}`,
    `Server-Stand: ${author?.remoteIsSelf ? 'eigenes Konto' : 'fremdes Konto'}, Gerät ${remoteDev}, Fingerabdruck ${ownFp ? 'Treffer' : 'kein Treffer'}`,
    `Blöcke B/L/R ${counts}`,
    `Konflikte ${conflicts?.length || 0}: ${blocks}`,
    `online=${typeof navigator !== 'undefined' ? navigator.onLine : '?'}`,
  ].join(' · ');
}

export function reportConflictShown(info) {
  const report = typeof window !== 'undefined' ? window.__reportClientError : null;
  if (typeof report !== 'function') return;
  try {
    report({
      kind: 'conflict',
      message: formatConflictReport(info),
      stack: null,
      source: 'notebook-conflict',
      line: null,
      col: null,
      pageUrl: typeof location !== 'undefined' ? location.href : null,
    });
  } catch { /* Diagnose darf den Konfliktpfad nie stören */ }
}
