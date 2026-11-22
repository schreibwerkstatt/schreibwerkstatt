'use strict';
// Dezenter App-Hinweis in der Share-Leseansicht (pro Link abschaltbar über
// share_links.show_promo, Standard an). Zwei Stellen:
//   - Footer: «Dieses Manuskript entsteht mit {appName} · Selbst ausprobieren»
//     → Landing derselben Instanz mit `?ref=share`.
//   - Einmaliger Hinweis nach dem ersten abgeschickten Kommentar (Client:
//     public/js/share-reader/promo.js) → Landing mit `?ref=share-comment`.
// Der `ref`-Parameter landet über lib/register-source.js als Herkunft in der
// Zugangsanfrage (Landing reicht ihn als `src` an /register weiter).
// Kein Text behauptet, der Autor empfehle die App — er sagt nur, womit das
// Manuskript geschrieben wird.

const appSettings = require('./app-settings');
const { tServer, tServerParams } = require('./i18n-server');
const { escHtml: _escHtml } = require('./share-helpers');

function _baseUrl() {
  return (appSettings.get('app.public_url') || '').replace(/\/$/, '');
}

function appName() {
  return appSettings.get('app.name') || 'Schreibwerkstatt';
}

function landingUrl(ref) {
  return `${_baseUrl()}/?ref=${encodeURIComponent(ref)}`;
}

/**
 * @param {{ show_promo?: number|null }} link
 * @param {string} lang
 * @returns {{ footerHtml: string, config: object|null }}
 *   footerHtml: fertiges, escaptes Markup für den App-Teil des Footers
 *   config:     Daten für den Kommentar-Hinweis im Reader (null = aus)
 */
function buildPromo(link, lang) {
  const name = appName();
  // NULL (Alt-Zeile ohne Default) zählt wie an — nur explizit 0 schaltet ab.
  const on = link?.show_promo !== 0;
  if (!on) {
    const home = _escHtml(_baseUrl() || '/');
    return {
      footerHtml: `<a class="share-footer__link" href="${home}" target="_blank" rel="noopener noreferrer">${_escHtml(name)}</a>`,
      config: null,
    };
  }
  const footerHtml = `<span class="share-footer__promo">${_escHtml(tServerParams('share.reader.promo_footer', { appName: name }, lang))}</span>`
    + ` · <a class="share-footer__link share-footer__link--promo" href="${_escHtml(landingUrl('share'))}" target="_blank" rel="noopener">${_escHtml(tServer('share.reader.promo_try', lang))}</a>`;
  return {
    footerHtml,
    config: {
      url: landingUrl('share-comment'),
      title: tServer('share.reader.promo_comment_title', lang),
      body: tServerParams('share.reader.promo_comment_body', { appName: name }, lang),
      link: tServer('share.reader.promo_comment_link', lang),
      close: tServer('share.reader.close', lang),
    },
  };
}

module.exports = { buildPromo, landingUrl, appName };
