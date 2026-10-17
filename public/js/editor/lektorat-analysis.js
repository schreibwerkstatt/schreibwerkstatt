// Analyse-Block unter den Lektorat-Befunden (Szenen, Stilanalyse, Fazit) —
// SSoT für den frischen Lauf (editor/lektorat.js) und den aus dem Verlauf
// geöffneten (book/history.js). Pure Funktion, `t` wird injiziert.
//
// Das Ergebnis fliesst in `analysisOut` (x-html): jedes KI-Feld UND jeder
// übersetzte String läuft durch escHtml.

import { escHtml } from '../utils.js';

const BADGE_CLASS = { stark: 'badge-ok', schwach: 'badge-err', mittel: 'badge-warn' };

/**
 * @param {(key: string, params?: object) => string} t
 * @param {{ szenen?: Array<{wertung?: string, titel?: string, kommentar?: string}>,
 *           stilanalyse?: string, fazit?: string }} data
 * @returns {string} HTML
 */
export function renderLektoratAnalysisHtml(t, { szenen, stilanalyse, fazit } = {}) {
  let out = '';
  const list = Array.isArray(szenen) ? szenen : [];
  if (list.length > 0) {
    const badge = (w) => {
      const key = BADGE_CLASS[w] ? w : 'mittel';
      return `<span class="badge ${BADGE_CLASS[key]}">${escHtml(t(`szenen.rating.${key}`))}</span>`;
    };
    const rows = list.map(s =>
      `<div class="szene-item">
          <div class="szene-header">${badge(s.wertung)} <span class="szene-titel">${escHtml(s.titel)}</span></div>
          ${s.kommentar ? `<div class="szene-kommentar">${escHtml(s.kommentar)}</div>` : ''}
        </div>`
    ).join('');
    out += `<div class="stilbox"><div class="bewertung-section-title">${escHtml(t('lektorat.section.szenen'))}</div>${rows}</div>`;
  }
  if (stilanalyse) out += `<div class="stilbox"><div class="bewertung-section-title">${escHtml(t('lektorat.section.stilanalyse'))}</div>${escHtml(stilanalyse)}</div>`;
  if (fazit) out += `<div class="fazit">${escHtml(fazit)}</div>`;
  return out;
}
