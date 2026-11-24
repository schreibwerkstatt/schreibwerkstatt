'use strict';
// Oeffentliche Funktionsuebersicht (vor dem Auth-Guard, eingehaengt ueber
// routes/public-pages.js):
//   GET /funktionen — alle Funktionen der App, nach Bereich gruppiert, je
//                     Bereich ein Screenshot.
//
// Die Landing wirbt mit drei Kacheln; diese Seite listet vollstaendig. Die
// Inventur, gegen die sie bei neuen Funktionen abzugleichen ist, ist der
// Hilfe-Katalog (public/js/cards/help-catalog.js).
//
// Texte: publicFeatures.<gruppe>.{title,intro} und
// publicFeatures.<gruppe>.<item>.{title,desc}. Die Gruppen-Liste kann das
// Mini-Template (lib/public-render.js) nicht wiederholen — sie wird hier als
// Markup gebaut, jeder Text durch escHtml.

const express = require('express');
const { tServer } = require('../lib/i18n-server');
const {
  render, escHtml, toInlineJson, pageLang, demoUrl, appName, seoLinks, breadcrumbLd,
  langSwitchVars, setPublicPageHeaders, headMetaHtml, ogImageUrl, publicHeaderHtml, publicFooterHtml,
} = require('../lib/public-render');

const router = express.Router();

const FEATURES_PATH = '/funktionen';

// `img` = Screenshot unter /img/landing/ (erzeugt von `npm run shots:landing`,
// 920 × 614), `accent` = Kartenfarbe der App (--card-accent-<accent>).
const FEATURE_GROUPS = [
  { key: 'write',    img: 'schreiben',   accent: 'bookeditor',
    items: ['editors', 'structure', 'history', 'status', 'spellcheck', 'voice', 'blocks', 'offline'] },
  { key: 'lektorat', img: 'lektorat',    accent: 'stil',
    items: ['page', 'types', 'apply', 'heatmap', 'erzaehl'] },
  { key: 'stil',     img: 'ueberblick',  accent: 'heatmap',
    items: ['heatmap', 'wortschatz', 'redundanz', 'growth', 'mystats', 'autorenprofil'] },
  { key: 'review',   img: 'bewertung',   accent: 'review',
    items: ['book', 'chapter', 'axes'] },
  { key: 'analysis', img: 'buchanalyse', accent: 'figuren',
    items: ['figures', 'places', 'scenes', 'timeline', 'continuity', 'worldfacts', 'semantic', 'music'] },
  { key: 'chats',    img: 'chat',        accent: 'chat',
    items: ['page', 'book', 'research', 'plot', 'ideas', 'images'] },
  { key: 'plan',     img: 'plot',        accent: 'plot',
    items: ['plot', 'figures', 'motifs', 'ideas', 'series'] },
  { key: 'research', img: 'recherche',   accent: 'recherche',
    items: ['board', 'extension', 'sources', 'links', 'search'] },
  { key: 'share',    img: 'testleser',   accent: 'share',
    items: ['link', 'comments', 'listen', 'stats', 'collab'] },
  { key: 'export',   img: 'export',      accent: 'pdfexport',
    items: ['import', 'pdf', 'docx', 'epub', 'expose', 'bundle', 'finetune'] },
  { key: 'types',    img: null,          accent: 'blog',
    items: ['novel', 'nonfiction', 'journalism', 'blog', 'diary'] },
];

/** Anker-ID einer Gruppe (Sprungmarke aus dem Inhaltsverzeichnis). */
const _anchor = (key) => `f-${key}`;

function _tocHtml(t) {
  return FEATURE_GROUPS.map(g =>
    `<li><a class="public-inline-link" href="#${_anchor(g.key)}">${escHtml(t(`publicFeatures.${g.key}.title`))}</a></li>`
  ).join('');
}

function _groupsHtml(t) {
  return FEATURE_GROUPS.map((g) => {
    const p = (f) => escHtml(t(`publicFeatures.${g.key}.${f}`));
    const items = g.items.map(i =>
      `<li><h3>${p(`${i}.title`)}</h3><p>${p(`${i}.desc`)}</p></li>`
    ).join('');
    // Bild illustrativ: die h2 daneben sagt, was es zeigt — alt="" haelt es
    // aus dem Screenreader (wie auf der Landing).
    const shot = g.img
      ? `<img class="public-fgroup-shot" src="/img/landing/${g.img}.webp" alt="" width="920" height="614" loading="lazy" decoding="async">`
      : '';
    return `<section class="public-fgroup public-fgroup--${g.accent}${g.img ? '' : ' public-fgroup--noimg'}" id="${_anchor(g.key)}">`
      + `<div class="public-fgroup-head">${shot}<div class="public-fgroup-lead">`
      + `<h2 class="public-heading">${p('title')}</h2><p>${p('intro')}</p></div></div>`
      + `<ul class="public-fgroup-items">${items}</ul></section>`;
  }).join('\n');
}

function _renderFeatures(req, res) {
  const lang = pageLang(req);
  const t = (key) => tServer(key, lang);
  const seo = seoLinks(FEATURES_PATH, lang);
  const name = appName();
  const h1 = t('publicFeatures.h1');
  const title = `${t('publicFeatures.title')} – ${name}`;
  const langSwitch = langSwitchVars(req, FEATURES_PATH, lang);
  setPublicPageHeaders(res);
  res.type('html').send(render('funktionen.html', {
    lang,
    appName: name,
    noindex: !seo.canonical,
    ...seo,
    ...langSwitch,
    headerHtml: publicHeaderHtml({ lang, h1, intro: t('publicFeatures.intro') }),
    footerHtml: publicFooterHtml({ lang, current: FEATURES_PATH, ...langSwitch }),
    title,
    metaDescription: t('publicFeatures.metaDescription'),
    headMetaHtml: headMetaHtml({ lang, ogImage: ogImageUrl('funktionen', lang), ogAlt: title }),
    ldJson: toInlineJson(breadcrumbLd(h1, FEATURES_PATH, lang)),
    tocLabel: t('publicFeatures.tocLabel'),
    tocHtml: _tocHtml(t),
    groupsHtml: _groupsHtml(t),
    ctaTitle: t('publicPage.ctaTitle'),
    ctaText: t('publicPage.ctaText'),
    demoUrl: demoUrl(),
    noDemo: !demoUrl(),
    demoLabel: t('publicPage.demoLabel'),
    registerLabel: t('publicPage.registerLabel'),
  }));
}

router.get(FEATURES_PATH, _renderFeatures);

module.exports = router;
module.exports.FEATURES_PATH = FEATURES_PATH;
module.exports.FEATURE_GROUPS = FEATURE_GROUPS;
