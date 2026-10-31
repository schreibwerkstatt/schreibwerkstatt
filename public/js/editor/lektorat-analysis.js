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
// «Im Chat besprechen»: der Knopf trägt Art und Text als data-Attribute
// (escHtml maskiert auch Anführungszeichen); der Klick wird am Container
// delegiert (editor-findings.html → $app.onLektoratAnalysisClick).
function discussBtn(t, kind, text, titel = '') {
  return `<button type="button" class="btn-compact lektorat-discuss" data-chat-discuss="${kind}"`
    + ` data-text="${escHtml(text)}" data-titel="${escHtml(titel)}">${escHtml(t('lektorat.discussInChat'))}</button>`;
}

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
          ${s.kommentar ? `<div class="szene-kommentar">${escHtml(s.kommentar)}</div>${discussBtn(t, 'szene', s.kommentar, s.titel || '')}` : ''}
        </div>`
    ).join('');
    out += `<div class="stilbox"><div class="card-section-title">${escHtml(t('lektorat.section.szenen'))}</div>${rows}</div>`;
  }
  if (stilanalyse) out += `<div class="stilbox"><div class="card-section-title">${escHtml(t('lektorat.section.stilanalyse'))}</div>${escHtml(stilanalyse)}${discussBtn(t, 'stil', stilanalyse)}</div>`;
  if (fazit) out += `<div class="fazit">${escHtml(fazit)}${discussBtn(t, 'fazit', fazit)}</div>`;
  return out;
}
