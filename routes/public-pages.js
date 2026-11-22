'use strict';
// Oeffentliche Inhaltsseiten fuer Erstbesucher (vor dem Auth-Guard gemountet):
//   GET /lektorat            — Themenseite KI-Lektorat
//   GET /testleser           — Themenseite Testleser-Feedback
//   GET /funktionen          — Funktionsuebersicht (routes/public-features.js)
//
// Indexierbar wie Landing und Datenschutz (gleicher Schalter `seo.indexable`);
// die Pfade stehen in PUBLIC_PAGE_PATHS und damit in der Sitemap (routes/public.js).
// Sprache allein aus der URL (`?lang=en`, sonst Deutsch) — lib/public-render.js#pageLang.

const express = require('express');
const { tServer, tServerParams } = require('../lib/i18n-server');
const {
  render, toInlineJson, pageLang, demoUrl, appName, seoLinks, breadcrumbLd,
  langSwitchVars, setPublicPageHeaders, headMetaHtml, ogImageUrl,
} = require('../lib/public-render');

const router = express.Router();

// Themenseiten: Key-Praefix publicPage.<key>.* (title, metaDescription, h1,
// intro, s1..s3 Title/Text) + Produktbild aus /img/landing/ (pre-auth frei).
const TOPICS = {
  lektorat:  { img: '/img/landing/lektorat.webp' },
  testleser: { img: '/img/landing/testleser.webp' },
};

// Funktionsuebersicht /funktionen: eigenes Modul, hier eingehaengt, damit sie
// mit den Themenseiten in der Sitemap steht.
const featuresRouter = require('./public-features');
router.use(featuresRouter);

const PUBLIC_PAGE_PATHS = [...Object.keys(TOPICS).map(k => `/${k}`), featuresRouter.FEATURES_PATH];

function _commonVars(req, pathName) {
  const lang = pageLang(req);
  const t = (key, params) => (params ? tServerParams(key, params, lang) : tServer(key, lang));
  const seo = seoLinks(pathName, lang);
  const demo = demoUrl();
  return {
    t, lang,
    vars: {
      lang,
      appName: appName(),
      noindex: !seo.canonical,
      ...seo,
      ...langSwitchVars(req, pathName, lang),
      demoUrl: demo,
      demoLabel: t('publicPage.demoLabel'),
      registerLabel: t('publicPage.registerLabel'),
      backToLanding: t('publicPage.backToLanding'),
      privacyLabel: t('privacy.footerLink'),
      footer: t('landing.footer'),
    },
  };
}

function _renderTopic(key) {
  const topic = TOPICS[key];
  return (req, res) => {
    const { t, vars } = _commonVars(req, `/${key}`);
    const p = (f) => t(`publicPage.${key}.${f}`);
    const title = `${p('title')} – ${vars.appName}`;
    setPublicPageHeaders(res);
    res.type('html').send(render('topic.html', {
      ...vars,
      title,
      metaDescription: p('metaDescription'),
      headMetaHtml: headMetaHtml({ lang: vars.lang, ogImage: ogImageUrl(key, vars.lang), ogAlt: title }),
      ldJson: toInlineJson(breadcrumbLd(p('h1'), `/${key}`, vars.lang)),
      img: topic.img,
      h1: p('h1'),
      intro: p('intro'),
      s1Title: p('s1Title'), s1Text: p('s1Text'),
      s2Title: p('s2Title'), s2Text: p('s2Text'),
      s3Title: p('s3Title'), s3Text: p('s3Text'),
      ctaTitle: t('publicPage.ctaTitle'),
      ctaText: t('publicPage.ctaText'),
    }));
  };
}

for (const key of Object.keys(TOPICS)) router.get(`/${key}`, _renderTopic(key));

module.exports = router;
module.exports.PUBLIC_PAGE_PATHS = PUBLIC_PAGE_PATHS;
